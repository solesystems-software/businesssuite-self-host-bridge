import { authenticateBusinessJsonRequest } from './paymentsRequestAuthentication'
import { badRequest, jsonResponse, notFoundResponse } from './paymentsWorkerHttp'
import type {
  Env,
  PaymentLinkRow,
  PaymentMethod,
  PaymentRow,
} from './paymentsWorkerTypes'
import { decryptStripeSecret } from './stripeApiKeyCrypto'
import {
  getStripeApiKeyRow,
  resolveBusinessStripe,
  stripeApiBase,
  stripeAuthHeaders,
} from './stripeApiKeys'

// The Payments Worker's payment routes. Payments are an independent service (Galen, 2026-09-29): an
// invoice can be paid by card in the desktop app, or through a hosted payment link, whether or not it
// is ever sent through Client Portal. Every Stripe call authenticates with the Business's own Stripe API
// key (stripeApiKeys.ts) directly against the Business's own account.
//
// Two collection paths:
//   - in-app card entry: the desktop asks for a PaymentIntent and embeds /pay-embed (payEmbedPage.ts);
//     it polls payment-status for the outcome.
//   - hosted payment link: the desktop creates a link (an unguessable token for one invoice) and shares
//     the URL however it likes (email, text, or embedded in a Client Portal page). The payer's page asks
//     this Worker for a PaymentIntent on demand; succeeded link payments are listed for the desktop, which
//     imports and acknowledges them.
//
// Mock mode is per Business and development-only: a development Worker where the Business has no key
// stored (or stored an sk_test_mock*/rk_test_mock* key) runs deterministic mock payments. Any other
// environment with no key stored fails closed with "payments unavailable".

function paymentsUnavailableResponse(requestId: string, message = 'Payments are not available: this business has not connected a Stripe account.') {
  return jsonResponse(503, { ok: false, requestId, message }, requestId)
}

function nowIso() {
  return new Date().toISOString()
}

const paymentAmountFloorCents = 50
const paymentAmountCeilingCents = 100_000_00
const supportedCurrencies = new Set(['usd', 'cad', 'gbp', 'eur', 'aud'])

const paymentRowColumns = `
  id, business_id, invoice_ref, amount_cents, currency, method, payment_intent_id, link_token, status,
  created_at, updated_at, succeeded_at, desktop_acknowledged_at
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

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

async function synthesizeMockPaymentIntent(invoiceRef: string, method: PaymentMethod) {
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
  secretKey: string,
  amountCents: number,
  currency: string,
  invoiceRef: string,
  method: PaymentMethod,
): Promise<{ id: string; clientSecret: string }> {
  const body = new URLSearchParams()
  body.set('amount', String(amountCents))
  body.set('currency', currency)
  body.set('automatic_payment_methods[enabled]', 'true')
  body.set('metadata[invoice_ref]', invoiceRef)
  body.set('metadata[method]', method)
  body.set('description', `Invoice ${invoiceRef}`)

  const response = await fetch(`${stripeApiBase(env)}/payment_intents`, {
    method: 'POST',
    headers: stripeAuthHeaders(secretKey, { 'Content-Type': 'application/x-www-form-urlencoded' }),
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
  invoiceRef: string
  amountCents: number
  currency: string
  method: PaymentMethod
  paymentIntentId: string
  linkToken: string | null
}) {
  await env.DB
    .prepare(`
      INSERT INTO payments_payments
        (id, business_id, invoice_ref, amount_cents, currency, method, payment_intent_id, link_token, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requires_payment')
    `)
    .bind(
      crypto.randomUUID(), input.businessId, input.invoiceRef, input.amountCents, input.currency,
      input.method, input.paymentIntentId, input.linkToken,
    )
    .run()
}

function payEmbedUrlFor(origin: string, params: {
  clientSecret: string
  publishableKey: string
  amountCents: number
  currency: string
  mock: boolean
}) {
  const fragment = new URLSearchParams()
  fragment.set('cs', params.clientSecret)
  fragment.set('pk', params.publishableKey)
  fragment.set('amt', String(params.amountCents))
  fragment.set('cur', params.currency)
  if (params.mock) fragment.set('mock', '1')
  return `${origin}/pay-embed#${fragment.toString()}`
}

// Shared by both collection paths: resolve the Business's credentials, open a real or mock
// PaymentIntent, and record the payment row. Returns a ready Response on failure.
async function openPaymentIntent(env: Env, requestId: string, origin: string, input: {
  businessId: string
  invoiceRef: string
  amountCents: number
  currency: string
  method: PaymentMethod
  linkToken: string | null
}): Promise<
  | { ok: true; paymentIntentId: string; clientSecret: string; publishableKey: string; mock: boolean; payEmbedUrl: string }
  | { ok: false; response: Response }
