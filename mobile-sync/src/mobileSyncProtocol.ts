import type { PacketEnvelopeV1 } from './mobileSyncTypes'

const textEncoder = new TextEncoder()

export const protocolVersion = 1 as const
export const maximumJsonBodyBytes = 1024 * 1024
export const maximumMediaBodyBytes = 25 * 1024 * 1024
export const maximumClockSkewSeconds = 5 * 60
export const nonceRetentionSeconds = 10 * 60

export function encodeHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function sha256(value: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)))
}

export async function sha256Bytes(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return encodeHex(await crypto.subtle.digest('SHA-256', bytes))
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

export function isIdentifier(value: unknown, minimum = 3, maximum = 160): value is string {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && /^[A-Za-z0-9._:-]+$/.test(value)
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

// entity_revision_seen is an OPAQUE optimistic-concurrency token echoed back to the
// desktop for an equality check — never an identifier, path segment, or SQL fragment
// (it is always bound as a parameter). Desktop rows use a SQLite CURRENT_TIMESTAMP
// string ("2026-09-03 03:42:39", note the space), so requiring identifier characters
// here wrongly rejected every note.update / timesheet.update on a synced row.
export function isRevisionToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function parsePacketEnvelope(value: unknown): PacketEnvelopeV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const packet = value as Record<string, unknown>
  if (
    packet.protocol_version !== protocolVersion
    || !isIdentifier(packet.packet_id)
    || !isIdentifier(packet.packet_type)
    || !isIdentifier(packet.account_sync_id)
    || !isIdentifier(packet.device_id)
    || !isIdentifier(packet.user_id)
    || !isIsoDate(packet.created_at)
    || !Number.isSafeInteger(packet.client_sequence)
    || Number(packet.client_sequence) < 0
    || !(packet.snapshot_version_seen === null || (Number.isSafeInteger(packet.snapshot_version_seen) && Number(packet.snapshot_version_seen) >= 0))
    || !(packet.entity_id === null || isIdentifier(packet.entity_id))
    || !(packet.entity_revision_seen === null || isRevisionToken(packet.entity_revision_seen))
    || !isIdentifier(packet.idempotency_key, 8, 160)
    || !Array.isArray(packet.attachments)
    || !isSha256(packet.payload_hash)
  ) return null
  return packet as unknown as PacketEnvelopeV1
}

export function canonicalRequest(input: {
  method: string
  path: string
  timestamp: string
  nonce: string
  accountSyncId: string
  credentialId: string
  identityId: string
  bodyHash: string
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.accountSyncId,
    input.credentialId,
    input.identityId,
    input.bodyHash,
  ].join('\n')
}
