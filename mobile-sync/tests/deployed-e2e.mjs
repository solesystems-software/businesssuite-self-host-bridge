import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const baseUrl = process.env.MOBILE_SYNC_TEST_BASE_URL
const bootstrapSecret = process.env.MOBILE_SYNC_TEST_BOOTSTRAP_SECRET
if (!baseUrl || !bootstrapSecret) throw new Error('Required deployed test environment is not configured.')

const sha256 = value => createHash('sha256').update(value).digest('hex')
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}
const nonce = () => randomBytes(18).toString('base64url')
const pass = name => process.stdout.write(`PASS ${name}\n`)
const assert = (condition, name) => { if (!condition) throw new Error(`Assertion failed: ${name}`); pass(name) }

async function raw(path, { method = 'GET', body, headers = {}, expected = [200] } = {}) {
  const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array
  const requestBody = body === undefined ? undefined : isBytes ? body : typeof body === 'string' ? body : JSON.stringify(body)
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined && !isBytes ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: requestBody } : {}),
  })
  let result = null
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    try { result = await response.json() } catch { result = {} }
  } else result = Buffer.from(await response.arrayBuffer())
  if (!expected.includes(response.status)) throw new Error(`Unexpected HTTP ${response.status} for ${method} ${path}: ${result?.error || 'unknown'}`)
  return { status: response.status, body: result }
}

async function signed(client, path, { method = 'GET', body, expected = [200], timestamp, requestNonce, signatureOverride,
  accountOverride, identityOverride, headers = {} } = {}) {
  const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array
  const bodyValue = body === undefined ? '' : isBytes ? Buffer.from(body) : typeof body === 'string' ? body : JSON.stringify(body)
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000))
  const n = requestNonce ?? nonce()
  const account = accountOverride ?? client.account
  const identity = identityOverride ?? client.identity
  const canonical = [method, path, ts, n, account, client.credential, identity, sha256(bodyValue)].join('\n')
  const signature = signatureOverride ?? createHmac('sha256', Buffer.from(client.secret, 'base64')).update(canonical).digest('base64url')
  return raw(path, { method, body: body === undefined ? undefined : bodyValue, expected, headers: {
    'x-solesystems-account-id': account,
    'x-solesystems-credential-id': client.credential,
    [client.role === 'desktop' ? 'x-solesystems-desktop-client-id' : 'x-solesystems-device-id']: identity,
    'x-solesystems-timestamp': ts,
    'x-solesystems-nonce': n,
    'x-solesystems-signature': signature,
    ...headers,
  } })
}

function channelWsUrl(account) {
  return `${baseUrl.replace(/^http/, 'ws')}/v1/accounts/${account}/channel`
}

function signedChannelHeaders(client, { pathAccount, headerAccount, signatureOverride } = {}) {
  const forPath = pathAccount ?? client.account
  const forHeader = headerAccount ?? client.account
  const path = `/v1/accounts/${forPath}/channel`
  const ts = String(Math.floor(Date.now() / 1000))
  const n = nonce()
  const canonical = ['GET', path, ts, n, forHeader, client.credential, client.identity, sha256('')].join('\n')
  const signature = signatureOverride ?? createHmac('sha256', Buffer.from(client.secret, 'base64')).update(canonical).digest('base64url')
  return {
    'x-solesystems-account-id': forHeader,
    'x-solesystems-credential-id': client.credential,
    [client.role === 'mobile' ? 'x-solesystems-device-id' : 'x-solesystems-desktop-client-id']: client.identity,
    'x-solesystems-timestamp': ts,
    'x-solesystems-nonce': n,
    'x-solesystems-signature': signature,
  }
}

