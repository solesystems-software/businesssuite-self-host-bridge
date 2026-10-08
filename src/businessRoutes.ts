import {
  authenticateBusinessBinaryRequest,
  authenticateBusinessJsonRequest,
} from './clientPortalRequestAuthentication'
import {
  badRequest,
  jsonResponse,
  notFoundResponse,
} from './clientPortalWorkerHttp'
import { runClientPortalCleanup } from './clientPortalCleanup'
import type { Env, PortalAccessGrantRow, PortalPacketInboxRow, PortalSnapshotPayload } from './clientPortalWorkerTypes'

// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 1: Business-authenticated endpoints (every
// one requires a valid HMAC signature over businessId, per clientPortalRequestAuthentication.ts). Every
// query is scoped by business_id -- Part B Phase 8's tenant-isolation requirement, designed in from
// Phase 1 rather than retrofitted.

const snapshotRetentionDays = 60 // Part 0: snapshot expiry 60 days after publish.
// Correction (2026-08-24): raised from 250KB, but capped well under Cloudflare D1's own hard 2MB
// max row size (this snapshot is stored as one JSON TEXT value in one portal_snapshots_current row)
// -- NOT raised to match the 25MB per-file upload cap, on purpose. notesHtml (the rendered Notes
// canvas) never reaches this endpoint carrying embedded image bytes: the desktop app's own
// publishRecord (ClientPortalRuntimeService.ts) uploads every embedded image to R2 individually,
// through this same Worker's upload-object endpoint, before it ever calls publish-snapshot, and
// replaces each one in the HTML with a short data-object-id reference -- so this limit only needs
// to cover markup/text, never photo bytes.
const maximumSnapshotPayloadBytes = 1.5 * 1024 * 1024 // Part 0 (corrected 2026-08-24): snapshot payload max 1.5MB (D1 row ceiling is 2MB).
// Correction (2026-08-24): raised from 10MB to 25MB alongside clientPortalRoutes.ts's own matching
// cap -- see that file's comment for why (real JPEG photos vs. small dev/test PNGs).
const maximumUploadBytes = 25 * 1024 * 1024 // Part 0 (corrected 2026-08-24): single upload max 25MB.

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

const validFieldTypes = new Set(['signature', 'initials', 'text', 'date', 'checkbox'])

