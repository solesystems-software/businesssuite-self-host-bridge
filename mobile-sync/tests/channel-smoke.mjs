// Post-deploy smoke test for AccountSyncChannel realtime push.
//
//   npm run channel:smoke
//
// Verifies against the deployed Worker (MOBILE_SYNC_TEST_BASE_URL, default the
// dev Worker) that: a signed desktop WebSocket upgrade is accepted, a mobile
// packet upload pokes it with a `packets_pending` frame, and `sync_check`
// returns the current `high_water` sequence.
//
// Assumes /v1/dev/bootstrap is reachable (unauthenticated on the dev Worker
// since MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET was removed). Set
// MOBILE_SYNC_TEST_BOOTSTRAP_SECRET to send the header if a Worker still has one.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const base = (process.env.MOBILE_SYNC_TEST_BASE_URL || 'https://businesssuite-mobile-sync-dev.solebusinesssuite-selfhostbridge-dev.workers.dev').replace(/\/+$/, '')
const bootstrapSecret = process.env.MOBILE_SYNC_TEST_BOOTSTRAP_SECRET || ''

const sha256 = v => createHash('sha256').update(v).digest('hex')
const stable = v => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
}
const nonce = () => randomBytes(18).toString('base64url')
const runId = randomUUID().slice(0, 8)
const account = `acct-smoke-${runId}`

const sign = (method, path, acct, credential, identity, secret, body = '') => {
  const ts = String(Math.floor(Date.now() / 1000))
  const n = nonce()
  const canonical = [method, path, ts, n, acct, credential, identity, sha256(body)].join('\n')
  return {
    'x-solesystems-account-id': acct,
    'x-solesystems-credential-id': credential,
    'x-solesystems-timestamp': ts,
    'x-solesystems-nonce': n,
    'x-solesystems-signature': createHmac('sha256', Buffer.from(secret, 'base64')).update(canonical).digest('base64url'),
  }
}

const bootstrap = await (await fetch(`${base}/v1/dev/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(bootstrapSecret ? { 'x-solesystems-bootstrap-secret': bootstrapSecret } : {}) },
  body: JSON.stringify({ account_sync_id: account, desktop_client_id: `desktop-${runId}` }),
})).json()
if (!bootstrap.credential_id) throw new Error(`bootstrap failed: ${JSON.stringify(bootstrap)}`)
const desktop = { identity: `desktop-${runId}`, credential: bootstrap.credential_id, secret: bootstrap.credential_secret_base64 }

const sessionBody = JSON.stringify({ user_id: 'user-1', intended_device_id: `device-${runId}`, expires_in_seconds: 300 })
const session = await (await fetch(`${base}/v1/pairing-sessions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-solesystems-desktop-client-id': desktop.identity,
    ...sign('POST', '/v1/pairing-sessions', account, desktop.credential, desktop.identity, desktop.secret, sessionBody),
  },
  body: sessionBody,
})).json()
const claim = await (await fetch(`${base}/v1/pairing-claims`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pairing_token: session.pairing_token, account_sync_id: account, device_id: `device-${runId}` }),
})).json()
const mobile = { identity: `device-${runId}`, credential: claim.credential_id, secret: claim.credential_secret_base64 }

const channelPath = `/v1/accounts/${account}/channel`
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${channelPath}`, {
  headers: {
    'x-solesystems-desktop-client-id': desktop.identity,
    ...sign('GET', channelPath, account, desktop.credential, desktop.identity, desktop.secret),
  },
})
const messages = []
ws.on('message', d => { try { messages.push(JSON.parse(String(d))) } catch { /* ignore */ } })
await new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
  ws.on('unexpected-response', (_request, res) => reject(new Error(`upgrade ${res.statusCode}`)))
})
console.log('channel connected')

const payload = { note: `smoke-${runId}`, record_id: 'record-1' }
const packet = {
  protocol_version: 1, packet_id: `packet-${runId}`, packet_type: 'note_capture', account_sync_id: account,
  device_id: mobile.identity, user_id: 'user-1', created_at: new Date().toISOString(), client_sequence: 1,
  snapshot_version_seen: 0, entity_id: 'record-1', entity_revision_seen: null,
  idempotency_key: `idem-${runId}`, payload, attachments: [], payload_hash: sha256(stable(payload)),
}
const packetBody = JSON.stringify(packet)
const upload = await fetch(`${base}/v1/packets`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-solesystems-device-id': mobile.identity,
    ...sign('POST', '/v1/packets', account, mobile.credential, mobile.identity, mobile.secret, packetBody),
  },
  body: packetBody,
})
if (upload.status !== 201) throw new Error(`packet upload ${upload.status}`)

for (let i = 0; i < 50 && !messages.some(m => m.type === 'packets_pending'); i += 1) await new Promise(r => setTimeout(r, 100))
const poke = messages.find(m => m.type === 'packets_pending')
if (!poke) throw new Error(`no packets_pending frame; got ${JSON.stringify(messages)}`)
if (typeof poke.server_sequence !== 'number') throw new Error('poke frame missing server_sequence')

messages.length = 0
ws.send(JSON.stringify({ type: 'sync_check' }))
for (let i = 0; i < 30 && !messages.some(m => m.type === 'high_water'); i += 1) await new Promise(r => setTimeout(r, 100))
const highWater = messages.find(m => m.type === 'high_water')
if (!highWater || highWater.server_sequence !== poke.server_sequence) throw new Error(`sync_check mismatch: ${JSON.stringify(highWater)} vs ${poke.server_sequence}`)

ws.close()
console.log(`CHANNEL SMOKE PASS (${base}) — packets_pending seq ${poke.server_sequence}, sync_check ${highWater.server_sequence}`)
