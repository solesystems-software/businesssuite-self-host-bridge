import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  notFoundResponse,
  payloadTooLarge,
} from './clientPortalWorkerHttp'
import { estimateRefIsAllowed, parseEstimateEventBody } from './estimateEventValidation'
import { invoiceRefIsAllowed, parseInvoiceEventBody } from './invoiceEventValidation'
import type { AllowedRefs } from './portalRegistryValidation'
import type { Env, PortalAccessGrantRow } from './clientPortalWorkerTypes'

// Client_Portal_Site_Publishing_Task_Spec_20261112.md (D5, D6, D7, D14): the Worker is a bridge only. It
// serves no pages and holds no published content; the Business's own site hosts the portal page, and that
// page calls the four POST routes below. Every route is authenticated by the invite-link token alone, and a
// token is live only while the Business has it registered (portal_live_registrations, written by
// POST /business/register-portal): grant present, not revoked, expires_at set and in the future, companion
// row present. Every row this reads or writes is scoped through the token's own access_grant_id, never a
// client-supplied business_id/client_id -- Part B Phase 8's tenant-isolation requirement.

// Correction (2026-08-24): raised from 10MB -- real phone-camera JPEGs routinely exceed that,
// while the small PNGs used in this project's own dev/test data stayed comfortably under it, which
// read as a JPG-vs-PNG format bug until traced back to this cap. 25MB is well inside Cloudflare
// Workers' own request-body ceiling (100MB+ on every plan tier) and R2's per-object limits, so this
// is purely this app's own choice, not a platform constraint. pendingPerClientBytes keeps its
// original ~5x-single-upload ratio.
const maximumUploadBytes = 25 * 1024 * 1024 // Part 0 (corrected 2026-08-24): single upload max 25MB.
const pendingPerClientBytes = 125 * 1024 * 1024 // Part 0 (corrected 2026-08-24): 125MB pending per Client.
const pendingPerBusinessBytes = 1024 * 1024 * 1024 // Part 0: 1GB pending per Business.

const documentSigningResponsePacketType = 'document_signing_response'

export type ClientPortalRoute = 'submit' | 'upload' | 'estimate-event' | 'invoice-event'

export type LiveRegistration = {
  grant: PortalAccessGrantRow
  allowedOrigin: string
  allowedRefs: AllowedRefs
}

type LiveRegistrationRow = PortalAccessGrantRow & {
  allowed_origin: string
  allowed_refs_json: string
}

function parseStoredRefs(refsJson: string): AllowedRefs {
  const empty: AllowedRefs = { documentIds: [], estimateRefs: [], invoiceRefs: [] }
  try {
    const parsed = JSON.parse(refsJson) as Partial<Record<keyof AllowedRefs, unknown>> | null
    if (!parsed || typeof parsed !== 'object') return empty
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
    return { documentIds: list(parsed.documentIds), estimateRefs: list(parsed.estimateRefs), invoiceRefs: list(parsed.invoiceRefs) }
  } catch {
    return empty
  }
}

// A token is live only when its grant exists, is not revoked, has a non-null expires_at in the future, and has a
// companion portal_live_registrations row. Grants made by the retired publish path have no companion row
// (and a null expires_at), so they are never live.
async function findLiveRegistration(env: Env, inviteToken: string): Promise<LiveRegistration | null> {
  if (!/^[a-f0-9]{64}$/.test(inviteToken)) return null

  const row = await env.DB
    .prepare(`
      SELECT g.id, g.business_id, g.client_id, g.portal_context_id, g.invite_token, g.created_at, g.expires_at, g.revoked_at,
             r.allowed_origin, r.allowed_refs_json
      FROM portal_access_grants g
      JOIN portal_live_registrations r ON r.access_grant_id = g.id
      WHERE g.invite_token = ?
    `)
    .bind(inviteToken)
    .first<LiveRegistrationRow>()

  if (!row) return null
  if (row.revoked_at) return null
  if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) return null

  const { allowed_origin: allowedOrigin, allowed_refs_json: allowedRefsJson, ...grant } = row
  return { grant, allowedOrigin, allowedRefs: parseStoredRefs(allowedRefsJson) }
}