// Structural validation of the snapshot payload against PortalSnapshotPayload
// (clientPortalWorkerTypes.ts) -- lenient (extra fields are fine), but rejects a snapshot the embed
// shell (embedShellPage.ts) could not render, so a Business publish mistake fails loudly here rather
// than silently reaching a Client's browser as a broken page.
function validateSnapshotPayload(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return 'snapshot must be an object.'
  const candidate = snapshot as Partial<PortalSnapshotPayload>

  if (!isNonEmptyString(candidate.title)) return 'snapshot.title is required.'
  if (candidate.documents !== undefined && !Array.isArray(candidate.documents)) return 'snapshot.documents must be an array.'
  if (candidate.photos !== undefined && !Array.isArray(candidate.photos)) return 'snapshot.photos must be an array.'

  for (const doc of candidate.documents || []) {
    if (!doc || typeof doc !== 'object') return 'Each snapshot.documents entry must be an object.'
    if (!isNonEmptyString(doc.documentId) || !isNonEmptyString(doc.title) || !isNonEmptyString(doc.sourceObjectId)) {
      return 'Each document requires documentId, title, and sourceObjectId.'
    }
    if (!Array.isArray(doc.fields)) return `Document ${doc.documentId} is missing a fields array.`
    for (const field of doc.fields) {
      if (!field || typeof field !== 'object' || !isNonEmptyString(field.id) || !validFieldTypes.has(field.fieldType)) {
        return `Document ${doc.documentId} has an invalid field entry.`
      }
      if (
        typeof field.pageNumber !== 'number' || typeof field.xPosition !== 'number'
        || typeof field.yPosition !== 'number' || typeof field.width !== 'number' || typeof field.height !== 'number'
      ) {
        return `Document ${doc.documentId}, field ${field.id} is missing numeric position/size.`
      }
    }
  }

  for (const photo of candidate.photos || []) {
    if (!photo || typeof photo !== 'object' || !isNonEmptyString(photo.photoId) || !isNonEmptyString(photo.objectId)) {
      return 'Each photo requires photoId and objectId.'
    }
  }

  // Phase 3: optional "Payment Gateway" item.
  if (candidate.payment !== undefined && candidate.payment !== null) {
    const payment = candidate.payment
    if (typeof payment !== 'object') return 'snapshot.payment must be an object or null.'
    if (!isNonEmptyString(payment.invoiceRef) || !isNonEmptyString(payment.title)) {
      return 'snapshot.payment requires invoiceRef and title.'
    }
    if (typeof payment.amountCents !== 'number' || !Number.isFinite(payment.amountCents) || payment.amountCents <= 0) {
      return 'snapshot.payment.amountCents must be a positive number.'
    }
    if (!isNonEmptyString(payment.currency)) return 'snapshot.payment.currency is required.'
    try {
      const payUrl = new URL(String(payment.payUrl || ''))
      if (payUrl.protocol !== 'https:' && payUrl.protocol !== 'http:') return 'snapshot.payment.payUrl must be an http(s) URL.'
    } catch {
      return 'snapshot.payment.payUrl is required.'
    }
  }

  // BS-2: optional published Estimate item.
  if (candidate.estimate !== undefined && candidate.estimate !== null) {
    const estimate = candidate.estimate
    if (typeof estimate !== 'object') return 'snapshot.estimate must be an object or null.'
    if (!isNonEmptyString(estimate.estimateRef) || !isNonEmptyString(estimate.documentTerm)) {
      return 'snapshot.estimate requires estimateRef and documentTerm.'
    }
    if (!isNonEmptyString(estimate.bodyHtml)) return 'snapshot.estimate.bodyHtml is required.'
    if (typeof estimate.grandTotalCents !== 'number' || !Number.isFinite(estimate.grandTotalCents)) {
      return 'snapshot.estimate.grandTotalCents must be a number.'
    }
    if (!isNonEmptyString(estimate.currency)) return 'snapshot.estimate.currency is required.'
  }

  return null
}

