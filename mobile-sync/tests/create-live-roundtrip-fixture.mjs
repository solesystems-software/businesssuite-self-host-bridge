import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const baseUrl = process.env.MOBILE_SYNC_TEST_BASE_URL
const bootstrapSecret = process.env.MOBILE_SYNC_TEST_BOOTSTRAP_SECRET
const outputPath = process.env.MOBILE_SYNC_LIVE_FIXTURE_PATH
if (!baseUrl || !bootstrapSecret || !outputPath) throw new Error('Required live fixture environment is not configured.')

const sha256 = value => createHash('sha256').update(value).digest('hex')
const nonce = () => randomBytes(18).toString('base64url')

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type':'application/json' }), ...headers },
    ...(body === undefined ? {} : { body:bodyText }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`Live fixture request failed with HTTP ${response.status}: ${result.error || 'unknown'}`)
  return result
}

async function signed(client, path, body) {
  const method = 'POST'
  const bodyText = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const requestNonce = nonce()
  const canonical = [method, path, timestamp, requestNonce, client.accountSyncId,
    client.credentialId, client.desktopClientId, sha256(bodyText)].join('\n')
  return request(path, { method, body, headers: {
    'x-solesystems-account-id':client.accountSyncId,
    'x-solesystems-credential-id':client.credentialId,
    'x-solesystems-desktop-client-id':client.desktopClientId,
    'x-solesystems-timestamp':timestamp,
    'x-solesystems-nonce':requestNonce,
    'x-solesystems-signature':createHmac('sha256', Buffer.from(client.credentialSecretBase64,'base64')).update(canonical).digest('base64url'),
  }})
}

const runId = randomUUID().slice(0, 12)
const runtimeRoot = path.dirname(outputPath)
const accountSyncId = `live-e2e-${runId}`
const desktopClientId = `desktop-live-${runId}`
const issuedAt = new Date().toISOString()
const bootstrapped = await request('/v1/dev/bootstrap', { method:'POST', headers:{
  'x-solesystems-bootstrap-secret':bootstrapSecret,
}, body:{account_sync_id:accountSyncId, desktop_client_id:desktopClientId} })
const desktopCredential = {
  version:1,
  accountSyncId,
  desktopClientId,
  credentialId:String(bootstrapped.credential_id),
  credentialSecretBase64:String(bootstrapped.credential_secret_base64),
  workerUrl:baseUrl,
  issuedAt,
  expiresAt:String(bootstrapped.expires_at),
}
const pairing = await signed(desktopCredential, '/v1/pairing-sessions', {
  user_id:'dev-user', expires_in_seconds:600,
})
writeFileSync(outputPath, JSON.stringify({
  accountSyncId,
  pairingToken:String(pairing.pairing_token),
  pairingExpiresAt:String(pairing.expires_at),
  desktopCredential,
  runtimeRoot,
  accountPath:path.join(runtimeRoot,'mobile-sync-live-e2e.bsa'),
  resultPath:path.join(runtimeRoot,'desktop-cycle-result.json'),
}), {encoding:'utf8', mode:0o600, flag:'wx'})
process.stdout.write('LIVE MOBILE SYNC FIXTURE CREATED\n')
