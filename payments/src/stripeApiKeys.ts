import { authenticateBusinessJsonRequest } from './paymentsRequestAuthentication'
import { badRequest, jsonResponse } from './paymentsWorkerHttp'
import type { Env, StripeApiKeyRow } from './paymentsWorkerTypes'
import {
  decryptStripeSecret,
  encryptStripeSecret,
  StripeKeyEncryptionConfigurationError,
} from './stripeApiKeyCrypto'

// Stripe_Unified_Raw_API_Key_Payments_And_Bank_Connections_Task_Spec_20260929.md Part C2/C5: each
// Business supplies its own Stripe secret or restricted API key (plus its publishable key), stored
// encrypted per Business. Every Stripe call for that Business authenticates with that key directly
// against the Business's own Stripe account: no Connect, no Stripe-Account header, no Sole-side Stripe
// credential. This Worker is Payments only and independent of Client Portal and Bank Connections; the
// desktop's single "Save key" action gives each service its own copy.

const defaultStripeApiBaseUrl = 'https://api.stripe.com/v1'

// The development-only STRIPE_API_BASE_URL override lets local integration tests stub Stripe.
export function stripeApiBase(env: Env) {
  return env.SERVICE_ENVIRONMENT === 'development' && env.STRIPE_API_BASE_URL
    ? env.STRIPE_API_BASE_URL.replace(/\/+$/, '')
    : defaultStripeApiBaseUrl
}

// Events the per-Business webhook endpoint subscribes to.
const webhookEnabledEvents = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
]

const secretKeyPattern = /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/
const publishableKeyPattern = /^pk_(live|test)_[A-Za-z0-9]{8,}$/
const mockKeyPattern = /^(sk|rk)_test_mock/

export type BusinessStripeCredentials =
  // Development-only deterministic fake (no key stored, or a stored sk_test_mock*/rk_test_mock* key).
  | { mode: 'mock' }
  // No key and not a development Worker: payments are unavailable for this Business.
  | { mode: 'none' }
  | {
      mode: 'real'
      secretKey: string
      publishableKey: string
      keyKind: 'restricted' | 'secret'
      livemode: boolean
      row: StripeApiKeyRow
    }

function nowIso() {
  return new Date().toISOString()
}

export async function getStripeApiKeyRow(env: Env, businessId: string) {
  return env.DB
    .prepare(`SELECT * FROM payments_stripe_api_keys WHERE business_id = ?`)
    .bind(businessId)
    .first<StripeApiKeyRow>()
}

