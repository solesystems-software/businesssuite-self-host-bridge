import {
  handleAcknowledgePacket,
  handleDownloadBusinessObject,
  handleListPendingPackets,
  handleRegisterPortal,
  handleRunCleanup,
  handleUnregisterPortal,
} from './businessRoutes'
import { runClientPortalCleanup } from './clientPortalCleanup'
import { handleClientPortalRoute } from './clientPortalRoutes'
import type { ClientPortalRoute } from './clientPortalRoutes'
import {
  internalServerError,
  jsonResponse,
  methodNotAllowed,
  notFoundResponse,
} from './clientPortalWorkerHttp'
import type { Env, PortalSchemaVersionRow } from './clientPortalWorkerTypes'

const clientPortalRoutes: Record<string, ClientPortalRoute> = {
  '/submit': 'submit',
  '/upload': 'upload',
  '/estimate-event': 'estimate-event',
  '/invoice-event': 'invoice-event',
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

// Route shapes (bridge only): /business/* require HMAC auth (businessRoutes.ts); the four
// /portal/{inviteToken}/<route> POST routes are Client-facing, token-authenticated only and CORS-bound to
// the origin registered for the token (clientPortalRoutes.ts). The Worker serves no pages: every other
// path, and OPTIONS on any other path, is the generic 404.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID()

    try {
      const url = new URL(request.url)
      const pathname = normalizePath(url.pathname)

      // OPTIONS exists only as the CORS preflight of the four Client routes (handled with the route, after the
      // token lookup); on every other path it is the generic 404, not a blanket 204.
      if (request.method === 'OPTIONS' && !/^\/portal\/[a-f0-9]{64}\/(submit|upload|estimate-event|invoice-event)$/.test(pathname)) {
        return notFoundResponse(requestId)
      }

      if (pathname === '/health') return handleHealth(request, env, requestId)
      if (pathname === '/readiness') return handleReadiness(request, env, requestId)

      if (pathname === '/business/register-portal') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleRegisterPortal(request, env, requestId)
      }
      if (pathname === '/business/unregister-portal') {
        if (request.method !== 'POST') return methodNotAllowed(requestId)
        return handleUnregisterPortal(request, env, requestId)
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

        const route = Object.hasOwn(clientPortalRoutes, subPath) ? clientPortalRoutes[subPath] : undefined
        if (route) return handleClientPortalRoute(request, env, requestId, inviteToken, route)
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
