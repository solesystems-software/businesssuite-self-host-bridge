// Notifications_..._7Phase_Plan Part C-2 / C-5 (Orchestration BS-2): pure validation for the
// Client-facing estimate-event beacon (POST /portal/{inviteToken}/estimate-event). Extracted so it
// has a dependency-free `node --test` surface (test/estimate-events.test.ts) -- the route in
// clientPortalRoutes.ts is thin glue over this plus the snapshot-ref check and the D1 insert.

export type EstimateEvent = 'viewed' | 'accepted' | 'declined'

export const ESTIMATE_EVENTS: ReadonlySet<string> = new Set(['viewed', 'accepted', 'declined'])

export type ParsedEstimateEventBody =
  | { ok: true; estimateRef: string; event: EstimateEvent }
  | { ok: false; error: string }

export function parseEstimateEventBody(body: unknown): ParsedEstimateEventBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const record = body as Record<string, unknown>
  const estimateRef = typeof record.estimateRef === 'string' ? record.estimateRef.trim() : ''
  const event = typeof record.event === 'string' ? record.event.trim() : ''
  if (!estimateRef || !ESTIMATE_EVENTS.has(event)) {
    return { ok: false, error: 'estimateRef and a valid event (viewed | accepted | declined) are required.' }
  }
  return { ok: true, estimateRef, event: event as EstimateEvent }
}

// The published snapshot's estimate ref must match the ref the Client claims -- a mismatched ref is
// rejected here, never forwarded to the Business's inbox.
export function estimateRefMatchesSnapshot(snapshotPayloadJson: string, estimateRef: string): boolean {
  try {
    const payload = JSON.parse(snapshotPayloadJson) as { estimate?: { estimateRef?: unknown } | null }
    const publishedRef = payload.estimate && typeof payload.estimate.estimateRef === 'string'
      ? payload.estimate.estimateRef
      : ''
    return Boolean(publishedRef) && publishedRef === estimateRef
  } catch {
    return false
  }
}
