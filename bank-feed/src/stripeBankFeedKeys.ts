import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  serviceUnavailable,
} from './bankFeedWorkerHttp'
import { authenticateBrokerJsonRequest } from './requestAuthentication'
import {
  decryptStripeSecret,
  encryptStripeSecret,
  StripeKeyEncryptionConfigurationError,
} from './stripeApiKeyCrypto'
import type { Env, StripeBankFeedKeyRow } from './bankFeedWorkerTypes'

// Stripe_Unified_Raw_API_Key_Payments_And_Bank_Connections_Task_Spec_20260929.md: Bank Connections
// (Stripe Financial Connections) authenticates with the Business's own Stripe API key, exactly as
// Payments does -- but per Galen (2026-09-29) this Worker is fully independent of Client Portal, so it
// stores its own encrypted copy of that key (the desktop's single "Save key" action sends it to both
// Workers) and registers its own webhook endpoint on the Business's Stripe account. Everything is keyed
// by the account integration id the desktop already authenticates with.

const defaultStripeApiBaseUrl = 'https://api.stripe.com/v1'

// The development-only STRIPE_API_BASE_URL override lets local integration tests stub Stripe.
export function stripeApiBase(env: Env) {
  return env.SERVICE_ENVIRONMENT === 'development' && env.STRIPE_API_BASE_URL
    ? env.STRIPE_API_BASE_URL.replace(/\/+$/, '')
    : defaultStripeApiBaseUrl
}

const webhookEnabledEvents = [
  'financial_connections.account.created',
  'financial_connections.account.deactivated',
  'financial_connections.account.disconnected',
  'financial_connections.account.reactivated',
  'financial_connections.account.refreshed_balance',
  'financial_connections.account.refreshed_transactions',
]

const secretKeyPattern = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/
const publishableKeyPattern = /^pk_(live|test)_[A-Za-z0-9]{8,}$/
// Development-only fake key: skips every Stripe call so route contracts can be tested offline.
const mockKeyPattern = /^(sk|rk)_test_mock/

export type AccountStripeCredentials =
  | { mode: 'none' }
  | { mode: 'mock'; row: StripeBankFeedKeyRow }
  | {
      mode: 'real'
      secretKey: string
      publishableKey: string
      keyKind: 'restricted' | 'secret'
      livemode: boolean
      row: StripeBankFeedKeyRow
    }

function nowIso() {
  return new Date().toISOString()
}

export async function getStripeBankFeedKeyRow(env: Env, accountIntegrationId: string) {
  return env.DB
    .prepare(`SELECT * FROM stripe_bank_feed_keys WHERE account_integration_id = ?`)
    .bind(accountIntegrationId)
    .first<StripeBankFeedKeyRow>()
}

export async function resolveAccountStripe(env: Env, accountIntegrationId: string): Promise<AccountStripeCredentials> {
  const row = await getStripeBankFeedKeyRow(env, accountIntegrationId)
  if (!row) return { mode: 'none' }

  const secretKey = await decryptStripeSecret(env, { accountIntegrationId, kind: 'api_key' }, {
    ciphertext: row.encrypted_secret_key,
    iv: row.secret_key_iv,
    version: row.secret_key_version,
  })
  if (env.SERVICE_ENVIRONMENT === 'development' && mockKeyPattern.test(secretKey)) return { mode: 'mock', row }

  return {
    mode: 'real',
    secretKey,
    publishableKey: row.publishable_key,
    keyKind: row.key_kind,
    livemode: row.livemode === 1,
    row,
  }
}

