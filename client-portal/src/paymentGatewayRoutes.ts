import { authenticateBusinessJsonRequest } from './clientPortalRequestAuthentication'
import { badRequest, jsonResponse, notFoundResponse } from './clientPortalWorkerHttp'
import type {
  Env,
  PortalPaymentGatewayConnectionRow,
  PortalPaymentMethod,
  PortalPaymentRow,
  PortalSnapshotPayment,
} from './clientPortalWorkerTypes'

// Payments_Gateway_Component_Task_Spec_20260829.md Part C (locked decision) + Part E Phases 1 & 3:
// the payment gateway lives inside this same Client Portal Worker -- the trust boundary Client
// Portal's signing/submission data already lives in -- not a separate broker Worker.
// Phase 1: Stripe Connect OAuth skeleton (authorize-redirect start, callback/token-exchange,
// connection status, disconnect).
// Phase 3: PaymentIntent creation for both collection paths (in-app card entry and the Client
// Portal hosted link), the Stripe webhook, payment status, and a mock-mode /mock-complete that
// stands in for the webhook. Succeeded Client-Portal payments enqueue a `payment_received` packet
// into portal_packet_inbox -- the same delivery mechanism a document-signing submission already
// uses -- so the desktop imports them through the existing /business/pending-packets + acknowledge
// flow. In-app payments (no grant/client) are polled by the desktop via /business/payment-gateway/
// payment-status instead.
//
// Only Stripe is implemented. The route vocabulary is kept provider-generic (/business/payment-gateway/*)
// so Square/PayPal are additive later behind the same shape (Part D).
//
// Mock mode: when STRIPE_SECRET_KEY or STRIPE_CONNECT_CLIENT_ID is absent (Phases 1-4 run before Galen
// registers the real Stripe Connect application in Phase 5), the OAuth token exchange synthesizes a
// deterministic `acct_mock_*` connected account instead of calling connect.stripe.com. Every other
// line of this file is identical in both modes, so Phase 5 is purely "set the secrets and re-verify".

const oauthStateTtlSeconds = 15 * 60
const stripeAuthorizeBaseUrl = 'https://connect.stripe.com/oauth/v2/authorize'
const stripeTokenUrl = 'https://connect.stripe.com/oauth/token'
const stripeDeauthorizeUrl = 'https://connect.stripe.com/oauth/deauthorize'

type PaymentGatewayProvider = 'stripe' | 'square' | 'paypal'
const supportedProviders = new Set<PaymentGatewayProvider>(['stripe'])

function hasRealStripeCredentials(env: Env) {
  const secret = (env.STRIPE_SECRET_KEY || '').trim()
  const clientId = (env.STRIPE_CONNECT_CLIENT_ID || '').trim()
  return Boolean(secret && clientId && !secret.toLowerCase().startsWith('sk_test_mock'))
}

// Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A ("Payments carve-out"):
// previously any deployment with no real Stripe secrets configured silently ran in mock mode --
// correct for Phases 1-4 before Galen registered the real Stripe Connect application, wrong to ship
// to a self-hosted customer's real end clients (a "payments fake-succeed" state, not a "payments
// unavailable" state). Mock mode now also requires SERVICE_ENVIRONMENT === 'development', so it
// fails closed by default in every other environment -- including Sole's own future Production
// Account 2 for non-self-hosting customers, which gets the same protection with no extra flag.
function isStripeMockMode(env: Env) {
  return !hasRealStripeCredentials(env) && env.SERVICE_ENVIRONMENT === 'development'
}

// True once this Worker can actually process a payment one way or another (real Stripe credentials,
// or a development sandbox correctly running in mock mode). False only for the fail-closed case Wave
// 2A added: a non-development deployment with no real Stripe credentials configured.
function stripePaymentsAvailable(env: Env) {
  return hasRealStripeCredentials(env) || isStripeMockMode(env)
}

function paymentsUnavailableResponse(requestId: string) {
  return jsonResponse(503, {
    ok: false,
    requestId,
    message: 'Payments are not available: no payment processor is configured for this Worker.',
  }, requestId)
}