// The single lookup Payments uses to get this Business's key.
export async function resolveBusinessStripe(env: Env, businessId: string): Promise<BusinessStripeCredentials> {
  const row = await getStripeApiKeyRow(env, businessId)
  if (!row) return env.SERVICE_ENVIRONMENT === 'development' ? { mode: 'mock' } : { mode: 'none' }

  const secretKey = await decryptStripeSecret(env, { businessId, kind: 'api_key' }, {
    ciphertext: row.encrypted_secret_key,
    iv: row.secret_key_iv,
    version: row.secret_key_version,
  })
  if (env.SERVICE_ENVIRONMENT === 'development' && mockKeyPattern.test(secretKey)) return { mode: 'mock' }

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

function mapConnection(row: StripeApiKeyRow) {
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

function paymentsUnavailable(requestId: string, message: string, status = 503) {
  return jsonResponse(status, { ok: false, requestId, message }, requestId)
}

async function stripeJson<T>(response: Response) {
  return await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null
}

// Best effort: a Stripe-side cleanup failure must not block a local key replacement/removal.
async function deleteWebhookEndpoint(env: Env, row: StripeApiKeyRow) {
  if (!row.webhook_endpoint_id) return
  try {
    const secretKey = await decryptStripeSecret(env, { businessId: row.business_id, kind: 'api_key' }, {
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

// POST /business/payment-gateway/stripe/save-key (HMAC business-auth).
// Body: { businessId, secretKey, publishableKey }. Validates the key live against GET /v1/balance,
// registers this Business's own webhook endpoint (using its own key) pointed at this Worker, then
// stores the key and the endpoint's signing secret encrypted.
export async function handleStripeSaveKey(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response
  const { businessId, body } = auth.request

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
    // Fail early (before any Stripe call) when encryption is not configured on this Worker.
    await encryptStripeSecret(env, { businessId, kind: 'api_key' }, 'configuration-check')
  } catch (error) {
    if (error instanceof StripeKeyEncryptionConfigurationError) {
      return paymentsUnavailable(requestId, 'Payments are not available: this Worker has no Stripe key encryption secret configured.')
    }
    throw error
  }

  const existing = await getStripeApiKeyRow(env, businessId)
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

    const webhookUrl = `${new URL(request.url).origin}/payment-gateway/stripe/webhook/${encodeURIComponent(businessId)}`
    const endpointBody = new URLSearchParams()
    endpointBody.set('url', webhookUrl)
    endpointBody.set('description', 'Sole Business Suite payments and bank connections')
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
        message: `Could not register the payment webhook on your Stripe account: ${endpoint?.error?.message || `HTTP ${endpointResponse.status}`}. The key needs Webhook Endpoints write permission.`,
      }, requestId)
    }
    webhookEndpointId = endpoint.id
    webhookSecret = endpoint.secret
  }

  const encryptedKey = await encryptStripeSecret(env, { businessId, kind: 'api_key' }, secretKey)
  const encryptedWebhook = webhookSecret
    ? await encryptStripeSecret(env, { businessId, kind: 'webhook_secret' }, webhookSecret)
    : null
  const timestamp = nowIso()

  await env.DB
    .prepare(`
      INSERT INTO payments_stripe_api_keys
        (business_id, encrypted_secret_key, secret_key_iv, secret_key_version, key_kind, publishable_key, livemode,
         webhook_endpoint_id, encrypted_webhook_secret, webhook_secret_iv, webhook_secret_version,
         last_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (business_id) DO UPDATE SET
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
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `)
    .bind(
      businessId,
      encryptedKey.ciphertext, encryptedKey.iv, encryptedKey.version,
      keyKind, publishableKey, keyLivemode ? 1 : 0,
      webhookEndpointId,
      encryptedWebhook?.ciphertext ?? null, encryptedWebhook?.iv ?? null, encryptedWebhook?.version ?? null,
      timestamp, timestamp, timestamp,
    )
    .run()

  const saved = await getStripeApiKeyRow(env, businessId) as StripeApiKeyRow
  return jsonResponse(200, { ok: true, requestId, provider: 'stripe', connection: mapConnection(saved), mock }, requestId)
}

// POST /business/payment-gateway/stripe/remove-key (HMAC business-auth). Best-effort removes the
// webhook endpoint from the Business's Stripe account, then deletes the stored ciphertext.
export async function handleStripeRemoveKey(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response
  const { businessId } = auth.request

  const existing = await getStripeApiKeyRow(env, businessId)
  if (!existing) {
    return jsonResponse(200, { ok: true, requestId, provider: 'stripe', alreadyRemoved: true }, requestId)
  }

  await deleteWebhookEndpoint(env, existing)
  await env.DB.prepare(`DELETE FROM payments_stripe_api_keys WHERE business_id = ?`).bind(businessId).run()

  return jsonResponse(200, { ok: true, requestId, provider: 'stripe', removedAt: nowIso() }, requestId)
}

// POST /business/payment-gateway/status (HMAC business-auth). Body: { businessId, provider? }.
export async function handlePaymentGatewayStatus(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const provider = auth.request.body.provider
  if (provider !== undefined && provider !== null && provider !== '' && provider !== 'stripe' && provider !== 'square' && provider !== 'paypal') {
    return badRequest(requestId, 'provider must be one of stripe, square, or paypal.')
  }

  const row = provider === undefined || provider === null || provider === '' || provider === 'stripe'
    ? await getStripeApiKeyRow(env, auth.request.businessId)
    : null

  return jsonResponse(200, {
    ok: true,
    requestId,
    provider: provider || 'stripe',
    connection: row ? mapConnection(row) : null,
    mock: env.SERVICE_ENVIRONMENT === 'development' && !row,
  }, requestId)
}
