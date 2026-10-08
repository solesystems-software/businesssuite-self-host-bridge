import {
  canonicalRequest,
  isIdentifier,
  maximumJsonBodyBytes,
  maximumClockSkewSeconds,
  nonceRetentionSeconds,
  sha256Bytes,
} from './mobileSyncProtocol'
import type {
  AuthenticatedRequest,
  CredentialRole,
  CredentialRow,
  Env,
} from './mobileSyncTypes'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const credentialKeyVersion = 1

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function encodeBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function encodeBase64Url(value: ArrayBuffer): string {
  let encoded = encodeBase64(value).replace(/\+/g, '-').replace(/\//g, '_')
  while (encoded.endsWith('=')) encoded = encoded.slice(0, -1)
  return encoded
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  if (leftBytes.length !== rightBytes.length) return false
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference += Math.abs(leftBytes[index] - rightBytes[index])
  }
  return difference === 0
}

// The credential encryption key is self-bootstrapped into D1 on first use rather than supplied as
// a Worker secret: read the single settings row if it exists; otherwise generate 32 random bytes,
// insert with ON CONFLICT DO NOTHING, then re-read -- so a first-request race lands on whichever
// insert won rather than two different keys, mirroring the same race-safety pattern already used
// by bootstrap() and uploadSnapshot/uploadPacket in mobileSyncWorkerEntry.ts.
async function getOrCreateWorkerEncryptionKeyB64(env: Env): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT credential_encryption_key_b64 FROM mobile_sync_worker_settings WHERE singleton_id = 1'
  ).first<{ credential_encryption_key_b64: string }>()
  if (existing) return existing.credential_encryption_key_b64
  const generated = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB.prepare(
    'INSERT INTO mobile_sync_worker_settings (singleton_id, credential_encryption_key_b64) VALUES (1, ?) ON CONFLICT DO NOTHING'
  ).bind(generated).run()
  const row = await env.DB.prepare(
    'SELECT credential_encryption_key_b64 FROM mobile_sync_worker_settings WHERE singleton_id = 1'
  ).first<{ credential_encryption_key_b64: string }>()
  if (!row) throw new Error('Mobile Sync credential encryption key bootstrap failed.')
  return row.credential_encryption_key_b64
}

// The desktop bootstrap secret lives in the same single settings row and is created the same race-safe
// way: make sure the row exists, set the column only while it is still NULL, then re-read whichever value won.
export async function getOrCreateDesktopBootstrapSecretB64(env: Env): Promise<string> {
  await getOrCreateWorkerEncryptionKeyB64(env)
  const read = () => env.DB.prepare(
    'SELECT desktop_bootstrap_secret_b64 AS secret FROM mobile_sync_worker_settings WHERE singleton_id = 1'
  ).first<{ secret: string | null }>()
  const existing = await read()
  if (existing?.secret) return existing.secret
  const generated = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB.prepare(
    'UPDATE mobile_sync_worker_settings SET desktop_bootstrap_secret_b64 = ? WHERE singleton_id = 1 AND desktop_bootstrap_secret_b64 IS NULL'
  ).bind(generated).run()
  const row = await read()
  if (!row?.secret) throw new Error('Mobile Sync desktop bootstrap secret bootstrap failed.')
  return row.secret
}

async function importEncryptionKey(env: Env, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const bytes = decodeBase64(await getOrCreateWorkerEncryptionKeyB64(env))
  if (bytes.byteLength !== 32) throw new Error('Mobile Sync credential encryption key is invalid.')
  try {
    return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage])
  } finally {
    bytes.fill(0)
  }
}

function credentialAdditionalData(input: {
  credentialId: string
  accountSyncId: string
  identityId: string
  role: CredentialRole
}): Uint8Array {
  return textEncoder.encode(JSON.stringify([
    'businesssuite-mobile-sync-credential',
    credentialKeyVersion,
    input.role,
    input.credentialId,
    input.accountSyncId,
    input.identityId,
  ]))
}

export async function encryptCredentialSecret(env: Env, input: {
  secretBase64: string
  credentialId: string
  accountSyncId: string
  identityId: string
  role: CredentialRole
}): Promise<{ encryptedSecret: string; secretIv: string; secretKeyVersion: number }> {
  const key = await importEncryptionKey(env, 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: credentialAdditionalData(input),
    tagLength: 128,
  }, key, textEncoder.encode(input.secretBase64))
  return {
    encryptedSecret: encodeBase64(encrypted),
    secretIv: encodeBase64(iv),
    secretKeyVersion: credentialKeyVersion,
  }
}

async function decryptCredentialSecret(env: Env, input: CredentialRow & { role: CredentialRole }): Promise<string> {
  if (input.secret_key_version !== credentialKeyVersion) throw new Error('Unsupported credential key version.')
  const key = await importEncryptionKey(env, 'decrypt')
  const encrypted = decodeBase64(input.encrypted_secret)
  const iv = decodeBase64(input.secret_iv)
  try {
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: credentialAdditionalData({
        credentialId: input.credential_id,
        accountSyncId: input.account_sync_id,
        identityId: input.identity_id,
        role: input.role,
      }),
      tagLength: 128,
    }, key, encrypted)
    return textDecoder.decode(decrypted)
  } finally {
    encrypted.fill(0)
    iv.fill(0)
  }
}

export function createCredentialSecret(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
}

export async function signCanonicalRequest(secretBase64: string, canonical: string): Promise<string> {
  const bytes = decodeBase64(secretBase64)
  if (bytes.byteLength !== 32) throw new Error('Credential secret is invalid.')
  try {
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return encodeBase64Url(await crypto.subtle.sign('HMAC', key, textEncoder.encode(canonical)))
  } finally {
    bytes.fill(0)
  }
}

