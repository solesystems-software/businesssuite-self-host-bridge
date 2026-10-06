// Local integration test for the Payments Worker. Same approach as the other Workers' local tests:
// apply schema.sql to a scratch local D1, boot a real `wrangler dev`, drive the routes over HTTP with
// the Worker's own HMAC business-request scheme (its signing secret is self-bootstrapped into D1 and
// read back out here), and inspect D1 directly. Stripe is stubbed by a local HTTP server that the
// Worker's development-only STRIPE_API_BASE_URL override points at; everything else is real.
//
// This package has no node_modules of its own; wrangler is borrowed from cloudflare-client-portal.
// Run with: node test/run-local-e2e.mjs (from cloudflare-payments/)

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import http from 'node:http'
import assert from 'node:assert/strict'

const wrangler = join(process.cwd(), '..', 'cloudflare-client-portal', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const databaseName = 'businesssuite-payments-dev'
const localCompatibilityDate = '2026-07-06'
const safeEnvironment = { ...process.env, NO_COLOR: '1' }

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: process.cwd(), env: safeEnvironment, windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  child.on('error', reject)
  child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`wrangler exited ${code}: ${output.slice(-3000)}`)))
})

async function queryFirst(statePath, sql) {
  const out = await run(['d1', 'execute', databaseName, '--local', '--persist-to', statePath, '--command', sql, '--json'])
  return JSON.parse(out)[0]?.results?.[0] ?? null
}