function nowIso() {
  return new Date().toISOString()
}

function secondsFromNowIso(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function randomStateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function readProvider(value: unknown): PaymentGatewayProvider | null {
  if (value === undefined || value === null || value === '') return 'stripe'
  if (value === 'stripe' || value === 'square' || value === 'paypal') return value
  return null
}

function htmlCloseWindowPage(status: number, heading: string, detail: string) {
  const escaped = (text: string) => text.replace(/[&<>"]/g, character => (
    character === '&' ? '&amp;'
      : character === '<' ? '&lt;'
        : character === '>' ? '&gt;'
          : '&quot;'
  ))
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escaped(heading)}</title>
<style>
  body { font: 15px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 48px 24px; color: #1f2933; background: #f5f7fa; text-align: center; }
  .card { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { margin: 0; color: #52606d; }
</style>
</head>
<body>
<div class="card">
<h1>${escaped(heading)}</h1>
<p>${escaped(detail)}</p>
<p style="margin-top:16px;">You can close this window and return to Sole Business Suite.</p>
</div>
</body>
</html>`
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function sweepExpiredOAuthStates(env: Env) {
  await env.DB
    .prepare(`DELETE FROM portal_payment_gateway_oauth_states WHERE expires_at <= ?`)
    .bind(nowIso())
    .run()
}

function mapConnection(row: PortalPaymentGatewayConnectionRow) {
  return {
    connected: !row.disconnected_at,
    provider: row.provider,
    connectedAccountId: row.connected_account_id,
    accountStatus: row.account_status,
    scope: row.scope,
    livemode: row.livemode === 1,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
  }
}

// POST /business/payment-gateway/stripe/oauth-start (HMAC business-auth).
// Body: { businessId, provider? } -- returns the URL the desktop app opens in the system browser.
export async function handlePaymentGatewayStripeOAuthStart(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const provider = readProvider(auth.request.body.provider)
  if (!provider || !supportedProviders.has(provider)) {
    return badRequest(requestId, 'Only the "stripe" payment gateway provider is available in this version.')
  }

  if (!stripePaymentsAvailable(env)) return paymentsUnavailableResponse(requestId)

  await sweepExpiredOAuthStates(env)

  const state = randomStateToken()
  const expiresAt = secondsFromNowIso(oauthStateTtlSeconds)

  await env.DB
    .prepare(`
      INSERT INTO portal_payment_gateway_oauth_states (state, business_id, provider, expires_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(state, auth.request.businessId, provider, expiresAt)
    .run()

  const origin = new URL(request.url).origin
  const redirectUri = `${origin}/payment-gateway/stripe/oauth-callback`
  const clientId = (env.STRIPE_CONNECT_CLIENT_ID || 'ca_mock_development').trim()

  const authorizeUrl = new URL(stripeAuthorizeBaseUrl)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('scope', 'read_write')
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('state', state)

  return jsonResponse(200, {
    ok: true,
    requestId,
    provider,
    authorizeUrl: authorizeUrl.toString(),
    state,
    expiresAt,
    mock: isStripeMockMode(env),
  }, requestId)
}

async function exchangeStripeAuthorizationCode(env: Env, code: string): Promise<{
  connectedAccountId: string
  scope: string | null
  livemode: number
}> {
  if (isStripeMockMode(env)) {
    // Deterministic from the code so a test can assert the exact value it will get back.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
    const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
    return { connectedAccountId: `acct_mock_${hex.slice(0, 16)}`, scope: 'read_write', livemode: 0 }
  }

  const response = await fetch(stripeTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_secret: (env.STRIPE_SECRET_KEY || '').trim(),
      code,
      grant_type: 'authorization_code',
    }),
  })

  const payload = await response.json().catch(() => null) as
    | { stripe_user_id?: string; scope?: string; livemode?: boolean; error_description?: string; error?: string }
    | null

  if (!response.ok || !payload?.stripe_user_id) {
    const detail = payload?.error_description || payload?.error || `Stripe token exchange failed with HTTP ${response.status}.`
    throw new Error(detail)
  }

  return {
    connectedAccountId: payload.stripe_user_id,
    scope: typeof payload.scope === 'string' ? payload.scope : null,
    livemode: payload.livemode ? 1 : 0,
  }
}

// GET /payment-gateway/stripe/oauth-callback?code&state[&error] -- PUBLIC (Stripe redirects the
// browser here; no HMAC is possible). The single-use, time-limited `state` row is the CSRF/replay
// guard and is what binds this callback to the businessId that started the flow.
export async function handlePaymentGatewayStripeOAuthCallback(request: Request, url: URL, env: Env, requestId: string): Promise<Response> {
  const state = (url.searchParams.get('state') || '').trim()
  const code = (url.searchParams.get('code') || '').trim()
  const providerError = (url.searchParams.get('error') || '').trim()
  const providerErrorDescription = (url.searchParams.get('error_description') || '').trim()

  if (!/^[a-f0-9]{64}$/.test(state)) {
    return htmlCloseWindowPage(400, 'Stripe connection failed', 'The authorization response was missing a valid state value.')
  }

  await sweepExpiredOAuthStates(env)

  const stateRow = await env.DB
    .prepare(`
      SELECT state, business_id, provider, created_at, expires_at, consumed_at
      FROM portal_payment_gateway_oauth_states
      WHERE state = ?
    `)
    .bind(state)
    .first<{ state: string; business_id: string; provider: string; created_at: string; expires_at: string; consumed_at: string | null }>()

  if (!stateRow || stateRow.consumed_at || Date.parse(stateRow.expires_at) <= Date.now()) {
    return htmlCloseWindowPage(400, 'Stripe connection failed', 'This connection link has already been used or has expired. Start again from Settings.')
  }

  // Single-use: consume the state row before doing anything else, so a duplicated redirect can't
  // double-process.
  await env.DB
    .prepare(`UPDATE portal_payment_gateway_oauth_states SET consumed_at = ? WHERE state = ?`)
    .bind(nowIso(), state)
    .run()

  if (providerError) {
    return htmlCloseWindowPage(400, 'Stripe connection cancelled', providerErrorDescription || `Stripe reported: ${providerError}`)
  }
  if (!code) {
    return htmlCloseWindowPage(400, 'Stripe connection failed', 'Stripe did not return an authorization code.')
  }

  let exchange: { connectedAccountId: string; scope: string | null; livemode: number }
  try {
    exchange = await exchangeStripeAuthorizationCode(env, code)
  } catch (error) {
    console.error('Stripe OAuth token exchange failed:', error)
    return htmlCloseWindowPage(502, 'Stripe connection failed', error instanceof Error ? error.message : 'The Stripe token exchange failed.')
  }

  await env.DB
    .prepare(`INSERT OR IGNORE INTO portal_businesses (id) VALUES (?)`)
    .bind(stateRow.business_id)
    .run()

  await env.DB
    .prepare(`
      INSERT INTO portal_payment_gateway_connections
        (business_id, provider, connected_account_id, account_status, scope, livemode, connected_at, updated_at, disconnected_at)
      VALUES (?, 'stripe', ?, 'connected', ?, ?, ?, ?, NULL)
      ON CONFLICT (business_id, provider) DO UPDATE SET
        connected_account_id = excluded.connected_account_id,
        account_status = 'connected',
        scope = excluded.scope,
        livemode = excluded.livemode,
        connected_at = excluded.connected_at,
        updated_at = excluded.updated_at,
        disconnected_at = NULL
    `)
    .bind(stateRow.business_id, exchange.connectedAccountId, exchange.scope, exchange.livemode, nowIso(), nowIso())
    .run()

  return htmlCloseWindowPage(200, 'Stripe connected', 'Your Stripe account is now connected to Sole Business Suite.')
}

// POST /business/payment-gateway/status (HMAC business-auth). Body: { businessId, provider? }.
export async function handlePaymentGatewayStatus(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const provider = readProvider(auth.request.body.provider)
  if (!provider) return badRequest(requestId, 'provider must be one of stripe, square, or paypal.')

  const row = await env.DB
    .prepare(`
      SELECT business_id, provider, connected_account_id, account_status, scope, livemode, connected_at, updated_at, disconnected_at
      FROM portal_payment_gateway_connections
      WHERE business_id = ? AND provider = ? AND disconnected_at IS NULL
    `)
    .bind(auth.request.businessId, provider)
    .first<PortalPaymentGatewayConnectionRow>()

  return jsonResponse(200, {
    ok: true,
    requestId,
    provider,
    connection: row ? mapConnection(row) : null,
    mock: isStripeMockMode(env),
  }, requestId)
}

// POST /business/payment-gateway/disconnect (HMAC business-auth). Body: { businessId, provider? }.
export async function handlePaymentGatewayDisconnect(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const provider = readProvider(auth.request.body.provider)
  if (!provider || !supportedProviders.has(provider)) {
    return badRequest(requestId, 'Only the "stripe" payment gateway provider is available in this version.')
  }

  const row = await env.DB
    .prepare(`
      SELECT business_id, provider, connected_account_id, account_status, scope, livemode, connected_at, updated_at, disconnected_at
      FROM portal_payment_gateway_connections
      WHERE business_id = ? AND provider = ? AND disconnected_at IS NULL
    `)
    .bind(auth.request.businessId, provider)
    .first<PortalPaymentGatewayConnectionRow>()

  if (!row) {
    return jsonResponse(200, { ok: true, requestId, provider, alreadyDisconnected: true }, requestId)
  }

  if (!isStripeMockMode(env)) {
    try {
      await fetch(stripeDeauthorizeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${(env.STRIPE_SECRET_KEY || '').trim()}`,
        },
        body: new URLSearchParams({
          client_id: (env.STRIPE_CONNECT_CLIENT_ID || '').trim(),
          stripe_user_id: row.connected_account_id,
        }),
      })
    } catch (error) {
      // Best effort: a failed deauthorize on Stripe's side must not block the local disconnect. The
      // Business can also revoke access from their own Stripe dashboard.
      console.error('Stripe deauthorize call failed (continuing with local disconnect):', error)
    }
  }

  const disconnectedAt = nowIso()
  await env.DB
    .prepare(`
      UPDATE portal_payment_gateway_connections
      SET disconnected_at = ?, account_status = 'disconnected', updated_at = ?
      WHERE business_id = ? AND provider = ?
    `)
    .bind(disconnectedAt, disconnectedAt, auth.request.businessId, provider)
    .run()

  return jsonResponse(200, { ok: true, requestId, provider, disconnectedAt }, requestId)
}

// ============================================================================
// Phase 3: PaymentIntent creation, webhook, mock-complete, status.
// ============================================================================

const stripePaymentIntentsUrl = 'https://api.stripe.com/v1/payment_intents'
const paymentAmountFloorCents = 50
const paymentAmountCeilingCents = 100_000_00
const supportedCurrencies = new Set(['usd', 'cad', 'gbp', 'eur', 'aud'])

const paymentRowColumns = `
  id, business_id, connected_account_id, invoice_ref, amount_cents, currency, provider, method,
  payment_intent_id, status, access_grant_id, client_id, created_at, updated_at, succeeded_at
`

function normalizeCurrency(value: unknown) {
  const currency = String(value || 'usd').trim().toLowerCase()
  return supportedCurrencies.has(currency) ? currency : 'usd'
}

function normalizeAmountCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const amount = Math.round(value)
  if (amount < paymentAmountFloorCents || amount > paymentAmountCeilingCents) return null
  return amount
}

async function getActiveConnection(env: Env, businessId: string) {
  return env.DB
    .prepare(`
      SELECT business_id, provider, connected_account_id, account_status, scope, livemode, connected_at, updated_at, disconnected_at
      FROM portal_payment_gateway_connections
      WHERE business_id = ? AND provider = 'stripe' AND disconnected_at IS NULL
    `)
    .bind(businessId)
    .first<PortalPaymentGatewayConnectionRow>()
}

async function synthesizeMockPaymentIntent(invoiceRef: string, method: PortalPaymentMethod) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${invoiceRef}|${method}|${Date.now()}|${crypto.randomUUID()}`),
  )
  const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
  const id = `pi_mock_${hex.slice(0, 24)}`
  return { id, clientSecret: `${id}_secret_${hex.slice(24, 48)}` }
}

async function createRealStripePaymentIntent(
  env: Env,
  connectedAccountId: string,
  amountCents: number,
  currency: string,
  invoiceRef: string,
  method: PortalPaymentMethod,
): Promise<{ id: string; clientSecret: string }> {
  const body = new URLSearchParams()
  body.set('amount', String(amountCents))
  body.set('currency', currency)
  body.set('automatic_payment_methods[enabled]', 'true')
  body.set('metadata[invoice_ref]', invoiceRef)
  body.set('metadata[method]', method)
  body.set('description', `Invoice ${invoiceRef}`)

  const response = await fetch(stripePaymentIntentsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(env.STRIPE_SECRET_KEY || '').trim()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Direct charge on the Business's own connected account.
      'Stripe-Account': connectedAccountId,
    },
    body,
  })

  const payload = await response.json().catch(() => null) as
    | { id?: string; client_secret?: string; error?: { message?: string } }
    | null

  if (!response.ok || !payload?.id || !payload.client_secret) {
    throw new Error(payload?.error?.message || `Stripe PaymentIntent creation failed with HTTP ${response.status}.`)
  }
  return { id: payload.id, clientSecret: payload.client_secret }
}

