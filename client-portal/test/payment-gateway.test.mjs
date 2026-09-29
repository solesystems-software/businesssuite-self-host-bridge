// Payments_Gateway_Component_Task_Spec_20260829.md Part E Phase 1: real, live tests of the Stripe
// Connect OAuth skeleton (start -> mock callback -> status -> disconnect) against the actual deployed
// dev Worker -- the Node/test-runner counterpart to the desktop repo's Playwright suite, matching
// hardening.test.mjs's own "real, not stubbed" discipline. Stripe itself is stubbed here only because
// no real Stripe Connect application exists until Phase 5 -- the Worker's own mock mode (STRIPE_*
// secrets absent) makes the token exchange deterministic so this can assert exact values.
//
// Requires live relay credentials from the same SOLESYSTEMS_CLIENT_PORTAL_* environment variables the
// desktop app uses (see .env.client-portal.development.local, gitignored). Skips entirely if absent.
//
// Run with: node --test test/payment-gateway.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'

const relayUrl = (process.env.SOLESYSTEMS_CLIENT_PORTAL_RELAY_URL || '').replace(/\/+$/, '')
const signingSecretBase64 = process.env.SOLESYSTEMS_CLIENT_PORTAL_SIGNING_SECRET || ''
const businessId = process.env.SOLESYSTEMS_CLIENT_PORTAL_BUSINESS_ID || ''
const hasCredentials = Boolean(relayUrl && signingSecretBase64 && businessId)
// Phase 5 (Payments_Gateway_Phases_3-5_Continuation_20260829.md): the deployed Worker leaves mock
// mode once the real STRIPE_* secrets are set, and the synthetic-code OAuth callback this file drives
// then hits Stripe's real token endpoint (invalid_grant). Live verification is the manual Phase 5
// pass. Probe the deployed Worker and skip when it is live.
const workerLive = hasCredentials
  ? await fetch(`${relayUrl}/readiness`).then(r => r.json()).then(j => Boolean(j?.stripePaymentGatewayConfigured)).catch(() => false)
  : false

const signingSecretBytes = signingSecretBase64 ? Buffer.from(signingSecretBase64, 'base64') : Buffer.alloc(0)

function signedHeaders(method, pathname, bodyHash) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = randomUUID().replace(/-/g, '')
  const canonicalRequest = [method, pathname, timestamp, nonce, businessId, bodyHash].join('\n')
  const signature = createHmac('sha256', signingSecretBytes).update(canonicalRequest, 'utf8').digest('base64url')
  return {
    'X-SoleSystems-Business-Id': businessId,
    'X-SoleSystems-Timestamp': timestamp,
    'X-SoleSystems-Nonce': nonce,
    'X-SoleSystems-Signature': signature,
  }
}