async function getCredential(env: Env, role: CredentialRole, credentialId: string): Promise<CredentialRow | null> {
  if (role === 'desktop') {
    return env.DB.prepare(`
      SELECT credential_id, account_sync_id, desktop_client_id AS identity_id,
        NULL AS user_id, encrypted_secret, secret_iv, secret_key_version,
        expires_at, revoked_at
      FROM mobile_sync_desktop_clients WHERE credential_id = ? LIMIT 1
    `).bind(credentialId).first<CredentialRow>()
  }
  return env.DB.prepare(`
    SELECT credential_id, account_sync_id, device_id AS identity_id,
      user_id, encrypted_secret, secret_iv, secret_key_version,
      expires_at, revoked_at
    FROM mobile_sync_devices WHERE credential_id = ? LIMIT 1
  `).bind(credentialId).first<CredentialRow>()
}

export type AuthenticationResult =
  | { ok: true; authenticated: AuthenticatedRequest; bodyText: string; bodyBytes: Uint8Array }
  | { ok: false; status: number; code: string }

export async function authenticateRequest(
  request: Request,
  env: Env,
  role: CredentialRole,
  maximumBodyBytes = maximumJsonBodyBytes,
): Promise<AuthenticationResult> {
  const accountSyncId = (request.headers.get('x-solesystems-account-id') || '').trim()
  const credentialId = (request.headers.get('x-solesystems-credential-id') || '').trim()
  const identityId = (request.headers.get(role === 'desktop' ? 'x-solesystems-desktop-client-id' : 'x-solesystems-device-id') || '').trim()
  const timestamp = (request.headers.get('x-solesystems-timestamp') || '').trim()
  const nonce = (request.headers.get('x-solesystems-nonce') || '').trim()
  const signature = (request.headers.get('x-solesystems-signature') || '').trim()
  if (!isIdentifier(accountSyncId) || !isIdentifier(credentialId, 8, 200) || !isIdentifier(identityId)
    || !/^\d{10}$/.test(timestamp) || !isIdentifier(nonce, 16, 128) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return { ok: false, status: 401, code: 'authentication_failed' }
  }
  const timestampSeconds = Number(timestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > maximumClockSkewSeconds) {
    return { ok: false, status: 401, code: 'timestamp_invalid' }
  }
  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    return { ok: false, status: 413, code: 'body_too_large' }
  }
  const bodyBytes = new Uint8Array(await request.arrayBuffer())
  if (bodyBytes.byteLength > maximumBodyBytes) return { ok: false, status: 413, code: 'body_too_large' }
  const bodyText = textDecoder.decode(bodyBytes)
  const row = await getCredential(env, role, credentialId)
  // A recognised credential for this exact identity that was explicitly revoked
  // (device removed on the desktop) reports a distinct code so the mobile client
  // can unpair itself instead of retrying a dead credential forever.
  if (row && row.account_sync_id === accountSyncId && row.identity_id === identityId && row.revoked_at) {
    return { ok: false, status: 401, code: 'credential_revoked' }
  }
  if (!row || row.account_sync_id !== accountSyncId || row.identity_id !== identityId || row.revoked_at
    || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, status: 401, code: 'authentication_failed' }
  }
  const bodyHash = await sha256Bytes(bodyBytes)
  const canonical = canonicalRequest({
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp,
    nonce,
    accountSyncId,
    credentialId,
    identityId,
    bodyHash,
  })
  let expected: string
  try {
    expected = await signCanonicalRequest(await decryptCredentialSecret(env, { ...row, role }), canonical)
  } catch {
    return { ok: false, status: 503, code: 'authentication_unavailable' }
  }
  if (!constantTimeEqual(expected, signature)) return { ok: false, status: 401, code: 'authentication_failed' }

  const now = new Date().toISOString()
  const expiresAt = new Date((timestampSeconds + nonceRetentionSeconds) * 1000).toISOString()
  await env.DB.prepare('DELETE FROM mobile_sync_nonce_claims WHERE expires_at <= ?').bind(now).run()
  const nonceResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO mobile_sync_nonce_claims
      (credential_id, nonce, request_timestamp_seconds, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(credentialId, nonce, timestampSeconds, expiresAt, now).run()
  if (nonceResult.meta.changes !== 1) return { ok: false, status: 401, code: 'nonce_reused' }

  const table = role === 'desktop' ? 'mobile_sync_desktop_clients' : 'mobile_sync_devices'
  await env.DB.prepare(`UPDATE ${table} SET last_used_at = ? WHERE credential_id = ?`).bind(now, credentialId).run()
  return {
    ok: true,
    authenticated: { accountSyncId, credentialId, identityId, role, ...(row.user_id ? { userId: row.user_id } : {}) },
    bodyText,
    bodyBytes,
  }
}

export async function applyRateLimit(env: Env, authenticated: AuthenticatedRequest, endpoint: string): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const windowStarted = nowSeconds - (nowSeconds % 60)
  const rateKey = `${authenticated.accountSyncId}:${authenticated.credentialId}:${endpoint}`
  await env.DB.prepare('DELETE FROM mobile_sync_rate_limits WHERE window_started_at_seconds < ?')
    .bind(windowStarted - 120).run()
  await env.DB.prepare(`
    INSERT INTO mobile_sync_rate_limits (rate_key, window_started_at_seconds, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT (rate_key, window_started_at_seconds)
    DO UPDATE SET request_count = request_count + 1
  `).bind(rateKey, windowStarted).run()
  const row = await env.DB.prepare(`
    SELECT request_count FROM mobile_sync_rate_limits
    WHERE rate_key = ? AND window_started_at_seconds = ?
  `).bind(rateKey, windowStarted).first<{ request_count: number }>()
  return Boolean(row && row.request_count <= 30)
}