async function insertPaymentRow(env: Env, input: {
  businessId: string
  connectedAccountId: string | null
  invoiceRef: string
  amountCents: number
  currency: string
  method: PortalPaymentMethod
  paymentIntentId: string
  accessGrantId: string | null
  clientId: string | null
}) {
  const id = crypto.randomUUID()
  await env.DB
    .prepare(`
      INSERT INTO portal_payments
        (id, business_id, connected_account_id, invoice_ref, amount_cents, currency, provider, method,
         payment_intent_id, status, access_grant_id, client_id)
      VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, ?, 'requires_payment', ?, ?)
    `)
    .bind(
      id, input.businessId, input.connectedAccountId, input.invoiceRef, input.amountCents, input.currency,
      input.method, input.paymentIntentId, input.accessGrantId, input.clientId,
    )
    .run()
  return id
}

function payEmbedUrlFor(origin: string, params: {
  clientSecret: string
  publishableKey: string
  amountCents: number
  currency: string
  mock: boolean
  connectedAccountId?: string | null
}) {
  const fragment = new URLSearchParams()
  fragment.set('cs', params.clientSecret)
  fragment.set('pk', params.publishableKey)
  fragment.set('amt', String(params.amountCents))
  fragment.set('cur', params.currency)
  if (params.mock) fragment.set('mock', '1')
  // Direct charges live on the connected account -- Stripe.js in /pay-embed must be initialised with
  // { stripeAccount } or elements({ clientSecret }) can't retrieve the PaymentIntent. Mock mode has
  // no connected account and doesn't load Stripe.js, so this is only ever set for real payments.
  if (!params.mock && params.connectedAccountId) fragment.set('acct', params.connectedAccountId)
  return `${origin}/pay-embed#${fragment.toString()}`
}

