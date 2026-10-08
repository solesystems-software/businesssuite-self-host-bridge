// Notifications_..._7Phase_Plan Part D / D-4 (Orchestration BS-3): pure validation for the
// Client-facing invoice-event beacon (POST /portal/{inviteToken}/invoice-event). Mirrors
// estimateEventValidation.ts -- extracted so it has a dependency-free `node --test` surface
// (test/invoice-events.test.ts). The only defined invoice event is 'viewed' (opening the published
// invoice deep-link); payment collection lives in the independent Payments Worker.

export type InvoiceEvent = 'viewed'

export const INVOICE_EVENTS: ReadonlySet<string> = new Set(['viewed'])

export type ParsedInvoiceEventBody =
  | { ok: true; invoiceRef: string; event: InvoiceEvent }
  | { ok: false; error: string }

export function parseInvoiceEventBody(body: unknown): ParsedInvoiceEventBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const record = body as Record<string, unknown>
  const invoiceRef = typeof record.invoiceRef === 'string' ? record.invoiceRef.trim() : ''
  const event = typeof record.event === 'string' ? record.event.trim() : ''
  if (!invoiceRef || !INVOICE_EVENTS.has(event)) {
    return { ok: false, error: 'invoiceRef and a valid event (viewed) are required.' }
  }
  return { ok: true, invoiceRef, event: event as InvoiceEvent }
}

// The published snapshot's invoice ref must match the ref the Client claims -- a mismatched ref is
// rejected here, never forwarded to the Business's inbox.
export function invoiceRefMatchesSnapshot(snapshotPayloadJson: string, invoiceRef: string): boolean {
  try {
    const payload = JSON.parse(snapshotPayloadJson) as { invoice?: { invoiceRef?: unknown } | null }
    const publishedRef = payload.invoice && typeof payload.invoice.invoiceRef === 'string'
      ? payload.invoice.invoiceRef
      : ''
    return Boolean(publishedRef) && publishedRef === invoiceRef
  } catch {
    return false
  }
}