// CORS (D14). The Worker answers a browser only when the request Origin is EXACTLY the origin the Business
// registered for this token: never "*", never a reflected arbitrary Origin. Every response for a live token
// carries Vary: Origin so a shared cache cannot hand one origin's answer to another. Non-browser clients
// ignore CORS entirely; they are bounded by the 256-bit token and the registration only.
function applyClientCors(response: Response, registration: LiveRegistration, requestOrigin: string | null) {
  response.headers.set('Vary', 'Origin')
  if (requestOrigin !== null && requestOrigin === registration.allowedOrigin) {
    response.headers.set('Access-Control-Allow-Origin', registration.allowedOrigin)
  }
  return response
}

function preflightResponse(requestId: string, registration: LiveRegistration, requestOrigin: string | null) {
  if (requestOrigin === null || requestOrigin !== registration.allowedOrigin) {
    return new Response(null, {
      status: 403,
      headers: { 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Request-Id': requestId },
    })
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': registration.allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-SoleSystems-Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      'X-Request-Id': requestId,
    },
  })
}

// One entry for the four Client routes. Not live (unknown, unregistered, revoked, expired, legacy grant) is
// the generic 404 with no CORS headers for every method; a live token gets the preflight, the POST handler,
// or a 405, each carrying Vary: Origin.
export async function handleClientPortalRoute(
  request: Request,
  env: Env,
  requestId: string,
  inviteToken: string,
  route: ClientPortalRoute,
): Promise<Response> {
  const registration = await findLiveRegistration(env, inviteToken)
  if (!registration) return notFoundResponse(requestId)

  const requestOrigin = request.headers.get('origin')

  if (request.method === 'OPTIONS') return preflightResponse(requestId, registration, requestOrigin)
  if (request.method !== 'POST') return applyClientCors(methodNotAllowed(requestId), registration, requestOrigin)

  let response: Response
  switch (route) {
    case 'submit':
      response = await submitPortalPacket(request, env, requestId, registration)
      break
    case 'upload':
      response = await uploadPortalPhoto(request, env, requestId, registration)
      break
    case 'estimate-event':
      response = await submitEstimateEvent(request, env, requestId, registration)
      break
    default:
      response = await submitInvoiceEvent(request, env, requestId, registration)
      break
  }
  return applyClientCors(response, registration, requestOrigin)
}