export function stripeAuthHeaders(secretKey: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${secretKey}`, ...extra }
}

function mapConnection(row: StripeBankFeedKeyRow) {
  return {
    connected: true,
    provider: 'stripe' as const,
    keyKind: row.key_kind,
    livemode: row.livemode === 1,
    publishableKey: row.publishable_key,
    connectedAt: row.created_at,
    lastVerifiedAt: row.last_verified_at,
    webhookRegistered: Boolean(row.webhook_endpoint_id),
  }
}

async function stripeJson<T>(response: Response) {
  return await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null
}

// Best effort: a Stripe-side cleanup failure must not block a local key replacement/removal.
async function deleteWebhookEndpoint(env: Env, row: StripeBankFeedKeyRow) {
  if (!row.webhook_endpoint_id) return
  try {
    const secretKey = await decryptStripeSecret(env, { accountIntegrationId: row.account_integration_id, kind: 'api_key' }, {
      ciphertext: row.encrypted_secret_key,
      iv: row.secret_key_iv,
      version: row.secret_key_version,
    })
    if (mockKeyPattern.test(secretKey)) return
    await fetch(`${stripeApiBase(env)}/webhook_endpoints/${encodeURIComponent(row.webhook_endpoint_id)}`, {
      method: 'DELETE',
      headers: stripeAuthHeaders(secretKey),
    })
  } catch (error) {
    console.error('Stripe webhook endpoint cleanup failed (continuing):', error instanceof Error ? error.message : 'unknown error')
  }
}

// POST /stripe/keys/save (broker-authenticated). Body: { accountIntegrationId, secretKey, publishableKey }.
// Validates the key live (GET /v1/balance), registers this account's webhook endpoint with that key,
// then stores the key and the endpoint's signing secret encrypted.
export async function handleStripeSaveKey(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId, body } = authentication.request

  const secretKey = String(body.secretKey || '').trim()
  const publishableKey = String(body.publishableKey || '').trim()

  if (!secretKeyPattern.test(secretKey)) {
    return badRequest(requestId, 'Enter a Stripe secret or restricted key (starts with sk_live_, sk_test_, rk_live_ or rk_test_).')
  }
  if (!publishableKeyPattern.test(publishableKey)) {
    return badRequest(requestId, 'Enter your Stripe publishable key (starts with pk_live_ or pk_test_).')
  }
  const keyLivemode = secretKey.includes('_live_')
  if (publishableKey.includes('_live_') !== keyLivemode) {
    return badRequest(requestId, 'The secret and publishable keys must both be live keys or both be test keys.')
  }
  const keyKind = secretKey.startsWith('rk_') ? 'restricted' as const : 'secret' as const
  const mock = env.SERVICE_ENVIRONMENT === 'development' && mockKeyPattern.test(secretKey)

  try {
    // Fail before any Stripe call when encryption is not configured on this Worker.
    await encryptStripeSecret(env, { accountIntegrationId, kind: 'api_key' }, 'configuration-check')
  } catch (error) {
    if (error instanceof StripeKeyEncryptionConfigurationError) {
      return serviceUnavailable(requestId, 'Bank Connections are not available: this Worker has no Stripe key encryption secret configured.')
    }
    throw error
  }

  const existing = await getStripeBankFeedKeyRow(env, accountIntegrationId)
  let webhookEndpointId: string | null = null
  let webhookSecret: string | null = null

  if (!mock) {
    const balanceResponse = await fetch(`${stripeApiBase(env)}/balance`, { headers: stripeAuthHeaders(secretKey) })
    const balance = await stripeJson<{ livemode?: boolean }>(balanceResponse)
    if (!balanceResponse.ok) {
      return badRequest(requestId, `Stripe rejected this key: ${balance?.error?.message || `HTTP ${balanceResponse.status}`}`)
    }
    if (typeof balance?.livemode === 'boolean' && balance.livemode !== keyLivemode) {
      return badRequest(requestId, 'Stripe reports a different live/test mode than this key\'s prefix. Check the key.')
    }

    if (existing) await deleteWebhookEndpoint(env, existing)

    const webhookUrl = `${new URL(request.url).origin}/stripe/webhooks/${encodeURIComponent(accountIntegrationId)}`
    const endpointBody = new URLSearchParams()
    endpointBody.set('url', webhookUrl)
    endpointBody.set('description', 'Sole Business Suite bank connections')
    for (const event of webhookEnabledEvents) endpointBody.append('enabled_events[]', event)

    const endpointResponse = await fetch(`${stripeApiBase(env)}/webhook_endpoints`, {
      method: 'POST',
      headers: stripeAuthHeaders(secretKey, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: endpointBody,
    })
    const endpoint = await stripeJson<{ id?: string; secret?: string }>(endpointResponse)
    if (!endpointResponse.ok || !endpoint?.id || !endpoint.secret) {
      return jsonResponse(502, {
        ok: false,
        requestId,
        message: `Could not register the bank connections webhook on your Stripe account: ${endpoint?.error?.message || `HTTP ${endpointResponse.status}`}. The key needs Webhook Endpoints write permission.`,
      }, requestId)
    }
    webhookEndpointId = endpoint.id
    webhookSecret = endpoint.secret
  }

  const encryptedKey = await encryptStripeSecret(env, { accountIntegrationId, kind: 'api_key' }, secretKey)
  const encryptedWebhook = webhookSecret
    ? await encryptStripeSecret(env, { accountIntegrationId, kind: 'webhook_secret' }, webhookSecret)
    : null
  const timestamp = nowIso()

  await env.DB
    .prepare(`
      INSERT INTO stripe_bank_feed_keys
        (account_integration_id, encrypted_secret_key, secret_key_iv, secret_key_version, key_kind, publishable_key, livemode,
         webhook_endpoint_id, encrypted_webhook_secret, webhook_secret_iv, webhook_secret_version, customer_id,
         last_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT (account_integration_id) DO UPDATE SET
        encrypted_secret_key = excluded.encrypted_secret_key,
        secret_key_iv = excluded.secret_key_iv,
        secret_key_version = excluded.secret_key_version,
        key_kind = excluded.key_kind,
        publishable_key = excluded.publishable_key,
        livemode = excluded.livemode,
        webhook_endpoint_id = excluded.webhook_endpoint_id,
        encrypted_webhook_secret = excluded.encrypted_webhook_secret,
        webhook_secret_iv = excluded.webhook_secret_iv,
        webhook_secret_version = excluded.webhook_secret_version,
        customer_id = NULL,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `)
    .bind(
      accountIntegrationId,
      encryptedKey.ciphertext, encryptedKey.iv, encryptedKey.version,
      keyKind, publishableKey, keyLivemode ? 1 : 0,
      webhookEndpointId,
      encryptedWebhook?.ciphertext ?? null, encryptedWebhook?.iv ?? null, encryptedWebhook?.version ?? null,
      timestamp, timestamp, timestamp,
    )
    .run()

  const saved = await getStripeBankFeedKeyRow(env, accountIntegrationId) as StripeBankFeedKeyRow
  return jsonResponse(200, { ok: true, requestId, provider: 'stripe', connection: mapConnection(saved), mock }, requestId)
}

// POST /stripe/keys/remove (broker-authenticated). Removes the webhook endpoint (best effort) and the
// stored ciphertext. Existing Financial Connections accounts stay on the Stripe side untouched.
export async function handleStripeRemoveKey(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response
  const { accountIntegrationId } = authentication.request

  const existing = await getStripeBankFeedKeyRow(env, accountIntegrationId)
  if (!existing) {
    return jsonResponse(200, { ok: true, requestId, provider: 'stripe', alreadyRemoved: true }, requestId)
  }

  await deleteWebhookEndpoint(env, existing)
  await env.DB.prepare(`DELETE FROM stripe_bank_feed_keys WHERE account_integration_id = ?`).bind(accountIntegrationId).run()

  return jsonResponse(200, { ok: true, requestId, provider: 'stripe', removedAt: nowIso() }, requestId)
}

// POST /stripe/keys/status (broker-authenticated).
export async function handleStripeKeyStatus(request: Request, env: Env, requestId: string) {
  if (request.method !== 'POST') return methodNotAllowed(requestId)
  const authentication = await authenticateBrokerJsonRequest(request, env, requestId)
  if (!authentication.ok) return authentication.response

  const row = await getStripeBankFeedKeyRow(env, authentication.request.accountIntegrationId)
  return jsonResponse(200, {
    ok: true,
    requestId,
    provider: 'stripe',
    connection: row ? mapConnection(row) : null,
  }, requestId)
}

export async function saveStripeCustomerId(env: Env, accountIntegrationId: string, customerId: string) {
  await env.DB
    .prepare(`UPDATE stripe_bank_feed_keys SET customer_id = ?, updated_at = ? WHERE account_integration_id = ?`)
    .bind(customerId, nowIso(), accountIntegrationId)
    .run()
}
