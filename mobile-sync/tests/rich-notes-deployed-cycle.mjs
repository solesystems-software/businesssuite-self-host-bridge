import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const phase = process.argv[2]
const baseUrl = process.env.MOBILE_SYNC_TEST_BASE_URL
const fixturePath = process.env.MOBILE_SYNC_LIVE_FIXTURE_PATH
if (!baseUrl || !fixturePath || !['prepare', 'verify'].includes(phase)) {
  throw new Error('Usage: rich-notes-deployed-cycle.mjs <prepare|verify> with the deployed fixture environment configured.')
}

const sha256 = value => createHash('sha256').update(value).digest('hex')
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}
const nonce = () => randomBytes(18).toString('base64url')
const assert = (condition, message) => { if (!condition) throw new Error(message) }

async function raw(requestPath, { method = 'GET', body, headers = {}, expected = [200] } = {}) {
  const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array
  const requestBody = body === undefined ? undefined : isBytes ? body : typeof body === 'string' ? body : JSON.stringify(body)
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: { ...(body !== undefined && !isBytes ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: requestBody } : {}),
  })
  let result
  if ((response.headers.get('content-type') || '').includes('application/json')) result = await response.json()
  else result = Buffer.from(await response.arrayBuffer())
  if (!expected.includes(response.status)) {
    throw new Error(`Unexpected HTTP ${response.status} for ${method} ${requestPath}: ${result?.error || 'unknown'}`)
  }
  return result
}

async function signed(client, requestPath, { method = 'GET', body, expected = [200], headers = {} } = {}) {
  const isBytes = Buffer.isBuffer(body) || body instanceof Uint8Array
  const bodyValue = body === undefined ? '' : isBytes ? Buffer.from(body) : typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const requestNonce = nonce()
  const canonical = [method, requestPath, timestamp, requestNonce, client.account, client.credential,
    client.identity, sha256(bodyValue)].join('\n')
  return raw(requestPath, { method, body: body === undefined ? undefined : bodyValue, expected, headers: {
    'x-solesystems-account-id': client.account,
    'x-solesystems-credential-id': client.credential,
    [client.role === 'desktop' ? 'x-solesystems-desktop-client-id' : 'x-solesystems-device-id']: client.identity,
    'x-solesystems-timestamp': timestamp,
    'x-solesystems-nonce': requestNonce,
    'x-solesystems-signature': createHmac('sha256', Buffer.from(client.secret, 'base64')).update(canonical).digest('base64url'),
    ...headers,
  } })
}

function text(value, format = 0, style = '') {
  return { detail: 0, format, mode: 'normal', style, text: value, type: 'text', version: 1 }
}

function paragraph(children, format = '', indent = 0) {
  return { children, direction: null, format, indent, type: 'paragraph', version: 1 }
}

function longDocument() {
  const children = []
  for (let section = 1; section <= 18; section += 1) {
    children.push({ children: [text(`Section ${section}`)], direction: null, format: '', indent: 0,
      tag: section % 3 === 0 ? 'h1' : 'h2', type: 'heading', version: 1 })
    for (let line = 1; line <= 8; line += 1) {
      children.push(paragraph([
        text(`Paragraph ${section}.${line} keeps a realistic Business Suite project note readable on a phone. `),
        text('Important detail', line % 2 === 0 ? 1 : 2),
        text(' remains editable after scrolling, saving, and restart.', 0, line % 3 === 0 ? 'color: #1d5fa7;' : ''),
      ], line % 4 === 0 ? 'center' : ''))
    }
    children.push({ children: [
      { children: [paragraph([text(`Checklist item ${section}.1`)])], direction: null, format: '', indent: 0, type: 'listitem', value: 1, checked: false, version: 1 },
      { children: [paragraph([text(`Checklist item ${section}.2`)])], direction: null, format: '', indent: 0, type: 'listitem', value: 2, checked: true, version: 1 },
    ], direction: null, format: '', indent: 0, listType: 'check', start: 1, tag: 'ul', type: 'list', version: 1 })
    children.push({ type: 'horizontalrule', version: 1 })
  }
  children.push({ type: 'page-editor-image', version: 1, attachmentId: 'fixture-image', originalFileName: 'fixture-plan.png', storedFileName: 'fixture-plan.png', mimeType: 'image/png', fileSizeBytes: 1024, relativePath: 'notes/fixture-plan.png', widthPercent: 70, align: 'center', altText: 'Fixture plan', caption: 'Long-document fixture image' })
  children.push({ type: 'page-editor-webpage-capture', version: 1, attachmentId: 'fixture-webpage', originalFileName: 'fixture-webpage.png', storedFileName: 'fixture-webpage.png', mimeType: 'image/png', fileSizeBytes: 2048, relativePath: 'notes/fixture-webpage.png', align: 'left', url: 'https://example.com', previewTitle: 'Example fixture', previewFetchedAt: '2026-08-18T00:00:00Z' })
  return JSON.stringify({ root: { children, direction: null, format: '', indent: 0, type: 'root', version: 1 } })
}