// POST /business/payment-gateway/stripe/payment-intent (HMAC business-auth). In-app card entry.
// Body: { businessId, invoiceRef, amountCents, currency?, method? }
export async function handleCreateBusinessPaymentIntent(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const { businessId, body } = auth.request
  const invoiceRef = String(body.invoiceRef || '').trim()
  const amountCents = normalizeAmountCents(body.amountCents)
  const currency = normalizeCurrency(body.currency)
  const method: PortalPaymentMethod = body.method === 'client_portal_link' ? 'client_portal_link' : 'card_in_app'

  if (!invoiceRef) return badRequest(requestId, 'invoiceRef is required.')
  if (amountCents === null) return badRequest(requestId, `amountCents must be an integer between ${paymentAmountFloorCents} and ${paymentAmountCeilingCents}.`)

  if (!stripePaymentsAvailable(env)) return paymentsUnavailableResponse(requestId)

  const connection = await getActiveConnection(env, businessId)
  if (!connection && !isStripeMockMode(env)) {
    return badRequest(requestId, 'No Stripe account is connected. Connect one in Settings first.')
  }

  const mock = isStripeMockMode(env)
  const connectedAccountId = connection?.connected_account_id ?? null

  let intent: { id: string; clientSecret: string }
  try {
    intent = mock
      ? await synthesizeMockPaymentIntent(invoiceRef, method)
      : await createRealStripePaymentIntent(env, connectedAccountId as string, amountCents, currency, invoiceRef, method)
  } catch (error) {
    console.error('PaymentIntent creation failed:', error)
    return jsonResponse(502, { ok: false, requestId, message: error instanceof Error ? error.message : 'PaymentIntent creation failed.' }, requestId)
  }

  await insertPaymentRow(env, {
    businessId,
    connectedAccountId,
    invoiceRef,
    amountCents,
    currency,
    method,
    paymentIntentId: intent.id,
    accessGrantId: null,
    clientId: null,
  })

  const origin = new URL(request.url).origin
  const publishableKey = (env.STRIPE_PUBLISHABLE_KEY || 'pk_mock_development').trim()

  return jsonResponse(200, {
    ok: true,
    requestId,
    paymentIntentId: intent.id,
    clientSecret: intent.clientSecret,
    publishableKey,
    amountCents,
    currency,
    mock,
    payEmbedUrl: payEmbedUrlFor(origin, { clientSecret: intent.clientSecret, publishableKey, amountCents, currency, mock, connectedAccountId }),
  }, requestId)
}

