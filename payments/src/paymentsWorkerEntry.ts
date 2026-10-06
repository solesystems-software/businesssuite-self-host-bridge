import {
  internalServerError,
  jsonResponse,
  makeOptionsResponse,
  methodNotAllowed,
  notFoundResponse,
} from './paymentsWorkerHttp'
import {
  handleAcknowledgeLinkPayments,
  handleCreateBusinessPaymentIntent,
  handleCreateLinkPaymentIntent,
  handleCreatePaymentLink,
  handleGetPaymentStatus,
  handleListLinkPayments,
  handleMockCompletePayment,
  handleStripeWebhook,
} from './paymentRoutes'
import {
  handlePaymentGatewayStatus,
  handleStripeRemoveKey,
  handleStripeSaveKey,
} from './stripeApiKeys'
import { renderPayEmbedHtml } from './payEmbedPage'
import type { Env, PaymentsSchemaVersionRow } from './paymentsWorkerTypes'

// The Payments Worker: an independent service (Galen, 2026-09-29). Invoice card payments and hosted
// payment links work whether or not an invoice is ever sent through Client Portal, so Payments does not
// live inside the Client Portal Worker (and the two Workers share no code or bindings).

const serviceName = 'businesssuite-payments'
const serviceVersion = '0.1.0'

// The card page is designed to be embedded (the desktop invoice editor, or a Client Portal page, iframes
// it). Deliberately omits X-Frame-Options (its absence means "no restriction") and sets frame-ancestors *
// explicitly instead, the modern equivalent every current browser honors. The link token / client secret,
// not the framing origin, is what gates access.
const htmlResponseHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': 'frame-ancestors *',
}

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}

function handleHealth(request: Request, env: Env, requestId: string) {
  if (request.method !== 'GET') return methodNotAllowed(requestId)

  return jsonResponse(200, {
    ok: true,
    requestId,
    service: serviceName,
    version: serviceVersion,
    environment: env.SERVICE_ENVIRONMENT,
    message: 'SoleSystems Payments service is available.',
  }, requestId)
}

async function handleReadiness(request: Request, env: Env, requestId: string) {
  if (request.method !== 'GET') return methodNotAllowed(requestId)

  try {
    const schemaVersion = await env.DB
      .prepare(`SELECT version, description, applied_at FROM payments_schema_versions ORDER BY version DESC LIMIT 1`)
      .first<PaymentsSchemaVersionRow>()

    if (!schemaVersion) {
      return jsonResponse(503, { ok: false, requestId, service: serviceName, message: 'Payments D1 schema has not been initialized.' }, requestId)
    }

    const signingSettings = await env.DB
      .prepare(`SELECT singleton_id FROM payments_worker_settings WHERE singleton_id = 1`)
      .first<{ singleton_id: number }>()

    return jsonResponse(200, {
      ok: true,
      requestId,
      service: serviceName,
      version: serviceVersion,
      environment: env.SERVICE_ENVIRONMENT,
      schemaVersion: schemaVersion.version,
      schemaDescription: schemaVersion.description,
      requestSigningConfigured: Boolean(signingSettings),
      // True once the Stripe key encryption secret is set, i.e. a Business can save its own Stripe API
      // key. Until then only development mock payments work.
      stripeKeyEncryptionConfigured: Boolean((env.STRIPE_API_KEY_ENCRYPTION_KEY || '').trim()),
      message: 'SoleSystems Payments service is ready.',
    }, requestId)
  } catch (error) {
    console.error('Payments readiness check failed:', error)
    return jsonResponse(503, { ok: false, requestId, service: serviceName, message: 'Payments D1 schema is unavailable.' }, requestId)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()

    try {
      if (request.method === 'OPTIONS') return makeOptionsResponse()

      const pathname = normalizePath(new URL(request.url).pathname)

      if (pathname === '/health') return handleHealth(request, env, requestId)
      if (pathname === '/readiness') return handleReadiness(request, env, requestId)

      // Business requests (HMAC business-authenticated).
      if (pathname === '/business/payment-gateway/stripe/save-key') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleStripeSaveKey(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/stripe/remove-key') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleStripeRemoveKey(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/status') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handlePaymentGatewayStatus(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/stripe/payment-intent') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleCreateBusinessPaymentIntent(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/payment-status') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleGetPaymentStatus(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/payment-link') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleCreatePaymentLink(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/link-payments') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleListLinkPayments(request, env, requestId)
      }
      if (pathname === '/business/payment-gateway/link-payments/acknowledge') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleAcknowledgeLinkPayments(request, env, requestId)
      }

      // Stripe webhooks: per-Business (each Business's own Stripe account signs with its own secret). The
      // bare path is kept for development mock-mode events only.
      if (pathname === '/payment-gateway/stripe/webhook' || pathname.startsWith('/payment-gateway/stripe/webhook/')) {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        const webhookBusinessId = pathname.startsWith('/payment-gateway/stripe/webhook/')
          ? decodeURIComponent(pathname.slice('/payment-gateway/stripe/webhook/'.length))
          : null
        return handleStripeWebhook(request, env, requestId, webhookBusinessId || null)
      }
      if (pathname === '/payment-gateway/stripe/mock-complete') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleMockCompletePayment(request, env, requestId)
      }

      // Payer-facing pages (public; the link token / client secret is the capability).
      if (pathname === '/pay-embed') {
        if (request.method !== 'GET') return methodNotAllowed(requestId)
        return new Response(renderPayEmbedHtml(), { status: 200, headers: htmlResponseHeaders })
      }
      const linkMatch = pathname.match(/^\/pay\/([a-f0-9]{64})(\/intent)?$/)
      if (linkMatch) {
        if (linkMatch[2]) {
          if (request.method !== 'POST') return methodNotAllowed(requestId)
          return handleCreateLinkPaymentIntent(request, env, requestId, linkMatch[1])
        }
        if (request.method !== 'GET') return methodNotAllowed(requestId)
        return new Response(renderPayEmbedHtml(), { status: 200, headers: htmlResponseHeaders })
      }

      return notFoundResponse(requestId)
    } catch (error) {
      console.error('Unhandled Payments error:', error)
      return internalServerError(requestId)
    }
  },
}
