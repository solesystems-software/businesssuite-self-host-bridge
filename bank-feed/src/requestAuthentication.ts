import {
  badRequest,
  serviceUnavailable,
  unauthorized,
} from './bankFeedWorkerHttp'
import type {
  AuthenticatedJsonRequest,
  Env,
  JsonBody,
} from './bankFeedWorkerTypes'

const textEncoder = new TextEncoder()
const maximumBodyBytes = 16 * 1024
const maximumClockSkewSeconds = 5 * 60
const nonceRetentionSeconds = 10 * 60

type AuthenticationResult =
  | {
      ok: true
      request: AuthenticatedJsonRequest
    }
  | {
      ok: false
      response: Response
    }

function isValidAccountIntegrationId(value: string) {
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

// The bank-feed Worker owns its own request-signing secret (Galen, 2026-09-30): nothing about Bank
// Connections comes from licensing. The secret is self-bootstrapped into this Worker's D1 on first use --
// read the single settings row if it exists; otherwise generate 32 random bytes, insert with
// ON CONFLICT DO NOTHING, then re-read, so a first-request race lands on whichever insert won rather than
// two different secrets. Same pattern as the Client Portal and Payments Workers. The desktop learns the
// secret at deploy time (or by manual entry), never through licensing.
async function getOrCreateRequestSigningSecretBase64(env: Env): Promise<string> {
  const existing = await env.DB
    .prepare(`SELECT request_signing_secret FROM bank_feed_worker_settings WHERE singleton_id = 1`)
    .first<{ request_signing_secret: string }>()
  if (existing) return existing.request_signing_secret

  const generated = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB
    .prepare(`INSERT INTO bank_feed_worker_settings (singleton_id, request_signing_secret) VALUES (1, ?) ON CONFLICT DO NOTHING`)
    .bind(generated)
    .run()

  const row = await env.DB
    .prepare(`SELECT request_signing_secret FROM bank_feed_worker_settings WHERE singleton_id = 1`)
    .first<{ request_signing_secret: string }>()
  if (!row) throw new Error('Bank-feed request signing secret bootstrap failed.')
  return row.request_signing_secret
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
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(bodyText),
  )

  return encodeHex(digest)
}

async function signCanonicalRequest(
  signingSecretBase64: string,
  canonicalRequest: string,
) {
  let signingSecretBytes: Uint8Array

  try {
    signingSecretBytes = decodeBase64(signingSecretBase64)
  } catch {
    throw new Error('The bank-feed request signing secret must be valid Base64.')
  }

  if (signingSecretBytes.byteLength < 32) {
    signingSecretBytes.fill(0)
    throw new Error(
      'The bank-feed request signing secret must contain at least 32 bytes.',
    )
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      signingSecretBytes,
      {
        name: 'HMAC',
        hash: 'SHA-256',
      },
      false,
      ['sign'],
    )

    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      textEncoder.encode(canonicalRequest),
    )

    return encodeBase64Url(signature)
  } finally {
    signingSecretBytes.fill(0)
  }
}

async function claimNonce(
  env: Env,
  accountIntegrationId: string,
  nonce: string,
  timestampSeconds: number,
) {
  const now = new Date()
  const expiresAt = new Date(
    (timestampSeconds + nonceRetentionSeconds) * 1000,
  ).toISOString()
  const createdAt = now.toISOString()

  await env.DB
    .prepare(`
      DELETE FROM bank_feed_request_nonces
      WHERE expires_at <= ?
    `)
    .bind(createdAt)
    .run()

  const result = await env.DB
    .prepare(`
      INSERT OR IGNORE INTO bank_feed_request_nonces (
        account_integration_id,
        nonce,
        request_timestamp_seconds,
        expires_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      accountIntegrationId,
      nonce,
      timestampSeconds,
      expiresAt,
      createdAt,
    )
    .run()

  return result.meta.changes === 1
}

function parseJsonBody(bodyText: string): JsonBody | null {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as JsonBody
  } catch {
    return null
  }
}

export async function authenticateBrokerJsonRequest(
  request: Request,
  env: Env,
  requestId: string,
): Promise<AuthenticationResult> {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: badRequest(requestId, 'Content-Type must be application/json.'),
    }
  }

  const accountIntegrationId = (
    request.headers.get('x-solesystems-account-id') || ''
  ).trim()
  const timestampText = (
    request.headers.get('x-solesystems-timestamp') || ''
  ).trim()
  const nonce = (
    request.headers.get('x-solesystems-nonce') || ''
  ).trim()
  const suppliedSignature = (
    request.headers.get('x-solesystems-signature') || ''
  ).trim()

  if (
    !isValidAccountIntegrationId(accountIntegrationId)
    || !isValidNonce(nonce)
    || !/^\d{10}$/.test(timestampText)
    || !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
  ) {
    return {
      ok: false,
      response: unauthorized(requestId),
    }
  }

  const timestampSeconds = Number(timestampText)
  const currentTimestampSeconds = Math.floor(Date.now() / 1000)

  if (
    !Number.isSafeInteger(timestampSeconds)
    || Math.abs(currentTimestampSeconds - timestampSeconds)
      > maximumClockSkewSeconds
  ) {
    return {
      ok: false,
      response: unauthorized(requestId),
    }
  }

  const bodyText = await request.text()
  if (textEncoder.encode(bodyText).byteLength > maximumBodyBytes) {
    return {
      ok: false,
      response: badRequest(requestId, 'Request body is too large.'),
    }
  }

  const body = parseJsonBody(bodyText)
  if (!body) {
    return {
      ok: false,
      response: badRequest(requestId, 'Request body contains invalid JSON.'),
    }
  }
  if (body.accountIntegrationId !== accountIntegrationId) {
    return {
      ok: false,
      response: unauthorized(requestId),
    }
  }

  const bodyHash = await hashBody(bodyText)
  const url = new URL(request.url)
  const canonicalRequest = [
    request.method.toUpperCase(),
    url.pathname,
    timestampText,
    nonce,
    accountIntegrationId,
    bodyHash,
  ].join('\n')

  let expectedSignature: string
  try {
    expectedSignature = await signCanonicalRequest(
      await getOrCreateRequestSigningSecretBase64(env),
      canonicalRequest,
    )
  } catch (error) {
    console.error('Bank-feed request signing configuration failed:', error)
    return {
      ok: false,
      response: serviceUnavailable(
        requestId,
        'Broker request authentication is unavailable.',
      ),
    }
  }

  if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
    return {
      ok: false,
      response: unauthorized(requestId),
    }
  }

  const nonceClaimed = await claimNonce(
    env,
    accountIntegrationId,
    nonce,
    timestampSeconds,
  )

  if (!nonceClaimed) {
    return {
      ok: false,
      response: unauthorized(requestId),
    }
  }

  return {
    ok: true,
    request: {
      accountIntegrationId,
      body,
    },
  }
}
