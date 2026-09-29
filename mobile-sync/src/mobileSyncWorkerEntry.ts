import { isIdentifier, isSha256, maximumMediaBodyBytes, parsePacketEnvelope, sha256, sha256Bytes, stableStringify } from './mobileSyncProtocol'
import { applyRateLimit, authenticateRequest, createCredentialSecret, encryptCredentialSecret } from './mobileSyncSecurity'
import type { AuthenticatedRequest, Env, PacketEnvelopeV1 } from './mobileSyncTypes'

export { AccountSyncChannel } from './accountSyncChannel'

const headers = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' }
const response = (body: unknown, status = 200, requestId?: string) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, ...(requestId ? { 'x-request-id': requestId } : {}) },
})
const object = (text: string): Record<string, unknown> | null => {
  try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null }
}
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''

function diagnostic(requestId: string, endpoint: string, started: number, status: number, auth?: AuthenticatedRequest, category?: string) {
  console.log(JSON.stringify({ event: 'mobile_sync_request', request_id: requestId, endpoint,
    timestamp: new Date().toISOString(), account_sync_id: auth?.accountSyncId,
    credential_id: auth?.credentialId, identity_id: auth?.identityId,
    protocol_version: 1, status, category, latency_ms: Date.now() - started }))
}

async function secured(input: {
  request: Request; env: Env; role: 'desktop' | 'mobile'; endpoint: string
  requestId: string; started: number
  maximumBodyBytes?: number
  ctx?: ExecutionContext
  handler: (auth: AuthenticatedRequest, body: string, bodyBytes: Uint8Array, ctx?: ExecutionContext) => Promise<Response>
}) {
  const result = await authenticateRequest(input.request, input.env, input.role, input.maximumBodyBytes)
  if (!result.ok) {
    diagnostic(input.requestId, input.endpoint, input.started, result.status, undefined, result.code)
    return response({ ok: false, error: result.code }, result.status, input.requestId)
  }
  if (!await applyRateLimit(input.env, result.authenticated, input.endpoint)) {
    diagnostic(input.requestId, input.endpoint, input.started, 429, result.authenticated, 'rate_limited')
    return response({ ok: false, error: 'rate_limited' }, 429, input.requestId)
  }
  const resultResponse = await input.handler(result.authenticated, result.bodyText, result.bodyBytes, input.ctx)
  diagnostic(input.requestId, input.endpoint, input.started, resultResponse.status, result.authenticated)
  return resultResponse
}

async function bootstrap(request: Request, env: Env, requestId: string) {
  // Dev-only endpoint (404 anywhere else). A bootstrap secret is OPTIONAL in
  // development: when MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET is set it must match,
  // but a dev Worker with no secret configured accepts any request so the desktop
  // can provision itself with zero operator steps. Production never reaches here.
  if (env.SERVICE_ENVIRONMENT !== 'development') return response({ ok: false, error: 'not_found' }, 404, requestId)
  const configured = env.MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET || ''
  if (configured) {
    const supplied = request.headers.get('x-solesystems-bootstrap-secret') || ''
    if (!supplied || await sha256(configured) !== await sha256(supplied)) {
      return response({ ok: false, error: 'authentication_failed' }, 401, requestId)
    }
  }
  const body = object(await request.text())
  const account = clean(body?.account_sync_id)
  const client = clean(body?.desktop_client_id)
  if (!isIdentifier(account) || !isIdentifier(client)) return response({ ok: false, error: 'invalid_request' }, 400, requestId)
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 86400000).toISOString()
  const credential = `desktop-${crypto.randomUUID()}`
  const secret = createCredentialSecret()
  const encrypted = await encryptCredentialSecret(env, { secretBase64: secret, credentialId: credential,
    accountSyncId: account, identityId: client, role: 'desktop' })
  await env.DB.prepare('INSERT INTO mobile_sync_accounts (account_sync_id, created_at, disabled_at) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING').bind(account, now).run()
  await env.DB.prepare(`INSERT INTO mobile_sync_desktop_clients
    (credential_id, account_sync_id, desktop_client_id, encrypted_secret, secret_iv, secret_key_version, issued_at, expires_at, revoked_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).bind(credential, account, client,
      encrypted.encryptedSecret, encrypted.secretIv, encrypted.secretKeyVersion, now, expires).run()
  return response({ ok: true, account_sync_id: account, desktop_client_id: client,
    credential_id: credential, credential_secret_base64: secret, expires_at: expires }, 201, requestId)
}

async function createPairing(bodyText: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const body = object(bodyText)
  const user = clean(body?.user_id)
  const intended = clean(body?.intended_device_id) || null
  const lifetime = Number(body?.expires_in_seconds ?? 300)
  if (!isIdentifier(user) || (intended && !isIdentifier(intended)) || !Number.isSafeInteger(lifetime) || lifetime < 30 || lifetime > 600) {
    return response({ ok: false, error: 'invalid_request' }, 400, requestId)
  }
  const id = `pair-${crypto.randomUUID()}`
  const token = createCredentialSecret()
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + lifetime * 1000).toISOString()
  await env.DB.prepare(`INSERT INTO mobile_sync_pairing_sessions
    (session_id, account_sync_id, user_id, intended_device_id, pairing_token_hash, created_by_credential_id, created_at, expires_at, claimed_at, claimed_device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).bind(id, auth.accountSyncId, user, intended,
      await sha256(token), auth.credentialId, now, expires).run()
  return response({ ok: true, session_id: id, pairing_token: token, expires_at: expires }, 201, requestId)
}