function advancedDocument(mediaIds) {
  const image = mediaId => ({ type: 'page-editor-image', version: 1, attachmentId: mediaId, originalFileName: `${mediaId}.jpg`,
    storedFileName: `${mediaId}.jpg`, mimeType: 'image/jpeg', fileSizeBytes: 32, relativePath: `attachments/notes/note-task04-01-media/${mediaId}.jpg`,
    altText: mediaId, caption: '', width: 320, height: 180, maxWidth: 640, showCaption: false })
  const tableCell = value => ({ type: 'tablecell', version: 1, children: [paragraph([text(value)])], direction: 'ltr', format: '', indent: 0, headerState: 0, colSpan: 1, rowSpan: 1, width: 100, backgroundColor: null, verticalAlign: 'top' })
  return JSON.stringify({ root: { type: 'root', version: 1, direction: 'ltr', format: '', indent: 0, children: [
    { type: 'heading', version: 1, tag: 'h1', direction: 'ltr', format: '', indent: 0, children: [text('Advanced rich Note')] },
    { ...paragraph('Bold italic underline strike code'), children: [text('Bold', 1), text(' italic', 2), text(' underline', 8), text(' strike', 4), text(' code', 16)] },
    { type: 'list', version: 1, listType: 'bullet', tag: 'ul', start: 1, direction: 'ltr', format: '', indent: 0, children: [{ type: 'listitem', version: 1, value: 1, checked: false, direction: 'ltr', format: '', indent: 0, children: [text('Bullet item')] }] },
    { type: 'list', version: 1, listType: 'check', tag: 'ul', start: 1, direction: 'ltr', format: '', indent: 0, children: [{ type: 'listitem', version: 1, value: 1, checked: true, direction: 'ltr', format: '', indent: 0, children: [text('Checked item')] }] },
    { ...paragraph(''), children: [{ type: 'link', version: 1, direction: 'ltr', format: '', indent: 0, rel: null, target: '_blank', title: null, url: 'https://example.com/task04-01', children: [text('Conformance link')] }] },
    { type: 'horizontalrule', version: 1 },
    { type: 'table', version: 1, direction: 'ltr', format: '', indent: 0, colWidths: [100, 100], rowStriping: false, children: [
      { type: 'tablerow', version: 1, direction: 'ltr', format: '', indent: 0, height: null, children: [tableCell('R1C1'), tableCell('R1C2')] },
      { type: 'tablerow', version: 1, direction: 'ltr', format: '', indent: 0, height: null, children: [tableCell('R2C1'), tableCell('R2C2')] },
    ] },
    { type: 'page-editor-toggle-container', version: 1, open: true, direction: 'ltr', format: '', indent: 0, children: [
      { type: 'page-editor-toggle-title', version: 1, direction: 'ltr', format: '', indent: 0, children: [text('Toggle title')] },
      { type: 'page-editor-toggle-content', version: 1, direction: 'ltr', format: '', indent: 0, children: [paragraph([text('Toggle body')])] },
    ] },
    ...mediaIds.map(image),
    { type: 'page-editor-webpage-capture', version: 1, url: 'https://example.com/capture', title: 'Captured page', capturedAt: '2026-08-24T12:00:00.000Z', html: '<p>Preserve-only webpage capture</p>', textContent: 'Preserve-only webpage capture' },
  ] } })
}

function manifest(mediaId, bytes) {
  return { media_id: mediaId, record_id: 'r1', page_id: 'note-task04-01-media', original_file_name: `${mediaId}.jpg`,
    stored_file_name: `${mediaId}.jpg`, mime_type: 'image/jpeg', byte_size: bytes.byteLength, sha256: sha256(bytes) }
}

function packet(fixture, sequence, packetType, entityId, payload, revision = null, attachments = []) {
  return { protocol_version: 1, packet_id: `packet-task04-01-${fixture.runId}-${sequence}`, packet_type: packetType,
    account_sync_id: fixture.accountSyncId, device_id: fixture.mobileCredential.identity, user_id: 'dev-user',
    created_at: `2026-08-24T12:${String(sequence).padStart(2, '0')}:00.000Z`, client_sequence: sequence,
    snapshot_version_seen: 0, entity_id: entityId, entity_revision_seen: revision,
    idempotency_key: `task04-01-${fixture.runId}-${sequence}`, payload, attachments, payload_hash: sha256(stable(payload)) }
}

