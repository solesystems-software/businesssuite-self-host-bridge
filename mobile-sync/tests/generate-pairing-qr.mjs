import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'

const baseUrl = (process.env.MOBILE_SYNC_BASE_URL || 'https://businesssuite-mobile-sync-dev.solebusinesssuite-selfhostbridge-dev.workers.dev').replace(/\/+$/, '')
const bootstrapSecret = process.env.MOBILE_SYNC_BOOTSTRAP_SECRET
const accountSyncId = process.env.MOBILE_SYNC_ACCOUNT_SYNC_ID
const deviceId = process.env.MOBILE_SYNC_DEVICE_ID || `android-pairing-${randomBytes(4).toString('hex')}`
const userId = process.env.MOBILE_SYNC_USER_ID || 'user-1'
if (!bootstrapSecret || !accountSyncId) {
  throw new Error('Set MOBILE_SYNC_BOOTSTRAP_SECRET and MOBILE_SYNC_ACCOUNT_SYNC_ID (the bootstrap secret is read from env, never printed).')
}

const sha256 = value => createHash('sha256').update(value).digest('hex')
const nonce = () => randomBytes(18).toString('base64url')

async function raw(path, { method = 'GET', body, headers = {}, expected = [200] } = {}) {
  const requestBody = body === undefined ? undefined : JSON.stringify(body)
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: requestBody } : {}),
  })
  const result = (response.headers.get('content-type') || '').includes('application/json') ? await response.json().catch(() => ({})) : {}
  if (!expected.includes(response.status)) throw new Error(`HTTP ${response.status} for ${method} ${path}: ${result?.error || 'unknown'}`)
  return { status: response.status, body: result }
}

async function bootstrap() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await raw('/v1/dev/bootstrap', {
      method: 'POST', expected: [201, 401],
      headers: { 'x-solesystems-bootstrap-secret': bootstrapSecret },
      body: { account_sync_id: accountSyncId, desktop_client_id: `desktop-pairing-${randomBytes(4).toString('hex')}` },
    })
    if (result.status === 201) {
      return { account: accountSyncId, identity: `desktop-pairing-${result.body.credential_id}`.slice(0, 40),
        credential: result.body.credential_id, secret: result.body.credential_secret_base64,
        // deployed-e2e.mjs uses the desktop_client_id it sent as identity; keep it consistent:
        sentIdentity: result.body.desktop_client_id }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('Bootstrap secret did not become ready.')
}

async function signed(client, path, { method = 'GET', body, expected = [200] } = {}) {
  const bodyValue = body === undefined ? '' : JSON.stringify(body)
  const ts = String(Math.floor(Date.now() / 1000))
  const n = nonce()
  const canonical = [method, path, ts, n, client.account, client.credential, client.identity, sha256(bodyValue)].join('\n')
  const signature = createHmac('sha256', Buffer.from(client.secret, 'base64')).update(canonical).digest('base64url')
  return raw(path, { method, body, expected, headers: {
    'x-solesystems-account-id': client.account,
    'x-solesystems-credential-id': client.credential,
    'x-solesystems-desktop-client-id': client.identity,
    'x-solesystems-timestamp': ts,
    'x-solesystems-nonce': n,
    'x-solesystems-signature': signature,
  } })
}

const desktop = await bootstrap()
// The Worker signs against the desktop_client_id it issued the credential for.
desktop.identity = desktop.sentIdentity || desktop.identity

const created = await signed(desktop, '/v1/pairing-sessions', {
  method: 'POST', expected: [201],
  body: { user_id: userId, intended_device_id: deviceId, expires_in_seconds: 600 },
})
const pairingToken = created.body.pairing_token
const expiresAt = created.body.expires_at || '(unknown)'

const uri = `solesystems-mobilesync://pair?u=${encodeURIComponent(baseUrl)}&a=${encodeURIComponent(accountSyncId)}&t=${encodeURIComponent(pairingToken)}`

const scratchDir = join(process.cwd(), 'tests', '.scratch')
mkdirSync(scratchDir, { recursive: true })
const pngPath = join(scratchDir, `pairing-qr-${Date.now()}.png`)
await QRCode.toFile(pngPath, uri, { errorCorrectionLevel: 'M', margin: 2, width: 512 })

qrcodeTerminal.generate(uri, { small: true }, code => {
  process.stdout.write(`\nScan this with the Business Suite Mobile dev build (Settings → System → Development pairing → Scan pairing QR):\n\n${code}\n`)
})
process.stdout.write([
  '',
  `PNG written to: ${pngPath}`,
  '',
  'Manual fallback (Enter manually):',
  `  Worker URL:      ${baseUrl}`,
  `  Account sync ID: ${accountSyncId}`,
  `  Pairing token:   ${pairingToken}`,
  `  Device ID:       ${deviceId}`,
  `  Token expires:   ${expiresAt}`,
  '',
].join('\n'))
