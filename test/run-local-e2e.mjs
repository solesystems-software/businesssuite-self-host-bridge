// Local integration test for the bank-feed Worker's Stripe path (Stripe Financial Connections).
// Same approach as cloudflare-client-portal/test/run-local-e2e.mjs: apply schema.sql to a scratch local
// D1, boot a real `wrangler dev`, drive the routes over HTTP with the development shared-secret signing
// scheme, then inspect D1 directly. No Stripe call is made (development mock keys only); real-key
// behaviour is verified separately against Stripe's test mode.
//
// This package has no node_modules of its own; wrangler is borrowed from cloudflare-client-portal.
// Run with: node test/run-local-e2e.mjs (from cloudflare-bank-feeds/)

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import http from 'node:http'
import assert from 'node:assert/strict'

const wrangler = join(process.cwd(), '..', 'cloudflare-client-portal', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const databaseName = 'businesssuite-bank-feeds-dev'
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


// --- Stripe stub: stands in for api.stripe.com (the Worker's development-only STRIPE_API_BASE_URL
// override points at it). Only the remote service is stubbed; the Worker's own request handling, D1
// state, encryption and webhook verification are real.
const stripeState = {
  refreshIds: { fca_test_1: 'fctxnref_1', fca_test_2: 'fctxnref_1', fca_test_8: 'fctxnref_1' },
  subscribed: [],
  refreshStatus: {},
  accountStatus: {},
  sessionBodies: [],
  webhookDeleted: 0,
  transactions: {},
}
const webhookSigningSecret = 'whsec_localtest0000000000000001'
const stubAccount = (id, last4, status = stripeState.accountStatus[id] ?? 'active') => ({
  id,
  institution_name: 'StripeBank',
  display_name: `Checking ${last4}`,
  last4,
  category: 'cash',
  subcategory: 'checking',
  status,
  balance: { current: { usd: 100000 } },
  account_holder: { type: 'customer', customer: 'cus_test_1' },
  transaction_refresh: { id: stripeState.refreshIds[id], status: stripeState.refreshStatus[id] ?? 'succeeded' },
})
function startStripeStub() {
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://stub')
      const path = url.pathname
      const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
      if (request.method === 'GET' && path === '/balance') return send(200, { object: 'balance', livemode: false })
      if (request.method === 'POST' && path === '/webhook_endpoints') return send(200, { id: 'we_test_1', secret: webhookSigningSecret })
      if (request.method === 'DELETE' && path.startsWith('/webhook_endpoints/')) { stripeState.webhookDeleted += 1; return send(200, { deleted: true }) }
      if (request.method === 'POST' && path === '/customers') return send(200, { id: 'cus_test_1' })
      if (request.method === 'POST' && path === '/financial_connections/sessions') {
        stripeState.sessionBodies.push(Buffer.concat(chunks).toString())
        return send(200, { id: 'fcsess_test_1', client_secret: 'fcsess_client_secret_test_1', account_holder: { type: 'customer', customer: 'cus_test_1' } })
      }
      if (request.method === 'GET' && path === '/financial_connections/sessions/fcsess_test_1') {
        return send(200, { id: 'fcsess_test_1', status: 'succeeded', account_holder: { type: 'customer', customer: 'cus_test_1' } })
      }
      if (request.method === 'GET' && path === '/financial_connections/sessions/fcsess_inactive') {
        return send(200, { id: 'fcsess_inactive', status: 'succeeded', account_holder: { type: 'customer', customer: 'cus_test_1' } })
      }
      if (request.method === 'GET' && path === '/financial_connections/sessions/fcsess_other') {
        return send(200, { id: 'fcsess_other', status: 'succeeded', account_holder: { type: 'customer', customer: 'cus_someone_else' } })
      }
      if (request.method === 'GET' && path === '/financial_connections/accounts' && url.searchParams.get('session') === 'fcsess_inactive') {
        return send(200, { object: 'list', has_more: false, data: [stubAccount('fca_test_8', '8888', 'inactive')] })
      }
      if (request.method === 'GET' && path === '/financial_connections/accounts') {
        return send(200, { object: 'list', has_more: false, data: [stubAccount('fca_test_1', '1111'), stubAccount('fca_test_2', '2222')] })
      }
      const accountMatch = path.match(/^\/financial_connections\/accounts\/(fca_test_\d)(\/subscribe|\/disconnect)?$/)
      if (accountMatch && accountMatch[2] === '/subscribe') stripeState.subscribed.push(accountMatch[1])
      if (accountMatch) return send(200, stubAccount(accountMatch[1], accountMatch[1].endsWith('1') ? '1111' : '2222'))
      if (request.method === 'GET' && path === '/financial_connections/transactions') {
        const account = url.searchParams.get('account')
        const after = url.searchParams.get('transaction_refresh[after]')
        return send(200, { object: 'list', has_more: false, data: (stripeState.transactions[account] || []).filter(t => !after || t._refresh > after).map(({ _refresh, ...t }) => ({ ...t, transaction_refresh: _refresh })) })
      }
      return send(404, { error: { message: `stub: no route for ${request.method} ${path}` } })
    })
  })
  return new Promise((resolve, reject) => { server.listen(0, '127.0.0.1', () => resolve(server)); server.on('error', reject) })
}
const txn = (id, account, amount, status, refresh, description) => ({
  id, account, amount, currency: 'usd', description, status, transacted_at: 1758000000, updated: 1758000000, _refresh: refresh,
})

