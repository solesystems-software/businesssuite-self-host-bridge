-- Client_Portal_Mode_CR_Task_Spec_20260822.md Part B Phase 1: D1 schema for the minimal Client Portal
-- relay. Trimmed to Phase 1-4's actual scope (document signing + photos, per Part 0's locked
-- first-version-scope decision) -- source plan section 12.1 was "conceptual only... exact
-- implementation must be designed later"; this file is that design. Every table carries business_id
-- (and client_id where applicable) so every future query can be scoped by tenant -- Part B Phase 8's
-- tenant-isolation requirement, designed in from the start rather than retrofitted.

CREATE TABLE IF NOT EXISTS portal_schema_versions (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per Business (desktop install) that has ever published through this relay. This dev Worker
-- currently authenticates every publish request with one shared Worker-level HMAC secret
-- (CLIENT_PORTAL_PUBLISH_SIGNING_SECRET, pushed via `wrangler secret put`, mirroring the license
-- signing keypair's own single-secret-per-Worker shape per Part D) -- business_id is still required and
-- validated on every request so every other table can be correctly tenant-scoped regardless of how many
-- real Businesses eventually share this Worker. Per-business distinct credentials are a Phase 8
-- production-hardening concern, not built here.
CREATE TABLE IF NOT EXISTS portal_businesses (
  id TEXT PRIMARY KEY,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A Client the Business has published something to. Distinct from any desktop-side Sales Contact record
-- -- this table only exists to scope portal data, never holds business/accounting data itself.
CREATE TABLE IF NOT EXISTS portal_clients (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portal_clients_business
  ON portal_clients(business_id);

-- One row per invite-link token (Part 0: invite link token is this build's only Client login mechanism).
-- portal_context_id is an opaque reference to whatever desktop-side context this grant is for (e.g. a
-- Sales Contract's parent Project Manager record) -- meaningful only to the desktop app, never
-- interpreted by the Worker.
CREATE TABLE IF NOT EXISTS portal_access_grants (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  client_id TEXT NOT NULL REFERENCES portal_clients(id),
  portal_context_id TEXT NOT NULL,
  invite_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_access_grants_business
  ON portal_access_grants(business_id, client_id);

-- The current published snapshot for a grant -- overwritten on republish (source plan section 7.1: a
-- snapshot, not an append-only history). payload_json holds the job/context summary and the
-- FieldDefinition-positioned document reference(s) plus photo references the static portal shell (Phase
-- 3) renders directly; actual file bytes live in R2 (portal_file_objects), never inline here (Part 0's
-- 250KB snapshot payload cap).
CREATE TABLE IF NOT EXISTS portal_snapshots_current (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  client_id TEXT NOT NULL REFERENCES portal_clients(id),
  access_grant_id TEXT NOT NULL REFERENCES portal_access_grants(id),
  payload_json TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_snapshots_current_grant
  ON portal_snapshots_current(access_grant_id);

-- Client -> Business direction: a Client's submission (document_signing_response, photo_upload) awaiting
-- the Business's own desktop-side review/import (Phase 5). Per source plan section 7.2's rule, nothing
-- here ever commits to desktop SQLite without that review -- this table is only the relay's own inbox.
CREATE TABLE IF NOT EXISTS portal_packet_inbox (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  client_id TEXT NOT NULL REFERENCES portal_clients(id),
  access_grant_id TEXT NOT NULL REFERENCES portal_access_grants(id),
  packet_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_packet_inbox_business_status
  ON portal_packet_inbox(business_id, status);

-- Business -> Client direction, reserved for this table's own future use (e.g. a status message shown
-- in the portal shell) -- not written by anything in Phase 1-4's own scope (document signing + photos
-- only, per Part 0), created now per this codebase's established per-domain migration precedent of
-- creating a phase's full intended table set together (migration 032/033 in the desktop repo).
CREATE TABLE IF NOT EXISTS portal_packet_outbox (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  client_id TEXT NOT NULL REFERENCES portal_clients(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_packet_outbox_business
  ON portal_packet_outbox(business_id, client_id);

-- Metadata for every object actually stored in R2 (bucket businesssuite-client-portal-files-dev). Object
-- key pattern: business/{business_id}/portal/{client_id}/objects/{object_id} (source plan section
-- 12.2) -- no client/job/business names in keys, enforced by construction (object_id is a random id, not
-- a name).
CREATE TABLE IF NOT EXISTS portal_file_objects (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  client_id TEXT NOT NULL REFERENCES portal_clients(id),
  r2_object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_file_objects_business
  ON portal_file_objects(business_id, client_id);

-- Desktop-side sync/import confirmation for one inbox packet -- written when the Business's own desktop
-- app has actually imported (or explicitly declined) a packet, independent of portal_packet_inbox.status
-- so the relay's own acknowledgement bookkeeping stays a full audit trail even if a status value is later
-- corrected.
CREATE TABLE IF NOT EXISTS portal_sync_receipts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  packet_id TEXT NOT NULL REFERENCES portal_packet_inbox(id),
  delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_sync_receipts_business
  ON portal_sync_receipts(business_id, packet_id);

-- Phase 7's retention/cleanup routine writes one row here per object/snapshot/packet it actually deletes
-- -- created in Phase 1 alongside every other table this phase's scope needs, per this document's own
-- Part B Phase 1 instruction to create the full trimmed table list now.
CREATE TABLE IF NOT EXISTS portal_cleanup_log (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_cleanup_log_business
  ON portal_cleanup_log(business_id, deleted_at);

-- Replay protection for HMAC-signed Business-publish requests, same shape as
-- cloudflare-bank-feeds/schema.sql's own bank_feed_request_nonces.
CREATE TABLE IF NOT EXISTS portal_request_nonces (
  business_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_portal_request_nonces_expires
  ON portal_request_nonces(expires_at);

-- Payments_Gateway_Component_Task_Spec_20260829.md Part C (locked decision) + Part E Phase 1: the
-- payment gateway is a new element inside the existing Client Portal Worker, per Business, not a
-- separate Worker. One row per (business, provider) recording the OAuth-connected processor account.
-- Only 'stripe' is populated in this pass; the CHECK already accepts the union this project intends
-- so Square/PayPal are additive later (Part D). The Stripe platform secret key and Connect client id
-- live on this same Worker as `wrangler secret put` secrets (STRIPE_SECRET_KEY / STRIPE_CONNECT_CLIENT_ID),
-- mirroring CLIENT_PORTAL_PUBLISH_SIGNING_SECRET's single-secret-per-Worker shape.
CREATE TABLE IF NOT EXISTS portal_payment_gateway_connections (
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'square', 'paypal')),
  connected_account_id TEXT NOT NULL,
  account_status TEXT NOT NULL DEFAULT 'connected',
  scope TEXT,
  livemode INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  disconnected_at TEXT,
  PRIMARY KEY (business_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_portal_payment_gateway_connections_business
  ON portal_payment_gateway_connections(business_id);

-- One row per outstanding OAuth authorize round trip. The `state` value is the CSRF/replay guard
-- carried through the provider's authorize -> callback redirect; a row is single-use (consumed_at set
-- on first callback) and time-limited (expires_at). Same "claim once, expire on a sweep" shape as
-- portal_request_nonces.
CREATE TABLE IF NOT EXISTS portal_payment_gateway_oauth_states (
  state TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'square', 'paypal')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_payment_gateway_oauth_states_expires
  ON portal_payment_gateway_oauth_states(expires_at);

INSERT OR IGNORE INTO portal_schema_versions (version, description)
VALUES (1, 'Phase 1: businesses/clients/access grants/current snapshots/packet inbox+outbox/file objects/sync receipts/cleanup log/request nonces.');

INSERT OR IGNORE INTO portal_schema_versions (version, description)
VALUES (2, 'Payments Gateway Phase 1: portal_payment_gateway_connections + portal_payment_gateway_oauth_states (Stripe Connect OAuth skeleton -- connect/status/disconnect only; charge creation + webhooks are Phase 3).');

-- Payments_Gateway_Component_Task_Spec_20260829.md Part E Phase 3: one row per payment attempt for a
-- desktop invoice, created when a PaymentIntent is opened and updated by the Stripe webhook (or, in
-- mock mode, by /payment-gateway/stripe/mock-complete). invoice_ref is the desktop app's own opaque
-- sales_invoices.id -- never interpreted here. method distinguishes the two collection paths.
CREATE TABLE IF NOT EXISTS portal_payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES portal_businesses(id),
  connected_account_id TEXT,
  invoice_ref TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider IN ('stripe', 'square', 'paypal')),
  method TEXT NOT NULL CHECK (method IN ('card_in_app', 'client_portal_link')),
  payment_intent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requires_payment'
    CHECK (status IN ('requires_payment', 'processing', 'succeeded', 'failed', 'canceled')),
  access_grant_id TEXT,
  client_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_payments_payment_intent
  ON portal_payments(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_portal_payments_business_invoice
  ON portal_payments(business_id, invoice_ref);

INSERT OR IGNORE INTO portal_schema_versions (version, description)
VALUES (3, 'Payments Gateway Phase 3: portal_payments (PaymentIntent lifecycle for desktop invoices; webhook + mock-complete update status and enqueue a payment_received packet for the desktop to import).');

-- Cloudflare_Self_Hosting_Implementation_Task_Spec_20260928.md Wave 2A: single-row Worker-wide
-- settings, self-bootstrapped on first use instead of supplied as a Worker secret -- same shape and
-- race-safety pattern as cloudflare-mobile-sync's mobile_sync_worker_settings (migration 0004).
-- Currently holds only the publish-signing HMAC secret (see getOrCreatePublishSigningSecretBase64 in
-- clientPortalRequestAuthentication.ts): 32 random bytes generated with crypto.getRandomValues on
-- first request, base64-encoded, inserted with ON CONFLICT DO NOTHING, then re-read -- so a
-- first-request race lands on whichever insert won rather than two different secrets. This removes
-- the manual `wrangler secret put CLIENT_PORTAL_PUBLISH_SIGNING_SECRET` step from both self-hosting
-- provisioning paths (Deploy-to-Cloudflare button and the bundled installer script).
CREATE TABLE IF NOT EXISTS client_portal_worker_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  publish_signing_secret TEXT NOT NULL
);

INSERT OR IGNORE INTO portal_schema_versions (version, description)
VALUES (4, 'Cloudflare Self-Hosting Wave 2A: client_portal_worker_settings (self-bootstrapped publish signing secret, replacing the CLIENT_PORTAL_PUBLISH_SIGNING_SECRET Worker secret).');