async function requireActiveGrantForPayment(env: Env, inviteToken: string) {
  if (!/^[a-f0-9]{64}$/.test(inviteToken)) return null
  const grant = await env.DB
    .prepare(`
      SELECT id, business_id, client_id, invite_token, expires_at, revoked_at
      FROM portal_access_grants WHERE invite_token = ?
    `)
    .bind(inviteToken)
    .first<{ id: string; business_id: string; client_id: string; expires_at: string | null; revoked_at: string | null }>()
  if (!grant || grant.revoked_at) return null
  if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) return null
  return grant
}

// POST /portal/{inviteToken}/payment-intent (Client token-auth). Client-facing hosted payment.
export async function handleCreatePortalPaymentIntent(request: Request, env: Env, requestId: string, inviteToken: string): Promise<Response> {
  const grant = await requireActiveGrantForPayment(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

  const snapshot = await env.DB
    .prepare(`SELECT payload_json FROM portal_snapshots_current WHERE access_grant_id = ?`)
    .bind(grant.id)
    .first<{ payload_json: string }>()
  if (!snapshot) return notFoundResponse(requestId, 'Nothing has been published to this invite link yet.')

  let payment: PortalSnapshotPayment | null = null
  try {
    payment = (JSON.parse(snapshot.payload_json)?.payment ?? null) as PortalSnapshotPayment | null
  } catch {
    payment = null
  }
  if (!payment || !payment.invoiceRef || typeof payment.amountCents !== 'number') {
    return notFoundResponse(requestId, 'There is no payment to make on this Client Portal.')
  }

  const amountCents = normalizeAmountCents(payment.amountCents)
  if (amountCents === null) return badRequest(requestId, 'The published payment amount is invalid.')
  const currency = normalizeCurrency(payment.currency)

  if (!stripePaymentsAvailable(env)) return paymentsUnavailableResponse(requestId)

  const connection = await getActiveConnection(env, grant.business_id)
  if (!connection && !isStripeMockMode(env)) {
    return jsonResponse(503, { ok: false, requestId, message: 'This business has not connected a payment account yet.' }, requestId)
  }

  const mock = isStripeMockMode(env)
  const connectedAccountId = connection?.connected_account_id ?? null

  let intent: { id: string; clientSecret: string }
  try {
    intent = mock
      ? await synthesizeMockPaymentIntent(payment.invoiceRef, 'client_portal_link')
      : await createRealStripePaymentIntent(env, connectedAccountId as string, amountCents, currency, payment.invoiceRef, 'client_portal_link')
  } catch (error) {
    console.error('Portal PaymentIntent creation failed:', error)
    return jsonResponse(502, { ok: false, requestId, message: error instanceof Error ? error.message : 'PaymentIntent creation failed.' }, requestId)
  }

  await insertPaymentRow(env, {
    businessId: grant.business_id,
    connectedAccountId,
    invoiceRef: payment.invoiceRef,
    amountCents,
    currency,
    method: 'client_portal_link',
    paymentIntentId: intent.id,
    accessGrantId: grant.id,
    clientId: grant.client_id,
  })

  const origin = new URL(request.url).origin
  const publishableKey = (env.STRIPE_PUBLISHABLE_KEY || 'pk_mock_development').trim()

  return jsonResponse(200, {
    ok: true,
    requestId,
    clientSecret: intent.clientSecret,
    publishableKey,
    amountCents,
    currency,
    mock,
    payEmbedUrl: payEmbedUrlFor(origin, { clientSecret: intent.clientSecret, publishableKey, amountCents, currency, mock, connectedAccountId }),
  }, requestId)
}

// The webhook is the primary way a payment row becomes `succeeded`, but the in-app card flow polls
// payment-status immediately after the client confirms -- routinely before the webhook lands. So when
// a row is still pending, ask Stripe directly and apply the same outcome the webhook would. No-op in
// mock mode (the mock-complete route drives those). Reconciles success only -- a non-succeeded live
// PaymentIntent stays pending rather than being prematurely marked failed.
async function reconcilePendingPaymentFromStripe(env: Env, row: PortalPaymentRow): Promise<PortalPaymentRow> {
  if (isStripeMockMode(env)) return row
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'canceled') return row
  if (!row.connected_account_id) return row

  try {
    const response = await fetch(`${stripePaymentIntentsUrl}/${encodeURIComponent(row.payment_intent_id)}`, {
      headers: {
        Authorization: `Bearer ${(env.STRIPE_SECRET_KEY || '').trim()}`,
        'Stripe-Account': row.connected_account_id,
      },
    })
    const payload = await response.json().catch(() => null) as { status?: string } | null
    if (response.ok && payload?.status === 'succeeded') {
      await applyPaymentOutcome(env, row.payment_intent_id, true)
      return { ...row, status: 'succeeded', succeeded_at: nowIso() }
    }
  } catch (error) {
    console.error('Stripe PaymentIntent reconcile failed:', error)
  }
  return row
}