const temporary = await mkdtemp(join(tmpdir(), 'businesssuite-bank-feeds-'))
let worker
let stripeStub
try {
  stripeStub = await startStripeStub()
  const statePath = join(temporary, 'state')
  await run(['d1', 'execute', databaseName, '--local', '--persist-to', statePath, '--file', 'schema.sql'])

  const port = 8811
  const baseUrl = `http://127.0.0.1:${port}`
  worker = await startWorker(port, statePath, {
    STRIPE_API_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STRIPE_API_BASE_URL: `http://127.0.0.1:${stripeStub.address().port}`,
  })
  const accountIntegrationId = `stripe-keys-${randomUUID()}`

  // The Worker generates its own signing secret on the first authenticated request (nothing comes from
  // licensing). Trigger that with one deliberately mis-signed request, then read the secret out of D1 --
  // the same handoff the desktop performs at deploy time.
  async function rawSignedPost(pathname, body, secretBytes) {
    const text = JSON.stringify({ ...body, accountIntegrationId })
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID().replace(/-/g, '')
    const bodyHash = createHash('sha256').update(text, 'utf8').digest('hex')
    const signature = createHmac('sha256', secretBytes)
      .update(['POST', pathname, timestamp, nonce, accountIntegrationId, bodyHash].join('\n'), 'utf8')
      .digest('base64url')
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SoleSystems-Account-Id': accountIntegrationId,
        'X-SoleSystems-Timestamp': timestamp,
        'X-SoleSystems-Nonce': nonce,
        'X-SoleSystems-Signature': signature,
      },
      body: text,
    })
    return { status: response.status, json: await response.json() }
  }
  assert.equal((await rawSignedPost('/stripe/keys/status', {}, randomBytes(32))).status, 401, 'a wrongly signed request is refused')

  // The linking pages the desktop's Stripe window opens: public, secret-free, never frameable.
  const linkPage = await fetch(`${baseUrl}/stripe/link`)
  assert.equal(linkPage.status, 200)
  assert.match(linkPage.headers.get('content-type') || '', /text\/html/)
  assert.match(linkPage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
  const linkHtml = await linkPage.text()
  assert.match(linkHtml, /js\.stripe\.com\/v3/)
  assert.match(linkHtml, /collectFinancialConnectionsAccounts/)
  assert.match(linkHtml, /minimum-scale=1/)
  assert.equal((await fetch(`${baseUrl}/stripe/link/done?status=cancelled`)).status, 200)
  assert.equal((await fetch(`${baseUrl}/stripe/link`, { method: 'POST' })).status, 405)
  const secretRow = await queryFirst(statePath, 'SELECT request_signing_secret FROM bank_feed_worker_settings WHERE singleton_id = 1')
  assert.ok(secretRow?.request_signing_secret, 'signing secret bootstrapped into the Worker\'s own D1')
  const signingSecret = Buffer.from(secretRow.request_signing_secret, 'base64')

  async function signedPost(pathname, body) {
    const text = JSON.stringify({ ...body, accountIntegrationId })
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomUUID().replace(/-/g, '')
    const bodyHash = createHash('sha256').update(text, 'utf8').digest('hex')
    const signature = createHmac('sha256', signingSecret)
      .update(['POST', pathname, timestamp, nonce, accountIntegrationId, bodyHash].join('\n'), 'utf8')
      .digest('base64url')
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SoleSystems-Account-Id': accountIntegrationId,
        'X-SoleSystems-Timestamp': timestamp,
        'X-SoleSystems-Nonce': nonce,
        'X-SoleSystems-Signature': signature,
      },
      body: text,
    })
    return { status: response.status, json: await response.json() }
  }

  const readiness = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readiness.ok, true, JSON.stringify(readiness))
  assert.equal(readiness.stripeKeyEncryptionConfigured, true)
  assert.equal(readiness.stripeKeyStorageAvailable, true)

  const mockSecret = 'sk_test_mockbankfeed0000000001'
  const mockPublishable = 'pk_test_mockbankfeed0000000001'

  const save = await signedPost('/stripe/keys/save', { secretKey: mockSecret, publishableKey: mockPublishable })
  assert.equal(save.status, 200, JSON.stringify(save.json))
  assert.equal(save.json.mock, true)
  assert.equal(save.json.connection.keyKind, 'secret')
  assert.equal(JSON.stringify(save.json).includes(mockSecret), false, 'secret key must never be echoed')

  const status = await signedPost('/stripe/keys/status', {})
  assert.equal(status.status, 200)
  assert.equal(status.json.connection.connected, true)

  const stored = await queryFirst(statePath, `SELECT encrypted_secret_key, secret_key_iv FROM stripe_bank_feed_keys WHERE account_integration_id = '${accountIntegrationId}'`)
  assert.ok(stored?.encrypted_secret_key, 'row persisted')
  assert.equal(JSON.stringify(stored).includes('mockbankfeed'), false, 'key is stored encrypted, not in plaintext')

  const restricted = await signedPost('/stripe/keys/save', { secretKey: 'rk_test_mockbankfeed0000000002', publishableKey: mockPublishable })
  assert.equal(restricted.json.connection.keyKind, 'restricted')

  assert.equal((await signedPost('/stripe/keys/save', { secretKey: 'nope', publishableKey: mockPublishable })).status, 400)
  assert.equal((await signedPost('/stripe/keys/save', { secretKey: mockSecret, publishableKey: 'pk_live_mockbankfeed0000000001' })).status, 400)

  const removed = await signedPost('/stripe/keys/remove', {})
  assert.equal(removed.status, 200)
  const gone = await signedPost('/stripe/keys/status', {})
  assert.equal(gone.json.connection, null)

  // An unsigned request must be rejected.
  const unsigned = await fetch(`${baseUrl}/stripe/keys/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(unsigned.status, 401)


  // ---- Financial Connections flow against the Stripe stub (real-format key, so the Worker takes the
  // live path: /balance validation, webhook registration, Customer, Session, accounts, transactions).
  const liveKey = 'sk_test_stubbedrealformat0000001'
  const stubbedSave = await signedPost('/stripe/keys/save', { secretKey: liveKey, publishableKey: 'pk_test_stubbedrealformat0000001' })
  assert.equal(stubbedSave.status, 200, JSON.stringify(stubbedSave.json))
  assert.equal(stubbedSave.json.mock, false)
  assert.equal(stubbedSave.json.connection.webhookRegistered, true)

  const link = await signedPost('/stripe/link-session', {})
  assert.equal(link.status, 200, JSON.stringify(link.json))
  assert.equal(link.json.clientSecret, 'fcsess_client_secret_test_1')
  assert.equal(link.json.publishableKey, 'pk_test_stubbedrealformat0000001')
  // Session ownership: a session for someone else's Customer must be refused.
  const foreign = await signedPost('/stripe/connections/complete', { sessionId: 'fcsess_other' })
  assert.equal(foreign.status, 400)

  const complete = await signedPost('/stripe/connections/complete', { sessionId: 'fcsess_test_1' })
  assert.equal(complete.status, 200, JSON.stringify(complete.json))
  assert.equal(complete.json.provider, 'stripe')
  assert.equal(complete.json.accounts.length, 2)
  assert.equal(complete.json.accounts[0].mask, '1111')
  assert.equal(complete.json.replacedExistingConnection, false)
  const connectionId = complete.json.connectionId

  // First sync: everything after no cursor; the never-delivered void is skipped.
  stripeState.transactions.fca_test_1 = [
    txn('fctxn_1', 'fca_test_1', -2500, 'posted', 'fctxnref_1', 'Coffee Shop'),
    txn('fctxn_2', 'fca_test_1', -900, 'pending', 'fctxnref_1', 'Gas Station'),
    txn('fctxn_void', 'fca_test_1', -100, 'void', 'fctxnref_1', 'Voided'),
  ]
  stripeState.transactions.fca_test_2 = []
  const sync1 = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(sync1.status, 200, JSON.stringify(sync1.json))
  assert.equal(sync1.json.dataReady, true)
  assert.equal(sync1.json.addedCount, 2)
  assert.equal(sync1.json.removedCount, 0)
  assert.equal(sync1.json.addedRecords[0].amount, 25)
  assert.equal(sync1.json.addedRecords[0].isoCurrencyCode, 'USD')
  assert.equal(sync1.json.addedRecords[1].pending, true)
  const batchId = sync1.json.batchId

  const blocked = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.pendingBatchId, batchId)

  const wrongCounts = await signedPost('/stripe/transactions/acknowledge', { connectionId, batchId, persistedAddedCount: 1, persistedModifiedCount: 0, persistedRemovedCount: 0 })
  assert.equal(wrongCounts.status, 409)
  const ack = await signedPost('/stripe/transactions/acknowledge', { connectionId, batchId, persistedAddedCount: 2, persistedModifiedCount: 0, persistedRemovedCount: 0 })
  assert.equal(ack.status, 200, JSON.stringify(ack.json))
  assert.equal(ack.json.alreadyAcknowledged, false)
  const ackAgain = await signedPost('/stripe/transactions/acknowledge', { connectionId, batchId, persistedAddedCount: 2, persistedModifiedCount: 0, persistedRemovedCount: 0 })
  assert.equal(ackAgain.json.alreadyAcknowledged, true)

  // Nothing changed since the acknowledged cursor.
  const sync2 = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(sync2.json.dataReady, false)

  // A later refresh updates one transaction and voids another: modified -> added, void -> removed.
  stripeState.refreshIds.fca_test_1 = 'fctxnref_2'
  stripeState.transactions.fca_test_1 = [
    txn('fctxn_2', 'fca_test_1', -900, 'posted', 'fctxnref_2', 'Gas Station'),
    txn('fctxn_1', 'fca_test_1', -2500, 'void', 'fctxnref_2', 'Coffee Shop'),
  ]
  const sync3 = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(sync3.json.dataReady, true, JSON.stringify(sync3.json))
  assert.equal(sync3.json.addedCount, 1)
  assert.equal(sync3.json.removedCount, 1)
  assert.equal(sync3.json.removedRecords[0].providerTransactionId, 'fctxn_1')
  assert.equal(sync3.json.addedRecords[0].pending, false)
  await signedPost('/stripe/transactions/acknowledge', { connectionId, batchId: sync3.json.batchId, persistedAddedCount: 1, persistedModifiedCount: 0, persistedRemovedCount: 1 })

  // A refresh that is still pending or has failed must not abort the sync (Stripe errors when listing then).
  stripeState.refreshStatus.fca_test_1 = 'pending'
  stripeState.refreshStatus.fca_test_2 = 'failed'
  const syncSkipped = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(syncSkipped.status, 200, JSON.stringify(syncSkipped.json))
  assert.equal(syncSkipped.json.dataReady, false)
  stripeState.refreshStatus = {}

  // The Session must not ask for prefetch: Stripe's sandbox deactivates every account linked that way.
  assert.ok(stripeState.sessionBodies.length > 0)
  assert.ok(stripeState.sessionBodies.every(body => !body.includes('prefetch')), 'sessions are created without prefetch')
  assert.ok(stripeState.sessionBodies.every(body => body.includes('permissions')), 'sessions still request permissions')

  // Webhooks: verified with this account's own signing secret.
  const eventBody = JSON.stringify({ type: 'financial_connections.account.refreshed_transactions', data: { object: { id: 'fca_test_1' } } })
  const webhookTimestamp = Math.floor(Date.now() / 1000)
  const webhookSignature = createHmac('sha256', webhookSigningSecret).update(`${webhookTimestamp}.${eventBody}`).digest('hex')
  const webhookUrl = `${baseUrl}/stripe/webhooks/${encodeURIComponent(accountIntegrationId)}`
  const badWebhook = await fetch(webhookUrl, { method: 'POST', headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=${'0'.repeat(64)}` }, body: eventBody })
  assert.equal(badWebhook.status, 400)
  const goodWebhook = await fetch(webhookUrl, { method: 'POST', headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=${webhookSignature}` }, body: eventBody })
  assert.equal(goodWebhook.status, 200)
  const automatic = await signedPost('/stripe/transactions/automatic-status', {})
  assert.deepEqual(automatic.json.connectionIds, [connectionId])
  assert.equal(automatic.json.connections[0].lastWebhookCode, 'financial_connections.account.refreshed_transactions')

  // Per-account sync toggle and disconnect.
  const toggle = await signedPost('/stripe/connections/accounts/sync-enabled', { connectionId, providerAccountId: 'fca_test_2', syncEnabled: false })
  assert.equal(toggle.status, 200)
  assert.equal(toggle.json.syncEnabled, false)
  // An account Stripe has deactivated (its sandbox does so right after the first transactions refresh) still
  // delivers the refresh data Stripe holds; the connection is flagged, nothing is stranded.
  stripeState.accountStatus.fca_test_1 = 'inactive'
  stripeState.refreshIds.fca_test_1 = 'fctxnref_3'
  stripeState.transactions.fca_test_1 = [txn('fctxn_3', 'fca_test_1', -4200, 'posted', 'fctxnref_3', 'Hardware Store')]
  const syncInactive = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(syncInactive.status, 200, JSON.stringify(syncInactive.json))
  assert.equal(syncInactive.json.dataReady, true, JSON.stringify(syncInactive.json))
  assert.equal(syncInactive.json.addedRecords[0].amount, 42)
  await signedPost('/stripe/transactions/acknowledge', { connectionId, batchId: syncInactive.json.batchId, persistedAddedCount: 1, persistedModifiedCount: 0, persistedRemovedCount: 0 })
  stripeState.accountStatus = {}

  const disconnected = await signedPost('/stripe/connections/disconnect', { connectionId })
  assert.equal(disconnected.status, 200)
  assert.equal(disconnected.json.connectionStatus, 'disconnected')
  const afterDisconnect = await signedPost('/stripe/transactions/sync', { connectionId })
  assert.equal(afterDisconnect.status, 409)

  // Removing the key deletes this account's webhook endpoint from Stripe.
  // Stripe deactivating freshly linked accounts: the link result says so, nothing is subscribed, nothing is faked.
  const inactive = await signedPost('/stripe/connections/complete', { sessionId: 'fcsess_inactive' })
  assert.equal(inactive.status, 200, JSON.stringify(inactive.json))
  assert.equal(inactive.json.connectionStatus, 'needs_attention', 'no active account means the connection needs attention')
  assert.equal(inactive.json.accounts.length, 1)
  assert.equal(inactive.json.accounts[0].isActive, false)
  assert.ok(!stripeState.subscribed.includes('fca_test_8'), 'inactive accounts are not subscribed to transactions')
  assert.ok(stripeState.subscribed.includes('fca_test_1'), 'active accounts still are')

  await signedPost('/stripe/keys/remove', {})
  assert.ok(stripeState.webhookDeleted >= 1, 'webhook endpoint was deleted from Stripe on key removal')


  // ---- Independence from licensing: no licensing URL, secret or device credential exists on this Worker.
  const readinessAfter = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readinessAfter.requestSigningAvailable, true)
  assert.equal(readinessAfter.deviceCredentialAuthenticationConfigured, undefined)
  assert.equal(readinessAfter.developmentRequestSigningConfigured, undefined)
  // A request carrying device-credential headers is not a thing any more: it is just an unsigned/invalid request.
  const legacyDeviceStyle = await fetch(`${baseUrl}/stripe/keys/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SoleSystems-Account-Id': accountIntegrationId,
      'X-SoleSystems-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-SoleSystems-Nonce': randomUUID().replace(/-/g, ''),
      'X-SoleSystems-Signature': randomBytes(32).toString('base64url'),
      'X-SoleSystems-Device-Credential-Id': 'device-credential-local-0001',
      'X-SoleSystems-Device-Id': 'a'.repeat(64),
    },
    body: JSON.stringify({ accountIntegrationId }),
  })
  assert.equal(legacyDeviceStyle.status, 401)

  console.log('Bank-feed Stripe key and Financial Connections routes: all local checks passed.')
} finally {
  await stopWorker(worker)
  if (stripeStub) await new Promise(resolve => stripeStub.close(resolve))
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
