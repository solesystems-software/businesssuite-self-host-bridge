export type CredentialRole = 'desktop' | 'mobile'

export interface Env {
  DB: D1Database
  PAYLOADS: R2Bucket
  SERVICE_ENVIRONMENT: string
  MOBILE_SYNC_DEVELOPMENT_BOOTSTRAP_SECRET?: string
  ACCOUNT_SYNC_CHANNEL: DurableObjectNamespace
}

export interface AuthenticatedRequest {
  accountSyncId: string
  credentialId: string
  identityId: string
  role: CredentialRole
  userId?: string
}

export interface PacketEnvelopeV1 {
  protocol_version: 1
  packet_id: string
  packet_type: string
  account_sync_id: string
  device_id: string
  user_id: string
  created_at: string
  client_sequence: number
  snapshot_version_seen: number | null
  entity_id: string | null
  entity_revision_seen: string | null
  idempotency_key: string
  payload: unknown
  attachments: Array<Record<string, unknown>>
  payload_hash: string
}

// --- AccountSyncChannel frame protocol -------------------------------------
// Relayed between the connected desktop and the connected phone(s) for an
// account. See accountSyncChannel.ts for the full narrative. Unknown frame
// types are ignored by every client, so additions are backward compatible.
export type ChannelInboundFrame =
  | { type: 'ping' }
  | { type: 'sync_check' }
  | { type: 'request_push'; request_id?: string }
  | { type: 'request_publish'; request_id?: string }
  | { type: 'counterpart_status_request'; request_id?: string }

export type ChannelOutboundFrame =
  | { type: 'pong' }
  | { type: 'packets_pending'; server_sequence: number | null }
  | { type: 'high_water'; server_sequence: number | null }
  | { type: 'push_requested' }
  | { type: 'publish_requested' }
  | { type: 'push_ack'; request_id: string | null; counterpart_connected: boolean; delivered: number }
  | { type: 'publish_ack'; request_id: string | null; counterpart_connected: boolean; delivered: number }
  | { type: 'counterpart_status'; request_id: string | null; connected: boolean }

export interface CredentialRow {
  credential_id: string
  account_sync_id: string
  identity_id: string
  user_id: string | null
  encrypted_secret: string
  secret_iv: string
  secret_key_version: number
  expires_at: string
  revoked_at: string | null
}
