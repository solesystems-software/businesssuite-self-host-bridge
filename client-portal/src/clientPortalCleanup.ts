import type { Env } from './clientPortalWorkerTypes'

// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 7, narrowed by
// Client_Portal_Site_Publishing_Task_Spec_20261112.md (D16): the relay's own retention/cleanup routine.
// The Worker holds no published content any more, so the sweep removes exactly:
//   (a) live-registration companion rows whose grant is revoked or expired;
//   (b) revoked/expired registry grants (non-null expires_at) with no companion row and no inbox packet --
//       grants with a null expires_at (made by the retired publish path) are never touched;
//   (c) pending packets older than 30 days and legacy acknowledged packets past the 7-day grace
//       (new acknowledgements delete the packet at once; only pre-upgrade rows can still be 'acknowledged');
//   (d) expired Client-upload objects only (purpose 'client_upload'), R2 first.
// Legacy published_document/published_photo objects and legacy tables are deliberately left alone.
// portal_cleanup_log's own schema comment already anticipated this phase by name.

const acknowledgedPacketGraceMilliseconds = 7 * 24 * 60 * 60 * 1000
const pendingPacketExpiryMilliseconds = 30 * 24 * 60 * 60 * 1000

export type ClientPortalCleanupResult = {
  deletedRegistrations: number
  deletedGrants: number
  deletedAcknowledgedPackets: number
  deletedExpiredPendingPackets: number
  deletedFileObjects: number
}

async function logCleanupDeletion(env: Env, objectType: string, objectId: string, businessId: string, reason: string) {
  await env.DB
    .prepare(`INSERT INTO portal_cleanup_log (id, object_type, object_id, business_id, reason) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), objectType, objectId, businessId, reason)
    .run()
}

export async function runClientPortalCleanup(env: Env): Promise<ClientPortalCleanupResult> {
  const nowIso = new Date().toISOString()
  const acknowledgedCutoffIso = new Date(Date.now() - acknowledgedPacketGraceMilliseconds).toISOString()
  const pendingCutoffIso = new Date(Date.now() - pendingPacketExpiryMilliseconds).toISOString()

  // (a) Companion rows of revoked or expired grants. Companion rows go before grant rows (foreign keys).
  const staleRegistrations = await env.DB
    .prepare(`
      SELECT r.access_grant_id AS id, r.business_id AS business_id
      FROM portal_live_registrations r
      JOIN portal_access_grants g ON g.id = r.access_grant_id
      WHERE g.revoked_at IS NOT NULL OR (g.expires_at IS NOT NULL AND g.expires_at <= ?)
    `)
    .bind(nowIso)
    .all<{ id: string; business_id: string }>()
  for (const registration of staleRegistrations.results) {
    await logCleanupDeletion(env, 'live_registration', registration.id, registration.business_id, 'live registration revoked or expired')
    await env.DB.prepare(`DELETE FROM portal_live_registrations WHERE access_grant_id = ?`).bind(registration.id).run()
  }

  // (c, first half) Packets. Receipts reference the packet, so they are deleted first.
  const staleAcknowledgedPackets = await env.DB
    .prepare(`SELECT id, business_id FROM portal_packet_inbox WHERE status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_at <= ?`)
    .bind(acknowledgedCutoffIso)
    .all<{ id: string; business_id: string }>()
  for (const packet of staleAcknowledgedPackets.results) {
    await logCleanupDeletion(env, 'packet', packet.id, packet.business_id, 'acknowledged packet past 7-day grace period')
  }
  if (staleAcknowledgedPackets.results.length > 0) {
    await env.DB
      .prepare(`DELETE FROM portal_sync_receipts WHERE packet_id IN (SELECT id FROM portal_packet_inbox WHERE status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_at <= ?)`)
      .bind(acknowledgedCutoffIso)
      .run()
    await env.DB.prepare(`DELETE FROM portal_packet_inbox WHERE status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_at <= ?`).bind(acknowledgedCutoffIso).run()
  }

  const staleUnimportedPackets = await env.DB
    .prepare(`SELECT id, business_id FROM portal_packet_inbox WHERE status = 'pending' AND received_at <= ?`)
    .bind(pendingCutoffIso)
    .all<{ id: string; business_id: string }>()
  for (const packet of staleUnimportedPackets.results) {
    await logCleanupDeletion(env, 'packet', packet.id, packet.business_id, 'unimported packet expired (30 days)')
  }
  if (staleUnimportedPackets.results.length > 0) {
    await env.DB
      .prepare(`DELETE FROM portal_sync_receipts WHERE packet_id IN (SELECT id FROM portal_packet_inbox WHERE status = 'pending' AND received_at <= ?)`)
      .bind(pendingCutoffIso)
      .run()
    await env.DB.prepare(`DELETE FROM portal_packet_inbox WHERE status = 'pending' AND received_at <= ?`).bind(pendingCutoffIso).run()
  }

  // (b) Revoked/expired registry grants nothing references any more. A grant that still has a companion row
  // or an inbox packet is kept; null expires_at (legacy grants) is never matched.
  const staleGrants = await env.DB
    .prepare(`
      SELECT g.id AS id, g.business_id AS business_id
      FROM portal_access_grants g
      WHERE g.expires_at IS NOT NULL
        AND (g.revoked_at IS NOT NULL OR g.expires_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM portal_live_registrations r WHERE r.access_grant_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM portal_packet_inbox p WHERE p.access_grant_id = g.id)
    `)
    .bind(nowIso)
    .all<{ id: string; business_id: string }>()
  let deletedGrants = 0
  for (const grant of staleGrants.results) {
    try {
      await env.DB.prepare(`DELETE FROM portal_access_grants WHERE id = ?`).bind(grant.id).run()
    } catch (error) {
      // A leftover row from the retired publish path may still reference the grant (foreign key); keep the
      // grant and retry on the next sweep. Only the error name is logged.
      console.error('Client Portal cleanup could not delete a stale access grant:', error instanceof Error ? error.name : 'unknown')
      continue
    }
    await logCleanupDeletion(env, 'access_grant', grant.id, grant.business_id, 'registry grant revoked or expired')
    deletedGrants += 1
  }

  // (d) Expired Client-upload objects only.
  const expiredObjects = await env.DB
    .prepare(`SELECT id, business_id, r2_object_key FROM portal_file_objects WHERE expires_at <= ? AND purpose = 'client_upload'`)
    .bind(nowIso)
    .all<{ id: string; business_id: string; r2_object_key: string }>()
  let deletedFileObjects = 0
  for (const object of expiredObjects.results) {
    try {
      await env.FILES.delete(object.r2_object_key)
      await logCleanupDeletion(env, 'file_object', object.id, object.business_id, 'file object expired')
      await env.DB.prepare(`DELETE FROM portal_file_objects WHERE id = ?`).bind(object.id).run()
    } catch (error) {
      // Keep the row: the next sweep retries this key. Dropping it here would orphan the bytes in R2.
      // A failed log or row delete after the R2 delete is also retried next sweep (the R2 delete is idempotent).
      console.error(`Client Portal cleanup failed to delete R2 object ${object.r2_object_key}:`, error)
      continue
    }
    deletedFileObjects += 1
  }

  return {
    deletedRegistrations: staleRegistrations.results.length,
    deletedGrants,
    deletedAcknowledgedPackets: staleAcknowledgedPackets.results.length,
    deletedExpiredPendingPackets: staleUnimportedPackets.results.length,
    deletedFileObjects,
  }
}
