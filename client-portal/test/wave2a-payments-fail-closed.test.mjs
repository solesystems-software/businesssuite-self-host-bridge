// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: exercises the payments
// "fail closed" gate (stripePaymentsAvailable/paymentsUnavailableResponse, paymentGatewayRoutes.ts)
// against a real running Worker with SERVICE_ENVIRONMENT overridden away from "development" and no
// Stripe secrets configured -- the design doc's resolved case: any non-development deployment with no
// real Stripe credentials must return "payments unavailable", never the old silent mock success. Not
// run directly; invoked as a child process by test/run-local-e2e.mjs, which seeds the D1 fixtures
// (a business/client/grant/published-payment) directly since the business-authenticated publish
// route is unaffected by this task and stays development-only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'

const baseUrl = (process.env.WAVE2A_BASE_URL || '').replace(/\/+$/, '')
const inviteToken = process.env.WAVE2A_INVITE_TOKEN || ''
const businessId = process.env.WAVE2A_BUSINESS_ID || ''

assert.ok(baseUrl && inviteToken && businessId, 'WAVE2A_BASE_URL/INVITE_TOKEN/BUSINESS_ID must be set by run-local-e2e.mjs')

test('readiness reports the overridden non-development environment', async () => {
  const readiness = await fetch(`${baseUrl}/readiness`).then(r => r.json())
  assert.equal(readiness.ok, true)
  assert.equal(readiness.environment, 'wave2a-self-hosted-probe')
  assert.equal(readiness.stripePaymentGatewayConfigured, false)
})

test('client-facing payment-intent creation fails closed with "payments unavailable", not a mock success', async () => {
  const response = await fetch(`${baseUrl}/portal/${inviteToken}/payment-intent`, { method: 'POST' })
  const json = await response.json()
  assert.equal(response.status, 503, `expected 503, got ${response.status}: ${JSON.stringify(json)}`)
  assert.equal(json.ok, false)
  assert.match(json.message, /payments are not available/i)
  assert.equal(json.mock, undefined, 'a fail-closed response must never carry a mock payment intent')
  assert.equal(json.clientSecret, undefined, 'a fail-closed response must never carry a mock payment intent')
})

test('sanity: the business-authenticated publish route is still development-only (unrelated to this task, must not have been loosened)', async () => {
  const bodyText = JSON.stringify({
    businessId,
    clientId: 'payments-fail-closed-client',
    portalContextId: 'payments-fail-closed-context',
    snapshot: { title: 'Should never be reached' },
  })
  const response = await fetch(`${baseUrl}/business/publish-snapshot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SoleSystems-Business-Id': businessId,
      'X-SoleSystems-Timestamp': Math.floor(Date.now() / 1000).toString(),
      'X-SoleSystems-Nonce': randomUUID().replace(/-/g, ''),
      'X-SoleSystems-Signature': createHmac('sha256', Buffer.alloc(32)).update('irrelevant').digest('base64url'),
    },
    body: bodyText,
  })
  assert.equal(response.status, 401)
})