async function startWorker(port, statePath, vars) {
  const args = [wrangler, 'dev', '--port', String(port), '--persist-to', statePath, '--compatibility-date', localCompatibilityDate]
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`)
  const worker = spawn(process.execPath, args, { cwd: process.cwd(), env: safeEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  worker.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-6000) })
  worker.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-6000) })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return worker
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  worker.kill('SIGTERM')
  throw new Error(`Local Worker did not become ready.\n${output}`)
}

async function stopWorker(worker) {
  if (!worker || worker.exitCode !== null) return
  const exited = new Promise(resolve => worker.once('exit', resolve))
  worker.kill('SIGINT')
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
  if (worker.exitCode === null) worker.kill('SIGTERM')
}

// --- Stripe stub (api.stripe.com stand-in) ------------------------------------------------------------
const stripeState = { webhookDeleted: 0, intents: {} }
const webhookSigningSecret = 'whsec_localtest0000000000000001'
function startStripeStub() {
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const path = new URL(request.url, 'http://stub').pathname
      const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
      if (request.method === 'GET' && path === '/balance') return send(200, { object: 'balance', livemode: false })
      if (request.method === 'POST' && path === '/webhook_endpoints') return send(200, { id: 'we_test_1', secret: webhookSigningSecret })
      if (request.method === 'DELETE' && path.startsWith('/webhook_endpoints/')) { stripeState.webhookDeleted += 1; return send(200, { deleted: true }) }
      if (request.method === 'POST' && path === '/payment_intents') {
        const id = `pi_stub_${Object.keys(stripeState.intents).length + 1}`
        stripeState.intents[id] = { status: 'requires_payment_method' }
        return send(200, { id, client_secret: `${id}_secret_abc` })
      }
      const intentMatch = path.match(/^\/payment_intents\/(pi_stub_\d+)$/)
      if (request.method === 'GET' && intentMatch) return send(200, { id: intentMatch[1], status: stripeState.intents[intentMatch[1]]?.status ?? 'requires_payment_method' })
      return send(404, { error: { message: `stub: no route for ${request.method} ${path}` } })
    })
  })
  return new Promise((resolve, reject) => { server.listen(0, '127.0.0.1', () => resolve(server)); server.on('error', reject) })
}

const temporary = await mkdtemp(join(tmpdir(), 'businesssuite-payments-'))
let worker
let stripeStub
try {
  stripeStub = await startStripeStub()
  const statePath = join(temporary, 'state')
  await run(['d1', 'execute', databaseName, '--local', '--persist-to', statePath, '--file', 'schema.sql'])

  const port = 8821
  const baseUrl = `http://127.0.0.1:${port}`
  worker = await startWorker(port, statePath, {
    STRIPE_API_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STRIPE_API_BASE_URL: `http://127.0.0.1:${stripeStub.address().port}`,
  })
  const businessId = `payments-e2e-${randomUUID()}`

  // Bootstrap the self-generated signing secret with one deliberately mis-signed request, then read it.
  async function rawSignedPost(pathname, body, secretBytes) {
    const text = JSON.stringify({ ...body, businessId })
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID().replace(/-/g, '')
    const bodyHash = createHash('sha256').update(text, 'utf8').digest('hex')
    const signature = createHmac('sha256', secretBytes)
      .update(['POST', pathname, timestamp, nonce, businessId, bodyHash].join('\n'), 'utf8')
      .digest('base64url')
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SoleSystems-Business-Id': businessId,
        'X-SoleSystems-Timestamp': timestamp,
        'X-SoleSystems-Nonce': nonce,
        'X-SoleSystems-Signature': signature,
      },
      body: text,
    })
    return { status: response.status, json: await response.json() }
  }
  const unauthenticated = await rawSignedPost('/business/payment-gateway/status', {}, randomBytes(32))
  assert.equal(unauthenticated.status, 401, 'a wrongly signed request is refused')
  const secretRow = await queryFirst(statePath, 'SELECT request_signing_secret FROM payments_worker_settings WHERE singleton_id = 1')
  assert.ok(secretRow?.request_signing_secret, 'signing secret bootstrapped into D1')
  const signingSecret = Buffer.from(secretRow.request_signing_secret, 'base64')
  const post = (pathname, body = {}) => rawSignedPost(pathname, body, signingSecret)

  const readiness = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readiness.ok, true, JSON.stringify(readiness))
  assert.equal(readiness.stripeKeyEncryptionConfigured, true)
  assert.equal(readiness.requestSigningConfigured, true)

  // ---- Mock mode: key save, in-app payment, hosted link, list/acknowledge ----------------------------
  const mockSecret = 'sk_test_mockpayments0000000001'
  const mockPublishable = 'pk_test_mockpayments0000000001'
  const save = await post('/business/payment-gateway/stripe/save-key', { secretKey: mockSecret, publishableKey: mockPublishable })
  assert.equal(save.status, 200, JSON.stringify(save.json))
  assert.equal(save.json.mock, true)
  assert.equal(JSON.stringify(save.json).includes(mockSecret), false, 'secret key is never echoed')
  const stored = await queryFirst(statePath, `SELECT encrypted_secret_key FROM payments_stripe_api_keys WHERE business_id = '${businessId}'`)
  assert.equal(JSON.stringify(stored).includes('mockpayments'), false, 'key is stored encrypted')
  assert.equal((await post('/business/payment-gateway/stripe/save-key', { secretKey: 'nope', publishableKey: mockPublishable })).status, 400)

  const intent = await post('/business/payment-gateway/stripe/payment-intent', { invoiceRef: 'inv-1', amountCents: 24500, currency: 'usd' })
  assert.equal(intent.status, 200, JSON.stringify(intent.json))
  assert.match(intent.json.paymentIntentId, /^pi_mock_/)
  assert.equal(intent.json.mock, true)
  assert.match(intent.json.payEmbedUrl, /\/pay-embed#/)
  const pending = await post('/business/payment-gateway/payment-status', { paymentIntentId: intent.json.paymentIntentId })
  assert.equal(pending.json.payment.status, 'requires_payment')
  const mockComplete = await fetch(`${baseUrl}/payment-gateway/stripe/mock-complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentIntentId: intent.json.paymentIntentId }) })
  assert.equal(mockComplete.status, 200)
  const done = await post('/business/payment-gateway/payment-status', { paymentIntentId: intent.json.paymentIntentId })
  assert.equal(done.json.payment.status, 'succeeded')
  // In-app payments are not hosted-link payments and never appear in the link list.
  assert.deepEqual((await post('/business/payment-gateway/link-payments')).json.payments, [])

  const embedPage = await fetch(`${baseUrl}/pay-embed`)
  assert.equal(embedPage.status, 200)
  assert.match(await embedPage.text(), /js\.stripe\.com\/v3/)
  assert.equal(embedPage.headers.get('content-security-policy'), 'frame-ancestors *')

  // Hosted payment link: independent of Client Portal.
  const link1 = await post('/business/payment-gateway/payment-link', { invoiceRef: 'inv-2', amountCents: 9900, currency: 'usd', title: 'Invoice 2' })
  assert.equal(link1.status, 200, JSON.stringify(link1.json))
  assert.match(link1.json.token, /^[a-f0-9]{64}$/)
  assert.equal(link1.json.url, `${baseUrl}/pay/${link1.json.token}`)
  const linkPage = await fetch(link1.json.url)
  assert.equal(linkPage.status, 200)
  assert.match(await linkPage.text(), /\/pay\/' \+ linkMatch\[1\] \+ '\/intent/)
  const linkIntent = await fetch(`${link1.json.url}/intent`, { method: 'POST' }).then(r => r.json())
  assert.equal(linkIntent.ok, true, JSON.stringify(linkIntent))
  assert.equal(linkIntent.amountCents, 9900)
  assert.equal(linkIntent.title, 'Invoice 2')
  assert.equal(linkIntent.mock, true)
  const linkPaymentIntentId = linkIntent.clientSecret.split('_secret_')[0]
  assert.equal((await fetch(`${baseUrl}/payment-gateway/stripe/mock-complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentIntentId: linkPaymentIntentId }) })).status, 200)

  const listed = await post('/business/payment-gateway/link-payments')
  assert.equal(listed.json.payments.length, 1)
  assert.equal(listed.json.payments[0].invoiceRef, 'inv-2')
  assert.equal(listed.json.payments[0].method, 'payment_link')
  const acknowledged = await post('/business/payment-gateway/link-payments/acknowledge', { paymentIntentIds: [linkPaymentIntentId] })
  assert.equal(acknowledged.json.acknowledgedCount, 1)
  assert.deepEqual((await post('/business/payment-gateway/link-payments')).json.payments, [])
  // A paid link cannot be paid twice; a link for another invoice is independent.
  assert.equal((await fetch(`${link1.json.url}/intent`, { method: 'POST' })).status, 409)
  // A new link for the same invoice revokes the earlier one; a bogus token is not found.
  const link2 = await post('/business/payment-gateway/payment-link', { invoiceRef: 'inv-2', amountCents: 9900 })
  assert.equal((await fetch(`${baseUrl}/pay/${link1.json.token}/intent`, { method: 'POST' })).status, 404)
  assert.equal((await fetch(`${link2.json.url}/intent`, { method: 'POST' }).then(r => r.json())).ok, true)
  assert.equal((await fetch(`${baseUrl}/pay/${'0'.repeat(64)}/intent`, { method: 'POST' })).status, 404)

  // Another Business cannot read this Business's payments.
  const otherBusinessId = `payments-e2e-other-${randomUUID()}`
  const otherText = JSON.stringify({ businessId: otherBusinessId, paymentIntentId: intent.json.paymentIntentId })
  const otherTimestamp = Math.floor(Date.now() / 1000).toString()
  const otherNonce = randomUUID().replace(/-/g, '')
  const otherSignature = createHmac('sha256', signingSecret)
    .update(['POST', '/business/payment-gateway/payment-status', otherTimestamp, otherNonce, otherBusinessId, createHash('sha256').update(otherText).digest('hex')].join('\n')).digest('base64url')
  const other = await fetch(`${baseUrl}/business/payment-gateway/payment-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SoleSystems-Business-Id': otherBusinessId, 'X-SoleSystems-Timestamp': otherTimestamp, 'X-SoleSystems-Nonce': otherNonce, 'X-SoleSystems-Signature': otherSignature },
    body: otherText,
  })
  assert.equal(other.status, 404, 'payments are scoped to their own Business')

  // ---- Real-format key against the Stripe stub: validation, per-Business webhook, real intents -------
  const liveKey = 'sk_test_stubbedrealformat0000001'
  const stubbedSave = await post('/business/payment-gateway/stripe/save-key', { secretKey: liveKey, publishableKey: 'pk_test_stubbedrealformat0000001' })
  assert.equal(stubbedSave.status, 200, JSON.stringify(stubbedSave.json))
  assert.equal(stubbedSave.json.mock, false)
  assert.equal(stubbedSave.json.connection.webhookRegistered, true)

  const realIntent = await post('/business/payment-gateway/stripe/payment-intent', { invoiceRef: 'inv-3', amountCents: 5000 })
  assert.equal(realIntent.json.mock, false)
  assert.equal(realIntent.json.paymentIntentId, 'pi_stub_1')
  assert.equal(realIntent.json.publishableKey, 'pk_test_stubbedrealformat0000001')
  // The Worker reconciles with Stripe when polled before the webhook arrives.
  stripeState.intents.pi_stub_1.status = 'succeeded'
  assert.equal((await post('/business/payment-gateway/payment-status', { paymentIntentId: 'pi_stub_1' })).json.payment.status, 'succeeded')

  // A real link payment, completed by a signed webhook.
  const realLink = await post('/business/payment-gateway/payment-link', { invoiceRef: 'inv-4', amountCents: 7500 })
  const realLinkIntent = await fetch(`${realLink.json.url}/intent`, { method: 'POST' }).then(r => r.json())
  assert.equal(realLinkIntent.mock, false)
  const eventBody = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_stub_2' } } })
  const webhookTimestamp = Math.floor(Date.now() / 1000)
  const webhookUrl = `${baseUrl}/payment-gateway/stripe/webhook/${encodeURIComponent(businessId)}`
  const signWebhook = (secret) => createHmac('sha256', secret).update(`${webhookTimestamp}.${eventBody}`).digest('hex')
  assert.equal((await fetch(webhookUrl, { method: 'POST', headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=${'0'.repeat(64)}` }, body: eventBody })).status, 400)
  assert.equal((await fetch(webhookUrl, { method: 'POST', headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=${signWebhook(webhookSigningSecret)}` }, body: eventBody })).status, 200)
  const realListed = await post('/business/payment-gateway/link-payments')
  assert.deepEqual(realListed.json.payments.map(payment => payment.invoiceRef), ['inv-4'])

  // Removing the key deletes this Business's webhook endpoint from Stripe.
  await post('/business/payment-gateway/stripe/remove-key')
  assert.ok(stripeState.webhookDeleted >= 1, 'webhook endpoint was deleted from Stripe on key removal')
  assert.equal((await post('/business/payment-gateway/status', { provider: 'stripe' })).json.connection, null)

  console.log('Payments Worker: all local checks passed.')
} finally {
  await stopWorker(worker)
  if (stripeStub) await new Promise(resolve => stripeStub.close(resolve))
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