async function findOrCreateAccessGrant(
  env: Env,
  businessId: string,
  clientId: string,
  portalContextId: string,
  existingInviteToken: string | undefined,
): Promise<PortalAccessGrantRow | null> {
  if (existingInviteToken) {
    const existing = await env.DB
      .prepare(`
        SELECT id, business_id, client_id, portal_context_id, invite_token, created_at, expires_at, revoked_at
        FROM portal_access_grants
        WHERE invite_token = ? AND business_id = ? AND client_id = ? AND portal_context_id = ?
      `)
      .bind(existingInviteToken, businessId, clientId, portalContextId)
      .first<PortalAccessGrantRow>()
    if (existing && !existing.revoked_at) return existing
    if (existing) return null // revoked -- caller must not silently mint a new one for a revoked grant
  }

  const id = crypto.randomUUID()
  const inviteToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')

  await env.DB
    .prepare(`
      INSERT INTO portal_access_grants (id, business_id, client_id, portal_context_id, invite_token)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(id, businessId, clientId, portalContextId, inviteToken)
    .run()

  return {
    id,
    business_id: businessId,
    client_id: clientId,
    portal_context_id: portalContextId,
    invite_token: inviteToken,
    created_at: new Date().toISOString(),
    expires_at: null,
    revoked_at: null,
  }
}

export async function handlePublishSnapshot(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const { businessId, body } = auth.request
  const clientId = body.clientId
  const clientLabel = body.clientLabel
  const portalContextId = body.portalContextId
  const inviteToken = body.inviteToken
  const snapshot = body.snapshot
  const fileObjectIds = body.fileObjectIds

  if (!isNonEmptyString(clientId) || !isNonEmptyString(portalContextId) || !snapshot || typeof snapshot !== 'object') {
    return badRequest(requestId, 'clientId, portalContextId, and snapshot are required.')
  }
  if (fileObjectIds !== undefined && !Array.isArray(fileObjectIds)) {
    return badRequest(requestId, 'fileObjectIds must be an array if provided.')
  }

  const snapshotValidationError = validateSnapshotPayload(snapshot)
  if (snapshotValidationError) {
    return badRequest(requestId, `Invalid snapshot: ${snapshotValidationError}`)
  }

  const snapshotJson = JSON.stringify(snapshot)
  if (new TextEncoder().encode(snapshotJson).byteLength > maximumSnapshotPayloadBytes) {
    return badRequest(requestId, 'Snapshot payload exceeds the 1.5MB limit.')
  }

  await env.DB
    .prepare(`INSERT OR IGNORE INTO portal_clients (id, business_id, label) VALUES (?, ?, ?)`)
    .bind(clientId, businessId, isNonEmptyString(clientLabel) ? clientLabel : null)
    .run()

  const grant = await findOrCreateAccessGrant(
    env,
    businessId,
    clientId,
    portalContextId,
    isNonEmptyString(inviteToken) ? inviteToken : undefined,
  )
  if (!grant) {
    return badRequest(requestId, 'The supplied inviteToken has been revoked and cannot be republished to.')
  }

  // Tenant check: every referenced file object must already belong to this business+client -- a snapshot
  // can never reference another tenant's (or another Client's) uploaded object.
  if (Array.isArray(fileObjectIds) && fileObjectIds.length > 0) {
    const placeholders = fileObjectIds.map(() => '?').join(',')
    const owned = await env.DB
      .prepare(`
        SELECT id FROM portal_file_objects
        WHERE business_id = ? AND client_id = ? AND id IN (${placeholders})
      `)
      .bind(businessId, clientId, ...fileObjectIds)
      .all<{ id: string }>()
    const ownedIds = new Set(owned.results.map(row => row.id))
    const missing = fileObjectIds.filter(id => !ownedIds.has(id))
    if (missing.length > 0) {
      return badRequest(requestId, `fileObjectIds references objects that do not belong to this Business/Client: ${missing.join(', ')}`)
    }
  }

  const snapshotId = crypto.randomUUID()
  const expiresAt = daysFromNow(snapshotRetentionDays)

  await env.DB
    .prepare(`DELETE FROM portal_snapshots_current WHERE access_grant_id = ?`)
    .bind(grant.id)
    .run()

  await env.DB
    .prepare(`
      INSERT INTO portal_snapshots_current (id, business_id, client_id, access_grant_id, payload_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(snapshotId, businessId, clientId, grant.id, snapshotJson, expiresAt)
    .run()

  return jsonResponse(200, {
    ok: true,
    requestId,
    accessGrantId: grant.id,
    inviteToken: grant.invite_token,
    snapshotId,
    expiresAt,
  }, requestId)
}

export async function handleUploadObject(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessBinaryRequest(request, env, requestId, maximumUploadBytes)
  if (!auth.ok) return auth.response

  const clientId = (request.headers.get('x-solesystems-client-id') || '').trim()
  const contentType = (request.headers.get('x-solesystems-content-type') || request.headers.get('content-type') || 'application/octet-stream').trim()
  const purpose = (request.headers.get('x-solesystems-object-purpose') || 'published_document').trim()

  if (!clientId) {
    return badRequest(requestId, 'X-SoleSystems-Client-Id header is required.')
  }

  await env.DB
    .prepare(`INSERT OR IGNORE INTO portal_clients (id, business_id) VALUES (?, ?)`)
    .bind(clientId, auth.businessId)
    .run()

  const objectId = crypto.randomUUID()
  // Object key pattern per source plan section 12.2 -- no client/job/business names, only opaque ids.
  const objectKey = `business/${auth.businessId}/portal/${clientId}/objects/${objectId}`

  await env.FILES.put(objectKey, auth.bytes, { httpMetadata: { contentType } })

  const expiresAt = daysFromNow(30) // Part 0: unimported-packet/upload expiry 30 days.

  await env.DB
    .prepare(`
      INSERT INTO portal_file_objects (id, business_id, client_id, r2_object_key, content_type, byte_size, purpose, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(objectId, auth.businessId, clientId, objectKey, contentType, auth.bytes.byteLength, purpose, expiresAt)
    .run()

  return jsonResponse(200, { ok: true, requestId, objectId, byteSize: auth.bytes.byteLength, expiresAt }, requestId)
}

// Photo upload/viewing follow-up (2026-08-22): lets the Business (desktop app) download the bytes of
// any object it owns -- currently used for Client-uploaded photos (portal_file_objects rows with
// purpose 'client_upload', surfaced to the Business via pending-packets' 'photo_upload' packets), but
// scoped generically by ownership so it works for any object the Business already published too.
export async function handleDownloadBusinessObject(request: Request, env: Env, requestId: string, objectId: string): Promise<Response> {
  const auth = await authenticateBusinessBinaryRequest(request, env, requestId, 0)
  if (!auth.ok) return auth.response

  const object = await env.DB
    .prepare(`
      SELECT r2_object_key, content_type, byte_size, expires_at
      FROM portal_file_objects
      WHERE id = ? AND business_id = ?
    `)
    .bind(objectId, auth.businessId)
    .first<{ r2_object_key: string; content_type: string; byte_size: number; expires_at: string }>()

  if (!object) return notFoundResponse(requestId, 'Object not found for this Business.')
  if (Date.parse(object.expires_at) <= Date.now()) return notFoundResponse(requestId, 'This object has expired.')

  const stored = await env.FILES.get(object.r2_object_key)
  if (!stored) return notFoundResponse(requestId, 'Object not found in storage.')

  return new Response(stored.body, {
    status: 200,
    headers: {
      'Content-Type': object.content_type,
      'Cache-Control': 'private, max-age=300',
      'Content-Length': String(object.byte_size),
    },
  })
}

// Part B Phase 8's own [ASSUMPTION]: manually triggerable (any validly-signed Business request, not
// scoped to that Business's own data since cleanup is a global maintenance sweep) so this codebase's
// established real-not-stubbed testing discipline can verify it deterministically, alongside the
// scheduled() cron trigger (clientPortalWorkerEntry.ts) that runs it automatically in production.
export async function handleRunCleanup(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const result = await runClientPortalCleanup(env)
  return jsonResponse(200, { ok: true, requestId, ...result }, requestId)
}

export async function handleListPendingPackets(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const rows = await env.DB
    .prepare(`
      SELECT id, business_id, client_id, access_grant_id, packet_type, payload_json, status, received_at, acknowledged_at
      FROM portal_packet_inbox
      WHERE business_id = ? AND status = 'pending'
      ORDER BY received_at ASC
      LIMIT 100
    `)
    .bind(auth.request.businessId)
    .all<PortalPacketInboxRow>()

  return jsonResponse(200, {
    ok: true,
    requestId,
    packets: rows.results.map(row => ({
      id: row.id,
      clientId: row.client_id,
      accessGrantId: row.access_grant_id,
      packetType: row.packet_type,
      payload: JSON.parse(row.payload_json),
      receivedAt: row.received_at,
    })),
  }, requestId)
}

export async function handleAcknowledgePacket(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const packetId = auth.request.body.packetId
  if (!isNonEmptyString(packetId)) {
    return badRequest(requestId, 'packetId is required.')
  }

  const packet = await env.DB
    .prepare(`SELECT id FROM portal_packet_inbox WHERE id = ? AND business_id = ?`)
    .bind(packetId, auth.request.businessId)
    .first<{ id: string }>()
  if (!packet) return notFoundResponse(requestId, 'Packet not found for this Business.')

  const nowIso = new Date().toISOString()

  await env.DB
    .prepare(`UPDATE portal_packet_inbox SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?`)
    .bind(nowIso, packetId)
    .run()

  await env.DB
    .prepare(`
      INSERT INTO portal_sync_receipts (id, business_id, packet_id, acknowledged_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(crypto.randomUUID(), auth.request.businessId, packetId, nowIso)
    .run()

  return jsonResponse(200, { ok: true, requestId, packetId, acknowledgedAt: nowIso }, requestId)
}