// POST /business/payment-gateway/payment-status (HMAC business-auth). Body: { businessId, paymentIntentId }
export async function handleGetPaymentStatus(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const paymentIntentId = String(auth.request.body.paymentIntentId || '').trim()
  if (!paymentIntentId) return badRequest(requestId, 'paymentIntentId is required.')

  const stored = await env.DB
    .prepare(`SELECT ${paymentRowColumns} FROM portal_payments WHERE payment_intent_id = ? AND business_id = ?`)
    .bind(paymentIntentId, auth.request.businessId)
    .first<PortalPaymentRow>()

  if (!stored) return notFoundResponse(requestId, 'No payment found for that PaymentIntent.')

  const row = await reconcilePendingPaymentFromStripe(env, stored)

  return jsonResponse(200, {
    ok: true,
    requestId,
    payment: {
      paymentIntentId: row.payment_intent_id,
      invoiceRef: row.invoice_ref,
      amountCents: row.amount_cents,
      currency: row.currency,
      method: row.method,
      status: row.status,
      succeededAt: row.succeeded_at,
    },
  }, requestId)
}

async function applyPaymentOutcome(env: Env, paymentIntentId: string, succeeded: boolean) {
  const row = await env.DB
    .prepare(`SELECT ${paymentRowColumns} FROM portal_payments WHERE payment_intent_id = ?`)
    .bind(paymentIntentId)
    .first<PortalPaymentRow>()
  if (!row) return { updated: false }

  const nextStatus = succeeded ? 'succeeded' : 'failed'
  if (row.status === nextStatus) return { updated: false, row }

  const succeededAt = succeeded ? nowIso() : null
  await env.DB
    .prepare(`UPDATE portal_payments SET status = ?, succeeded_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nextStatus, succeededAt, nowIso(), row.id)
    .run()

  // Client Portal path: enqueue a packet the desktop drains via the existing /business/pending-packets
  // + acknowledge flow (the same mechanism a document-signing submission / photo upload already uses).
  // In-app payments have no grant/client -> the desktop polls /business/payment-gateway/payment-status
  // for those instead.
  if (succeeded && row.access_grant_id && row.client_id) {
    await env.DB
      .prepare(`
        INSERT INTO portal_packet_inbox (id, business_id, client_id, access_grant_id, packet_type, payload_json)
        VALUES (?, ?, ?, ?, 'payment_received', ?)
      `)
      .bind(
        crypto.randomUUID(),
        row.business_id,
        row.client_id,
        row.access_grant_id,
        JSON.stringify({
          paymentIntentId: row.payment_intent_id,
          invoiceRef: row.invoice_ref,
          amountCents: row.amount_cents,
          currency: row.currency,
          method: row.method,
          succeededAt,
        }),
      )
      .run()
  }

  return { updated: true, row }
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

async function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(pair => pair.split('=').map(value => value.trim())).filter(pair => pair.length === 2),
  ) as Record<string, string>
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${rawBody}`))
  const expected = Array.from(new Uint8Array(mac), value => value.toString(16).padStart(2, '0')).join('')
  return signatureHeader.split(',')
    .filter(pair => pair.trim().startsWith('v1='))
    .some(pair => timingSafeEqualHex(expected, pair.trim().slice(3)))
}

