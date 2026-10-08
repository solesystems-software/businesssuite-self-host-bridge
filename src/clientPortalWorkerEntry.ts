import {
  handleAcknowledgePacket,
  handleDownloadBusinessObject,
  handleListPendingPackets,
  handlePublishSnapshot,
  handleRunCleanup,
  handleUploadObject,
} from './businessRoutes'
import { runClientPortalCleanup } from './clientPortalCleanup'
import {
  handleGetPortalObject,
  handleGetPortalSnapshot,
  handleSubmitEstimateEvent,
  handleSubmitInvoiceEvent,
  handleSubmitPortalPacket,
  handleUploadPortalPhoto,
} from './clientPortalRoutes'
import {
  badRequest,
  internalServerError,
  jsonResponse,
  makeOptionsResponse,
  methodNotAllowed,
  notFoundResponse,
} from './clientPortalWorkerHttp'
import { renderEmbedShellHtml } from './embedShellPage'
import type { Env, PortalSchemaVersionRow } from './clientPortalWorkerTypes'

const htmlResponseHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // Part B Phase 3: this page is designed to be embedded via <iframe> on an arbitrary Business's own
  // website. Deliberately omits X-Frame-Options entirely (its absence means "no restriction" -- there is
  // no valid "allow all origins" value for that header) and sets frame-ancestors * explicitly instead,
  // the modern equivalent every current browser actually honors. The invite token itself, not the
  // framing origin, is what gates access to the underlying data.
  'Content-Security-Policy': "frame-ancestors *",
}

const serviceName = 'businesssuite-client-portal'
const serviceVersion = '0.1.0'

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
    message: 'SoleSystems Client Portal relay is available.',
  }, requestId)
}

async function handleReadiness(request: Request, env: Env, requestId: string) {
  if (request.method !== 'GET') return methodNotAllowed(requestId)

  try {
    const schemaVersion = await env.DB
      .prepare(`SELECT version, description, applied_at FROM portal_schema_versions ORDER BY version DESC LIMIT 1`)
      .first<PortalSchemaVersionRow>()

    if (!schemaVersion) {
      return jsonResponse(503, { ok: false, requestId, service: serviceName, message: 'Client Portal D1 schema has not been initialized.' }, requestId)
    }

    // Wave 2A: the publish signing secret is now self-bootstrapped into D1 on first use (see
    // getOrCreatePublishSigningSecretBase64 in clientPortalRequestAuthentication.ts) rather than
    // supplied as a Worker secret, so "configured" now means "has bootstrapped its row" instead of
    // "env var is set". Reported as a DB-existence check, not a live bootstrap attempt, so a
    // readiness ping never has the side effect of generating the secret itself.
    const publishSigningSettings = await env.DB
      .prepare(`SELECT singleton_id FROM client_portal_worker_settings WHERE singleton_id = 1`)
      .first<{ singleton_id: number }>()

    return jsonResponse(200, {
      ok: true,
      requestId,
      service: serviceName,
      version: serviceVersion,
      environment: env.SERVICE_ENVIRONMENT,
      schemaVersion: schemaVersion.version,
      schemaDescription: schemaVersion.description,
      publishSigningConfigured: Boolean(publishSigningSettings),
      message: 'SoleSystems Client Portal relay is ready.',
    }, requestId)
  } catch (error) {
    console.error('Client Portal readiness check failed:', error)
    return jsonResponse(503, { ok: false, requestId, service: serviceName, message: 'Client Portal D1 schema is unavailable.' }, requestId)
  }
}

// Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md: public, unauthenticated oEmbed
// endpoint (https://oembed.com/) so a bare pasted /embed/{inviteToken} URL auto-renders as an
// embedded iframe in WordPress's block editor (and any other oEmbed-consuming embed tool), rather
// than requiring the Business to hand-build an <iframe> snippet. Discovery is wired via the <link
// rel="alternate" type="application/json+oembed"> tag embedShellPage.ts's renderEmbedShellHtml
// renders into the /embed page's own <head>. Validates `url` against this relay's own /embed/{token}
// pattern rather than reflecting an arbitrary caller-supplied URL into the response.
function handleOembed(request: Request, url: URL, requestId: string) {
  if (request.method !== 'GET') return methodNotAllowed(requestId)

  const targetUrl = url.searchParams.get('url') || ''
  const embedMatch = targetUrl.match(/^https?:\/\/[^/]+\/embed\/([a-f0-9]{64})\/?$/)
  if (!embedMatch) return badRequest(requestId, "url must be one of this relay's own /embed/{inviteToken} links.")

  const embedUrl = `${url.origin}/embed/${embedMatch[1]}`
  return jsonResponse(200, {
    type: 'rich',
    version: '1.0',
    provider_name: 'Sole Business Suite Client Portal',
    html: `<iframe src="${embedUrl}" data-responsive="false" style="width:100%;height:800px;border:0;" loading="lazy"></iframe>`,
    width: 800,
    height: 800,
  }, requestId)
}

