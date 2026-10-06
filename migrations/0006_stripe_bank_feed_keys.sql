PRAGMA foreign_keys = ON;

-- Stripe_Unified_Raw_API_Key_Payments_And_Bank_Connections_Task_Spec_20260929.md: Bank Connections
-- (Stripe Financial Connections) uses the account's own Stripe API key. This Worker is independent of
-- Client Portal, so it keeps its own AES-GCM-encrypted copy (STRIPE_API_KEY_ENCRYPTION_KEY, see
-- stripeApiKeyCrypto.ts) plus this account's own webhook signing secret. customer_id is the account's
-- own Stripe Customer used as the Financial Connections account holder.
CREATE TABLE stripe_bank_feed_keys (
  account_integration_id TEXT PRIMARY KEY,
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
  customer_id TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  6,
  'Add Stripe Financial Connections: per-account encrypted Stripe API key storage',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
