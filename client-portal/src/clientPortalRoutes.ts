import {
  badRequest,
  jsonResponse,
  notFoundResponse,
  payloadTooLarge,
} from './clientPortalWorkerHttp'
import { estimateRefMatchesSnapshot, parseEstimateEventBody } from './estimateEventValidation'
import { invoiceRefMatchesSnapshot, parseInvoiceEventBody } from './invoiceEventValidation'
import type { Env, PortalAccessGrantRow, PortalSnapshotRow } from './clientPortalWorkerTypes'

// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 1/4: Client-facing endpoints, authenticated by
// invite-link token only (Part 0's locked Client login mechanism -- no accounts, no email codes). Every
// row this reads or writes is scoped through the token's own access_grant_id, never a client-supplied
// business_id/client_id -- Part B Phase 8's tenant-isolation requirement designed in from the start.

// Correction (2026-08-24): raised from 10MB -- real phone-camera JPEGs routinely exceed that,
// while the small PNGs used in this project's own dev/test data stayed comfortably under it, which
// read as a JPG-vs-PNG format bug until traced back to this cap. 25MB is well inside Cloudflare
// Workers' own request-body ceiling (100MB+ on every plan tier) and R2's per-object limits, so this
// is purely this app's own choice, not a platform constraint. pendingPerClientBytes keeps its
// original ~5x-single-upload ratio.
const maximumUploadBytes = 25 * 1024 * 1024 // Part 0 (corrected 2026-08-24): single upload max 25MB.
const pendingPerClientBytes = 125 * 1024 * 1024 // Part 0 (corrected 2026-08-24): 125MB pending per Client.
const pendingPerBusinessBytes = 1024 * 1024 * 1024 // Part 0: 1GB pending per Business.

async function requireActiveGrant(env: Env, inviteToken: string): Promise<PortalAccessGrantRow | null> {
  if (!/^[a-f0-9]{64}$/.test(inviteToken)) return null

  const grant = await env.DB
    .prepare(`
      SELECT id, business_id, client_id, portal_context_id, invite_token, created_at, expires_at, revoked_at
      FROM portal_access_grants
      WHERE invite_token = ?
    `)
    .bind(inviteToken)
    .first<PortalAccessGrantRow>()

  if (!grant) return null
  if (grant.revoked_at) return null
  if (grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) return null
  return grant
}