> {
  let credentials
  try {
    credentials = await resolveBusinessStripe(env, input.businessId)
  } catch (error) {
    console.error('Stripe credential lookup failed:', error instanceof Error ? error.message : 'unknown error')
    return { ok: false, response: paymentsUnavailableResponse(requestId, 'Payments are not available: the stored Stripe key could not be read. Save the key again in Settings.') }
  }
  if (credentials.mode === 'none') return { ok: false, response: paymentsUnavailableResponse(requestId) }

  const mock = credentials.mode === 'mock'
  let intent: { id: string; clientSecret: string }
  try {
    intent = credentials.mode === 'mock'
      ? await synthesizeMockPaymentIntent(input.invoiceRef, input.method)
      : await createRealStripePaymentIntent(env, credentials.secretKey, input.amountCents, input.currency, input.invoiceRef, input.method)
  } catch (error) {
    console.error('PaymentIntent creation failed:', error)
    return {
      ok: false,
      response: jsonResponse(502, { ok: false, requestId, message: error instanceof Error ? error.message : 'PaymentIntent creation failed.' }, requestId),
    }
  }

  await insertPaymentRow(env, {
    businessId: input.businessId,
    invoiceRef: input.invoiceRef,
    amountCents: input.amountCents,
    currency: input.currency,
    method: input.method,
    paymentIntentId: intent.id,
    linkToken: input.linkToken,
  })

  const publishableKey = credentials.mode === 'real' ? credentials.publishableKey : 'pk_mock_development'
  return {
    ok: true,
    paymentIntentId: intent.id,
    clientSecret: intent.clientSecret,
    publishableKey,
    mock,
    payEmbedUrl: payEmbedUrlFor(origin, {
      clientSecret: intent.clientSecret,
      publishableKey,
      amountCents: input.amountCents,
      currency: input.currency,
      mock,
    }),
  }
}

// POST /business/payment-gateway/stripe/payment-intent (HMAC business-auth). In-app card entry.
// Body: { businessId, invoiceRef, amountCents, currency? }
export async function handleCreateBusinessPaymentIntent(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const { businessId, body } = auth.request
  const invoiceRef = String(body.invoiceRef || '').trim()
  const amountCents = normalizeAmountCents(body.amountCents)
  const currency = normalizeCurrency(body.currency)

  if (!invoiceRef) return badRequest(requestId, 'invoiceRef is required.')
  if (amountCents === null) return badRequest(requestId, `amountCents must be an integer between ${paymentAmountFloorCents} and ${paymentAmountCeilingCents}.`)

  const opened = await openPaymentIntent(env, requestId, new URL(request.url).origin, {
    businessId, invoiceRef, amountCents, currency, method: 'card_in_app', linkToken: null,
  })
  if (!opened.ok) return opened.response

  return jsonResponse(200, {
    ok: true,
    requestId,
    paymentIntentId: opened.paymentIntentId,
    clientSecret: opened.clientSecret,
    publishableKey: opened.publishableKey,
    amountCents,
    currency,
    mock: opened.mock,
    payEmbedUrl: opened.payEmbedUrl,
  }, requestId)
}