function openChannel(client, { pathAccount, headerAccount, signatureOverride } = {}) {
  const target = pathAccount ?? client.account
  const socket = new WebSocket(channelWsUrl(target), { headers: signedChannelHeaders(client, { pathAccount: target, headerAccount, signatureOverride }) })
  const messages = []
  socket.on('message', data => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
  const outcome = new Promise(resolve => {
    socket.on('open', () => resolve({ status: 'open' }))
    socket.on('error', () => resolve({ status: 'error' }))
    socket.on('unexpected-response', (_request, res) => resolve({ status: res.statusCode }))
  })
  return { socket, messages, outcome }
}

async function waitFor(predicate, { attempts = 50, delayMs = 100 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return predicate()
}

async function bootstrap(account, identity) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await raw('/v1/dev/bootstrap', { method: 'POST', body: { account_sync_id: account, desktop_client_id: identity },
      expected: [201, 401], headers: { 'x-solesystems-bootstrap-secret': bootstrapSecret } })
    if (result.status === 201) {
      return { role: 'desktop', account, identity, credential: result.body.credential_id, secret: result.body.credential_secret_base64 }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Deployed bootstrap secret did not become ready.')
}

async function pair(desktop, device, user = 'user-1') {
  const created = await signed(desktop, '/v1/pairing-sessions', { method: 'POST', expected: [201],
    body: { user_id: user, intended_device_id: device, expires_in_seconds: 300 } })
  const claimed = await raw('/v1/pairing-claims', { method: 'POST', expected: [201], body: {
    pairing_token: created.body.pairing_token, account_sync_id: desktop.account, device_id: device,
  } })
  return { mobile: { role: 'mobile', account: desktop.account, identity: device,
    credential: claimed.body.credential_id, secret: claimed.body.credential_secret_base64, user }, token: created.body.pairing_token }
}

const runId = randomUUID().slice(0, 8)
const accountA = `acct-a-${runId}`
const accountB = `acct-b-${runId}`

const health = await raw('/health')
assert(health.body.protocol_version === 1, 'Worker health and protocol version')

const desktopA = await bootstrap(accountA, `desktop-a-${runId}`)
const desktopB = await bootstrap(accountB, `desktop-b-${runId}`)
const pairedA = await pair(desktopA, `device-a-${runId}`)
const mobileA = pairedA.mobile
assert(Boolean(mobileA.credential), 'Pairing session creation and claim')

const replayClaim = await raw('/v1/pairing-claims', { method: 'POST', expected: [401], body: {
  pairing_token: pairedA.token, account_sync_id: accountA, device_id: mobileA.identity,
} })
assert(replayClaim.body.error === 'pairing_invalid', 'Pairing replay rejected')

const wrongPair = await signed(desktopA, '/v1/pairing-sessions', { method: 'POST', expected: [201],
  body: { user_id: 'user-1', intended_device_id: `wrong-${runId}`, expires_in_seconds: 300 } })
await raw('/v1/pairing-claims', { method: 'POST', expected: [401], body: {
  pairing_token: wrongPair.body.pairing_token, account_sync_id: accountB, device_id: `wrong-${runId}`,
} })
pass('Wrong Account pairing rejected')
await raw('/v1/pairing-claims', { method: 'POST', expected: [401], body: { pairing_token: 'malformed', account_sync_id: accountA, device_id: 'bad' } })
pass('Malformed pairing rejected')

const expiring = await signed(desktopA, '/v1/pairing-sessions', { method: 'POST', expected: [201],
  body: { user_id: 'user-1', intended_device_id: `expired-${runId}`, expires_in_seconds: 30 } })
await new Promise(resolve => setTimeout(resolve, 31000))
await raw('/v1/pairing-claims', { method: 'POST', expected: [401], body: {
  pairing_token: expiring.body.pairing_token, account_sync_id: accountA, device_id: `expired-${runId}`,
} })
pass('Expired pairing rejected')

const revokeCandidate = await bootstrap(accountA, `desktop-revoke-${runId}`)
await signed(desktopA, `/v1/desktop-clients/${revokeCandidate.credential}/revoke`, { method: 'POST', body: {} })
await signed(revokeCandidate, '/v1/pairing-sessions', { method: 'POST', expected: [401], body: { user_id: 'user-1' } })
pass('Revoked desktop client rejected')

const pairedB = await pair(desktopB, `device-b-${runId}`, 'user-2')
const mobileB = pairedB.mobile

await signed(mobileA, '/v1/acks', { signatureOverride: 'A'.repeat(43), expected: [401] })
pass('Bad signature rejected')
const stale = Math.floor(Date.now() / 1000) - 601
await signed(mobileA, '/v1/acks', { timestamp: stale, expected: [401] })
pass('Stale timestamp rejected')
const future = Math.floor(Date.now() / 1000) + 601
await signed(mobileA, '/v1/acks', { timestamp: future, expected: [401] })
pass('Future timestamp rejected')
const replayNonce = nonce()
await signed(mobileA, '/v1/acks', { requestNonce: replayNonce })
await signed(mobileA, '/v1/acks', { requestNonce: replayNonce, expected: [401] })
pass('Nonce replay rejected')
await signed(mobileA, '/v1/acks', { accountOverride: accountB, expected: [401] })
pass('Wrong Account authentication rejected')
await signed(mobileA, '/v1/acks', { identityOverride: mobileB.identity, expected: [401] })
pass('Wrong device authentication rejected')

const snapshotPayload = { records: [{ id: 'record-1', name: 'Synthetic Record' }], notes: [] }
const snapshot = { snapshot_id: `snapshot-${runId}`, snapshot_version: 1, generated_at: new Date().toISOString(),
  payload: snapshotPayload, payload_hash: sha256(stable(snapshotPayload)) }
await signed(desktopA, '/v1/snapshots', { method: 'POST', body: snapshot, expected: [201] })
const downloaded = await signed(mobileA, '/v1/snapshots/latest')
assert(downloaded.body.payload_hash === snapshot.payload_hash && stable(downloaded.body.payload) === stable(snapshotPayload), 'Snapshot upload, download, and hash')
await signed(mobileB, '/v1/snapshots/latest', { accountOverride: accountA, expected: [401] })
pass('Cross-Account snapshot rejected')

const head1 = await signed(desktopA, '/v1/snapshots/head')
assert(head1.body.server_version === 1, 'Snapshot head reports the current server version')
const staleSnapshot = { snapshot_id: `snapshot-stale-${runId}`, snapshot_version: 1, generated_at: new Date().toISOString(),
  payload: snapshotPayload, payload_hash: sha256(stable(snapshotPayload)) }
const staleResult = await signed(desktopA, '/v1/snapshots', { method: 'POST', body: staleSnapshot, expected: [409] })
assert(staleResult.body.error === 'snapshot_version_behind' && staleResult.body.server_version === 1,
  'A behind desktop gets a clean 409 with the server version, not a 500')
const v2Payload = { records: [{ id: 'record-1', name: 'Synthetic Record v2' }], notes: [] }
const v2 = { snapshot_id: `snapshot-v2-${runId}`, snapshot_version: 2, generated_at: new Date().toISOString(),
  payload: v2Payload, payload_hash: sha256(stable(v2Payload)) }
await signed(desktopA, '/v1/snapshots', { method: 'POST', body: v2, expected: [201] })
const head2 = await signed(desktopA, '/v1/snapshots/head')
assert(head2.body.server_version === 2, 'Snapshot head advances after a valid publish')

// --- Desktop -> mobile snapshot media (generic binary store) -----------------
const snapshotMediaBytes = randomBytes(4096)
const snapshotMediaHash = sha256(snapshotMediaBytes)
const snapshotMediaId = `media-snapshot-${runId}`
const manifestMissing = await signed(desktopA, '/v1/snapshot-media/manifest', { method: 'POST', body: { media_ids: [snapshotMediaId] } })
assert(manifestMissing.body.present[snapshotMediaId] === undefined, 'Snapshot media manifest reports absent before upload')
await signed(desktopA, `/v1/snapshot-media/${snapshotMediaId}`, { method: 'PUT', body: snapshotMediaBytes, expected: [201],
  headers: { 'x-solesystems-snapshot-media-sha256': snapshotMediaHash, 'x-solesystems-snapshot-media-mime': 'image/jpeg' } })
const dup = await signed(desktopA, `/v1/snapshot-media/${snapshotMediaId}`, { method: 'PUT', body: snapshotMediaBytes, expected: [200],
  headers: { 'x-solesystems-snapshot-media-sha256': snapshotMediaHash, 'x-solesystems-snapshot-media-mime': 'image/jpeg' } })
assert(dup.body.duplicate === true, 'Re-uploading identical snapshot media is an idempotent 200')
const manifestPresent = await signed(desktopA, '/v1/snapshot-media/manifest', { method: 'POST', body: { media_ids: [snapshotMediaId, `${snapshotMediaId}-absent`] } })
assert(manifestPresent.body.present[snapshotMediaId]?.sha256 === snapshotMediaHash
  && manifestPresent.body.present[`${snapshotMediaId}-absent`] === undefined, 'Snapshot media manifest reports the stored hash')
const badHash = await signed(desktopA, `/v1/snapshot-media/${snapshotMediaId}-x`, { method: 'PUT', body: snapshotMediaBytes, expected: [400],
  headers: { 'x-solesystems-snapshot-media-sha256': sha256('wrong'), 'x-solesystems-snapshot-media-mime': 'image/jpeg' } })
assert(badHash.body.error === 'media_hash_mismatch', 'Snapshot media upload rejects a wrong hash')
const mobileDownload = await signed(mobileA, `/v1/snapshot-media/${snapshotMediaId}`)
assert(Buffer.isBuffer(mobileDownload.body) && Buffer.compare(mobileDownload.body, snapshotMediaBytes) === 0,
  'Mobile downloads the exact snapshot media bytes')
await signed(mobileB, `/v1/snapshot-media/${snapshotMediaId}`, { accountOverride: accountA, expected: [401] })
pass('Cross-Account snapshot media download rejected')
await signed(mobileB, `/v1/snapshot-media/${snapshotMediaId}`, { expected: [404] })
pass('Snapshot media is not visible to a different account')
const pdfBytes = randomBytes(9000)
await signed(desktopA, `/v1/snapshot-media/receipt-${runId}`, { method: 'PUT', body: pdfBytes, expected: [201],
  headers: { 'x-solesystems-snapshot-media-sha256': sha256(pdfBytes), 'x-solesystems-snapshot-media-mime': 'application/pdf' } })
const pdfDownload = await signed(mobileA, `/v1/snapshot-media/receipt-${runId}`)
assert(Buffer.compare(pdfDownload.body, pdfBytes) === 0, 'Snapshot media store is type-agnostic (receipt PDF round-trips)')

const makePacket = (suffix, sequence, attachments = []) => {
  const payload = { note: `synthetic-${suffix}`, record_id: 'record-1' }
  return { protocol_version: 1, packet_id: `packet-${suffix}-${runId}`, packet_type: 'note_capture', account_sync_id: accountA,
    device_id: mobileA.identity, user_id: mobileA.user, created_at: new Date().toISOString(), client_sequence: sequence,
    snapshot_version_seen: 1, entity_id: 'record-1', entity_revision_seen: 'revision-1',
    idempotency_key: `idem-${suffix}-${runId}`, payload, attachments, payload_hash: sha256(stable(payload)) }
}
const mediaBytes = randomBytes(2048)
const mediaManifest = { media_id: `media-a-${runId}`, record_id: 'r1', page_id: `page-a-${runId}`,
  original_file_name: 'camera.jpg', stored_file_name: `media-a-${runId}.jpg`, mime_type: 'image/jpeg',
  byte_size: mediaBytes.byteLength, sha256: sha256(mediaBytes) }
const packetA = makePacket('a', 1, [mediaManifest])
const firstA = await signed(mobileA, '/v1/packets', { method: 'POST', body: packetA, expected: [201] })
const retryA = await signed(mobileA, '/v1/packets', { method: 'POST', body: packetA })
assert(retryA.body.duplicate === true && retryA.body.server_sequence === firstA.body.server_sequence, 'Packet retry idempotent')
const pendingA = await signed(desktopA, '/v1/packets/pending')
assert(pendingA.body.packets.filter(item => item.envelope.packet_id === packetA.packet_id).length === 1, 'Desktop pending packet retrieval')
const mediaPath = `/v1/packets/${packetA.packet_id}/media/${mediaManifest.media_id}`
const corruptedMedia = Buffer.from(mediaBytes)
corruptedMedia[0] ^= 0xff
await signed(mobileA, mediaPath, { method: 'PUT', body: corruptedMedia, expected: [400], headers: { 'content-type': 'image/jpeg' } })
pass('Media hash mismatch rejected')
const mediaUpload = await signed(mobileA, mediaPath, { method: 'PUT', body: mediaBytes, expected: [201], headers: { 'content-type': 'image/jpeg' } })
assert(mediaUpload.body.payload_hash === mediaManifest.sha256 && mediaUpload.body.duplicate === false, 'Private media upload and hash validation')
const mediaRetry = await signed(mobileA, mediaPath, { method: 'PUT', body: mediaBytes, headers: { 'content-type': 'image/jpeg' } })
assert(mediaRetry.body.duplicate === true, 'Media retry idempotent')
const mediaDownload = await signed(desktopA, mediaPath)
assert(Buffer.compare(mediaDownload.body, mediaBytes) === 0, 'Authenticated desktop media download')
const receiptBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n')
const receiptId = `receipt-${runId}`
const receiptManifest = { media_id: receiptId, receipt_id: receiptId, record_id: 'record-1',
  original_file_name: 'receipt.pdf', stored_file_name: `${receiptId}.pdf`, mime_type: 'application/pdf',
  byte_size: receiptBytes.byteLength, sha256: sha256(receiptBytes), page_count: 1 }
const receiptPayload = { receipt_id: receiptId, record_id: 'record-1', original_file_name: 'receipt.pdf' }
const receiptPacket = { protocol_version: 1, packet_id: `packet-receipt-${runId}`, packet_type: 'receipt.create', account_sync_id: accountA,
  device_id: mobileA.identity, user_id: mobileA.user, created_at: new Date().toISOString(), client_sequence: 2,
  snapshot_version_seen: 1, entity_id: receiptId, entity_revision_seen: null,
  idempotency_key: `idem-receipt-${runId}`, payload: receiptPayload, attachments: [receiptManifest], payload_hash: sha256(stable(receiptPayload)) }
await signed(mobileA, '/v1/packets', { method: 'POST', body: receiptPacket, expected: [201] })
const receiptPath = `/v1/packets/${receiptPacket.packet_id}/media/${receiptId}`
await signed(mobileA, receiptPath, { method: 'PUT', body: receiptBytes, expected: [201], headers: { 'content-type': 'application/pdf' } })
const receiptDownload = await signed(desktopA, receiptPath)
assert(Buffer.compare(receiptDownload.body, receiptBytes) === 0, 'Receipt PDF manifest upload and desktop download')
await signed(desktopB, mediaPath, { expected: [404] })
pass('Cross-Account media download rejected')
await signed(mobileB, '/v1/packets', { method: 'POST', body: packetA, expected: [400] })
pass('Cross-Account packet rejected')
const ackA = await signed(desktopA, `/v1/packets/${packetA.packet_id}/ack`, { method: 'POST', body: { status: 'accepted' } })
assert(ackA.body.retained_backup_updated === true, 'First accepted packet retained')
const mobileAcks = await signed(mobileA, '/v1/acks')
assert(mobileAcks.body.acknowledgements.some(ack => ack.packet_id === packetA.packet_id && ack.status === 'accepted'), 'Mobile acknowledgement retrieval')

const packetB = makePacket('b', 3)
await signed(mobileA, '/v1/packets', { method: 'POST', body: packetB, expected: [201] })
await signed(desktopA, `/v1/packets/${packetB.packet_id}/ack`, { method: 'POST', body: { status: 'accepted' } })
const delayed = await signed(desktopA, `/v1/packets/${packetA.packet_id}/ack`, { method: 'POST', body: { status: 'accepted' } })
assert(delayed.body.retained_backup_updated === false, 'Delayed acknowledgement cannot regress retained backup')

const packetC = makePacket('c', 4)
await signed(mobileA, '/v1/packets', { method: 'POST', body: packetC, expected: [201] })
await signed(desktopA, `/v1/packets/${packetC.packet_id}/ack`, { method: 'POST', body: { status: 'rejected', reason_code: 'synthetic_rejection' } })
const inspected = await raw(`/v1/dev/inspect?account_sync_id=${accountA}`, { headers: { 'x-solesystems-bootstrap-secret': bootstrapSecret } })
assert(inspected.body.retained.packet_id === packetB.packet_id && inspected.body.retained.payload_exists === true, 'Newest accepted packet remains retained backup')
const inspectedA = inspected.body.packets.find(packet => packet.packet_id === packetA.packet_id)
const inspectedB = inspected.body.packets.find(packet => packet.packet_id === packetB.packet_id)
const inspectedC = inspected.body.packets.find(packet => packet.packet_id === packetC.packet_id)
assert(inspectedA.payload_exists === false && inspectedB.payload_exists === true && inspectedC.payload_exists === true, 'R2 retained and unresolved object lifecycle')
const inspectedMediaA = inspected.body.media.find(media => media.media_id === mediaManifest.media_id)
assert(inspectedMediaA.deleted_at && inspectedMediaA.payload_exists === false, 'Retained media advances and old accepted media is removed')
assert(inspected.body.counts.packets === 4 && inspected.body.counts.acknowledgements === 3 && inspected.body.counts.media === 2, 'D1 transport state consistency')

// A note.update / timesheet.update on a snapshot-origin row carries the desktop's
// SQLite CURRENT_TIMESTAMP string as entity_revision_seen ("2026-09-03 03:42:39",
// with a space) — it is an opaque equality token, not an identifier, and must be
// accepted rather than rejected as invalid_packet.
const revisionPayload = { note: { id: 'note-rev-1', updated_at: '2026-09-03 03:42:39' }, content_json: '{"root":{}}' }
const revisionPacket = { protocol_version: 1, packet_id: `packet-rev-${runId}`, packet_type: 'note.update', account_sync_id: accountA,
  device_id: mobileA.identity, user_id: mobileA.user, created_at: new Date().toISOString(), client_sequence: 5,
  snapshot_version_seen: 1, entity_id: 'note-rev-1', entity_revision_seen: '2026-09-03 03:42:39',
  idempotency_key: `idem-rev-${runId}`, payload: revisionPayload, attachments: [], payload_hash: sha256(stable(revisionPayload)) }
await signed(mobileA, '/v1/packets', { method: 'POST', body: revisionPacket, expected: [201] })
pass('Space-timestamp entity_revision_seen is accepted (not invalid_packet)')

// --- AccountSyncChannel (realtime push) ---------------------------------------
// A bad signature must not upgrade.
{
  const bad = openChannel(desktopA, { signatureOverride: 'A'.repeat(43) })
  const result = await bad.outcome
  assert(result.status === 401 || result.status === 'error', 'Channel upgrade rejects a bad signature')
  bad.socket.close()
}
// Valid auth for account A, but the URL names account B → 403.
{
  const mismatch = openChannel(desktopA, { pathAccount: accountB, headerAccount: accountA })
  const result = await mismatch.outcome
  assert(result.status === 403 || result.status === 'error', 'Channel upgrade rejects a path/account mismatch')
  mismatch.socket.close()
}
// A connected desktop is poked when a packet is uploaded, and the poke fans out
// to every connected socket.
{
  const first = openChannel(desktopA)
  const second = openChannel(desktopA)
  assert((await first.outcome).status === 'open' && (await second.outcome).status === 'open', 'Channel upgrade accepts a signed desktop')
  const channelPacket = makePacket('channel-1', 10)
  await signed(mobileA, '/v1/packets', { method: 'POST', body: channelPacket, expected: [201] })
  const delivered = await waitFor(() => first.messages.some(m => m.type === 'packets_pending') && second.messages.some(m => m.type === 'packets_pending'))
  assert(delivered, 'Packet upload pokes every connected channel socket')
  const poke = first.messages.find(m => m.type === 'packets_pending')
  assert(typeof poke.server_sequence === 'number', 'Poke frame carries the server_sequence')
  // sync_check over the open socket returns the last poked sequence.
  first.messages.length = 0
  first.socket.send(JSON.stringify({ type: 'sync_check' }))
  const answered = await waitFor(() => first.messages.some(m => m.type === 'high_water'))
  const highWater = first.messages.find(m => m.type === 'high_water')
  assert(answered && highWater.server_sequence === poke.server_sequence, 'sync_check returns the current high_water sequence')
  first.socket.close()
  second.socket.close()
}
pass('AccountSyncChannel realtime push')

// --- AccountSyncChannel round-trip relay (desktop <-> mobile) -----------------
// The channel also relays "flush now" nudges so one sync trigger on either side
// closes the staleness window in both directions.
{
  const desktopSide = openChannel(desktopA)
  const mobileSide = openChannel(mobileA)
  assert((await desktopSide.outcome).status === 'open', 'Desktop channel upgrade accepted (round-trip)')
  assert((await mobileSide.outcome).status === 'open', 'Mobile channel upgrade accepted (round-trip)')

  // Mobile can poll the snapshot head for its bounded wait.
  const mobileHead = await signed(mobileA, '/v1/snapshots/head')
  assert(typeof mobileHead.body.server_version === 'number', 'Mobile can read the snapshot head for a bounded wait')

  // Desktop asks the phone to push. The phone gets push_requested; the desktop
  // gets a push_ack that reports the counterpart is connected.
  desktopSide.messages.length = 0
  mobileSide.messages.length = 0
  desktopSide.socket.send(JSON.stringify({ type: 'request_push', request_id: 'rp-1' }))
  assert(await waitFor(() => mobileSide.messages.some(m => m.type === 'push_requested')), 'Desktop request_push reaches the phone as push_requested')
  const pushAck = await waitFor(() => desktopSide.messages.some(m => m.type === 'push_ack'))
    ? desktopSide.messages.find(m => m.type === 'push_ack') : null
  assert(pushAck && pushAck.request_id === 'rp-1' && pushAck.counterpart_connected === true && pushAck.delivered >= 1,
    'Desktop push_ack echoes the request id and reports the phone connected')

  // Phone asks the desktop to publish. The desktop gets publish_requested; the
  // phone gets a publish_ack.
  desktopSide.messages.length = 0
  mobileSide.messages.length = 0
  mobileSide.socket.send(JSON.stringify({ type: 'request_publish', request_id: 'rq-1' }))
  assert(await waitFor(() => desktopSide.messages.some(m => m.type === 'publish_requested')), 'Phone request_publish reaches the desktop as publish_requested')
  const publishAck = await waitFor(() => mobileSide.messages.some(m => m.type === 'publish_ack'))
    ? mobileSide.messages.find(m => m.type === 'publish_ack') : null
  assert(publishAck && publishAck.request_id === 'rq-1' && publishAck.counterpart_connected === true,
    'Phone publish_ack echoes the request id and reports the desktop connected')

  // counterpart_status_request is answered for each side.
  desktopSide.messages.length = 0
  desktopSide.socket.send(JSON.stringify({ type: 'counterpart_status_request', request_id: 'cs-1' }))
  const status = await waitFor(() => desktopSide.messages.some(m => m.type === 'counterpart_status'))
    ? desktopSide.messages.find(m => m.type === 'counterpart_status') : null
  assert(status && status.request_id === 'cs-1' && status.connected === true, 'counterpart_status_request reports the phone connected')

  // A mobile socket cannot drive a desktop-only frame.
  mobileSide.messages.length = 0
  desktopSide.messages.length = 0
  mobileSide.socket.send(JSON.stringify({ type: 'request_push', request_id: 'rp-x' }))
  await new Promise(resolve => setTimeout(resolve, 400))
  assert(!mobileSide.messages.some(m => m.type === 'push_ack') && !desktopSide.messages.some(m => m.type === 'push_requested'),
    'A mobile socket cannot issue request_push')

  mobileSide.socket.close()
  await waitFor(() => true, { attempts: 3, delayMs: 100 })

  // With no phone connected the desktop learns the counterpart is absent and
  // skips its bounded wait (graceful degradation).
  const soloDesktop = openChannel(desktopB)
  assert((await soloDesktop.outcome).status === 'open', 'Solo desktop channel upgrade accepted')
  soloDesktop.messages.length = 0
  soloDesktop.socket.send(JSON.stringify({ type: 'request_push', request_id: 'rp-solo' }))
  const soloAck = await waitFor(() => soloDesktop.messages.some(m => m.type === 'push_ack'))
    ? soloDesktop.messages.find(m => m.type === 'push_ack') : null
  assert(soloAck && soloAck.counterpart_connected === false && soloAck.delivered === 0,
    'push_ack reports no phone connected so the desktop can skip the wait')
  soloDesktop.socket.close()
  desktopSide.socket.close()
}
pass('AccountSyncChannel round-trip relay')

// NOTE: poke-failure isolation (POST /v1/packets still returns 201 when the DO
// poke throws) is covered by every packet upload above returning 201, plus the
// try/catch in notifyAccountChannel — there is no test hook to force the DO
// fetch to throw.

let limited = false
for (let index = 0; index < 70; index += 1) {
  const result = await signed(mobileA, '/v1/acks', { expected: [200, 429] })
  if (result.status === 429) { limited = true; break }
}
assert(limited, 'Abusive request sequence rate limited')
await signed(mobileB, '/v1/acks')
pass('Unrelated device not rate limited')

// Desktop lists the devices paired to its own account only — the account can hold
// more than one (Device A, plus a second device paired to the same user below).
const secondDevicePair = await pair(desktopA, `device-a2-${runId}`, pairedA.mobile.user)
assert(Boolean(secondDevicePair.mobile.credential), 'Second device on the same account paired')
const deviceListA = await signed(desktopA, '/v1/devices')
assert(Array.isArray(deviceListA.body.devices), 'Device list shape')
const listedIdsA = deviceListA.body.devices.map(row => row.device_id)
assert(listedIdsA.includes(mobileA.identity) && listedIdsA.includes(secondDevicePair.mobile.identity),
  'Device list contains both devices paired to the account')
assert(!listedIdsA.includes(mobileB.identity), 'Device list is scoped to the requesting account')
const deviceListB = await signed(desktopB, '/v1/devices')
assert(deviceListB.body.devices.every(row => row.device_id !== mobileA.identity),
  'A different account cannot see this account\'s devices')
pass('Desktop lists its own account\'s paired devices (multi-device)')

await signed(desktopA, `/v1/devices/${mobileA.identity}/revoke`, { method: 'POST', body: {} })
const revokedRead = await signed(mobileA, '/v1/snapshots/latest', { expected: [401] })
assert(revokedRead.body.error === 'credential_revoked', 'Revoked device gets the distinct credential_revoked code')
await signed(mobileA, '/v1/acks', { expected: [401] })
await signed(mobileA, '/v1/packets', { method: 'POST', body: makePacket('revoked', 5), expected: [401] })
pass('Revoked device rejected across mobile endpoints')
await signed(mobileB, '/v1/acks')
pass('Revoking Device A does not revoke Device B')
const deviceListAfterRevoke = await signed(desktopA, '/v1/devices')
assert(!deviceListAfterRevoke.body.devices.some(row => row.device_id === mobileA.identity),
  'A removed device drops off the paired-devices list')
assert(deviceListAfterRevoke.body.devices.some(row => row.device_id === secondDevicePair.mobile.identity),
  'The other device on the account is still listed')
pass('Device list shows only active devices')

// A device removed on the desktop must be re-pairable: same account + same device id,
// after revocation, pairs again and comes back with a fresh credential.
const rePaired = await pair(desktopA, mobileA.identity, pairedA.mobile.user)
assert(Boolean(rePaired.mobile.credential) && rePaired.mobile.credential !== mobileA.credential,
  'Revoked device re-pairs with a new credential')
await signed(rePaired.mobile, '/v1/acks')
const deviceListAfterRepair = await signed(desktopA, '/v1/devices')
assert(deviceListAfterRepair.body.devices.some(row => row.device_id === mobileA.identity),
  'Re-paired device is listed again')
assert(deviceListAfterRepair.body.devices.filter(row => row.device_id === mobileA.identity).length === 1,
  'Re-pairing replaces the row rather than duplicating it')
pass('A removed device is re-pairable')

process.stdout.write('DEPLOYED MOBILE SYNC BRIDGE ACCEPTANCE PASS\n')