// Route shapes: /business/* require HMAC auth (businessRoutes.ts); /portal/{inviteToken}[/*] are
// Client-facing, token-authenticated only (clientPortalRoutes.ts) -- source plan sections 15.1-15.4.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()

    try {
      if (request.method === 'OPTIONS') return makeOptionsResponse()

      const url = new URL(request.url)
      const pathname = normalizePath(url.pathname)

      if (pathname === '/health') return handleHealth(request, env, requestId)
      if (pathname === '/readiness') return handleReadiness(request, env, requestId)

      const embedMatch = pathname.match(/^\/embed\/([a-f0-9]{64})$/)
      if (embedMatch) {
        if (request.method !== 'GET') return methodNotAllowed(requestId)
        return new Response(renderEmbedShellHtml(embedMatch[1], url.origin), { status: 200, headers: htmlResponseHeaders })
      }

      if (pathname === '/oembed') return handleOembed(request, url, requestId)

      if (pathname === '/business/publish-snapshot') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handlePublishSnapshot(request, env, requestId)
      }
      if (pathname === '/business/upload-object') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleUploadObject(request, env, requestId)
      }
      if (pathname === '/business/pending-packets') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleListPendingPackets(request, env, requestId)
      }
      if (pathname === '/business/acknowledge-packet') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleAcknowledgePacket(request, env, requestId)
      }
      const businessObjectMatch = pathname.match(/^\/business\/objects\/([0-9a-f-]{36})$/)
      if (businessObjectMatch) {
        if (request.method !== 'GET') return methodNotAllowed(requestId)
        return handleDownloadBusinessObject(request, env, requestId, businessObjectMatch[1])
      }
      if (pathname === '/business/run-cleanup') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleRunCleanup(request, env, requestId)
      }


      const portalMatch = pathname.match(/^\/portal\/([a-f0-9]{64})(\/.*)?$/)
      if (portalMatch) {
        const inviteToken = portalMatch[1]
        const subPath = portalMatch[2] || ''

        if (subPath === '') {
          if (request.method !== 'GET') return methodNotAllowed(requestId)
          return handleGetPortalSnapshot(env, requestId, inviteToken)
        }
        if (subPath === '/submit') {
          if (request.method !== 'POST') return methodNotAllowed(requestId)
          return handleSubmitPortalPacket(request, env, requestId, inviteToken)
        }
        if (subPath === '/upload') {
          if (request.method !== 'POST') return methodNotAllowed(requestId)
          return handleUploadPortalPhoto(request, env, requestId, inviteToken)
        }
        if (subPath === '/estimate-event') {
          if (request.method !== 'POST') return methodNotAllowed(requestId)
          return handleSubmitEstimateEvent(request, env, requestId, inviteToken)
        }
        if (subPath === '/invoice-event') {
          if (request.method !== 'POST') return methodNotAllowed(requestId)
          return handleSubmitInvoiceEvent(request, env, requestId, inviteToken)
        }
        const objectMatch = subPath.match(/^\/objects\/([0-9a-f-]{36})$/)
        if (objectMatch) {
          if (request.method !== 'GET') return methodNotAllowed(requestId)
          return handleGetPortalObject(request, env, requestId, inviteToken, objectMatch[1])
        }
      }

      return notFoundResponse(requestId)
    } catch (error) {
      console.error('Unhandled Client Portal relay error:', error)
      return internalServerError(requestId)
    }
  },

  // Part B Phase 7: automatic production execution of the same cleanup routine
  // POST /business/run-cleanup triggers manually -- wired via wrangler.toml's [triggers] crons.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runClientPortalCleanup(env).catch(error => {
        console.error('Scheduled Client Portal cleanup failed:', error)
      }),
    )
  },
}
