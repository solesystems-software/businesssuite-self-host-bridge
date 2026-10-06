import {
  getPlaidWebhookVerificationKey,
  PlaidApiError,
  PlaidConfigurationError,
} from './plaidClient'
import type {
  Env,
  PlaidWebhookVerificationKey,
} from './bankFeedWorkerTypes'

const maximumWebhookAgeSeconds = 5 * 60
const maximumFutureSkewSeconds = 60
const fallbackKeyCacheLifetimeMilliseconds = 60 * 60 * 1000

const verificationKeyCache = new Map<
  string,
  {
    key: CryptoKey
    expiresAtMilliseconds: number
  }
>()

export class PlaidWebhookVerificationError extends Error {}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  let binary: string

  try {
    binary = atob(padded)
  } catch {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification token is not valid base64url.',
    )
  }

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function decodeJsonPart(value: string, label: string) {
  const bytes = decodeBase64Url(value)

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new PlaidWebhookVerificationError(
      `Plaid webhook ${label} is invalid.`,
    )
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

function getCachedKey(keyId: string) {
  const cached = verificationKeyCache.get(keyId)
  if (!cached) return null
  if (cached.expiresAtMilliseconds <= Date.now()) {
    verificationKeyCache.delete(keyId)
    return null
  }
  return cached.key
}

async function importVerificationKey(
  env: Env,
  keyId: string,
): Promise<CryptoKey> {
  const cached = getCachedKey(keyId)
  if (cached) return cached

  let keyResponse
  try {
    keyResponse = await getPlaidWebhookVerificationKey(env, {
      key_id: keyId,
    })
  } catch (error) {
    if (error instanceof PlaidApiError || error instanceof PlaidConfigurationError) {
      console.error('Plaid webhook verification key retrieval failed:', error)
    }
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification key is unavailable.',
    )
  }

  const key = keyResponse.key as PlaidWebhookVerificationKey
  if (
    key.alg !== 'ES256'
    || key.crv !== 'P-256'
    || key.kid !== keyId
    || key.kty !== 'EC'
    || key.use !== 'sig'
    || typeof key.x !== 'string'
    || typeof key.y !== 'string'
  ) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification key is invalid.',
    )
  }

  let importedKey: CryptoKey
  try {
    importedKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification key could not be imported.',
    )
  }

  const providerExpirationMilliseconds = key.expired_at == null
    ? Number.NaN
    : key.expired_at * 1000
  const expiresAtMilliseconds = Number.isFinite(providerExpirationMilliseconds)
    ? providerExpirationMilliseconds
    : Date.now() + fallbackKeyCacheLifetimeMilliseconds

  verificationKeyCache.set(keyId, {
    key: importedKey,
    expiresAtMilliseconds,
  })

  return importedKey
}

export async function verifyPlaidWebhook(
  env: Env,
  rawBody: string,
  verificationToken: string | null,
) {
  if (!verificationToken) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification header is missing.',
    )
  }

  const parts = verificationToken.split('.')
  if (parts.length !== 3 || parts.some(part => !part)) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification token is malformed.',
    )
  }

  const header = decodeJsonPart(parts[0], 'verification header')
  if (header.alg !== 'ES256') {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification algorithm is invalid.',
    )
  }
  const keyId = typeof header.kid === 'string' ? header.kid.trim() : ''
  if (!keyId) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification key id is missing.',
    )
  }

  const key = await importVerificationKey(env, keyId)
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = decodeBase64Url(parts[2])

  let signatureValid = false
  try {
    signatureValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      signingInput,
    )
  } catch {
    signatureValid = false
  }

  if (!signatureValid) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook signature is invalid.',
    )
  }

  const payload = decodeJsonPart(parts[1], 'verification payload')
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : Number.NaN
  const requestBodySha256 = typeof payload.request_body_sha256 === 'string'
    ? payload.request_body_sha256.toLowerCase()
    : ''
  const nowSeconds = Math.floor(Date.now() / 1000)

  if (
    !Number.isFinite(issuedAt)
    || issuedAt < nowSeconds - maximumWebhookAgeSeconds
    || issuedAt > nowSeconds + maximumFutureSkewSeconds
  ) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook verification token is outside the accepted time window.',
    )
  }
  if (!/^[a-f0-9]{64}$/.test(requestBodySha256)) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook body hash is invalid.',
    )
  }

  const bodyDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody)),
  )
  const claimedDigest = new Uint8Array(
    requestBodySha256.match(/.{2}/g)?.map(value => Number.parseInt(value, 16))
      || [],
  )

  if (!constantTimeEqual(bodyDigest, claimedDigest)) {
    throw new PlaidWebhookVerificationError(
      'Plaid webhook body hash does not match.',
    )
  }

  return payload
}
