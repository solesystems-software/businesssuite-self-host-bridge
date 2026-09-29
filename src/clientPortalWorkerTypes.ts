export type Env = {
  DB: D1Database
  FILES: R2Bucket
  SERVICE_ENVIRONMENT: string
  // Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: replaced the Worker-secret
  // shared HMAC secret with a self-bootstrapped single-row D1 table (client_portal_worker_settings) --
  // see getOrCreatePublishSigningSecretBase64 in clientPortalRequestAuthentication.ts. No longer read
  // from env anywhere; do not reintroduce this field.
  // Wave 2A: base URL of the centrally hosted licensing Worker's public /check-client-portal-access
  // route (see clientPortalLicensingClient.ts). Replaces the same-account LICENSE_SERVICE service
  // binding, which cannot resolve in a customer's own Cloudflare account. A [vars] entry (wrangler.toml),
  // not a secret -- it is a public HTTPS endpoint address, not sensitive.
  LICENSING_SERVICE_URL: string
  // Wave 2A: the Business's own license key, entered once during setup (customer-supplied, not
  // Worker-generated -- unlike the publish signing secret above, so it is not self-bootstrapped).
  // Pushed via `wrangler secret put CLIENT_PORTAL_LICENSE_KEY`. Used by checkPublishEntitlement
  // (clientPortalLicensingClient.ts) to gate POST /business/publish-snapshot on this Business's
  // Client Portal entitlement, checked against the licensing Worker at LICENSING_SERVICE_URL.
  CLIENT_PORTAL_LICENSE_KEY?: string
  // Payments_Gateway_Component_Task_Spec_20260829.md Part E Phase 1: the Stripe Connect platform
  // application's secret key and client id, pushed via `wrangler secret put` (Phase 5). When either is
  // absent the payment gateway routes run in a deterministic mock mode -- the OAuth token exchange
  // synthesizes an `acct_mock_*` connected account instead of calling connect.stripe.com -- so Phases
  // 1/3's acceptance bars ("exercised against a stubbed/mocked Stripe response") can be met with no
  // real credentials. Phase 5 sets these and the same code path reaches real Stripe.
  STRIPE_SECRET_KEY?: string
  STRIPE_CONNECT_CLIENT_ID?: string
  // Phase 3: the publishable key is returned to the browser (invoice pay page / Client Portal
  // payment view) so Stripe.js can be initialised; the webhook signing secret verifies incoming
  // Stripe webhook events. Both absent -> mock mode (no real Stripe call, deterministic pi_mock_*).
  STRIPE_PUBLISHABLE_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
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

export type PortalSnapshotRow = {
  id: string
  business_id: string
  client_id: string
  access_grant_id: string
  payload_json: string
  published_at: string
  expires_at: string
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

// Client_Portal_Mode_CR_Task_Spec_20260822.md Phase 3/4: the concrete shape a published snapshot's
// payload_json holds, and what a document_signing_response packet's payload holds. Mirrors Fields &
// Signatures' own FieldDefinition shape (src/shared/types/fieldsSignatures.ts in the desktop repo) so a
// future desktop publish service can build one directly from a SignatureRequestRecord's own fields, and
// so a future desktop import service can hand a submitted packet straight to
// fillDocumentFields/stageSignatureMark with no reshaping -- the exact design guarantee Phase 3 of the
// Signing UI task spec was written to expect.
export type PortalSnapshotFieldDefinition = {
  id: string
  fieldType: 'signature' | 'initials' | 'text' | 'date' | 'checkbox'
  pageNumber: number
  xPosition: number
  yPosition: number
  width: number
  height: number
  required: boolean
}

export type PortalSnapshotDocument = {
  documentId: string
  title: string
  // Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md: shown in the embed shell's
  // Contracts list row, matching the app-side selection table's own "{title} (v{versionNumber})"
  // row text.
  versionNumber: number
  // References a portal_file_objects.id -- fetched by the embed shell via
  // GET /portal/{inviteToken}/objects/{sourceObjectId}.
  sourceObjectId: string
  fields: PortalSnapshotFieldDefinition[]
}

export type PortalSnapshotPhoto = {
  photoId: string
  objectId: string
  caption: string | null
  // Client_Portal_and_Contracts_Corrections_Task_Spec_20260823.md: shown in the embed shell's
  // Photos list row, matching the app-side selection table's own row text.
  originalFileName: string
}

// Notifications_..._7Phase_Plan Part C-5 (Orchestration BS-2): the published Estimate item. Mirrors
// src/shared/types/clientPortal.ts's ClientPortalSnapshotEstimate (hand-synced, same as the other
// snapshot types in this file). The embed page renders bodyHtml read-only, plus Accept / Decline
// buttons and a "viewed" beacon (POST /portal/{inviteToken}/estimate-event).
export type PortalSnapshotEstimate = {
  estimateRef: string
  documentTerm: string
  numberLabel: string
  status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired' | 'converted'
  issueDate: string | null
  validUntil: string | null
  grandTotalCents: number
  currency: string
  bodyHtml: string
}

// Notifications_..._7Phase_Plan Part D (Orchestration BS-3): the published Invoice deep-link view.
// Mirrors src/shared/types/clientPortal.ts's ClientPortalSnapshotInvoice (hand-synced). The embed
// page renders bodyHtml read-only and fires a "viewed" beacon (POST /portal/{inviteToken}/invoice-event).
export type PortalSnapshotInvoice = {
  invoiceRef: string
  numberLabel: string
  status: 'draft' | 'sent' | 'viewed' | 'partial' | 'paid' | 'overdue'
  issueDate: string | null
  dueDate: string | null
  grandTotalCents: number
  balanceDueCents: number
  currency: string
  bodyHtml: string
}

export type PortalSnapshotPayload = {
  title: string
  jobSummary: string | null
  documents: PortalSnapshotDocument[]
  photos: PortalSnapshotPhoto[]
  // Phase 3: present when the Business published a "Payment Gateway" item for this Record. null/absent
  // otherwise. The Client's embed page renders a "Pay this invoice" view backed by it.
  payment?: PortalSnapshotPayment | null
  // BS-2: present when the Business published an Estimate item for this Record. null/absent otherwise.
  estimate?: PortalSnapshotEstimate | null
  // BS-3: present when the Business published an Invoice item for this Record. null/absent otherwise.
  invoice?: PortalSnapshotInvoice | null
  // Correction (2026-08-24): the rendered, self-contained HTML (images already inlined as data:
  // URLs) of the Business's locked Notes canvas, minus any block they excluded -- replaces the old
  // per-photo publish selection. null when the Record has no Notes content selected for publishing.
  notesHtml: string | null
}

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

// Payments_Gateway_Component_Task_Spec_20260829.md Part E Phase 1.
export type PortalPaymentGatewayProvider = 'stripe' | 'square' | 'paypal'

export type PortalPaymentGatewayConnectionRow = {
  business_id: string
  provider: PortalPaymentGatewayProvider
  connected_account_id: string
  account_status: string
  scope: string | null
  livemode: number
  connected_at: string
  updated_at: string
  disconnected_at: string | null
}

export type PortalPaymentGatewayOAuthStateRow = {
  state: string
  business_id: string
  provider: PortalPaymentGatewayProvider
  created_at: string
  expires_at: string
  consumed_at: string | null
}

// Phase 3.
export type PortalPaymentMethod = 'card_in_app' | 'client_portal_link'
export type PortalPaymentStatus = 'requires_payment' | 'processing' | 'succeeded' | 'failed' | 'canceled'

export type PortalPaymentRow = {
  id: string
  business_id: string
  connected_account_id: string | null
  invoice_ref: string
  amount_cents: number
  currency: string
  provider: PortalPaymentGatewayProvider
  method: PortalPaymentMethod
  payment_intent_id: string
  status: PortalPaymentStatus
  access_grant_id: string | null
  client_id: string | null
  created_at: string
  updated_at: string
  succeeded_at: string | null
}

// Phase 3: the "Payment Gateway" item a Business can publish for a Record -- carried in the snapshot
// payload alongside documents/photos/notesHtml. Mirrors src/shared/types/clientPortal.ts's
// ClientPortalSnapshotPayment (hand-synced, same as the other snapshot types in this file).
export type PortalSnapshotPayment = {
  invoiceRef: string
  title: string
  amountCents: number
  currency: string
}
