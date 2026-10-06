import {
  badRequest,
  serviceUnavailable,
  unauthorized,
} from './paymentsWorkerHttp'
import type {
  AuthenticatedBusinessRequest,
  Env,
  JsonBody,
} from './paymentsWorkerTypes'

// Business request authentication for the Payments Worker: HMAC-SHA256 over a canonical request
// (method, path, timestamp, nonce, businessId, body hash) with timestamp skew and nonce replay
// protection -- the same scheme Client Portal uses for its Business requests, so the desktop signs
// identically. The shared secret is self-bootstrapped into D1 on first use (there is nothing to
// `wrangler secret put`). Unlike Client Portal's business auth, this works in every environment: the
// secret is Worker-held, so there is no development-only shortcut to gate.

const textEncoder = new TextEncoder()
const maximumBodyBytes = 64 * 1024
const maximumClockSkewSeconds = 5 * 60
const nonceRetentionSeconds = 10 * 60

type AuthenticationResult =
  | { ok: true; request: AuthenticatedBusinessRequest }
  | { ok: false; response: Response }

function isValidBusinessId(value: string) {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value)
}

function isValidNonce(value: string) {
  return /^[A-Za-z0-9._:-]{16,128}$/.test(value)
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function encodeHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
}

function encodeBase64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

// Read the single settings row if it exists; otherwise generate 32 random bytes, insert with
// ON CONFLICT DO NOTHING, then re-read, so a first-request race lands on whichever insert won rather
// than two different secrets.
async function getOrCreateRequestSigningSecretBase64(env: Env): Promise<string> {
  const existing = await env.DB
    .prepare(`SELECT request_signing_secret FROM payments_worker_settings WHERE singleton_id = 1`)
    .first<{ request_signing_secret: string }>()
  if (existing) return existing.request_signing_secret

  const generated = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB
    .prepare(`INSERT INTO payments_worker_settings (singleton_id, request_signing_secret) VALUES (1, ?) ON CONFLICT DO NOTHING`)
    .bind(generated)
    .run()

  const row = await env.DB
    .prepare(`SELECT request_signing_secret FROM payments_worker_settings WHERE singleton_id = 1`)
    .first<{ request_signing_secret: string }>()
  if (!row) throw new Error('Payments request signing secret bootstrap failed.')
  return row.request_signing_secret
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  if (leftBytes.length !== rightBytes.length) return false

  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

async function hashBody(bodyText: string) {
  return encodeHex(await crypto.subtle.digest('SHA-256', textEncoder.encode(bodyText)))
}

async function signCanonicalRequest(signingSecretBase64: string, canonicalRequest: string) {
  let signingSecretBytes: Uint8Array
  try {
    signingSecretBytes = decodeBase64(signingSecretBase64)
  } catch {
    throw new Error('The Payments request signing secret must be valid Base64.')
  }
  if (signingSecretBytes.byteLength < 32) {
    signingSecretBytes.fill(0)
    throw new Error('The Payments request signing secret must contain at least 32 bytes.')
  }

  try {
    const key = await crypto.subtle.importKey('raw', signingSecretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return encodeBase64Url(await crypto.subtle.sign('HMAC', key, textEncoder.encode(canonicalRequest)))
  } finally {
    signingSecretBytes.fill(0)
  }
}

async function claimNonce(env: Env, businessId: string, nonce: string, timestampSeconds: number) {
  const createdAt = new Date().toISOString()
  const expiresAt = new Date((timestampSeconds + nonceRetentionSeconds) * 1000).toISOString()

  await env.DB.prepare(`DELETE FROM payments_request_nonces WHERE expires_at <= ?`).bind(createdAt).run()
  const result = await env.DB
    .prepare(`
      INSERT OR IGNORE INTO payments_request_nonces (business_id, nonce, request_timestamp_seconds, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(businessId, nonce, timestampSeconds, expiresAt, createdAt)
    .run()
  return result.meta.changes === 1
}

function parseJsonBody(bodyText: string): JsonBody | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as JsonBody
  } catch {
    return null
  }
}

// Authenticates a Business-originated JSON request. Never used for payer-originated requests (the
// hosted payment page authenticates by its unguessable link token instead).
export async function authenticateBusinessJsonRequest(
  request: Request,
  env: Env,
  requestId: string,
): Promise<AuthenticationResult> {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return { ok: false, response: badRequest(requestId, 'Content-Type must be application/json.') }
  }

  const businessId = (request.headers.get('x-solesystems-business-id') || '').trim()
  const timestampText = (request.headers.get('x-solesystems-timestamp') || '').trim()
  const nonce = (request.headers.get('x-solesystems-nonce') || '').trim()
  const suppliedSignature = (request.headers.get('x-solesystems-signature') || '').trim()

  if (
    !isValidBusinessId(businessId)
    || !isValidNonce(nonce)
    || !/^\d{10}$/.test(timestampText)
    || !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
  ) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const timestampSeconds = Number(timestampText)
  if (
    !Number.isSafeInteger(timestampSeconds)
    || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > maximumClockSkewSeconds
  ) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const bodyText = await request.text()
  if (textEncoder.encode(bodyText).byteLength > maximumBodyBytes) {
    return { ok: false, response: badRequest(requestId, 'Request body is too large.') }
  }
  const body = parseJsonBody(bodyText)
  if (!body) return { ok: false, response: badRequest(requestId, 'Request body contains invalid JSON.') }
  if (body.businessId !== businessId) return { ok: false, response: unauthorized(requestId) }

  const canonicalRequest = [
    request.method.toUpperCase(),
    new URL(request.url).pathname,
    timestampText,
    nonce,
    businessId,
    await hashBody(bodyText),
  ].join('\n')

  let expectedSignature: string
  try {
    expectedSignature = await signCanonicalRequest(await getOrCreateRequestSigningSecretBase64(env), canonicalRequest)
  } catch (error) {
    console.error('Payments request signing configuration failed:', error instanceof Error ? error.message : 'unknown error')
    return { ok: false, response: serviceUnavailable(requestId, 'Business request authentication is unavailable.') }
  }

  if (!constantTimeEqual(expectedSignature, suppliedSignature)) return { ok: false, response: unauthorized(requestId) }
  if (!(await claimNonce(env, businessId, nonce, timestampSeconds))) return { ok: false, response: unauthorized(requestId) }

  return { ok: true, request: { businessId, body } }
}