async function claimPairing(request: Request, env: Env, requestId: string) {
  const body = object(await request.text())
  const token = clean(body?.pairing_token)
  const account = clean(body?.account_sync_id)
  const device = clean(body?.device_id)
  if (!token || !isIdentifier(account) || !isIdentifier(device)) return response({ ok: false, error: 'pairing_invalid' }, 401, requestId)
  const row = await env.DB.prepare(`SELECT session_id, account_sync_id, user_id, intended_device_id, expires_at, claimed_at
    FROM mobile_sync_pairing_sessions WHERE pairing_token_hash = ? LIMIT 1`).bind(await sha256(token)).first<{
      session_id: string; account_sync_id: string; user_id: string; intended_device_id: string | null; expires_at: string; claimed_at: string | null
    }>()
  if (!row || row.account_sync_id !== account || row.claimed_at || Date.parse(row.expires_at) <= Date.now()
    || (row.intended_device_id && row.intended_device_id !== device)) return response({ ok: false, error: 'pairing_invalid' }, 401, requestId)
  const now = new Date().toISOString()
  const credential = `mobile-${crypto.randomUUID()}`
  const secret = createCredentialSecret()
  const expires = new Date(Date.now() + 2592000000).toISOString()
  const encrypted = await encryptCredentialSecret(env, { secretBase64: secret, credentialId: credential,
    accountSyncId: account, identityId: device, role: 'mobile' })
  // One atomic batch: claim the session, then provision the device credential only if
  // that claim landed (the INSERT's WHERE EXISTS re-checks it). A previously-revoked
  // row for the same (account, device) is replaced and un-revoked via ON CONFLICT, so
  // a device removed on the desktop stays re-pairable. If the batch fails, nothing
  // commits — the session is not burned.
  const [claimResult] = await env.DB.batch([
    env.DB.prepare(`UPDATE mobile_sync_pairing_sessions SET claimed_at = ?, claimed_device_id = ?
      WHERE session_id = ? AND claimed_at IS NULL AND expires_at > ?`).bind(now, device, row.session_id, now),
    env.DB.prepare(`INSERT INTO mobile_sync_devices
      (credential_id, account_sync_id, device_id, user_id, encrypted_secret, secret_iv, secret_key_version, issued_at, expires_at, revoked_at, last_used_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL
      WHERE EXISTS (SELECT 1 FROM mobile_sync_pairing_sessions
        WHERE session_id = ? AND claimed_device_id = ? AND claimed_at = ?)
      ON CONFLICT (account_sync_id, device_id) DO UPDATE SET
        credential_id = excluded.credential_id, user_id = excluded.user_id,
        encrypted_secret = excluded.encrypted_secret, secret_iv = excluded.secret_iv,
        secret_key_version = excluded.secret_key_version, issued_at = excluded.issued_at,
        expires_at = excluded.expires_at, revoked_at = NULL, last_used_at = NULL`)
      .bind(credential, account, device, row.user_id, encrypted.encryptedSecret, encrypted.secretIv,
        encrypted.secretKeyVersion, now, expires, row.session_id, device, now),
  ])
  if (claimResult.meta.changes !== 1) return response({ ok: false, error: 'pairing_invalid' }, 401, requestId)
  return response({ ok: true, account_sync_id: account, device_id: device, user_id: row.user_id,
    credential_id: credential, credential_secret_base64: secret, expires_at: expires }, 201, requestId)
}

