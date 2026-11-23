// Client Portal site publishing (D6/D7/D14): pure, dependency-free validation for the live-token registry
// (POST /business/register-portal, POST /business/unregister-portal). Kept free of Worker types so it has a
// plain `node --test` surface (test/portal-registry-validation.test.ts); the routes in businessRoutes.ts are
// thin glue over it plus the D1 writes.

export type AllowedRefs = {
  documentIds: string[]
  estimateRefs: string[]
  invoiceRefs: string[]
}

export type ParsedRegisterPortalBody =
  | {
      ok: true
      inviteToken: string
      clientId: string
      expiresAtIso: string
      allowedOrigin: string
      allowedRefs: AllowedRefs
    }
  | { ok: false; error: string }

export const maximumRegistrationDays = 400
export const maximumRefsPerList = 100
export const maximumRefLength = 200
export const maximumClientIdLength = 200

const millisecondsPerDay = 24 * 60 * 60 * 1000
const inviteTokenPattern = /^[a-f0-9]{64}$/
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isValidInviteToken(value: unknown): value is string {
  return typeof value === 'string' && inviteTokenPattern.test(value)
}

// Returns the normalised origin (`new URL(value).origin`), or null when the value is not exactly an origin:
// no path, query, fragment or credentials (one trailing "/" is tolerated), scheme https, or http only for
// the loopback hosts the in-process test pages use.
export function normalizeAllowedOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }

  if (parsed.origin === 'null' || parsed.origin !== withoutTrailingSlash) return null
  if (parsed.protocol === 'https:') return parsed.origin
  if (parsed.protocol === 'http:' && loopbackHosts.has(parsed.hostname)) return parsed.origin
  return null
}

function parseRefList(value: unknown, label: string): { ok: true; refs: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, refs: [] }
  if (!Array.isArray(value)) return { ok: false, error: `allowedRefs.${label} must be an array.` }
  if (value.length > maximumRefsPerList) {
    return { ok: false, error: `allowedRefs.${label} may hold at most ${maximumRefsPerList} entries.` }
  }

  const refs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > maximumRefLength) {
      return { ok: false, error: `allowedRefs.${label} entries must be non-empty strings of at most ${maximumRefLength} characters.` }
    }
    refs.push(entry.trim())
  }
  return { ok: true, refs }
}

export function parseAllowedRefs(value: unknown): { ok: true; refs: AllowedRefs } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, refs: { documentIds: [], estimateRefs: [], invoiceRefs: [] } }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'allowedRefs must be an object.' }

  const record = value as Record<string, unknown>
  const documentIds = parseRefList(record.documentIds, 'documentIds')
  if (!documentIds.ok) return documentIds
  const estimateRefs = parseRefList(record.estimateRefs, 'estimateRefs')
  if (!estimateRefs.ok) return estimateRefs
  const invoiceRefs = parseRefList(record.invoiceRefs, 'invoiceRefs')
  if (!invoiceRefs.ok) return invoiceRefs

  return { ok: true, refs: { documentIds: documentIds.refs, estimateRefs: estimateRefs.refs, invoiceRefs: invoiceRefs.refs } }
}

// The expiry must be a parseable ISO time in the future and at most maximumRegistrationDays ahead.
export function parseRegistrationExpiry(value: unknown, nowMilliseconds: number): { ok: true; iso: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return { ok: false, error: 'expiresAt must be an ISO 8601 time.' }
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return { ok: false, error: 'expiresAt must be an ISO 8601 time.' }
  if (milliseconds <= nowMilliseconds) return { ok: false, error: 'expiresAt must be in the future.' }
  if (milliseconds > nowMilliseconds + maximumRegistrationDays * millisecondsPerDay) {
    return { ok: false, error: `expiresAt must be at most ${maximumRegistrationDays} days ahead.` }
  }
  return { ok: true, iso: new Date(milliseconds).toISOString() }
}

export function parseRegisterPortalBody(body: Record<string, unknown>, nowMilliseconds: number): ParsedRegisterPortalBody {
  if (!isValidInviteToken(body.inviteToken)) {
    return { ok: false, error: 'inviteToken must be 64 lowercase hexadecimal characters.' }
  }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
  if (!clientId || clientId.length > maximumClientIdLength) {
    return { ok: false, error: `clientId is required and must be at most ${maximumClientIdLength} characters.` }
  }

  const expiry = parseRegistrationExpiry(body.expiresAt, nowMilliseconds)
  if (!expiry.ok) return expiry

  const allowedOrigin = normalizeAllowedOrigin(body.allowedOrigin)
  if (!allowedOrigin) {
    return { ok: false, error: 'allowedOrigin must be an https origin (http only for localhost) with no path, query or fragment.' }
  }

  const refs = parseAllowedRefs(body.allowedRefs)
  if (!refs.ok) return refs

  return {
    ok: true,
    inviteToken: body.inviteToken,
    clientId,
    expiresAtIso: expiry.iso,
    allowedOrigin,
    allowedRefs: refs.refs,
  }
}
