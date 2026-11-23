// BA-052 (Payments Worker): saving a replacement Stripe key must register the NEW payment webhook endpoint
// first, then (only after the new endpoint is registered and the row rewritten) delete the OLD endpoint. A failed
// registration must keep the old endpoint and the stored row untouched.
//
// Run: node --experimental-strip-types --test test/stripe-api-key-replacement-ordering.test.mjs
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

const { handleStripeSaveKey } = await import('../src/stripeApiKeys.ts')
const { encryptStripeSecret } = await import('../src/stripeApiKeyCrypto.ts')

const businessId = 'biz_test_0001'
const newSecretKey = 'sk_test_FakeReplacementKey0001'
const publishableKey = 'pk_test_FakePublishableKey0001'
const oldEndpointId = 'we_test_old0001'
const newEndpointId = 'we_test_new0001'
const encryptionKey = Buffer.alloc(32, 7).toString('base64')

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function createEnv(events, existingRow) {
  const state = { row: existingRow ?? null }
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => (sql.includes('SELECT * FROM payments_stripe_api_keys') ? state.row : null),
            run: async () => {
              if (sql.includes('INSERT INTO payments_stripe_api_keys')) {
                events.push('db:upsert')
                const [id, ciphertext, iv, version, keyKind, pubKey, livemode, webhookId, whCiphertext, whIv, whVersion, verified, created, updated] = args
                state.row = {
                  business_id: id,
                  encrypted_secret_key: ciphertext,
                  secret_key_iv: iv,
                  secret_key_version: version,
                  key_kind: keyKind,
                  publishable_key: pubKey,
                  livemode,
                  webhook_endpoint_id: webhookId,
                  encrypted_webhook_secret: whCiphertext,
                  webhook_secret_iv: whIv,
                  webhook_secret_version: whVersion,
                  last_verified_at: verified,
                  created_at: created,
                  updated_at: updated,
                }
              }
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }
  return {
    state,
    env: { DB, SERVICE_ENVIRONMENT: 'production', STRIPE_API_KEY_ENCRYPTION_KEY: encryptionKey },
  }
}

function createFakeStripe(events, { failRegistration = false } = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url)
    const method = (init.method || 'GET').toUpperCase()
    events.push(`stripe:${method} ${parsed.pathname}`)
    if (parsed.pathname === '/v1/balance') return jsonResponse(200, { livemode: false })
    if (parsed.pathname === '/v1/webhook_endpoints' && method === 'POST') {
      if (failRegistration) return jsonResponse(403, { error: { message: 'The provided key does not have write access to webhook endpoints.' } })
      return jsonResponse(200, { id: newEndpointId, secret: 'whsec_test_new0001' })
    }
    if (parsed.pathname === `/v1/webhook_endpoints/${oldEndpointId}` && method === 'DELETE') {
      return jsonResponse(200, { id: oldEndpointId, deleted: true })
    }
    return jsonResponse(404, { error: { message: `unexpected ${method} ${parsed.pathname}` } })
  }
}

async function seedExistingRow() {
  const encrypted = await encryptStripeSecret({ STRIPE_API_KEY_ENCRYPTION_KEY: encryptionKey }, { businessId, kind: 'api_key' }, 'sk_test_FakeOldKey00001')
  return {
    business_id: businessId,
    encrypted_secret_key: encrypted.ciphertext,
    secret_key_iv: encrypted.iv,
    secret_key_version: encrypted.version,
    key_kind: 'secret',
    publishable_key: publishableKey,
    livemode: 0,
    webhook_endpoint_id: oldEndpointId,
    encrypted_webhook_secret: null,
    webhook_secret_iv: null,
    webhook_secret_version: null,
    last_verified_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function saveRequest() {
  return new Request('https://payments.example.test/business/payment-gateway/stripe/save-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessId, secretKey: newSecretKey, publishableKey }),
  })
}

test('replacement: registers the new endpoint, saves the row, then deletes the old endpoint', async () => {
  const events = []
  const { env, state } = createEnv(events, await seedExistingRow())
  globalThis.fetch = createFakeStripe(events)

  const response = await handleStripeSaveKey(saveRequest(), env, 'req_test_replace')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.connection.webhookRegistered, true)
  assert.equal(state.row.webhook_endpoint_id, newEndpointId)

  const registerIndex = events.indexOf('stripe:POST /v1/webhook_endpoints')
  const saveIndex = events.indexOf('db:upsert')
  const deleteIndex = events.indexOf(`stripe:DELETE /v1/webhook_endpoints/${oldEndpointId}`)
  assert.ok(registerIndex >= 0, 'new endpoint is registered')
  assert.ok(saveIndex > registerIndex, 'row is rewritten only after the new endpoint exists')
  assert.ok(deleteIndex > saveIndex, 'old endpoint is deleted only after the new one is saved')
  assert.equal(events.filter(event => event.startsWith('stripe:DELETE')).length, 1)
})

test('failed registration: returns 502, keeps the old endpoint on Stripe and the stored row unchanged', async () => {
  const events = []
  const existing = await seedExistingRow()
  const { env, state } = createEnv(events, existing)
  globalThis.fetch = createFakeStripe(events, { failRegistration: true })

  const response = await handleStripeSaveKey(saveRequest(), env, 'req_test_fail')

  assert.equal(response.status, 502)
  assert.ok(events.includes('stripe:POST /v1/webhook_endpoints'))
  assert.equal(events.some(event => event.startsWith('stripe:DELETE')), false, 'the old endpoint must not be deleted')
  assert.equal(events.includes('db:upsert'), false, 'the row must not be rewritten')
  assert.equal(state.row, existing)
  assert.equal(state.row.webhook_endpoint_id, oldEndpointId)
})

test('first-time save (no existing row) registers and deletes nothing', async () => {
  const events = []
  const { env, state } = createEnv(events, null)
  globalThis.fetch = createFakeStripe(events)

  const response = await handleStripeSaveKey(saveRequest(), env, 'req_test_first')

  assert.equal(response.status, 200)
  assert.equal(state.row.webhook_endpoint_id, newEndpointId)
  assert.equal(events.some(event => event.startsWith('stripe:DELETE')), false)
})