async function uploadSnapshot(bodyText: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const body = object(bodyText)
  const id = clean(body?.snapshot_id)
  const version = Number(body?.snapshot_version)
  const generated = clean(body?.generated_at)
  const hash = clean(body?.payload_hash)
  if (!body || !isIdentifier(id) || !Number.isSafeInteger(version) || version < 1 || !Number.isFinite(Date.parse(generated))
    || !isSha256(hash) || !Object.hasOwn(body, 'payload')) return response({ ok: false, error: 'invalid_snapshot' }, 400, requestId)
  const payload = stableStringify(body.payload)
  if (await sha256(payload) !== hash) return response({ ok: false, error: 'hash_mismatch' }, 400, requestId)
  const existing = await env.DB.prepare('SELECT payload_hash, snapshot_version FROM mobile_sync_snapshots WHERE account_sync_id = ? AND snapshot_id = ?')
    .bind(auth.accountSyncId, id).first<{ payload_hash: string; snapshot_version: number }>()
  if (existing) return existing.payload_hash === hash && existing.snapshot_version === version
    ? response({ ok: true, snapshot_id: id, snapshot_version: version, duplicate: true })
    : response({ ok: false, error: 'snapshot_conflict' }, 409, requestId)
  // The uploader (desktop) can be behind the Worker — e.g. its local bookkeeping was reset
  // to a baseline while the Worker kept the older snapshots it published earlier. Reject the
  // stale version cleanly and report the current server version so the desktop can adopt it
  // and publish the next one, instead of retrying the same version until the UNIQUE
  // (account_sync_id, snapshot_version) constraint throws and surfaces as a 500.
  const head = await env.DB.prepare('SELECT MAX(snapshot_version) AS current FROM mobile_sync_snapshots WHERE account_sync_id = ?')
    .bind(auth.accountSyncId).first<{ current: number | null }>()
  const serverVersion = head?.current ?? 0
  if (version <= serverVersion) return response({ ok: false, error: 'snapshot_version_behind', server_version: serverVersion }, 409, requestId)
  const key = `snapshots/${auth.accountSyncId}/${id}.json`
  await env.PAYLOADS.put(key, payload, { httpMetadata: { contentType: 'application/json' } })
  try {
    await env.DB.prepare(`INSERT INTO mobile_sync_snapshots
      (snapshot_id, account_sync_id, snapshot_version, payload_object_key, payload_hash, uploaded_by_credential_id, created_at, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, auth.accountSyncId, version, key, hash, auth.credentialId, generated, new Date().toISOString()).run()
  } catch (error) {
    // Lost a race for this version (or the constraint fired for another reason) — never a 500.
    await env.PAYLOADS.delete(key)
    const raced = await env.DB.prepare('SELECT MAX(snapshot_version) AS current FROM mobile_sync_snapshots WHERE account_sync_id = ?')
      .bind(auth.accountSyncId).first<{ current: number | null }>()
    return response({ ok: false, error: 'snapshot_version_behind', server_version: raced?.current ?? serverVersion }, 409, requestId)
  }
  return response({ ok: true, snapshot_id: id, snapshot_version: version, payload_hash: hash }, 201, requestId)
}

async function snapshotHead(auth: AuthenticatedRequest, env: Env, requestId: string) {
  const head = await env.DB.prepare('SELECT MAX(snapshot_version) AS current FROM mobile_sync_snapshots WHERE account_sync_id = ?')
    .bind(auth.accountSyncId).first<{ current: number | null }>()
  return response({ ok: true, server_version: head?.current ?? 0 }, 200, requestId)
}

async function latestSnapshot(auth: AuthenticatedRequest, env: Env, requestId: string) {
  const row = await env.DB.prepare(`SELECT snapshot_id, snapshot_version, payload_object_key, payload_hash, created_at
    FROM mobile_sync_snapshots WHERE account_sync_id = ? ORDER BY snapshot_version DESC LIMIT 1`)
    .bind(auth.accountSyncId).first<{ snapshot_id: string; snapshot_version: number; payload_object_key: string; payload_hash: string; created_at: string }>()
  if (!row) return response({ ok: false, error: 'snapshot_not_found' }, 404, requestId)
  const stored = await env.PAYLOADS.get(row.payload_object_key)
  if (!stored) return response({ ok: false, error: 'snapshot_unavailable' }, 503, requestId)
  const payload = await stored.text()
  if (await sha256(payload) !== row.payload_hash) return response({ ok: false, error: 'snapshot_corrupt' }, 503, requestId)
  return response({ ok: true, snapshot_id: row.snapshot_id, snapshot_version: row.snapshot_version,
    generated_at: row.created_at, payload_hash: row.payload_hash, payload: JSON.parse(payload) })
}

async function allocateSequence(env: Env, account: string) {
  const row = await env.DB.prepare(`INSERT INTO mobile_sync_account_sequence (account_sync_id, next_sequence) VALUES (?, 2)
    ON CONFLICT (account_sync_id) DO UPDATE SET next_sequence = next_sequence + 1
    RETURNING next_sequence - 1 AS sequence`).bind(account).first<{ sequence: number }>()
  if (!row) throw new Error('Sequence allocation failed.')
  return row.sequence
}

async function uploadPacket(bodyText: string, auth: AuthenticatedRequest, env: Env, requestId: string, ctx?: ExecutionContext) {
  const packet = parsePacketEnvelope(object(bodyText))
  if (!packet || packet.account_sync_id !== auth.accountSyncId || packet.device_id !== auth.identityId || packet.user_id !== auth.userId) {
    return response({ ok: false, error: 'invalid_packet' }, 400, requestId)
  }
  if (await sha256(stableStringify(packet.payload)) !== packet.payload_hash) return response({ ok: false, error: 'hash_mismatch' }, 400, requestId)
  const existing = await env.DB.prepare(`SELECT packet_id, payload_hash, server_sequence, status FROM mobile_sync_packets
    WHERE account_sync_id = ? AND (packet_id = ? OR idempotency_key = ?) LIMIT 1`)
    .bind(auth.accountSyncId, packet.packet_id, packet.idempotency_key)
    .first<{ packet_id: string; payload_hash: string; server_sequence: number; status: string }>()
  if (existing) return existing.packet_id === packet.packet_id && existing.payload_hash === packet.payload_hash
    ? response({ ok: true, packet_id: existing.packet_id, server_sequence: existing.server_sequence, status: existing.status, duplicate: true })
    : response({ ok: false, error: 'idempotency_conflict' }, 409, requestId)
  const key = `packets/${auth.accountSyncId}/${packet.device_id}/${packet.packet_id}.json`
  await env.PAYLOADS.put(key, stableStringify(packet), { httpMetadata: { contentType: 'application/json' } })
  const sequence = await allocateSequence(env, auth.accountSyncId)
  try {
    await env.DB.prepare(`INSERT INTO mobile_sync_packets
      (packet_id, account_sync_id, device_id, user_id, packet_type, protocol_version, client_sequence, server_sequence,
       snapshot_version_seen, entity_id, entity_revision_seen, idempotency_key, payload_object_key, payload_hash, created_at, uploaded_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_desktop')`).bind(
      packet.packet_id, packet.account_sync_id, packet.device_id, packet.user_id, packet.packet_type, packet.protocol_version,
      packet.client_sequence, sequence, packet.snapshot_version_seen, packet.entity_id, packet.entity_revision_seen,
      packet.idempotency_key, key, packet.payload_hash, packet.created_at, new Date().toISOString()).run()
  } catch (error) { await env.PAYLOADS.delete(key); throw error }
  notifyAccountChannel(env, ctx, packet.account_sync_id, sequence)
  return response({ ok: true, packet_id: packet.packet_id, server_sequence: sequence, status: 'pending_desktop', duplicate: false }, 201, requestId)
}

// Best-effort poke to the account's live channel so a connected desktop pulls
// immediately. The packet row is already committed; a failed or absent poke
// only costs latency (the desktop still catches up on reconnect / account-open).
function notifyAccountChannel(env: Env, ctx: ExecutionContext | undefined, accountSyncId: string, serverSequence: number) {
  const poke = (async () => {
    try {
      const id = env.ACCOUNT_SYNC_CHANNEL.idFromName(accountSyncId)
      await env.ACCOUNT_SYNC_CHANNEL.get(id).fetch('https://account-sync-channel/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server_sequence: serverSequence }),
      })
    } catch {
      // channel eviction race / no listeners — ignore
    }
  })()
  if (ctx) ctx.waitUntil(poke)
}

async function loadPacket(env: Env, key: string): Promise<PacketEnvelopeV1 | null> {
  const stored = await env.PAYLOADS.get(key)
  return stored ? parsePacketEnvelope(JSON.parse(await stored.text())) : null
}

