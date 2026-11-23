// BA-053: disconnecting a Plaid connection whose Item is already gone at Plaid ("Item not found" and similar)
// must still release the local connection. Any other Plaid failure must keep the local row and return an error.
//
// Run: node --experimental-strip-types --test test/plaid-disconnect-item-gone.test.mjs
// Plaid is faked with a global fetch stub (the real plaidClient.ts runs); D1 and the broker signature check are
// replaced in-process. Nothing touches the network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

const calls = { marked: [] }
globalThis.__baTestCalls = calls

// The broker signature check is stubbed: it accepts the body's accountIntegrationId.
const authenticationStub = `
export async function authenticateBrokerJsonRequest(request) {
  const body = await request.json()
  return { ok: true, request: { accountIntegrationId: body.accountIntegrationId, body } }
}
`
// The repository is stubbed so the test controls the stored connection and records the local release.
const repositoryStub = `
export class BankFeedAccountNotFoundError extends Error {}
export class BankFeedAccountStorageValidationError extends Error {}
export class BankFeedAccountSyncStateUnavailableError extends Error {}
export class BankFeedConnectionNotFoundError extends Error {}
export async function savePlaidConnection() { throw new Error('not used by this test') }
export async function setStoredPlaidAccountSyncEnabled() { throw new Error('not used by this test') }
export async function getStoredPlaidConnectionCredentials() {
  return {
    accountIntegrationId: 'acct_test_0001',
    connectionId: 'conn_test_0001',
    providerItemId: 'item_test_0001',
    encryptedAccessToken: 'ciphertext-not-used',
    accessTokenIv: 'iv-not-used',
    accessTokenKeyVersion: 1,
    connectionStatus: 'active',
  }
}
export async function markPlaidConnectionDisconnected(env, accountIntegrationId, connectionId, disconnectedAt) {
  globalThis.__baTestCalls.marked.push({ accountIntegrationId, connectionId, disconnectedAt })
}
`
// Token decryption is not under test here; the stub returns a fixed fake access token.
const accessTokenStub = `
export class AccessTokenEncryptionConfigurationError extends Error {}
export class AccessTokenDecryptionError extends Error {}
export async function decryptPlaidAccessToken() { return 'access-sandbox-fake-token' }
`
const stubs = new Map([
  ['./requestAuthentication', authenticationStub],
  ['./bankFeedWorkerConnectionsRepository', repositoryStub],
  ['./accessTokenCrypto', accessTokenStub],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubs.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})

const { handleDisconnectPlaidConnection } = await import('../src/connectionLifecycleRoutes.ts')

const env = {
  SERVICE_ENVIRONMENT: 'production',
  PLAID_ENVIRONMENT: 'sandbox',
  PLAID_CLIENT_ID: 'client_test_fake',
  PLAID_SECRET: 'secret_test_fake',
}

function plaidErrorFetch(errorCode) {
  const seen = []
  const fetchStub = async (url) => {
    seen.push(String(url))
    return new Response(JSON.stringify({
      error_type: 'ITEM_ERROR',
      error_code: errorCode,
      error_message: 'the provided Item could not be found',
      display_message: null,
      request_id: 'req_plaid_test_0001',
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  return { fetchStub, seen }
}

function disconnectRequest() {
  return new Request('https://bank.example.test/bank-feeds/connections/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountIntegrationId: 'acct_test_0001', connectionId: 'conn_test_0001' }),
  })
}

test.beforeEach(() => {
  calls.marked.length = 0
})

test('an Item that is already gone at Plaid ("ITEM_NOT_FOUND") still releases the local connection', async () => {
  const { fetchStub, seen } = plaidErrorFetch('ITEM_NOT_FOUND')
  globalThis.fetch = fetchStub

  const response = await handleDisconnectPlaidConnection(disconnectRequest(), env, 'req_test_gone')
  const body = await response.json()

  assert.equal(seen.length, 1, 'Plaid /item/remove was attempted once')
  assert.match(seen[0], /\/item\/remove$/)
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.connectionStatus, 'disconnected')
  assert.equal(calls.marked.length, 1, 'the local connection was marked disconnected')
  assert.equal(calls.marked[0].connectionId, 'conn_test_0001')
})

test('"INVALID_ACCESS_TOKEN" also releases the local connection', async () => {
  globalThis.fetch = plaidErrorFetch('INVALID_ACCESS_TOKEN').fetchStub

  const response = await handleDisconnectPlaidConnection(disconnectRequest(), env, 'req_test_token')

  assert.equal(response.status, 200)
  assert.equal(calls.marked.length, 1)
})

test('an unrelated Plaid failure keeps the local connection and returns an error', async () => {
  globalThis.fetch = plaidErrorFetch('INTERNAL_SERVER_ERROR').fetchStub

  const response = await handleDisconnectPlaidConnection(disconnectRequest(), env, 'req_test_other')

  assert.equal(response.status, 502)
  assert.equal(calls.marked.length, 0, 'the local connection must not be released when Plaid may still hold the Item')
})

test('"ITEM_LOGIN_REQUIRED" is not treated as already removed (the Item still exists at Plaid)', async () => {
  globalThis.fetch = plaidErrorFetch('ITEM_LOGIN_REQUIRED').fetchStub

  const response = await handleDisconnectPlaidConnection(disconnectRequest(), env, 'req_test_login')

  assert.equal(response.status, 502)
  assert.equal(calls.marked.length, 0)
})
