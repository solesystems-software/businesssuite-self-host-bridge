import {
  badRequest,
  serviceUnavailable,
  unauthorized,
} from './clientPortalWorkerHttp'
import type {
  AuthenticatedBusinessRequest,
  Env,
  JsonBody,
} from './clientPortalWorkerTypes'

// Business-publish authentication (Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 1, source
// plan section 11.1): HMAC-signed requests with timestamp/nonce/body-hash and replay protection. Adapted
// from cloudflare-bank-feeds/src/requestAuthentication.ts's own proven "development_shared_secret" mode
// -- the only mode this Worker implements (Part D: one Worker-level secret, not per-business yet; see
// schema.sql's portal_businesses comment). Wave 2A (Cloudflare_Self_Hosting_Implementation_Task_Spec_
// 20260928.md): that secret is now self-bootstrapped into D1 on first use instead of pushed via
// `wrangler secret put` -- see getOrCreatePublishSigningSecretBase64 below.

const textEncoder = new TextEncoder()
const maximumBodyBytes = 256 * 1024
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
  return Array.from(new Uint8Array(bytes))
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
}

function encodeBase64Url(bytes: ArrayBuffer) {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: the publish-signing HMAC
// secret is self-bootstrapped into D1 on first use rather than supplied as a Worker secret -- read
// the single settings row if it exists; otherwise generate 32 random bytes, insert with
// ON CONFLICT DO NOTHING, then re-read -- so a first-request race lands on whichever insert won
// rather than two different secrets, mirroring cloudflare-mobile-sync's
// getOrCreateWorkerEncryptionKeyB64 (mobileSyncSecurity.ts). Removing the manual `wrangler secret put`
// step is exactly what self-hosting-design.md's "Secret handoff" resolution calls for.
async function getOrCreatePublishSigningSecretBase64(env: Env): Promise<string> {
  const existing = await env.DB
    .prepare(`SELECT publish_signing_secret FROM client_portal_worker_settings WHERE singleton_id = 1`)
    .first<{ publish_signing_secret: string }>()
  if (existing) return existing.publish_signing_secret

  const generated = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB
    .prepare(`INSERT INTO client_portal_worker_settings (singleton_id, publish_signing_secret) VALUES (1, ?) ON CONFLICT DO NOTHING`)
    .bind(generated)
    .run()

  const row = await env.DB
    .prepare(`SELECT publish_signing_secret FROM client_portal_worker_settings WHERE singleton_id = 1`)
    .first<{ publish_signing_secret: string }>()
  if (!row) throw new Error('Client Portal publish signing secret bootstrap failed.')
  return row.publish_signing_secret
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  if (leftBytes.length !== rightBytes.length) return false

  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index]
  }
  return difference === 0
}

async function hashBody(bodyText: string) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(bodyText))
  return encodeHex(digest)
}

async function signCanonicalRequest(signingSecretBase64: string, canonicalRequest: string) {
  let signingSecretBytes: Uint8Array
  try {
    signingSecretBytes = decodeBase64(signingSecretBase64)
  } catch {
    throw new Error('The Client Portal publish signing secret must be valid Base64.')
  }

  if (signingSecretBytes.byteLength < 32) {
    signingSecretBytes.fill(0)
    throw new Error('The Client Portal publish signing secret must contain at least 32 bytes.')
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      signingSecretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(canonicalRequest))
    return encodeBase64Url(signature)
  } finally {
    signingSecretBytes.fill(0)
  }
}