// POST /payment-gateway/stripe/webhook (PUBLIC -- Stripe posts here). Verified by Stripe-Signature.
export async function handleStripeWebhook(request: Request, env: Env, requestId: string): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') || ''
  const secret = (env.STRIPE_WEBHOOK_SECRET || '').trim()

  if (secret) {
    if (!signature || !(await verifyStripeWebhookSignature(rawBody, signature, secret))) {
      return jsonResponse(400, { ok: false, requestId, message: 'Webhook signature verification failed.' }, requestId)
    }
  } else if (!isStripeMockMode(env)) {
    // Real keys but no webhook secret configured -- refuse rather than trust an unsigned event.
    return jsonResponse(503, { ok: false, requestId, message: 'Webhook secret is not configured.' }, requestId)
  }

  let event: { type?: string; data?: { object?: { id?: string } } } | null = null
  try {
    event = JSON.parse(rawBody)
  } catch {
    return badRequest(requestId, 'Webhook body is not valid JSON.')
  }

  const paymentIntentId = event?.data?.object?.id
  if (typeof paymentIntentId === 'string' && (event?.type === 'payment_intent.succeeded' || event?.type === 'payment_intent.payment_failed')) {
    await applyPaymentOutcome(env, paymentIntentId, event.type === 'payment_intent.succeeded')
  }

  return jsonResponse(200, { ok: true, requestId, received: true }, requestId)
}

// POST /payment-gateway/stripe/mock-complete (DEV + MOCK MODE ONLY). Stands in for the real webhook so
// the whole flow is exercisable end to end without Stripe. Body: { paymentIntentId, outcome? }
export async function handleMockCompletePayment(request: Request, env: Env, requestId: string): Promise<Response> {
  if (env.SERVICE_ENVIRONMENT !== 'development' || !isStripeMockMode(env)) {
    return notFoundResponse(requestId, 'Not found.')
  }
  const body = await request.json().catch(() => null) as { paymentIntentId?: string; outcome?: string } | null
  const paymentIntentId = String(body?.paymentIntentId || '').trim()
  if (!paymentIntentId.startsWith('pi_mock_')) return badRequest(requestId, 'A mock paymentIntentId is required.')

  const succeeded = body?.outcome !== 'failed'
  const result = await applyPaymentOutcome(env, paymentIntentId, succeeded)
  if (!result.row) return notFoundResponse(requestId, 'No payment found for that PaymentIntent.')

  return jsonResponse(200, { ok: true, requestId, paymentIntentId, status: succeeded ? 'succeeded' : 'failed' }, requestId)
}