async function submitPortalPacket(request: Request, env: Env, requestId: string, registration: LiveRegistration): Promise<Response> {
  const { grant, allowedRefs } = registration

  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return badRequest(requestId, 'Content-Type must be application/json.')
  }

  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    body = parsed as Record<string, unknown>
  } catch {
    return badRequest(requestId, 'Request body contains invalid JSON.')
  }

  const packetType = body.packetType
  const payload = body.payload
  if (typeof packetType !== 'string' || !packetType.trim() || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return badRequest(requestId, 'packetType and payload are required.')
  }

  // The site-hosted page can only send a signed-document response; every other packet type is Worker-made.
  if (packetType.trim() !== documentSigningResponsePacketType) {
    return badRequest(requestId, 'packetType must be document_signing_response.')
  }

  const documentId = (payload as Record<string, unknown>).documentId
  if (typeof documentId !== 'string' || !documentId.trim() || !allowedRefs.documentIds.includes(documentId.trim())) {
    return badRequest(requestId, 'documentId is not registered for this invite link.')
  }

  const packetId = crypto.randomUUID()

  // Business, client and grant come from the registration, never from the body.
  await env.DB
    .prepare(`
      INSERT INTO portal_packet_inbox (id, business_id, client_id, access_grant_id, packet_type, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(packetId, grant.business_id, grant.client_id, grant.id, documentSigningResponsePacketType, JSON.stringify(payload))
    .run()

  return jsonResponse(200, { ok: true, requestId, packetId, message: 'Submitted -- pending Business review.' }, requestId)
}

// Notifications_..._7Phase_Plan Part C-2 / C-5 (Orchestration BS-2): the Client's own actions on a
// published Estimate -- opening it fires a 'viewed' beacon, the Accept / Decline buttons fire
// 'accepted' / 'declined'. Each becomes an 'estimate_event' packet in the Business's inbox, which
// ClientPortalRuntimeService.pollEstimateClientEvents drains into an estimate status change +
// notification. The estimateRef must be one the Business registered for this token
// (allowedRefs.estimateRefs) -- any other ref is rejected here, never forwarded to the Business.
// (parseEstimateEventBody / estimateRefIsAllowed live in estimateEventValidation.ts so they carry a
// dependency-free node --test surface.)
async function submitEstimateEvent(request: Request, env: Env, requestId: string, registration: LiveRegistration): Promise<Response> {
  const { grant, allowedRefs } = registration

  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return badRequest(requestId, 'Content-Type must be application/json.')
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return badRequest(requestId, 'Request body contains invalid JSON.')
  }

  const parsed = parseEstimateEventBody(rawBody)
  if (!parsed.ok) return badRequest(requestId, parsed.error)
  const { estimateRef, event } = parsed

  if (!estimateRefIsAllowed(allowedRefs.estimateRefs, estimateRef)) {
    return badRequest(requestId, 'estimateRef is not registered for this invite link.')
  }

  // For 'viewed', collapse repeat page loads: skip if an unacknowledged 'viewed' event for this
  // estimate is already queued. 'accepted' / 'declined' are always recorded (the Business side
  // dedupes the resulting notification).
  if (event === 'viewed') {
    const existing = await env.DB
      .prepare(`
        SELECT id FROM portal_packet_inbox
        WHERE access_grant_id = ? AND packet_type = 'estimate_event' AND status = 'pending'
          AND json_extract(payload_json, '$.event') = 'viewed'
          AND json_extract(payload_json, '$.estimateRef') = ?
        LIMIT 1
      `)
      .bind(grant.id, estimateRef)
      .first<{ id: string }>()
    if (existing) {
      return jsonResponse(200, { ok: true, requestId, deduped: true, message: 'Already recorded.' }, requestId)
    }
  }

  const packetId = crypto.randomUUID()
  await env.DB
    .prepare(`
      INSERT INTO portal_packet_inbox (id, business_id, client_id, access_grant_id, packet_type, payload_json)
      VALUES (?, ?, ?, ?, 'estimate_event', ?)
    `)
    .bind(packetId, grant.business_id, grant.client_id, grant.id, JSON.stringify({ estimateRef, event }))
    .run()

  return jsonResponse(200, { ok: true, requestId, packetId, event, message: 'Recorded.' }, requestId)
}

// Notifications_..._7Phase_Plan Part D / D-4 (Orchestration BS-3): the Client opening a published
// invoice deep-link fires a 'viewed' beacon, which becomes an 'invoice_event' packet the Business
// polls (ClientPortalRuntimeService.pollInvoiceClientEvents) into an invoice status change +
// notification. Thin glue over invoiceEventValidation.ts plus the same registration / D1-insert
// pattern submitEstimateEvent uses.
async function submitInvoiceEvent(request: Request, env: Env, requestId: string, registration: LiveRegistration): Promise<Response> {
  const { grant, allowedRefs } = registration

  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return badRequest(requestId, 'Content-Type must be application/json.')
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return badRequest(requestId, 'Request body contains invalid JSON.')
  }

  const parsed = parseInvoiceEventBody(rawBody)
  if (!parsed.ok) return badRequest(requestId, parsed.error)
  const { invoiceRef, event } = parsed

  if (!invoiceRefIsAllowed(allowedRefs.invoiceRefs, invoiceRef)) {
    return badRequest(requestId, 'invoiceRef is not registered for this invite link.')
  }

  // Collapse repeat page loads: skip if an unacknowledged 'viewed' event for this invoice is queued.
  const existing = await env.DB
    .prepare(`
      SELECT id FROM portal_packet_inbox
      WHERE access_grant_id = ? AND packet_type = 'invoice_event' AND status = 'pending'
        AND json_extract(payload_json, '$.event') = 'viewed'
        AND json_extract(payload_json, '$.invoiceRef') = ?
      LIMIT 1
    `)
    .bind(grant.id, invoiceRef)
    .first<{ id: string }>()
  if (existing) {
    return jsonResponse(200, { ok: true, requestId, deduped: true, message: 'Already recorded.' }, requestId)
  }

  const packetId = crypto.randomUUID()
  await env.DB
    .prepare(`
      INSERT INTO portal_packet_inbox (id, business_id, client_id, access_grant_id, packet_type, payload_json)
      VALUES (?, ?, ?, ?, 'invoice_event', ?)
    `)
    .bind(packetId, grant.business_id, grant.client_id, grant.id, JSON.stringify({ invoiceRef, event }))
    .run()

  return jsonResponse(200, { ok: true, requestId, packetId, event, message: 'Recorded.' }, requestId)
}

async function uploadPortalPhoto(request: Request, env: Env, requestId: string, registration: LiveRegistration): Promise<Response> {
  const { grant } = registration

  const contentType = (request.headers.get('x-solesystems-content-type') || request.headers.get('content-type') || 'application/octet-stream').trim()
  if (!contentType.startsWith('image/')) {
    return badRequest(requestId, 'Only image uploads are accepted here.')
  }

  const bodyBuffer = await request.arrayBuffer()
  if (bodyBuffer.byteLength > maximumUploadBytes) {
    return payloadTooLarge(requestId, 'Photo exceeds the 25MB upload limit.')
  }

  const clientPending = await env.DB
    .prepare(`SELECT COALESCE(SUM(byte_size), 0) AS total FROM portal_file_objects WHERE business_id = ? AND client_id = ? AND expires_at > ?`)
    .bind(grant.business_id, grant.client_id, new Date().toISOString())
    .first<{ total: number }>()
  if ((clientPending?.total || 0) + bodyBuffer.byteLength > pendingPerClientBytes) {
    return payloadTooLarge(requestId, 'This Client has exceeded their pending-upload quota (125MB).')
  }

  const businessPending = await env.DB
    .prepare(`SELECT COALESCE(SUM(byte_size), 0) AS total FROM portal_file_objects WHERE business_id = ? AND expires_at > ?`)
    .bind(grant.business_id, new Date().toISOString())
    .first<{ total: number }>()
  if ((businessPending?.total || 0) + bodyBuffer.byteLength > pendingPerBusinessBytes) {
    return payloadTooLarge(requestId, 'This Business has exceeded its pending-upload quota (1GB).')
  }

  const objectId = crypto.randomUUID()
  const objectKey = `business/${grant.business_id}/portal/${grant.client_id}/objects/${objectId}`
  const bytes = new Uint8Array(bodyBuffer)

  await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType } })

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // Part 0: 30 days.

  await env.DB
    .prepare(`
      INSERT INTO portal_file_objects (id, business_id, client_id, r2_object_key, content_type, byte_size, purpose, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'client_upload', ?)
    `)
    .bind(objectId, grant.business_id, grant.client_id, objectKey, contentType, bytes.byteLength, expiresAt)
    .run()

  const packetId = crypto.randomUUID()
  await env.DB
    .prepare(`
      INSERT INTO portal_packet_inbox (id, business_id, client_id, access_grant_id, packet_type, payload_json)
      VALUES (?, ?, ?, ?, 'photo_upload', ?)
    `)
    .bind(packetId, grant.business_id, grant.client_id, grant.id, JSON.stringify({ objectId, contentType, byteSize: bytes.byteLength }))
    .run()

  return jsonResponse(200, { ok: true, requestId, objectId, packetId, message: 'Submitted -- pending Business review.' }, requestId)
}
