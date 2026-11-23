export type Env = {
  DB: D1Database
  FILES: R2Bucket
  SERVICE_ENVIRONMENT: string
  // Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: replaced the Worker-secret
  // shared HMAC secret with a self-bootstrapped single-row D1 table (client_portal_worker_settings) --
  // see getOrCreatePublishSigningSecretBase64 in clientPortalRequestAuthentication.ts. No longer read
  // from env anywhere; do not reintroduce this field.
}

export type JsonBody = Record<string, unknown>

export type PortalSchemaVersionRow = {
  version: number
  description: string
  applied_at: string
}

export type AuthenticatedBusinessRequest = {
  businessId: string
  body: JsonBody
}

export type PortalBusinessRow = {
  id: string
  label: string | null
  created_at: string
  updated_at: string
}

export type PortalClientRow = {
  id: string
  business_id: string
  label: string | null
  created_at: string
}

export type PortalAccessGrantRow = {
  id: string
  business_id: string
  client_id: string
  portal_context_id: string
  invite_token: string
  created_at: string
  expires_at: string | null
  revoked_at: string | null
}

export type PortalFileObjectRow = {
  id: string
  business_id: string
  client_id: string
  r2_object_key: string
  content_type: string
  byte_size: number
  purpose: string
  created_at: string
  expires_at: string
}

// The live-token registry companion row (schema.sql, portal_live_registrations): written by
// POST /business/register-portal, one per registered grant. allowed_refs_json holds opaque ids only
// (documentIds / estimateRefs / invoiceRefs), never content.
export type PortalLiveRegistrationRow = {
  access_grant_id: string
  business_id: string
  allowed_origin: string
  allowed_refs_json: string
  registered_at: string
  updated_at: string
}

// What a document_signing_response packet's payload holds. A future desktop import service hands a
// submitted packet straight to fillDocumentFields/stageSignatureMark with no reshaping.
export type DocumentSigningResponseMark = {
  fieldId: string
  captureMode: 'drawn' | 'typed_name'
  signatureImageDataUrl: string | null
  typedName: string | null
}

export type DocumentSigningResponsePayload = {
  documentId: string
  fieldValues: Record<string, string | boolean>
  marks: DocumentSigningResponseMark[]
}

export type PortalPacketInboxRow = {
  id: string
  business_id: string
  client_id: string
  access_grant_id: string
  packet_type: string
  payload_json: string
  status: string
  received_at: string
  acknowledged_at: string | null
}