async function uploadPacket(fixture, envelope, mediaById) {
  await signed(fixture.mobileCredential, '/v1/packets', { method: 'POST', body: envelope, expected: [201] })
  for (const item of envelope.attachments) {
    await signed(fixture.mobileCredential, `/v1/packets/${envelope.packet_id}/media/${item.media_id}`, {
      method: 'PUT', body: mediaById.get(item.media_id), expected: [201], headers: { 'content-type': item.mime_type },
    })
  }
}

async function prepare() {
  const bootstrapSecret = process.env.MOBILE_SYNC_TEST_BOOTSTRAP_SECRET
  if (!bootstrapSecret) throw new Error('MOBILE_SYNC_TEST_BOOTSTRAP_SECRET is required for prepare.')
  const runId = randomUUID().slice(0, 12)
  const accountSyncId = `task04-01-${runId}`
  const desktopIdentity = `desktop-task04-01-${runId}`
  const bootstrapped = await raw('/v1/dev/bootstrap', { method: 'POST', expected: [201],
    headers: { 'x-solesystems-bootstrap-secret': bootstrapSecret }, body: { account_sync_id: accountSyncId, desktop_client_id: desktopIdentity } })
  const desktopClient = { role: 'desktop', account: accountSyncId, identity: desktopIdentity,
    credential: String(bootstrapped.credential_id), secret: String(bootstrapped.credential_secret_base64) }
  const deviceId = `device-task04-01-${runId}`
  const pairing = await signed(desktopClient, '/v1/pairing-sessions', { method: 'POST', expected: [201],
    body: { user_id: 'dev-user', intended_device_id: deviceId, expires_in_seconds: 600 } })
  const claim = await raw('/v1/pairing-claims', { method: 'POST', expected: [201],
    body: { pairing_token: pairing.pairing_token, account_sync_id: accountSyncId, device_id: deviceId } })
  const runtimeRoot = path.dirname(fixturePath)
  const fixture = {
    runId, accountSyncId, runtimeRoot,
    accountPath: path.join(runtimeRoot, 'task04-01-deployed.bsa'),
    resultPath: path.join(runtimeRoot, 'task04-01-desktop-result.json'),
    desktopCredential: { version: 1, accountSyncId, desktopClientId: desktopIdentity,
      credentialId: desktopClient.credential, credentialSecretBase64: desktopClient.secret, workerUrl: baseUrl,
      issuedAt: new Date().toISOString(), expiresAt: String(bootstrapped.expires_at) },
    mobileCredential: { role: 'mobile', account: accountSyncId, identity: deviceId,
      credential: String(claim.credential_id), secret: String(claim.credential_secret_base64) },
  }
  const long = longDocument()
  assert(Buffer.byteLength(long, 'utf8') === 90653, 'The deployed long fixture is not the exact Task 04 fixture.')
  const bytesA = Buffer.from('task04-01-deployed-image-a')
  const bytesB = Buffer.from('task04-01-deployed-image-bb')
  const bytesC = Buffer.from('task04-01-deployed-image-ccc')
  const mediaA = manifest('media-task04-01-a', bytesA)
  const mediaB = manifest('media-task04-01-b', bytesB)
  const mediaC = manifest('media-task04-01-c', bytesC)
  const mediaById = new Map([[mediaA.media_id, bytesA], [mediaB.media_id, bytesB], [mediaC.media_id, bytesC]])
  const longNote = { id: 'note-task04-01-long', entity_type: 'record', entity_id: 'r1', title: 'Long Task 04 Note',
    plain_text_preview: 'Section 1', created_at: '2026-08-24T12:01:00.000Z', updated_at: '2026-08-24T12:01:00.000Z', deleted: false, deleted_at: null }
  const richBase = { id: 'note-task04-01-media', entity_type: 'record', entity_id: 'r1', title: 'Advanced Task 04 Note',
    plain_text_preview: 'Advanced rich Note', created_at: '2026-08-24T12:02:00.000Z', updated_at: '2026-08-24T12:02:00.000Z', deleted: false, deleted_at: null }
  const envelopes = [
    packet(fixture, 1, 'note.create', longNote.id, { note: longNote, content_json: long }),
    packet(fixture, 2, 'note.create', richBase.id, { note: richBase, content_json: advancedDocument([mediaA.media_id]) }, null, [mediaA]),
    packet(fixture, 3, 'note.update', richBase.id, { note: { ...richBase, title: 'Advanced retained', updated_at: '2026-08-24T12:03:00.000Z' }, content_json: advancedDocument([mediaA.media_id]) }, richBase.updated_at, [mediaA]),
    packet(fixture, 4, 'note.update', richBase.id, { note: { ...richBase, title: 'Advanced two images', updated_at: '2026-08-24T12:04:00.000Z' }, content_json: advancedDocument([mediaA.media_id, mediaB.media_id]) }, '2026-08-24T12:03:00.000Z', [mediaA, mediaB]),
    packet(fixture, 5, 'note.update', richBase.id, { note: { ...richBase, title: 'Advanced Image B removed', updated_at: '2026-08-24T12:05:00.000Z' }, content_json: advancedDocument([mediaA.media_id]) }, '2026-08-24T12:04:00.000Z', [mediaA]),
    packet(fixture, 6, 'note.update', richBase.id, { note: { ...richBase, title: 'Stale update must not apply', updated_at: '2026-08-24T12:06:00.000Z' }, content_json: advancedDocument([mediaA.media_id, mediaC.media_id]) }, '2026-08-24T00:00:00.000Z', [mediaA, mediaC]),
    packet(fixture, 7, 'note.create', 'note-task04-01-malformed', { note: { ...richBase, id: 'note-task04-01-malformed', updated_at: '2026-08-24T12:07:00.000Z' }, content_json: 'not-json' }),
  ]
  for (const envelope of envelopes) await uploadPacket(fixture, envelope, mediaById)
  fixture.expected = { longSha256: sha256(long), longBytes: Buffer.byteLength(long, 'utf8'), packetIds: envelopes.map(item => item.packet_id) }
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  process.stdout.write('TASK 04-01 DEPLOYED RICH NOTES FIXTURE PREPARED\n')
}