type MediaManifest = {
  media_id: string
  record_id: string
  page_id: string
  receipt_id?: never
  original_file_name: string
  stored_file_name: string
  mime_type: 'image/jpeg'
  byte_size: number
  sha256: string
  page_count?: never
} | {
  media_id: string
  record_id: string
  receipt_id: string
  page_id?: never
  original_file_name: string
  stored_file_name: string
  mime_type: 'application/pdf'
  byte_size: number
  sha256: string
  page_count: number
}

function parseMediaManifest(value: unknown): MediaManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const media = value as Record<string, unknown>
  const noteManifest = media.mime_type === 'image/jpeg' && isIdentifier(media.page_id, 1) && !Object.hasOwn(media, 'receipt_id')
  const receiptManifest = media.mime_type === 'application/pdf' && isIdentifier(media.receipt_id, 3)
    && media.receipt_id === media.media_id && !Object.hasOwn(media, 'page_id')
    && Number.isSafeInteger(media.page_count) && Number(media.page_count) >= 1 && Number(media.page_count) <= 100
  if (!isIdentifier(media.media_id) || !isIdentifier(media.record_id, 1) || (!noteManifest && !receiptManifest)
    || typeof media.original_file_name !== 'string' || media.original_file_name.length < 1 || media.original_file_name.length > 200
    || typeof media.stored_file_name !== 'string' || media.stored_file_name.length < 1 || media.stored_file_name.length > 200
    || !Number.isSafeInteger(media.byte_size)
    || Number(media.byte_size) < 1 || Number(media.byte_size) > maximumMediaBodyBytes || !isSha256(media.sha256)
    || Object.hasOwn(media, 'local_uri') || Object.hasOwn(media, 'relative_path')) return null
  return media as MediaManifest
}

async function packetAndManifest(env: Env, auth: AuthenticatedRequest, packetId: string, mediaId: string) {
  const row = await env.DB.prepare(`SELECT packet_id, account_sync_id, device_id, payload_object_key
    FROM mobile_sync_packets WHERE packet_id = ? AND account_sync_id = ? LIMIT 1`)
    .bind(packetId, auth.accountSyncId).first<{ packet_id: string; account_sync_id: string; device_id: string; payload_object_key: string }>()
  if (!row || (auth.role === 'mobile' && row.device_id !== auth.identityId)) return null
  const packet = await loadPacket(env, row.payload_object_key)
  if (!packet) return null
  const manifests = packet.attachments.map(parseMediaManifest)
  if (manifests.some(item => !item)) return null
  const manifest = manifests.find(item => item?.media_id === mediaId) || null
  return manifest ? { row, manifest } : null
}

