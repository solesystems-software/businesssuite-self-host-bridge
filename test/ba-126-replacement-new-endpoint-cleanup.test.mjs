// BA-126 (Bank Feeds Worker): when the local row write fails after the NEW webhook endpoint was registered, the new
// endpoint must be deleted from Stripe and the original write error rethrown. A failed delete of the OLD endpoint
// (after a successful replacement) must be logged and must not fail the key replacement.
//
// Run: node --experimental-strip-types --test test/ba-126-replacement-new-endpoint-cleanup.test.mjs
// Stripe, D1 and the broker signature check are faked in-process; nothing touches the network.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { registerHooks } from 'node:module'

const authenticationStub = `
export async function authenticateBrokerJsonRequest(request) {
  const body = await request.json()
  return { ok: true, request: { accountIntegrationId: body.accountIntegrationId, body } }
}
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './requestAuthentication') {
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

const { handleStripeSaveKey } = await import('../src/stripeBankFeedKeys.ts')
const { encryptStripeSecret } = await import('../src/stripeApiKeyCrypto.ts')

const accountIntegrationId = 'acct_test_0001'
const newSecretKey = 'sk_test_FakeReplacementKey0001'
const publishableKey = 'pk_test_FakePublishableKey0001'
const oldEndpointId = 'we_test_old0001'
const newEndpointId = 'we_test_new0001'
const encryptionKey = Buffer.alloc(32, 7).toString('base64')

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function createEnv(events, existingRow, { failUpsert = false } = {}) {
  const state = { row: existingRow ?? null }
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => (sql.includes('SELECT * FROM stripe_bank_feed_keys') ? state.row : null),
            run: async () => {
              if (sql.includes('INSERT INTO stripe_bank_feed_keys')) {
                events.push('db:upsert')
                if (failUpsert) throw new Error('D1 write failed')
                const [id, ciphertext, iv, version, keyKind, pubKey, livemode, webhookId, whCiphertext, whIv, whVersion, verified, created, updated] = args
                state.row = {
                  account_integration_id: id,
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

function createFakeStripe(events, { failOldDelete = false } = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url)
    const method = (init.method || 'GET').toUpperCase()
    events.push(`stripe:${method} ${parsed.pathname}`)
    if (parsed.pathname === '/v1/balance') return jsonResponse(200, { livemode: false })
    if (parsed.pathname === '/v1/webhook_endpoints' && method === 'POST') {
      return jsonResponse(200, { id: newEndpointId, secret: 'whsec_test_new0001' })
    }
    if (parsed.pathname === `/v1/webhook_endpoints/${newEndpointId}` && method === 'DELETE') {
      return jsonResponse(200, { id: newEndpointId, deleted: true })
    }
    if (parsed.pathname === `/v1/webhook_endpoints/${oldEndpointId}` && method === 'DELETE') {
      if (failOldDelete) throw new TypeError('fetch failed: network unreachable')
      return jsonResponse(200, { id: oldEndpointId, deleted: true })
    }
    return jsonResponse(404, { error: { message: `unexpected ${method} ${parsed.pathname}` } })
  }
}

async function seedExistingRow() {
  const encrypted = await encryptStripeSecret({ STRIPE_API_KEY_ENCRYPTION_KEY: encryptionKey }, { accountIntegrationId, kind: 'api_key' }, 'sk_test_FakeOldKey00001')
  return {
    account_integration_id: accountIntegrationId,
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
  return new Request('https://bank.example.test/stripe/keys/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountIntegrationId, secretKey: newSecretKey, publishableKey }),
  })
}

test('BA-126: a failed row write deletes the new endpoint, keeps the old one, and rethrows the write error', async () => {
  const events = []
  const existing = await seedExistingRow()
  const { env, state } = createEnv(events, existing, { failUpsert: true })
  globalThis.fetch = createFakeStripe(events)
  mock.method(console, 'error', () => {})
  try {
    await assert.rejects(handleStripeSaveKey(saveRequest(), env, 'req_test_upsert_fail'), /D1 write failed/)

    assert.ok(events.includes('stripe:POST /v1/webhook_endpoints'), 'the new endpoint was registered first')
    assert.ok(events.includes(`stripe:DELETE /v1/webhook_endpoints/${newEndpointId}`), 'the new endpoint is deleted after the failed write')
    assert.equal(events.includes(`stripe:DELETE /v1/webhook_endpoints/${oldEndpointId}`), false, 'the old endpoint is untouched')
    assert.equal(state.row, existing, 'the stored row is unchanged')
  } finally {
    mock.restoreAll()
  }
})

test('BA-126: a failed delete of the old endpoint is logged and does not fail the key replacement', async () => {
  const events = []
  const { env, state } = createEnv(events, await seedExistingRow())
  globalThis.fetch = createFakeStripe(events, { failOldDelete: true })
  const consoleError = mock.method(console, 'error', () => {})
  try {
    const response = await handleStripeSaveKey(saveRequest(), env, 'req_test_old_delete_fail')
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(state.row.webhook_endpoint_id, newEndpointId, 'the replacement is saved')
    assert.ok(events.includes(`stripe:DELETE /v1/webhook_endpoints/${oldEndpointId}`), 'the old endpoint delete was attempted')
    assert.ok(consoleError.mock.calls.length >= 1, 'the failure is logged')
    const logged = consoleError.mock.calls.map(call => call.arguments.map(String).join(' ')).join('\n')
    assert.ok(logged.includes(oldEndpointId), 'the log names the old endpoint id')
    assert.equal(logged.includes(newSecretKey), false, 'the log never contains the secret key')
  } finally {
    mock.restoreAll()
  }
})
