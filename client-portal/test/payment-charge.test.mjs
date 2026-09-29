// Payments_Gateway_Component_Task_Spec_20260829.md Part E Phase 3: live tests of the PaymentIntent /
// webhook / mock-complete / status flow against the deployed dev Worker in Stripe mock mode. Same
// "real, not stubbed" discipline as hardening.test.mjs; Stripe itself is stubbed by the Worker's own
// mock mode (STRIPE_* secrets absent) so the whole payment lifecycle is exercised deterministically.
//
// Requires the SOLESYSTEMS_CLIENT_PORTAL_* env vars (see .env.client-portal.development.local).
// Run with: node --test test/payment-charge.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'

const relayUrl = (process.env.SOLESYSTEMS_CLIENT_PORTAL_RELAY_URL || '').replace(/\/+$/, '')
const signingSecretBase64 = process.env.SOLESYSTEMS_CLIENT_PORTAL_SIGNING_SECRET || ''
const hasCredentials = Boolean(relayUrl && signingSecretBase64 && process.env.SOLESYSTEMS_CLIENT_PORTAL_BUSINESS_ID)
// Phase 5 (Payments_Gateway_Phases_3-5_Continuation_20260829.md): once the real STRIPE_* secrets are
// set, the deployed Worker leaves mock mode -- the synthetic-code OAuth callback and /mock-complete
// this file drives no longer exist there. Live-mode verification is the manual Phase 5 pass. Probe
// the deployed Worker and skip when it is live.
const workerLive = hasCredentials
  ? await fetch(`${relayUrl}/readiness`).then(r => r.json()).then(j => Boolean(j?.stripePaymentGatewayConfigured)).catch(() => false)
  : false
// A synthetic business id (signed with the same Worker-level shared secret) so this file's own
// connect/disconnect of the Stripe payment gateway never races payment-gateway.test.mjs, which runs
// concurrently against the real dev business id. Same "synthetic business, same secret" approach
// hardening.test.mjs uses for businessIdB.
const businessId = `payment-charge-test-business-${Date.now()}`
const secret = signingSecretBase64 ? Buffer.from(signingSecretBase64, 'base64') : Buffer.alloc(0)

function signedHeaders(method, path, bodyHash) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = randomUUID().replace(/-/g, '')
  const canonical = [method, path, timestamp, nonce, businessId, bodyHash].join('\n')
  const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url')
  return {
    'X-SoleSystems-Business-Id': businessId,
    'X-SoleSystems-Timestamp': timestamp,
    'X-SoleSystems-Nonce': nonce,
    'X-SoleSystems-Signature': signature,
  }
}

async function post(path, body) {
  const bodyText = JSON.stringify({ ...body, businessId })
  const bodyHash = createHash('sha256').update(bodyText, 'utf8').digest('hex')
  const response = await fetch(`${relayUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, bodyHash) },
    body: bodyText,
  })
  return { status: response.status, json: await response.json() }
}

async function connectStripeMock() {
  const start = await post('/business/payment-gateway/stripe/oauth-start', { provider: 'stripe' })
  assert.equal(start.status, 200)
  const state = new URL(start.json.authorizeUrl).searchParams.get('state')
  const callback = await fetch(`${relayUrl}/payment-gateway/stripe/oauth-callback?state=${state}&code=charge_test_${Date.now()}`)
  assert.equal(callback.status, 200)
}

test('Payment gateway Phase 3: in-app PaymentIntent -> mock-complete -> status', { skip: !hasCredentials || workerLive }, async (t) => {
  await connectStripeMock()

  const invoiceRef = `inv_charge_${Date.now()}`
  let paymentIntentId = ''

  await t.test('create a card_in_app PaymentIntent', async () => {
    const pi = await post('/business/payment-gateway/stripe/payment-intent', {
      invoiceRef, amountCents: 24500, currency: 'usd', method: 'card_in_app',
    })
    assert.equal(pi.status, 200, JSON.stringify(pi.json))
    assert.match(pi.json.paymentIntentId, /^pi_mock_/)
    assert.ok(pi.json.clientSecret.includes('_secret_'))
    assert.equal(pi.json.mock, true)
    assert.match(pi.json.payEmbedUrl, /\/pay-embed#/)
    assert.equal(pi.json.amountCents, 24500)
    paymentIntentId = pi.json.paymentIntentId
  })

  await t.test('status is requires_payment before completion', async () => {
    const s = await post('/business/payment-gateway/payment-status', { paymentIntentId })
    assert.equal(s.status, 200)
    assert.equal(s.json.payment.status, 'requires_payment')
    assert.equal(s.json.payment.invoiceRef, invoiceRef)
  })

  await t.test('mock-complete marks it succeeded', async () => {
    const mc = await fetch(`${relayUrl}/payment-gateway/stripe/mock-complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId }),
    })
    const body = await mc.json()
    assert.equal(mc.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'succeeded')

    const s = await post('/business/payment-gateway/payment-status', { paymentIntentId })
    assert.equal(s.json.payment.status, 'succeeded')
    assert.ok(s.json.payment.succeededAt)
  })

  await t.test('an unknown paymentIntent 404s on status', async () => {
    const s = await post('/business/payment-gateway/payment-status', { paymentIntentId: 'pi_mock_does_not_exist' })
    assert.equal(s.status, 404)
  })

  await t.test('the pay-embed page is served', async () => {
    const page = await fetch(`${relayUrl}/pay-embed`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(html, /js\.stripe\.com\/v3/)
    assert.match(html, /Invoice payment/)
  })

  await t.test('a webhook with no signature and real keys absent is accepted in mock mode', async () => {
    // In mock mode there is no STRIPE_WEBHOOK_SECRET; the handler accepts unsigned events rather than
    // 503, but only mock-mode payments exist to act on.
    const wh = await fetch(`${relayUrl}/payment-gateway/stripe/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_mock_irrelevant' } } }),
    })
    assert.equal(wh.status, 200)
  })

  await post('/business/payment-gateway/disconnect', { provider: 'stripe' })
})