async function uploadMedia(packetId: string, mediaId: string, bytes: Uint8Array, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const related = await packetAndManifest(env, auth, packetId, mediaId)
  if (!related) return response({ ok: false, error: 'media_not_declared' }, 404, requestId)
  const { manifest } = related
  if (bytes.byteLength !== manifest.byte_size) return response({ ok: false, error: 'media_size_mismatch' }, 400, requestId)
  if (await sha256Bytes(bytes) !== manifest.sha256) return response({ ok: false, error: 'media_hash_mismatch' }, 400, requestId)
  const existing = await env.DB.prepare(`SELECT packet_id, device_id, payload_hash, mime_type, byte_size, payload_object_key, deleted_at
    FROM mobile_sync_packet_media_objects WHERE media_id = ? AND account_sync_id = ? AND packet_id = ? LIMIT 1`).bind(mediaId, auth.accountSyncId, packetId)
    .first<{ packet_id: string; device_id: string | null; payload_hash: string; mime_type: string | null; byte_size: number | null; payload_object_key: string; deleted_at: string | null }>()
  if (existing) {
    const matches = existing.device_id === auth.identityId
      && existing.payload_hash === manifest.sha256 && existing.mime_type === manifest.mime_type
      && existing.byte_size === manifest.byte_size && !existing.deleted_at
    return matches
      ? response({ ok: true, packet_id: packetId, media_id: mediaId, payload_hash: manifest.sha256, duplicate: true })
      : response({ ok: false, error: 'media_conflict' }, 409, requestId)
  }
  const extension = manifest.mime_type === 'application/pdf' ? 'pdf' : 'jpg'
  const key = `media/${auth.accountSyncId}/${packetId}/${mediaId}.${extension}`
  await env.PAYLOADS.put(key, bytes, {
    httpMetadata: { contentType: manifest.mime_type },
    customMetadata: { account_sync_id: auth.accountSyncId, packet_id: packetId, media_id: mediaId, sha256: manifest.sha256 },
  })
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(`INSERT INTO mobile_sync_packet_media_objects
      (account_sync_id, packet_id, media_id, device_id, payload_object_key, payload_hash, mime_type, byte_size, created_at, uploaded_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(auth.accountSyncId, packetId, mediaId, auth.identityId, key,
        manifest.sha256, manifest.mime_type, manifest.byte_size, now, now).run()
  } catch (error) { await env.PAYLOADS.delete(key); throw error }
  return response({ ok: true, packet_id: packetId, media_id: mediaId, payload_hash: manifest.sha256, duplicate: false }, 201, requestId)
}

async function downloadMedia(packetId: string, mediaId: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const related = await packetAndManifest(env, auth, packetId, mediaId)
  if (!related) return response({ ok: false, error: 'media_not_found' }, 404, requestId)
  const row = await env.DB.prepare(`SELECT payload_object_key, payload_hash, mime_type, byte_size, deleted_at
    FROM mobile_sync_packet_media_objects WHERE media_id = ? AND account_sync_id = ? AND packet_id = ? LIMIT 1`)
    .bind(mediaId, auth.accountSyncId, packetId)
    .first<{ payload_object_key: string; payload_hash: string; mime_type: string | null; byte_size: number | null; deleted_at: string | null }>()
  if (!row || row.deleted_at) return response({ ok: false, error: 'media_not_found' }, 404, requestId)
  const stored = await env.PAYLOADS.get(row.payload_object_key)
  if (!stored) return response({ ok: false, error: 'media_unavailable' }, 503, requestId)
  const bytes = new Uint8Array(await stored.arrayBuffer())
  if (bytes.byteLength !== row.byte_size || await sha256Bytes(bytes) !== row.payload_hash) {
    return response({ ok: false, error: 'media_corrupt' }, 503, requestId)
  }
  return new Response(bytes, { status: 200, headers: {
    'cache-control': 'no-store', 'content-type': row.mime_type || 'application/octet-stream',
    'content-length': String(bytes.byteLength), 'x-content-type-options': 'nosniff',
    'x-solesystems-media-sha256': row.payload_hash, 'x-solesystems-media-id': mediaId,
    'x-request-id': requestId,
  } })
}

// --- Desktop -> mobile binary media (snapshot media) -------------------------
// One generic, type-agnostic, account-scoped blob store. The desktop owns the
// truth: it uploads each media object's bytes once, keyed by a stable id (a Note
// attachment id, or a receipt id). The phone downloads them on demand after a
// snapshot so desktop-authored Note images, webpage captures, and receipt PDFs
// render on the phone exactly as on the desktop.

const snapshotMediaMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])

function snapshotMediaKey(accountSyncId: string, mediaId: string) {
  return `snapshot-media/${accountSyncId}/${mediaId}`
}

// The desktop asks "which of these media ids do you already have, and at what
// hash?" before a snapshot so it only uploads what changed. Batched.
async function snapshotMediaManifest(bodyText: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const body = object(bodyText)
  const raw = body?.media_ids
  const ids = Array.isArray(raw) ? raw as unknown[] : null
  if (!ids || ids.length > 500 || !ids.every(id => isIdentifier(id))) {
    return response({ ok: false, error: 'invalid_request' }, 400, requestId)
  }
  const present: Record<string, { sha256: string; byte_size: number }> = {}
  for (let start = 0; start < ids.length; start += 100) {
    const chunk = ids.slice(start, start + 100) as string[]
    const rows = await env.DB.prepare(`SELECT media_id, sha256, byte_size FROM mobile_sync_snapshot_media
      WHERE account_sync_id = ? AND media_id IN (${chunk.map(() => '?').join(',')})`)
      .bind(auth.accountSyncId, ...chunk).all<{ media_id: string; sha256: string; byte_size: number }>()
    for (const row of rows.results) present[row.media_id] = { sha256: row.sha256, byte_size: row.byte_size }
  }
  return response({ ok: true, present }, 200, requestId)
}

async function uploadSnapshotMedia(mediaId: string, bytes: Uint8Array, request: Request, auth: AuthenticatedRequest, env: Env, requestId: string) {
  if (!isIdentifier(mediaId)) return response({ ok: false, error: 'invalid_media_id' }, 400, requestId)
  const declaredHash = (request.headers.get('x-solesystems-snapshot-media-sha256') || '').trim()
  const mimeType = (request.headers.get('x-solesystems-snapshot-media-mime') || '').trim().toLowerCase()
  if (!isSha256(declaredHash) || !snapshotMediaMimeTypes.has(mimeType)) {
    return response({ ok: false, error: 'invalid_media_headers' }, 400, requestId)
  }
  if (bytes.byteLength < 1 || bytes.byteLength > maximumMediaBodyBytes) {
    return response({ ok: false, error: 'media_size_invalid' }, 400, requestId)
  }
  if (await sha256Bytes(bytes) !== declaredHash) return response({ ok: false, error: 'media_hash_mismatch' }, 400, requestId)
  const existing = await env.DB.prepare(`SELECT sha256 FROM mobile_sync_snapshot_media
    WHERE account_sync_id = ? AND media_id = ? LIMIT 1`).bind(auth.accountSyncId, mediaId).first<{ sha256: string }>()
  if (existing?.sha256 === declaredHash) {
    return response({ ok: true, media_id: mediaId, sha256: declaredHash, duplicate: true }, 200, requestId)
  }
  const key = snapshotMediaKey(auth.accountSyncId, mediaId)
  await env.PAYLOADS.put(key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { account_sync_id: auth.accountSyncId, media_id: mediaId, sha256: declaredHash },
  })
  const now = new Date().toISOString()
  await env.DB.prepare(`INSERT INTO mobile_sync_snapshot_media
    (account_sync_id, media_id, sha256, byte_size, mime_type, payload_object_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_sync_id, media_id) DO UPDATE SET
      sha256 = excluded.sha256, byte_size = excluded.byte_size, mime_type = excluded.mime_type,
      payload_object_key = excluded.payload_object_key, updated_at = excluded.updated_at`)
    .bind(auth.accountSyncId, mediaId, declaredHash, bytes.byteLength, mimeType, key, now, now).run()
  return response({ ok: true, media_id: mediaId, sha256: declaredHash, duplicate: false }, 201, requestId)
}

async function downloadSnapshotMedia(mediaId: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  if (!isIdentifier(mediaId)) return response({ ok: false, error: 'invalid_media_id' }, 400, requestId)
  const row = await env.DB.prepare(`SELECT payload_object_key, sha256, byte_size, mime_type
    FROM mobile_sync_snapshot_media WHERE account_sync_id = ? AND media_id = ? LIMIT 1`)
    .bind(auth.accountSyncId, mediaId)
    .first<{ payload_object_key: string; sha256: string; byte_size: number; mime_type: string }>()
  if (!row) return response({ ok: false, error: 'media_not_found' }, 404, requestId)
  const stored = await env.PAYLOADS.get(row.payload_object_key)
  if (!stored) return response({ ok: false, error: 'media_unavailable' }, 503, requestId)
  const bytes = new Uint8Array(await stored.arrayBuffer())
  if (bytes.byteLength !== row.byte_size || await sha256Bytes(bytes) !== row.sha256) {
    return response({ ok: false, error: 'media_corrupt' }, 503, requestId)
  }
  return new Response(bytes, { status: 200, headers: {
    'cache-control': 'no-store', 'content-type': row.mime_type, 'content-length': String(bytes.byteLength),
    'x-content-type-options': 'nosniff', 'x-solesystems-media-sha256': row.sha256, 'x-solesystems-media-id': mediaId,
    'x-request-id': requestId,
  } })
}

async function pendingPackets(auth: AuthenticatedRequest, env: Env) {
  const rows = await env.DB.prepare(`SELECT packet_id, server_sequence, payload_object_key, uploaded_at
    FROM mobile_sync_packets WHERE account_sync_id = ? AND status = 'pending_desktop' ORDER BY server_sequence ASC LIMIT 100`)
    .bind(auth.accountSyncId).all<{ packet_id: string; server_sequence: number; payload_object_key: string; uploaded_at: string }>()
  const packets: Array<{ server_sequence: number; uploaded_at: string; envelope: PacketEnvelopeV1 }> = []
  for (const row of rows.results) {
    const envelope = await loadPacket(env, row.payload_object_key)
    if (envelope) packets.push({ server_sequence: row.server_sequence, uploaded_at: row.uploaded_at, envelope })
  }
  return response({ ok: true, packets })
}

async function acknowledge(packetId: string, bodyText: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const body = object(bodyText)
  const status = clean(body?.status)
  const reason = clean(body?.reason_code) || null
  if (!['accepted', 'rejected', 'action_required'].includes(status) || (reason && !isIdentifier(reason))) {
    return response({ ok: false, error: 'invalid_acknowledgement' }, 400, requestId)
  }
  const packet = await env.DB.prepare(`SELECT packet_id, account_sync_id, device_id, server_sequence, payload_object_key
    FROM mobile_sync_packets WHERE packet_id = ? AND account_sync_id = ? LIMIT 1`).bind(packetId, auth.accountSyncId)
    .first<{ packet_id: string; account_sync_id: string; device_id: string; server_sequence: number; payload_object_key: string }>()
  if (!packet) return response({ ok: false, error: 'packet_not_found' }, 404, requestId)
  const priorAck = await env.DB.prepare('SELECT ack_status, reason_code, acknowledged_at FROM mobile_sync_packet_acks WHERE packet_id = ?')
    .bind(packetId).first<{ ack_status: string; reason_code: string | null; acknowledged_at: string }>()
  if (priorAck && (priorAck.ack_status !== status || priorAck.reason_code !== reason)) {
    return response({ ok: false, error: 'acknowledgement_conflict' }, 409, requestId)
  }
  const now = priorAck?.acknowledged_at || new Date().toISOString()
  if (!priorAck) {
    await env.DB.prepare(`INSERT INTO mobile_sync_packet_acks
      (packet_id, account_sync_id, device_id, ack_status, reason_code, acknowledged_by_credential_id, acknowledged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(packetId, packet.account_sync_id, packet.device_id, status, reason, auth.credentialId, now).run()
    await env.DB.prepare('UPDATE mobile_sync_packets SET status = ? WHERE packet_id = ?').bind(status, packetId).run()
  }
  let retained = false
  let oldKey: string | null = null
  let oldPacketId: string | null = null
  if (status === 'accepted') {
    const current = await env.DB.prepare(`SELECT packet_id, server_sequence, payload_object_key FROM mobile_sync_retained_backup WHERE account_sync_id = ?`)
      .bind(packet.account_sync_id).first<{ packet_id: string; server_sequence: number; payload_object_key: string }>()
    if (!current || packet.server_sequence > current.server_sequence) {
      const result = await env.DB.prepare(`INSERT INTO mobile_sync_retained_backup
        (account_sync_id, packet_id, server_sequence, payload_object_key, retained_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (account_sync_id) DO UPDATE SET packet_id = excluded.packet_id, server_sequence = excluded.server_sequence,
          payload_object_key = excluded.payload_object_key, retained_at = excluded.retained_at
        WHERE excluded.server_sequence > mobile_sync_retained_backup.server_sequence`).bind(
          packet.account_sync_id, packet.packet_id, packet.server_sequence, packet.payload_object_key, now).run()
      retained = result.meta.changes === 1
      if (retained && current && current.packet_id !== packet.packet_id) {
        oldKey = current.payload_object_key
        oldPacketId = current.packet_id
      }
    }
  }
  if (oldKey) {
    await env.PAYLOADS.delete(oldKey)
    const oldMedia = await env.DB.prepare(`SELECT media_id, payload_object_key FROM mobile_sync_packet_media_objects
      WHERE account_sync_id = ? AND packet_id = ? AND deleted_at IS NULL`).bind(packet.account_sync_id,
        oldPacketId || '').all<{ media_id: string; payload_object_key: string }>()
    for (const media of oldMedia.results) await env.PAYLOADS.delete(media.payload_object_key)
    if (oldMedia.results.length) await env.DB.prepare(`UPDATE mobile_sync_packet_media_objects SET deleted_at = ?
      WHERE account_sync_id = ? AND packet_id = ?`).bind(now, packet.account_sync_id, oldPacketId).run()
  }
  return response({ ok: true, packet_id: packetId, status, acknowledged_at: now,
    retained_backup_updated: retained, duplicate: Boolean(priorAck) })
}

async function acknowledgements(auth: AuthenticatedRequest, env: Env) {
  const rows = await env.DB.prepare(`SELECT packet_id, ack_status AS status, reason_code, acknowledged_at
    FROM mobile_sync_packet_acks WHERE account_sync_id = ? AND device_id = ? ORDER BY acknowledged_at ASC LIMIT 100`)
    .bind(auth.accountSyncId, auth.identityId).all()
  return response({ ok: true, acknowledgements: rows.results })
}

async function listDevices(auth: AuthenticatedRequest, env: Env) {
  // Only currently-paired devices. A removed device's row is retained for re-pair
  // (ON CONFLICT un-revoke) but must not appear in the desktop's paired-devices list.
  const rows = await env.DB.prepare(`SELECT device_id, user_id, issued_at, expires_at, last_used_at
    FROM mobile_sync_devices WHERE account_sync_id = ? AND revoked_at IS NULL ORDER BY issued_at ASC LIMIT 100`)
    .bind(auth.accountSyncId).all()
  return response({ ok: true, devices: rows.results })
}

async function revoke(device: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const now = new Date().toISOString()
  const result = await env.DB.prepare(`UPDATE mobile_sync_devices SET revoked_at = ?
    WHERE account_sync_id = ? AND device_id = ? AND revoked_at IS NULL`).bind(now, auth.accountSyncId, device).run()
  return result.meta.changes === 1
    ? response({ ok: true, device_id: device, revoked_at: now })
    : response({ ok: false, error: 'device_not_found' }, 404, requestId)
}

async function revokeDesktop(credential: string, auth: AuthenticatedRequest, env: Env, requestId: string) {
  const now = new Date().toISOString()
  const result = await env.DB.prepare(`UPDATE mobile_sync_desktop_clients SET revoked_at = ?
    WHERE account_sync_id = ? AND credential_id = ? AND revoked_at IS NULL`).bind(now, auth.accountSyncId, credential).run()
  return result.meta.changes === 1
    ? response({ ok: true, credential_id: credential, revoked_at: now })
    : response({ ok: false, error: 'desktop_client_not_found' }, 404, requestId)
}

async function inspectDevelopment(request: Request, env: Env, requestId: string) {
  if (env.SERVICE_ENVIRONMENT !== 'development') return response({ ok: false, error: 'not_found' }, 404, requestId)
  const configured = env.MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET || ''
  const supplied = request.headers.get('x-solesystems-bootstrap-secret') || ''
  if (!configured || !supplied || await sha256(configured) !== await sha256(supplied)) {
    return response({ ok: false, error: 'authentication_failed' }, 401, requestId)
  }
  const account = new URL(request.url).searchParams.get('account_sync_id') || ''
  if (!isIdentifier(account)) return response({ ok: false, error: 'invalid_request' }, 400, requestId)
  const retained = await env.DB.prepare(`SELECT packet_id, server_sequence, payload_object_key
    FROM mobile_sync_retained_backup WHERE account_sync_id = ?`).bind(account)
    .first<{ packet_id: string; server_sequence: number; payload_object_key: string }>()
  const counts = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM mobile_sync_packets WHERE account_sync_id = ?) AS packets,
    (SELECT COUNT(*) FROM mobile_sync_packet_acks WHERE account_sync_id = ?) AS acknowledgements,
    (SELECT COUNT(*) FROM mobile_sync_devices WHERE account_sync_id = ?) AS devices,
    (SELECT COUNT(*) FROM mobile_sync_snapshots WHERE account_sync_id = ?) AS snapshots,
    (SELECT COUNT(*) FROM mobile_sync_packet_media_objects WHERE account_sync_id = ?) AS media`).bind(account, account, account, account, account)
    .first<{ packets: number; acknowledgements: number; devices: number; snapshots: number; media: number }>()
  const retainedObjectExists = retained ? Boolean(await env.PAYLOADS.head(retained.payload_object_key)) : false
  const packetRows = await env.DB.prepare(`SELECT packet_id, payload_object_key, status, server_sequence
    FROM mobile_sync_packets WHERE account_sync_id = ? ORDER BY server_sequence`).bind(account)
    .all<{ packet_id: string; payload_object_key: string; status: string; server_sequence: number }>()
  const packets = []
  for (const row of packetRows.results) packets.push({ packet_id: row.packet_id, status: row.status,
    server_sequence: row.server_sequence, payload_exists: Boolean(await env.PAYLOADS.head(row.payload_object_key)) })
  const mediaRows = await env.DB.prepare(`SELECT media_id, packet_id, payload_object_key, payload_hash, byte_size, deleted_at
    FROM mobile_sync_packet_media_objects WHERE account_sync_id = ? ORDER BY created_at`).bind(account)
    .all<{ media_id: string; packet_id: string; payload_object_key: string; payload_hash: string; byte_size: number; deleted_at: string | null }>()
  const media = []
  for (const row of mediaRows.results) media.push({ media_id: row.media_id, packet_id: row.packet_id,
    payload_hash: row.payload_hash, byte_size: row.byte_size, deleted_at: row.deleted_at,
    payload_exists: Boolean(await env.PAYLOADS.head(row.payload_object_key)) })
  return response({ ok: true, retained: retained ? { packet_id: retained.packet_id,
    server_sequence: retained.server_sequence, payload_exists: retainedObjectExists } : null, counts, packets, media })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID()
    const started = Date.now()
    const path = new URL(request.url).pathname
    try {
      if (request.method === 'GET' && path === '/health') return response({ status: 'ok', environment: env.SERVICE_ENVIRONMENT, protocol_version: 1 }, 200, requestId)
      if (request.method === 'POST' && path === '/v1/dev/bootstrap') return bootstrap(request, env, requestId)
      if (request.method === 'GET' && path === '/v1/dev/inspect') return inspectDevelopment(request, env, requestId)
      if (request.method === 'POST' && path === '/v1/pairing-claims') return claimPairing(request, env, requestId)
      if (request.method === 'POST' && path === '/v1/pairing-sessions') return secured({ request, env, role: 'desktop', endpoint: 'pairing_sessions', requestId, started,
        handler: (auth, body) => createPairing(body, auth, env, requestId) })
      if (request.method === 'POST' && path === '/v1/snapshots') return secured({ request, env, role: 'desktop', endpoint: 'snapshot_upload', requestId, started,
        handler: (auth, body) => uploadSnapshot(body, auth, env, requestId) })
      if (request.method === 'GET' && path === '/v1/snapshots/head') {
        // Both sides poll this to bounded-wait for the counterpart's publish during
        // a round-trip sync. snapshotHead() is account-scoped only, so role-agnostic.
        const role = request.headers.has('x-solesystems-device-id') ? 'mobile' : 'desktop'
        return secured({ request, env, role, endpoint: 'snapshot_head', requestId, started,
          handler: auth => snapshotHead(auth, env, requestId) })
      }
      if (request.method === 'GET' && path === '/v1/snapshots/latest') return secured({ request, env, role: 'mobile', endpoint: 'snapshot_latest', requestId, started,
        handler: auth => latestSnapshot(auth, env, requestId) })
      if (request.method === 'POST' && path === '/v1/packets') return secured({ request, env, role: 'mobile', endpoint: 'packet_upload', requestId, started, ctx,
        handler: (auth, body, _bytes, context) => uploadPacket(body, auth, env, requestId, context) })
      const media = path.match(/^\/v1\/packets\/([A-Za-z0-9._:-]+)\/media\/([A-Za-z0-9._:-]+)$/)
      if (request.method === 'PUT' && media) return secured({ request, env, role: 'mobile', endpoint: 'media_upload', requestId, started,
        maximumBodyBytes: maximumMediaBodyBytes, handler: (auth, _body, bytes) => uploadMedia(media[1], media[2], bytes, auth, env, requestId) })
      if (request.method === 'GET' && media) {
        const role = request.headers.has('x-solesystems-desktop-client-id') ? 'desktop' : 'mobile'
        return secured({ request, env, role, endpoint: 'media_download', requestId, started,
          handler: auth => downloadMedia(media[1], media[2], auth, env, requestId) })
      }
      if (request.method === 'POST' && path === '/v1/snapshot-media/manifest') return secured({ request, env, role: 'desktop', endpoint: 'snapshot_media_manifest', requestId, started,
        handler: (auth, body) => snapshotMediaManifest(body, auth, env, requestId) })
      const snapshotMedia = path.match(/^\/v1\/snapshot-media\/([A-Za-z0-9._:-]+)$/)
      if (request.method === 'PUT' && snapshotMedia) return secured({ request, env, role: 'desktop', endpoint: 'snapshot_media_upload', requestId, started,
        maximumBodyBytes: maximumMediaBodyBytes, handler: (auth, _body, bytes) => uploadSnapshotMedia(snapshotMedia[1], bytes, request, auth, env, requestId) })
      if (request.method === 'GET' && snapshotMedia) return secured({ request, env, role: 'mobile', endpoint: 'snapshot_media_download', requestId, started,
        handler: auth => downloadSnapshotMedia(snapshotMedia[1], auth, env, requestId) })

      if (request.method === 'GET' && path === '/v1/packets/pending') return secured({ request, env, role: 'desktop', endpoint: 'packets_pending', requestId, started,
        handler: auth => pendingPackets(auth, env) })
      const ack = path.match(/^\/v1\/packets\/([A-Za-z0-9._:-]+)\/ack$/)
      if (request.method === 'POST' && ack) return secured({ request, env, role: 'desktop', endpoint: 'packet_ack', requestId, started,
        handler: (auth, body) => acknowledge(ack[1], body, auth, env, requestId) })
      if (request.method === 'GET' && path === '/v1/acks') return secured({ request, env, role: 'mobile', endpoint: 'acks', requestId, started,
        handler: auth => acknowledgements(auth, env) })
      if (request.method === 'GET' && path === '/v1/devices') return secured({ request, env, role: 'desktop', endpoint: 'devices_list', requestId, started,
        handler: auth => listDevices(auth, env) })
      const device = path.match(/^\/v1\/devices\/([A-Za-z0-9._:-]+)\/revoke$/)
      if (request.method === 'POST' && device) return secured({ request, env, role: 'desktop', endpoint: 'device_revoke', requestId, started,
        handler: auth => revoke(device[1], auth, env, requestId) })
      const desktop = path.match(/^\/v1\/desktop-clients\/([A-Za-z0-9._:-]+)\/revoke$/)
      if (request.method === 'POST' && desktop) return secured({ request, env, role: 'desktop', endpoint: 'desktop_revoke', requestId, started,
        handler: auth => revokeDesktop(desktop[1], auth, env, requestId) })
      const channel = path.match(/^\/v1\/accounts\/([A-Za-z0-9._:-]+)\/channel$/)
      if (request.method === 'GET' && channel) {
        if (request.headers.get('Upgrade') !== 'websocket') return response({ ok: false, error: 'expected_websocket' }, 426, requestId)
        // The desktop and the phone both connect to the same per-account channel.
        // The role is decided by which identity header the signed upgrade carries.
        const role = request.headers.has('x-solesystems-device-id') ? 'mobile' : 'desktop'
        const auth = await authenticateRequest(request, env, role)
        if (!auth.ok) {
          diagnostic(requestId, 'account_channel', started, auth.status, undefined, auth.code)
          return response({ ok: false, error: auth.code }, auth.status, requestId)
        }
        if (auth.authenticated.accountSyncId !== channel[1]) {
          diagnostic(requestId, 'account_channel', started, 403, auth.authenticated, 'account_mismatch')
          return response({ ok: false, error: 'account_mismatch' }, 403, requestId)
        }
        const id = env.ACCOUNT_SYNC_CHANNEL.idFromName(auth.authenticated.accountSyncId)
        const forwardUrl = new URL(request.url)
        forwardUrl.searchParams.set('channel_role', role)
        return env.ACCOUNT_SYNC_CHANNEL.get(id).fetch(new Request(forwardUrl, request))
      }
      return response({ ok: false, error: 'not_found' }, 404, requestId)
    } catch (error) {
      console.error(JSON.stringify({ event: 'mobile_sync_internal_error', request_id: requestId, endpoint: path,
        category: error instanceof Error ? error.name : 'unknown' }))
      diagnostic(requestId, path, started, 500, undefined, 'internal_error')
      return response({ ok: false, error: 'internal_error' }, 500, requestId)
    }
  },
} satisfies ExportedHandler<Env>