async function claimNonce(env: Env, businessId: string, nonce: string, timestampSeconds: number) {
  const now = new Date()
  const expiresAt = new Date((timestampSeconds + nonceRetentionSeconds) * 1000).toISOString()
  const createdAt = now.toISOString()

  await env.DB.prepare(`DELETE FROM portal_request_nonces WHERE expires_at <= ?`).bind(createdAt).run()

  const result = await env.DB
    .prepare(`
      INSERT OR IGNORE INTO portal_request_nonces (business_id, nonce, request_timestamp_seconds, expires_at, created_at)
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

async function ensureBusinessRow(env: Env, businessId: string) {
  await env.DB
    .prepare(`INSERT OR IGNORE INTO portal_businesses (id) VALUES (?)`)
    .bind(businessId)
    .run()
}

// Authenticates a Business-originated binary request (upload-object only -- file bytes can't be hashed
// as a JSON body). Same canonical-request shape as the JSON path, but the body hash covers the raw
// bytes directly and there is no body.businessId field to cross-check.
export async function authenticateBusinessBinaryRequest(
  request: Request,
  env: Env,
  requestId: string,
  maximumBytes: number,
): Promise<
  | { ok: true; businessId: string; bytes: Uint8Array }
  | { ok: false; response: Response }
> {
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
  const currentTimestampSeconds = Math.floor(Date.now() / 1000)
  if (
    !Number.isSafeInteger(timestampSeconds)
    || Math.abs(currentTimestampSeconds - timestampSeconds) > maximumClockSkewSeconds
  ) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const bodyBuffer = await request.arrayBuffer()
  if (bodyBuffer.byteLength > maximumBytes) {
    return { ok: false, response: badRequest(requestId, 'Uploaded object is too large.') }
  }
  const bytes = new Uint8Array(bodyBuffer)

  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const bodyHash = encodeHex(digest)

  const url = new URL(request.url)
  const canonicalRequest = [
    request.method.toUpperCase(),
    url.pathname,
    timestampText,
    nonce,
    businessId,
    bodyHash,
  ].join('\n')

  let publishSigningSecret: string
  let expectedSignature: string
  try {
    publishSigningSecret = await getOrCreatePublishSigningSecretBase64(env)
    expectedSignature = await signCanonicalRequest(publishSigningSecret, canonicalRequest)
  } catch (error) {
    console.error('Client Portal publish signing configuration failed:', error)
    return { ok: false, response: serviceUnavailable(requestId, 'Business-publish authentication is unavailable.') }
  }

  if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const nonceClaimed = await claimNonce(env, businessId, nonce, timestampSeconds)
  if (!nonceClaimed) {
    return { ok: false, response: unauthorized(requestId) }
  }

  await ensureBusinessRow(env, businessId)

  return { ok: true, businessId, bytes }
}

// Authenticates a Business-originated JSON request (publish snapshot, upload object, acknowledge
// packet, list pending packets). Never used for Client-originated requests -- those are authenticated by
// invite-link token instead (clientPortalTokenRequests.ts).
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
  const currentTimestampSeconds = Math.floor(Date.now() / 1000)
  if (
    !Number.isSafeInteger(timestampSeconds)
    || Math.abs(currentTimestampSeconds - timestampSeconds) > maximumClockSkewSeconds
  ) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const bodyText = await request.text()
  if (textEncoder.encode(bodyText).byteLength > maximumBodyBytes) {
    return { ok: false, response: badRequest(requestId, 'Request body is too large.') }
  }

  const body = parseJsonBody(bodyText)
  if (!body) {
    return { ok: false, response: badRequest(requestId, 'Request body contains invalid JSON.') }
  }
  if (body.businessId !== businessId) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const bodyHash = await hashBody(bodyText)
  const url = new URL(request.url)
  const canonicalRequest = [
    request.method.toUpperCase(),
    url.pathname,
    timestampText,
    nonce,
    businessId,
    bodyHash,
  ].join('\n')

  let publishSigningSecret: string
  let expectedSignature: string
  try {
    publishSigningSecret = await getOrCreatePublishSigningSecretBase64(env)
    expectedSignature = await signCanonicalRequest(publishSigningSecret, canonicalRequest)
  } catch (error) {
    console.error('Client Portal publish signing configuration failed:', error)
    return { ok: false, response: serviceUnavailable(requestId, 'Business-publish authentication is unavailable.') }
  }

  if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
    return { ok: false, response: unauthorized(requestId) }
  }

  const nonceClaimed = await claimNonce(env, businessId, nonce, timestampSeconds)
  if (!nonceClaimed) {
    return { ok: false, response: unauthorized(requestId) }
  }

  await ensureBusinessRow(env, businessId)

  return { ok: true, request: { businessId, body } }
}
