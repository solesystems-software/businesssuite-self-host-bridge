import type { Env } from './clientPortalWorkerTypes'

// Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 7: the relay's own retention/cleanup
// routine, using Part 0's locked numbers (snapshot expiry 60 days after publish -- already enforced
// via portal_snapshots_current.expires_at at publish time; acknowledged-packet grace 7 days;
// unimported-packet/upload expiry 30 days). This was explicitly deferred design detail in the source
// plan and is real, scheduled work here, not a configuration flag left unset. portal_cleanup_log's
// own schema comment already anticipated this phase by name.

const acknowledgedPacketGraceMilliseconds = 7 * 24 * 60 * 60 * 1000
const pendingPacketExpiryMilliseconds = 30 * 24 * 60 * 60 * 1000

export type ClientPortalCleanupResult = {
  deletedSnapshots: number
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

  const expiredSnapshots = await env.DB
    .prepare(`SELECT id, business_id FROM portal_snapshots_current WHERE expires_at <= ?`)
    .bind(nowIso)
    .all<{ id: string; business_id: string }>()
  for (const snapshot of expiredSnapshots.results) {
    await logCleanupDeletion(env, 'snapshot', snapshot.id, snapshot.business_id, 'snapshot expired (60 days after publish)')
  }
  if (expiredSnapshots.results.length > 0) {
    await env.DB.prepare(`DELETE FROM portal_snapshots_current WHERE expires_at <= ?`).bind(nowIso).run()
  }

  const staleAcknowledgedPackets = await env.DB
    .prepare(`SELECT id, business_id FROM portal_packet_inbox WHERE status = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_at <= ?`)
    .bind(acknowledgedCutoffIso)
    .all<{ id: string; business_id: string }>()
  for (const packet of staleAcknowledgedPackets.results) {
    await logCleanupDeletion(env, 'packet', packet.id, packet.business_id, 'acknowledged packet past 7-day grace period')
  }
  if (staleAcknowledgedPackets.results.length > 0) {
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
    await env.DB.prepare(`DELETE FROM portal_packet_inbox WHERE status = 'pending' AND received_at <= ?`).bind(pendingCutoffIso).run()
  }

  const expiredObjects = await env.DB
    .prepare(`SELECT id, business_id, r2_object_key FROM portal_file_objects WHERE expires_at <= ?`)
    .bind(nowIso)
    .all<{ id: string; business_id: string; r2_object_key: string }>()
  for (const object of expiredObjects.results) {
    try {
      await env.FILES.delete(object.r2_object_key)
    } catch (error) {
      console.error(`Client Portal cleanup failed to delete R2 object ${object.r2_object_key}:`, error)
      continue
    }
    await logCleanupDeletion(env, 'file_object', object.id, object.business_id, 'file object expired (30 days)')
  }
  if (expiredObjects.results.length > 0) {
    await env.DB.prepare(`DELETE FROM portal_file_objects WHERE expires_at <= ?`).bind(nowIso).run()
  }

  return {
    deletedSnapshots: expiredSnapshots.results.length,
    deletedAcknowledgedPackets: staleAcknowledgedPackets.results.length,
    deletedExpiredPendingPackets: staleUnimportedPackets.results.length,
    deletedFileObjects: expiredObjects.results.length,
  }
}
