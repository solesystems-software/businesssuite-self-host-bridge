-- Payments Worker schema. Independent of Client Portal (Galen, 2026-09-29): invoices are paid by card in
-- the app or through a hosted payment link whether or not they are ever sent through Client Portal.

CREATE TABLE IF NOT EXISTS payments_schema_versions (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Single-row Worker settings, self-bootstrapped on first use (same race-safe pattern as Client Portal's
-- client_portal_worker_settings): the HMAC secret the desktop signs Business requests with. Generated
-- with crypto.getRandomValues on the first authenticated request and read out of D1 once for the desktop
-- setup (there is nothing to `wrangler secret put`).
CREATE TABLE IF NOT EXISTS payments_worker_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  request_signing_secret TEXT NOT NULL
);

-- Replay protection for signed Business requests.
CREATE TABLE IF NOT EXISTS payments_request_nonces (
  business_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_payments_request_nonces_expires
  ON payments_request_nonces(expires_at);

-- The Business's own Stripe secret/restricted key (encrypted at rest with STRIPE_API_KEY_ENCRYPTION_KEY,
-- AES-GCM, per-record IV -- see stripeApiKeyCrypto.ts), its publishable key (not sensitive; Stripe.js
-- needs it in the browser), and the signing secret of the webhook endpoint registered on the Business's
-- own Stripe account.
CREATE TABLE IF NOT EXISTS payments_stripe_api_keys (
  business_id TEXT NOT NULL PRIMARY KEY,
  encrypted_secret_key TEXT NOT NULL,
  secret_key_iv TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL DEFAULT 1,
  key_kind TEXT NOT NULL CHECK (key_kind IN ('restricted', 'secret')),
  publishable_key TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0,
  webhook_endpoint_id TEXT,
  encrypted_webhook_secret TEXT,
  webhook_secret_iv TEXT,
  webhook_secret_version INTEGER,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Hosted payment links: an unguessable token a Business can send a payer (email, text, or embedded in a
-- Client Portal page) to pay one invoice. invoice_ref is the desktop's own opaque sales_invoices.id --
-- never interpreted here. A new link for the same invoice revokes the previous one.
CREATE TABLE IF NOT EXISTS payments_links (
  token TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  invoice_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_links_business_invoice
  ON payments_links(business_id, invoice_ref);

-- One row per payment attempt (a Stripe PaymentIntent). method distinguishes in-app card entry from a
-- hosted payment link. desktop_acknowledged_at is how hosted-link payments reach the desktop: it lists
-- succeeded, unacknowledged link payments and acknowledges each after importing it.
CREATE TABLE IF NOT EXISTS payments_payments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  invoice_ref TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  method TEXT NOT NULL CHECK (method IN ('card_in_app', 'payment_link')),
  payment_intent_id TEXT NOT NULL,
  link_token TEXT,
  status TEXT NOT NULL DEFAULT 'requires_payment'
    CHECK (status IN ('requires_payment', 'processing', 'succeeded', 'failed', 'canceled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded_at TEXT,
  desktop_acknowledged_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payments_payment_intent
  ON payments_payments(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payments_payments_business_invoice
  ON payments_payments(business_id, invoice_ref);
CREATE INDEX IF NOT EXISTS idx_payments_payments_link_pending
  ON payments_payments(business_id, method, status, desktop_acknowledged_at);

INSERT OR IGNORE INTO payments_schema_versions (version, description)
VALUES (1, 'Independent Payments Worker: signing-secret settings, request nonces, per-Business encrypted Stripe keys, hosted payment links, payment attempts.');
