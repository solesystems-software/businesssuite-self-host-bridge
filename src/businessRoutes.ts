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
import { isValidInviteToken, parseRegisterPortalBody } from './portalRegistryValidation'
import type { Env, PortalPacketInboxRow } from './clientPortalWorkerTypes'

// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 1: Business-authenticated endpoints (every
// one requires a valid HMAC signature over businessId, per clientPortalRequestAuthentication.ts). Every
// query is scoped by business_id -- Part B Phase 8's tenant-isolation requirement, designed in from
// Phase 1 rather than retrofitted. Client_Portal_Site_Publishing_Task_Spec_20261112.md (D5-D7): the
// Worker is a bridge only -- the publishing and Business-upload routes are gone; the Business
// registers a token it generated, and the Worker relays only what Clients send back.

const sitePortalContextId = 'site-portal' // portal_context_id of every grant made by register-portal.

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// Registry routes (D6): the Business's desktop app generates the invite token and registers it here; the
// Worker never creates tokens. A token is "live" only while its grant is unrevoked and unexpired AND its
// companion portal_live_registrations row exists (see findLiveRegistration in clientPortalRoutes.ts).
// Both routes are signed (authenticateBusinessJsonRequest) and idempotent.
export async function handleRegisterPortal(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const { businessId, body } = auth.request
  const parsed = parseRegisterPortalBody(body, Date.now())
  if (!parsed.ok) return badRequest(requestId, parsed.error)
  const { inviteToken, clientId, expiresAtIso, allowedOrigin, allowedRefs } = parsed

  await env.DB
    .prepare(`INSERT OR IGNORE INTO portal_clients (id, business_id) VALUES (?, ?)`)
    .bind(clientId, businessId)
    .run()

  const existing = await env.DB
    .prepare(`SELECT id, business_id, client_id FROM portal_access_grants WHERE invite_token = ?`)
    .bind(inviteToken)
    .first<{ id: string; business_id: string; client_id: string }>()

  if (existing && (existing.business_id !== businessId || existing.client_id !== clientId)) {
    return jsonResponse(409, { ok: false, requestId, message: 'This invite token cannot be registered.' }, requestId)
  }

  let grantId: string
  if (existing) {
    grantId = existing.id
    await env.DB
      .prepare(`UPDATE portal_access_grants SET expires_at = ?, revoked_at = NULL WHERE id = ?`)
      .bind(expiresAtIso, grantId)
      .run()
  } else {
    grantId = crypto.randomUUID()
    await env.DB
      .prepare(`
        INSERT INTO portal_access_grants (id, business_id, client_id, portal_context_id, invite_token, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(grantId, businessId, clientId, sitePortalContextId, inviteToken, expiresAtIso)
      .run()
  }

  const nowIso = new Date().toISOString()
  await env.DB
    .prepare(`
      INSERT INTO portal_live_registrations (access_grant_id, business_id, allowed_origin, allowed_refs_json, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(access_grant_id) DO UPDATE SET
        allowed_origin = excluded.allowed_origin,
        allowed_refs_json = excluded.allowed_refs_json,
        updated_at = excluded.updated_at
    `)
    .bind(grantId, businessId, allowedOrigin, JSON.stringify(allowedRefs), nowIso, nowIso)
    .run()

  return jsonResponse(200, { ok: true, requestId, inviteToken, expiresAt: expiresAtIso }, requestId)
}

export async function handleUnregisterPortal(request: Request, env: Env, requestId: string): Promise<Response> {
  const auth = await authenticateBusinessJsonRequest(request, env, requestId)
  if (!auth.ok) return auth.response

  const { businessId, body } = auth.request
  if (!isValidInviteToken(body.inviteToken)) {
    return badRequest(requestId, 'inviteToken must be 64 lowercase hexadecimal characters.')
  }

  const grant = await env.DB
    .prepare(`SELECT id FROM portal_access_grants WHERE invite_token = ? AND business_id = ?`)
    .bind(body.inviteToken, businessId)
    .first<{ id: string }>()
  if (!grant) return jsonResponse(200, { ok: true, requestId, removed: false }, requestId)

  const companion = await env.DB
    .prepare(`SELECT access_grant_id FROM portal_live_registrations WHERE access_grant_id = ?`)
    .bind(grant.id)
    .first<{ access_grant_id: string }>()

  // Companion row first (D1 enforces foreign keys), then revoke the grant. Already unregistered (no
  // companion row) changes nothing and reports removed: false.
  if (!companion) return jsonResponse(200, { ok: true, requestId, removed: false }, requestId)

  await env.DB.prepare(`DELETE FROM portal_live_registrations WHERE access_grant_id = ?`).bind(grant.id).run()
  await env.DB
    .prepare(`UPDATE portal_access_grants SET revoked_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), grant.id)
    .run()

  return jsonResponse(200, { ok: true, requestId, removed: true }, requestId)
}

// Photo upload/viewing follow-up (2026-08-22): lets the Business (desktop app) download the bytes of a
// Client-uploaded photo (portal_file_objects rows with purpose 'client_upload', surfaced to the Business
// via pending-packets' 'photo_upload' packets). The Worker holds no other object kind any more, so the
// lookup is scoped by ownership AND by that purpose.
export async function handleDownloadBusinessObject(request: Request, env: Env, requestId: string, objectId: string): Promise<Response> {
  const auth = await authenticateBusinessBinaryRequest(request, env, requestId, 0)
  if (!auth.ok) return auth.response

  const object = await env.DB
    .prepare(`
      SELECT r2_object_key, content_type, byte_size, expires_at
      FROM portal_file_objects
      WHERE id = ? AND business_id = ? AND purpose = 'client_upload'
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
    .prepare(`SELECT id, packet_type, payload_json FROM portal_packet_inbox WHERE id = ? AND business_id = ?`)
    .bind(packetId, auth.request.businessId)
    .first<{ id: string; packet_type: string; payload_json: string }>()
  if (!packet) return notFoundResponse(requestId, 'Packet not found for this Business.')

  const businessId = auth.request.businessId

  // D5 ack-and-delete: acknowledging a packet deletes it. A photo_upload packet also deletes the Client's
  // uploaded object (R2 bytes first, then the row). If the R2 delete throws, the object row is kept so the
  // daily sweep retries it; only the error code is logged.
  if (packet.packet_type === 'photo_upload') {
    let objectId: unknown
    try {
      objectId = (JSON.parse(packet.payload_json) as { objectId?: unknown }).objectId
    } catch {
      objectId = undefined
    }
    if (typeof objectId === 'string' && objectId) {
      const object = await env.DB
        .prepare(`SELECT id, r2_object_key FROM portal_file_objects WHERE id = ? AND business_id = ? AND purpose = 'client_upload'`)
        .bind(objectId, businessId)
        .first<{ id: string; r2_object_key: string }>()
      if (object) {
        try {
          await env.FILES.delete(object.r2_object_key)
          await env.DB.prepare(`DELETE FROM portal_file_objects WHERE id = ?`).bind(object.id).run()
        } catch (error) {
          console.error('Client Portal acknowledge: R2 object delete failed:', error instanceof Error ? error.name : 'unknown')
        }
      }
    }
  }

  const acknowledgedAt = new Date().toISOString()
  // Receipts reference the packet (D1 enforces foreign keys), so they go first.
  await env.DB.prepare(`DELETE FROM portal_sync_receipts WHERE packet_id = ?`).bind(packetId).run()
  await env.DB.prepare(`DELETE FROM portal_packet_inbox WHERE id = ? AND business_id = ?`).bind(packetId, businessId).run()

  return jsonResponse(200, { ok: true, requestId, packetId, acknowledgedAt, deleted: true }, requestId)
}