async function verify() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const result = JSON.parse(readFileSync(fixture.resultPath, 'utf8'))
  const long = result.notes.find(item => item.id === 'note-task04-01-long')
  const rich = result.notes.find(item => item.id === 'note-task04-01-media')
  assert(long && Buffer.byteLength(long.content_json, 'utf8') === fixture.expected.longBytes && sha256(long.content_json) === fixture.expected.longSha256,
    'The deployed authoritative import changed the exact Task 04 document.')
  assert(rich?.title === 'Advanced Image B removed', 'The deployed accepted rich Note sequence did not reconcile to the expected revision.')
  const parsed = JSON.parse(rich.content_json)
  const serialized = JSON.stringify(parsed)
  for (const marker of ['table', 'page-editor-toggle-container', 'page-editor-image', 'page-editor-webpage-capture']) {
    assert(serialized.includes(marker), `The deployed snapshot lost ${marker}.`)
  }
  const attachmentA = result.attachments.find(item => item.id === 'media-task04-01-a')
  const attachmentB = result.attachments.find(item => item.id === 'media-task04-01-b')
  assert(attachmentA?.deleted === 0 && attachmentB?.deleted === 1, 'The deployed attachment add/remove lifecycle did not reconcile metadata.')
  assert(!result.attachments.some(item => item.id === 'media-task04-01-c'), 'The stale deployed packet committed Image C metadata.')
  const stale = result.dispositions.find(item => item.packet_id === fixture.expected.packetIds[5])
  const malformed = result.dispositions.find(item => item.packet_id === fixture.expected.packetIds[6])
  assert(stale?.acknowledgement_status === 'action_required' && stale.reason_code === 'stale_entity_revision', 'The stale deployed packet disposition is incorrect.')
  assert(malformed?.acknowledgement_status === 'rejected' && malformed.reason_code === 'invalid_note', 'The malformed deployed packet disposition is incorrect.')
  const acknowledgements = await signed(fixture.mobileCredential, '/v1/acks')
  assert(fixture.expected.packetIds.every(packetId => acknowledgements.acknowledgements.some(item => item.packet_id === packetId)),
    'Mobile acknowledgement reconciliation did not return every deployed packet disposition.')
  const snapshot = await signed(fixture.mobileCredential, '/v1/snapshots/latest')
  const snapshotLong = snapshot.payload.notes.find(item => item.note.id === 'note-task04-01-long')
  const snapshotRich = snapshot.payload.notes.find(item => item.note.id === 'note-task04-01-media')
  assert(snapshotLong && sha256(snapshotLong.content_json) === fixture.expected.longSha256, 'The mobile-downloaded deployed snapshot changed the long Note.')
  assert(snapshotRich && JSON.stringify(snapshotRich).includes('page-editor-webpage-capture'), 'The mobile-downloaded deployed snapshot lost advanced structures.')
  process.stdout.write('TASK 04-01 DEPLOYED RICH NOTES ROUND TRIP PASS\n')
}

if (phase === 'prepare') await prepare()
else await verify()
