// BA-056 (Payments Worker): the PaymentIntent must not offer redirect-based payment methods (Cash App Pay, Klarna,
// Affirm, bank redirects). The embedded page confirms with return_url = /pay-embed and reads only the URL fragment,
// so a redirect return would land on "This payment link is missing its details." with no confirmation shown.
// Fix: automatic_payment_methods[allow_redirects]=never is sent alongside automatic_payment_methods[enabled]=true.
//
// Run: node --experimental-strip-types --test test/ba-056-redirect-payment-methods.test.mjs
// Stripe, D1 and the HMAC business-auth check are faked in-process; nothing touches the network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// Extensionless relative imports (as used by the Worker sources) resolve to .ts for plain-Node loading.
// The business-auth check is replaced by a stub that accepts the body's businessId.
const authenticationStub = `
export async function authenticateBusinessJsonRequest(request) {
  const body = await request.json()
  return { ok: true, request: { businessId: body.businessId, body } }
}
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './paymentsRequestAuthentication') {
      return { url: `data:text/javascript,${encodeURIComponent(authenticationStub)}`, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})

const { handleCreateBusinessPaymentIntent } = await import('../src/paymentRoutes.ts')
const { encryptStripeSecret } = await import('../src/stripeApiKeyCrypto.ts')

const businessId = 'biz_test_0056'
const secretKey = 'sk_test_FakeBa056Key00001'
const publishableKey = 'pk_test_FakeBa056Publishable1'
const encryptionKey = Buffer.alloc(32, 9).toString('base64')

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function seedStripeRow() {
  const encrypted = await encryptStripeSecret({ STRIPE_API_KEY_ENCRYPTION_KEY: encryptionKey }, { businessId, kind: 'api_key' }, secretKey)
  return {
    business_id: businessId,
    encrypted_secret_key: encrypted.ciphertext,
    secret_key_iv: encrypted.iv,
    secret_key_version: encrypted.version,
    key_kind: 'secret',
    publishable_key: publishableKey,
    livemode: 0,
    webhook_endpoint_id: null,
    encrypted_webhook_secret: null,
    webhook_secret_iv: null,
    webhook_secret_version: null,
    last_verified_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function createEnv(row) {
  const DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => (sql.includes('FROM payments_stripe_api_keys') ? row : null),
            run: async () => ({ meta: { changes: 1 } }),
          }
        },
      }
    },
  }
  return { DB, SERVICE_ENVIRONMENT: 'production', STRIPE_API_KEY_ENCRYPTION_KEY: encryptionKey }
}

// Captures the form body sent to Stripe's PaymentIntent endpoint.
function installFakeStripe(captured) {
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/v1/payment_intents' && (init.method || 'GET').toUpperCase() === 'POST') {
      captured.push(new URLSearchParams(String(init.body)))
      return jsonResponse(200, { id: 'pi_test_ba056', client_secret: 'pi_test_ba056_secret_fake' })
    }
    return jsonResponse(404, { error: { message: `unexpected ${parsed.pathname}` } })
  }
}

function intentRequest() {
  return new Request('https://payments.example.test/business/payment-gateway/stripe/payment-intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessId, invoiceRef: 'INV-BA056', amountCents: 2500, currency: 'usd' }),
  })
}

test('BA-056: the PaymentIntent enables automatic methods but forbids redirect-based methods', async () => {
  const captured = []
  installFakeStripe(captured)

  const response = await handleCreateBusinessPaymentIntent(intentRequest(), createEnv(await seedStripeRow()), 'req_ba056')
  assert.equal(response.status, 200)
  assert.equal(captured.length, 1, 'exactly one PaymentIntent is created')

  const form = captured[0]
  assert.equal(form.get('automatic_payment_methods[enabled]'), 'true')
  assert.equal(form.get('automatic_payment_methods[allow_redirects]'), 'never',
    'redirect-based methods must be excluded so the payer never returns to /pay-embed with query-string results')
})

test('BA-056: the payer stays on the embedded page; the returned fragment carries the client secret the page reads', async () => {
  const captured = []
  installFakeStripe(captured)

  const response = await handleCreateBusinessPaymentIntent(intentRequest(), createEnv(await seedStripeRow()), 'req_ba056_url')
  const body = await response.json()

  // The page reads only the fragment (cs=...). A redirect return would carry payment_intent_client_secret in the
  // query string instead; with redirects disabled the flow stays on the fragment path.
  const payEmbed = new URL(body.payEmbedUrl)
  assert.equal(payEmbed.pathname, '/pay-embed')
  assert.equal(payEmbed.search, '')
  assert.equal(new URLSearchParams(payEmbed.hash.replace(/^#/, '')).get('cs'), 'pi_test_ba056_secret_fake')
  assert.equal(captured[0].get('automatic_payment_methods[allow_redirects]'), 'never')
})