// POST /business/payment-gateway/payment-link (HMAC business-auth).
// Body: { businessId, invoiceRef, amountCents, currency?, title? } -- creates a hosted payment link for
// one invoice and revokes any earlier active link for the same invoice.
export async function handleCreatePaymentLink(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const { businessId, body } = auth.request
  const invoiceRef = String(body.invoiceRef || '').trim()
  const amountCents = normalizeAmountCents(body.amountCents)
  const currency = normalizeCurrency(body.currency)
  const title = String(body.title || '').trim().slice(0, 200) || 'Invoice payment'

  if (!invoiceRef) return badRequest(requestId, 'invoiceRef is required.')
  if (amountCents === null) return badRequest(requestId, `amountCents must be an integer between ${paymentAmountFloorCents} and ${paymentAmountCeilingCents}.`)

  let credentials
  try {
    credentials = await resolveBusinessStripe(env, businessId)
  } catch {
    return paymentsUnavailableResponse(requestId, 'Payments are not available: the stored Stripe key could not be read. Save the key again in Settings.')
  }
  if (credentials.mode === 'none') return paymentsUnavailableResponse(requestId)

  const token = randomToken()
  const createdAt = nowIso()
  await env.DB.batch([
    env.DB.prepare(`UPDATE payments_links SET revoked_at = ? WHERE business_id = ? AND invoice_ref = ? AND revoked_at IS NULL`)
      .bind(createdAt, businessId, invoiceRef),
    env.DB.prepare(`
      INSERT INTO payments_links (token, business_id, invoice_ref, title, amount_cents, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(token, businessId, invoiceRef, title, amountCents, currency, createdAt),
  ])

  return jsonResponse(200, {
    ok: true,
    requestId,
    token,
    url: `${new URL(request.url).origin}/pay/${token}`,
    invoiceRef,
    amountCents,
    currency,
    mock: credentials.mode === 'mock',
  }, requestId)
}

// POST /pay/{token}/intent (PUBLIC -- the payer's page; the unguessable link token is the capability).
export async function handleCreateLinkPaymentIntent(request: Request, env: Env, requestId: string, token: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(token)) return notFoundResponse(requestId, 'This payment link is not valid.')

  const link = await env.DB
    .prepare(`SELECT token, business_id, invoice_ref, title, amount_cents, currency, created_at, revoked_at FROM payments_links WHERE token = ?`)
    .bind(token)
    .first<PaymentLinkRow>()
  if (!link || link.revoked_at) return notFoundResponse(requestId, 'This payment link is not valid or has been replaced.')

  const alreadyPaid = await env.DB
    .prepare(`SELECT 1 AS paid FROM payments_payments WHERE link_token = ? AND status = 'succeeded' LIMIT 1`)
    .bind(token)
    .first<{ paid: number }>()
  if (alreadyPaid) {
    return jsonResponse(409, { ok: false, requestId, message: 'This invoice has already been paid. Thank you!' }, requestId)
  }

  const opened = await openPaymentIntent(env, requestId, new URL(request.url).origin, {
    businessId: link.business_id,
    invoiceRef: link.invoice_ref,
    amountCents: link.amount_cents,
    currency: link.currency,
    method: 'payment_link',
    linkToken: token,
  })
  if (!opened.ok) return opened.response

  return jsonResponse(200, {
    ok: true,
    requestId,
    title: link.title,
    clientSecret: opened.clientSecret,
    publishableKey: opened.publishableKey,
    amountCents: link.amount_cents,
    currency: link.currency,
    mock: opened.mock,
  }, requestId)
}

// The webhook is the primary way a payment row becomes `succeeded`, but the in-app card flow polls
// payment-status immediately after the payer confirms -- routinely before the webhook lands. So when a
// row is still pending, ask Stripe directly (with the Business's own key) and apply the same outcome the
// webhook would. No-op for mock payments (the mock-complete route drives those). Reconciles success
// only -- a non-succeeded live PaymentIntent stays pending rather than being prematurely marked failed.
async function reconcilePendingPaymentFromStripe(env: Env, row: PaymentRow): Promise<PaymentRow> {
  if (row.payment_intent_id.startsWith('pi_mock_')) return row
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'canceled') return row

  try {
    const credentials = await resolveBusinessStripe(env, row.business_id)
    if (credentials.mode !== 'real') return row
    const response = await fetch(`${stripeApiBase(env)}/payment_intents/${encodeURIComponent(row.payment_intent_id)}`, {
      headers: stripeAuthHeaders(credentials.secretKey),
    })
    const payload = await response.json().catch(() => null) as { status?: string } | null
    if (response.ok && payload?.status === 'succeeded') {
      await applyPaymentOutcome(env, row.payment_intent_id, true)
      return { ...row, status: 'succeeded', succeeded_at: nowIso() }
    }
  } catch (error) {
    console.error('Stripe PaymentIntent reconcile failed:', error instanceof Error ? error.message : 'unknown error')
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
    .prepare(`SELECT ${paymentRowColumns} FROM payments_payments WHERE payment_intent_id = ? AND business_id = ?`)
    .bind(paymentIntentId, auth.request.businessId)
    .first<PaymentRow>()

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

// POST /business/payment-gateway/link-payments (HMAC business-auth). Succeeded hosted-link payments the
// desktop has not yet imported. Body: { businessId }.
export async function handleListLinkPayments(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const result = await env.DB
    .prepare(`
      SELECT ${paymentRowColumns} FROM payments_payments
      WHERE business_id = ? AND method = 'payment_link' AND status = 'succeeded' AND desktop_acknowledged_at IS NULL
      ORDER BY succeeded_at ASC LIMIT 100
    `)
    .bind(auth.request.businessId)
    .all<PaymentRow>()

  return jsonResponse(200, {
    ok: true,
    requestId,
    payments: (result.results ?? []).map(row => ({
      paymentIntentId: row.payment_intent_id,
      invoiceRef: row.invoice_ref,
      amountCents: row.amount_cents,
      currency: row.currency,
      method: row.method,
      succeededAt: row.succeeded_at,
    })),
  }, requestId)
}

// POST /business/payment-gateway/link-payments/acknowledge (HMAC business-auth).
// Body: { businessId, paymentIntentIds: string[] } -- the desktop imported these payments.
export async function handleAcknowledgeLinkPayments(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const ids = Array.isArray(auth.request.body.paymentIntentIds)
    ? auth.request.body.paymentIntentIds.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, 100)
    : []
  if (ids.length === 0) return badRequest(requestId, 'paymentIntentIds must be a non-empty array of strings.')

  const acknowledgedAt = nowIso()
  const result = await env.DB
    .prepare(`
      UPDATE payments_payments SET desktop_acknowledged_at = ?
      WHERE business_id = ? AND method = 'payment_link' AND desktop_acknowledged_at IS NULL
        AND payment_intent_id IN (${ids.map(() => '?').join(',')})
    `)
    .bind(acknowledgedAt, auth.request.businessId, ...ids)
    .run()

  return jsonResponse(200, { ok: true, requestId, acknowledgedCount: result.meta.changes, acknowledgedAt }, requestId)
}

// When businessId is given (a per-Business webhook), only that Business's own payments can be updated.
async function applyPaymentOutcome(env: Env, paymentIntentId: string, succeeded: boolean, businessId?: string) {
  const row = await env.DB
    .prepare(`SELECT ${paymentRowColumns} FROM payments_payments WHERE payment_intent_id = ?`)
    .bind(paymentIntentId)
    .first<PaymentRow>()
  if (!row) return { updated: false }
  if (businessId && row.business_id !== businessId) return { updated: false }

  const nextStatus = succeeded ? 'succeeded' : 'failed'
  if (row.status === nextStatus) return { updated: false, row }

  await env.DB
    .prepare(`UPDATE payments_payments SET status = ?, succeeded_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nextStatus, succeeded ? nowIso() : null, nowIso(), row.id)
    .run()

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

// POST /payment-gateway/stripe/webhook/{businessId} (PUBLIC -- Stripe posts here). Each Business is an
// independent Stripe account whose webhook endpoint (registered by save-key) is signed with that
// Business's own secret, so verification looks up that Business's stored secret. Without a stored
// secret (development mock only) unsigned events are accepted but may only touch pi_mock_* payments.
export async function handleStripeWebhook(request: Request, env: Env, requestId: string, businessId: string | null): Promise<Response> {
  const rawBody = await request.text()
  const signature = request.headers.get('stripe-signature') || ''

  let webhookSecret: string | null = null
  if (businessId) {
    const row = await getStripeApiKeyRow(env, businessId)
    if (row?.encrypted_webhook_secret && row.webhook_secret_iv && row.webhook_secret_version) {
      try {
        webhookSecret = await decryptStripeSecret(env, { businessId, kind: 'webhook_secret' }, {
          ciphertext: row.encrypted_webhook_secret,
          iv: row.webhook_secret_iv,
          version: row.webhook_secret_version,
        })
      } catch (error) {
        console.error('Stripe webhook secret could not be read:', error instanceof Error ? error.message : 'unknown error')
        return jsonResponse(503, { ok: false, requestId, message: 'Webhook secret could not be read.' }, requestId)
      }
    }
  }

  const unsignedMockOnly = !webhookSecret
  if (webhookSecret) {
    if (!signature || !(await verifyStripeWebhookSignature(rawBody, signature, webhookSecret))) {
      return jsonResponse(400, { ok: false, requestId, message: 'Webhook signature verification failed.' }, requestId)
    }
  } else if (env.SERVICE_ENVIRONMENT !== 'development') {
    // No stored signing secret outside development -- refuse rather than trust an unsigned event.
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
    if (!unsignedMockOnly || paymentIntentId.startsWith('pi_mock_')) {
      await applyPaymentOutcome(env, paymentIntentId, event.type === 'payment_intent.succeeded', businessId ?? undefined)
    }
  }

  return jsonResponse(200, { ok: true, requestId, received: true }, requestId)
}

// POST /payment-gateway/stripe/mock-complete (DEV + MOCK MODE ONLY). Stands in for the real webhook so
// the whole flow is exercisable end to end without Stripe. Body: { paymentIntentId, outcome? }
export async function handleMockCompletePayment(request: Request, env: Env, requestId: string): Promise<Response> {
  if (env.SERVICE_ENVIRONMENT !== 'development') return notFoundResponse(requestId, 'Not found.')

  const body = await request.json().catch(() => null) as { paymentIntentId?: string; outcome?: string } | null
  const paymentIntentId = String(body?.paymentIntentId || '').trim()
  if (!paymentIntentId.startsWith('pi_mock_')) return badRequest(requestId, 'A mock paymentIntentId is required.')

  const succeeded = body?.outcome !== 'failed'
  const result = await applyPaymentOutcome(env, paymentIntentId, succeeded)
  if (!result.row) return notFoundResponse(requestId, 'No payment found for that PaymentIntent.')

  return jsonResponse(200, { ok: true, requestId, paymentIntentId, status: succeeded ? 'succeeded' : 'failed' }, requestId)
}