async function signedPostJson(pathname, body) {
  const bodyText = JSON.stringify({ ...body, businessId })
  const bodyHash = createHash('sha256').update(bodyText, 'utf8').digest('hex')
  const response = await fetch(`${relayUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', pathname, bodyHash) },
    body: bodyText,
  })
  const json = await response.json()
  return { status: response.status, json }
}

function expectedMockAccountId(code) {
  const hex = createHash('sha256').update(code, 'utf8').digest('hex')
  return `acct_mock_${hex.slice(0, 16)}`
}

async function runOAuthConnect(code) {
  const start = await signedPostJson('/business/payment-gateway/stripe/oauth-start', { provider: 'stripe' })
  assert.equal(start.status, 200, `oauth-start failed: ${JSON.stringify(start.json)}`)
  assert.ok(start.json.authorizeUrl.startsWith('https://connect.stripe.com/oauth/v2/authorize?'), 'authorizeUrl points at Stripe Connect authorize')
  assert.match(start.json.state, /^[a-f0-9]{64}$/, 'state is a 64-hex token')
  assert.equal(start.json.mock, true, 'Worker is in Stripe mock mode (no real STRIPE_* secrets yet)')

  const authorizeUrl = new URL(start.json.authorizeUrl)
  assert.equal(authorizeUrl.searchParams.get('state'), start.json.state)
  assert.equal(authorizeUrl.searchParams.get('scope'), 'read_write')
  assert.equal(authorizeUrl.searchParams.get('response_type'), 'code')

  const callback = await fetch(`${relayUrl}/payment-gateway/stripe/oauth-callback?state=${start.json.state}&code=${encodeURIComponent(code)}`)
  const callbackHtml = await callback.text()
  assert.equal(callback.status, 200, `callback failed: ${callbackHtml}`)
  assert.match(callbackHtml, /Stripe connected/, 'callback renders the success page')

  return start.json.state
}

test('Payment gateway Phase 1: Stripe Connect OAuth skeleton', { skip: !hasCredentials || workerLive }, async (t) => {
  const code = `phase1_test_${Date.now()}`

  await t.test('connect: start -> callback -> status reports the mock connected account', async () => {
    await runOAuthConnect(code)

    const status = await signedPostJson('/business/payment-gateway/status', { provider: 'stripe' })
    assert.equal(status.status, 200)
    assert.ok(status.json.connection, 'a connection row exists after the callback')
    assert.equal(status.json.connection.connected, true)
    assert.equal(status.json.connection.provider, 'stripe')
    assert.equal(status.json.connection.connectedAccountId, expectedMockAccountId(code))
    assert.equal(status.json.connection.livemode, false)
  })

  await t.test('replaying a consumed state callback is rejected', async () => {
    // Re-run a callback with a fresh state, then replay that exact URL.
    const replayCode = `${code}_replay`
    const state = await runOAuthConnect(replayCode)
    const replay = await fetch(`${relayUrl}/payment-gateway/stripe/oauth-callback?state=${state}&code=${encodeURIComponent(replayCode)}`)
    const replayHtml = await replay.text()
    assert.equal(replay.status, 400, 'a consumed state must not be reusable')
    assert.match(replayHtml, /already been used|expired/i)
  })

  await t.test('an unknown state value is rejected', async () => {
    const bogusState = createHash('sha256').update(`bogus_${Date.now()}`).digest('hex')
    const response = await fetch(`${relayUrl}/payment-gateway/stripe/oauth-callback?state=${bogusState}&code=whatever`)
    assert.equal(response.status, 400)
  })

  await t.test('disconnect clears the connection; status then reports nothing connected', async () => {
    const disconnect = await signedPostJson('/business/payment-gateway/disconnect', { provider: 'stripe' })
    assert.equal(disconnect.status, 200, `disconnect failed: ${JSON.stringify(disconnect.json)}`)
    assert.ok(disconnect.json.disconnectedAt || disconnect.json.alreadyDisconnected)

    const status = await signedPostJson('/business/payment-gateway/status', { provider: 'stripe' })
    assert.equal(status.status, 200)
    assert.equal(status.json.connection, null, 'no active connection after disconnect')
  })

  await t.test('reconnecting after a disconnect updates the same row back to connected', async () => {
    const reconnectCode = `${code}_reconnect`
    await runOAuthConnect(reconnectCode)

    const status = await signedPostJson('/business/payment-gateway/status', { provider: 'stripe' })
    assert.equal(status.status, 200)
    assert.ok(status.json.connection)
    assert.equal(status.json.connection.connected, true)
    assert.equal(status.json.connection.connectedAccountId, expectedMockAccountId(reconnectCode))

    // Leave the shared dev business in a clean state for other suites.
    await signedPostJson('/business/payment-gateway/disconnect', { provider: 'stripe' })
  })

  await t.test('an unsupported provider is rejected at start', async () => {
    const start = await signedPostJson('/business/payment-gateway/stripe/oauth-start', { provider: 'square' })
    assert.equal(start.status, 400)
  })
})