export async function handleGetPortalSnapshot(env: Env, requestId: string, inviteToken: string): Promise<Response> {
  const grant = await requireActiveGrant(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

  const snapshot = await env.DB
    .prepare(`
      SELECT id, business_id, client_id, access_grant_id, payload_json, published_at, expires_at
      FROM portal_snapshots_current
      WHERE access_grant_id = ?
    `)
    .bind(grant.id)
    .first<PortalSnapshotRow>()

  if (!snapshot) return notFoundResponse(requestId, 'Nothing has been published to this invite link yet.')
  if (Date.parse(snapshot.expires_at) <= Date.now()) {
    return notFoundResponse(requestId, 'This published snapshot has expired.')
  }

  return jsonResponse(200, {
    ok: true,
    requestId,
    snapshot: JSON.parse(snapshot.payload_json),
    publishedAt: snapshot.published_at,
    expiresAt: snapshot.expires_at,
  }, requestId)
}

export async function handleGetPortalObject(request: Request, env: Env, requestId: string, inviteToken: string, objectId: string): Promise<Response> {
  const grant = await requireActiveGrant(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

  const object = await env.DB
    .prepare(`
      SELECT r2_object_key, content_type, byte_size, expires_at
      FROM portal_file_objects
      WHERE id = ? AND business_id = ? AND client_id = ?
    `)
    .bind(objectId, grant.business_id, grant.client_id)
    .first<{ r2_object_key: string; content_type: string; byte_size: number; expires_at: string }>()

  if (!object) return notFoundResponse(requestId, 'Object not found for this invite link.')
  if (Date.parse(object.expires_at) <= Date.now()) return notFoundResponse(requestId, 'This object has expired.')

  const stored = await env.FILES.get(object.r2_object_key)
  if (!stored) return notFoundResponse(requestId, 'Object not found in storage.')

  void request
  return new Response(stored.body, {
    status: 200,
    headers: {
      'Content-Type': object.content_type,
      'Cache-Control': 'private, max-age=300',
      'Content-Length': String(object.byte_size),
    },
  })
}

export async function handleSubmitPortalPacket(request: Request, env: Env, requestId: string, inviteToken: string): Promise<Response> {
  const grant = await requireActiveGrant(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

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
  if (typeof packetType !== 'string' || !packetType.trim() || !payload || typeof payload !== 'object') {
    return badRequest(requestId, 'packetType and payload are required.')
  }

  const packetId = crypto.randomUUID()

  await env.DB
    .prepare(`
      INSERT INTO portal_packet_inbox (id, business_id, client_id, access_grant_id, packet_type, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(packetId, grant.business_id, grant.client_id, grant.id, packetType.trim(), JSON.stringify(payload))
    .run()

  return jsonResponse(200, { ok: true, requestId, packetId, message: 'Submitted -- pending Business review.' }, requestId)
}

// Notifications_..._7Phase_Plan Part C-2 / C-5 (Orchestration BS-2): the Client's own actions on a
// published Estimate -- opening it fires a 'viewed' beacon, the Accept / Decline buttons fire
// 'accepted' / 'declined'. Each becomes an 'estimate_event' packet in the Business's inbox, which
// ClientPortalRuntimeService.pollEstimateClientEvents drains into an estimate status change +
// notification. The estimateRef is validated against the currently-published snapshot's own
// estimate.estimateRef -- a mismatched ref is rejected here, never forwarded to the Business.
// (parseEstimateEventBody / estimateRefMatchesSnapshot are extracted into estimateEventValidation.ts
// so they carry a dependency-free node --test surface.)

export async function handleSubmitEstimateEvent(request: Request, env: Env, requestId: string, inviteToken: string): Promise<Response> {
  const grant = await requireActiveGrant(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

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

  const snapshot = await env.DB
    .prepare(`SELECT payload_json, expires_at FROM portal_snapshots_current WHERE access_grant_id = ?`)
    .bind(grant.id)
    .first<{ payload_json: string; expires_at: string }>()
  if (!snapshot || Date.parse(snapshot.expires_at) <= Date.now()) {
    return notFoundResponse(requestId, 'Nothing is currently published to this invite link.')
  }

  if (!estimateRefMatchesSnapshot(snapshot.payload_json, estimateRef)) {
    return badRequest(requestId, 'estimateRef does not match the estimate published to this invite link.')
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
// notification. Thin glue over invoiceEventValidation.ts plus the same grant-lookup / D1-insert
// pattern handleSubmitEstimateEvent uses.
export async function handleSubmitInvoiceEvent(request: Request, env: Env, requestId: string, inviteToken: string): Promise<Response> {
  const grant = await requireActiveGrant(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

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

  const snapshot = await env.DB
    .prepare(`SELECT payload_json, expires_at FROM portal_snapshots_current WHERE access_grant_id = ?`)
    .bind(grant.id)
    .first<{ payload_json: string; expires_at: string }>()
  if (!snapshot || Date.parse(snapshot.expires_at) <= Date.now()) {
    return notFoundResponse(requestId, 'Nothing is currently published to this invite link.')
  }

  if (!invoiceRefMatchesSnapshot(snapshot.payload_json, invoiceRef)) {
    return badRequest(requestId, 'invoiceRef does not match the invoice published to this invite link.')
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

export async function handleUploadPortalPhoto(request: Request, env: Env, requestId: string, inviteToken: string): Promise<Response> {
  const grant = await requireActiveGrant(env, inviteToken)
  if (!grant) return notFoundResponse(requestId, 'This invite link is invalid, expired, or has been revoked.')

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
