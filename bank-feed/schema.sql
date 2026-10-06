PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bank_feed_schema_versions (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  1,
  'Initial SoleSystems bank-feed broker foundation',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE IF NOT EXISTS bank_feed_connections (
  id TEXT PRIMARY KEY,
  account_integration_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('plaid')),
  provider_item_id TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  access_token_iv TEXT NOT NULL,
  access_token_key_version INTEGER NOT NULL DEFAULT 1 CHECK (access_token_key_version > 0),
  connection_status TEXT NOT NULL DEFAULT 'active'
    CHECK (connection_status IN ('active', 'needs_attention', 'disconnected', 'revoked')),
  institution_id TEXT,
  institution_name TEXT,
  consent_expiration_time TEXT,
  webhook_url TEXT,
  webhook_configured_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_item_id)
);

CREATE TABLE IF NOT EXISTS bank_feed_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  account_type TEXT NOT NULL,
  account_subtype TEXT,
  iso_currency_code TEXT,
  unofficial_currency_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sync_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  UNIQUE (connection_id, provider_account_id)
);

CREATE TABLE IF NOT EXISTS bank_feed_sync_state (
  connection_id TEXT PRIMARY KEY,
  acknowledged_cursor TEXT,
  pending_batch_id TEXT,
  pending_cursor TEXT,
  updates_available INTEGER NOT NULL DEFAULT 0 CHECK (updates_available IN (0, 1)),
  last_webhook_at TEXT,
  last_webhook_code TEXT,
  last_webhook_request_id TEXT,
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_acknowledged_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES bank_feed_connections(id) ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS bank_feed_account_sync_state (
  connection_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  acknowledged_cursor TEXT,
  pending_batch_id TEXT,
  pending_cursor TEXT,
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_acknowledged_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, provider_account_id),
  FOREIGN KEY (connection_id) REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id, provider_account_id)
    REFERENCES bank_feed_accounts(connection_id, provider_account_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_feed_delivery_batch_accounts (
  batch_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  from_cursor TEXT,
  proposed_cursor TEXT NOT NULL,
  PRIMARY KEY (batch_id, provider_account_id),
  FOREIGN KEY (batch_id) REFERENCES bank_feed_delivery_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id, provider_account_id)
    REFERENCES bank_feed_accounts(connection_id, provider_account_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_feed_delivery_batches (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  from_cursor TEXT,
  proposed_cursor TEXT,
  delivery_status TEXT NOT NULL
    CHECK (delivery_status IN ('issued', 'acknowledged', 'expired', 'failed')),
  added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  modified_count INTEGER NOT NULL DEFAULT 0 CHECK (modified_count >= 0),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  issued_at TEXT NOT NULL,
  acknowledged_at TEXT,
  expires_at TEXT NOT NULL,
  failure_code TEXT,
  FOREIGN KEY (connection_id) REFERENCES bank_feed_connections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_feed_request_nonces (
  account_integration_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_integration_id, nonce)
);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  2,
  'Add authenticated broker request replay protection',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);


INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  3,
  'Add per-account Bank Feed synchronization preferences and cursors',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);



INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  4,
  'Add Plaid webhook registration and automatic synchronization state',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);



INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  5,
  'Rename Business Suite account identifiers',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE INDEX IF NOT EXISTS idx_bank_feed_connections_account_status
  ON bank_feed_connections(account_integration_id, connection_status);

CREATE INDEX IF NOT EXISTS idx_bank_feed_connections_updated
  ON bank_feed_connections(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_feed_accounts_connection_active
  ON bank_feed_accounts(connection_id, is_active);

CREATE INDEX IF NOT EXISTS idx_bank_feed_sync_state_updates
  ON bank_feed_sync_state(updates_available, updated_at);

CREATE INDEX IF NOT EXISTS idx_bank_feed_delivery_batches_connection_status
  ON bank_feed_delivery_batches(connection_id, delivery_status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_feed_delivery_batches_expiration
  ON bank_feed_delivery_batches(delivery_status, expires_at);

CREATE INDEX IF NOT EXISTS idx_bank_feed_request_nonces_expiration
  ON bank_feed_request_nonces(expires_at);


CREATE INDEX IF NOT EXISTS idx_bank_feed_accounts_sync_enabled
  ON bank_feed_accounts(connection_id, is_active, sync_enabled, provider_account_id);

CREATE INDEX IF NOT EXISTS idx_bank_feed_account_sync_pending
  ON bank_feed_account_sync_state(connection_id, pending_batch_id, provider_account_id);

CREATE INDEX IF NOT EXISTS idx_bank_feed_delivery_batch_accounts_connection
  ON bank_feed_delivery_batch_accounts(connection_id, batch_id, provider_account_id);


CREATE INDEX IF NOT EXISTS idx_bank_feed_sync_automatic_updates
  ON bank_feed_sync_state(updates_available, pending_batch_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_bank_feed_connections_webhook_registration
  ON bank_feed_connections(
    account_integration_id,
    connection_status,
    webhook_configured_at,
    updated_at
  );

-- Stripe_Unified_Raw_API_Key_Payments_And_Bank_Connections_Task_Spec_20260929.md: Bank Connections
-- (Stripe Financial Connections) uses the account's own Stripe API key. This Worker is independent of
-- Client Portal, so it keeps its own AES-GCM-encrypted copy (STRIPE_API_KEY_ENCRYPTION_KEY, see
-- stripeApiKeyCrypto.ts) plus this account's own webhook signing secret. customer_id is the account's
-- own Stripe Customer used as the Financial Connections account holder.
CREATE TABLE IF NOT EXISTS stripe_bank_feed_keys (
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

-- Stripe Financial Connections (Bank Connections), parallel to the Plaid tables (which are untouched):
-- one connection per completed Financial Connections Session (one institution link); its accounts
-- carry their own per-account transaction cursor (the last acknowledged Stripe transaction_refresh id)
-- and pending delivery batch, so no Plaid-shaped schema is bent to fit Stripe.
CREATE TABLE IF NOT EXISTS stripe_fc_connections (
  id TEXT PRIMARY KEY,
  account_integration_id TEXT NOT NULL,
  stripe_session_id TEXT,
  institution_name TEXT,
  connection_status TEXT NOT NULL DEFAULT 'active'
    CHECK (connection_status IN ('active', 'needs_attention', 'disconnected', 'revoked')),
  updates_available INTEGER NOT NULL DEFAULT 0 CHECK (updates_available IN (0, 1)),
  last_webhook_at TEXT,
  last_webhook_code TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_fc_connections_account_status
  ON stripe_fc_connections(account_integration_id, connection_status);

CREATE TABLE IF NOT EXISTS stripe_fc_accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  account_type TEXT NOT NULL,
  account_subtype TEXT,
  iso_currency_code TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sync_enabled IN (0, 1)),
  acknowledged_cursor TEXT,
  pending_batch_id TEXT,
  pending_cursor TEXT,
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES stripe_fc_connections(id) ON DELETE CASCADE,
  UNIQUE (connection_id, provider_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_fc_accounts_provider_account
  ON stripe_fc_accounts(provider_account_id);

CREATE TABLE IF NOT EXISTS stripe_fc_delivery_batches (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'acknowledged', 'expired')),
  added_count INTEGER NOT NULL CHECK (added_count >= 0),
  modified_count INTEGER NOT NULL CHECK (modified_count >= 0),
  removed_count INTEGER NOT NULL CHECK (removed_count >= 0),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  acknowledged_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES stripe_fc_connections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stripe_fc_delivery_batches_connection_status
  ON stripe_fc_delivery_batches(connection_id, delivery_status, issued_at DESC);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  7,
  'Add Stripe Financial Connections connections, accounts (with per-account cursors) and delivery batches',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- Bank Connections owns its request-signing secret (Galen, 2026-09-30): nothing about it comes from
-- licensing (no license gate, no device credential). Single-row Worker settings, self-bootstrapped on first
-- use (see getOrCreateRequestSigningSecretBase64 in requestAuthentication.ts); the desktop learns the secret
-- at deploy time or by manual entry.
CREATE TABLE IF NOT EXISTS bank_feed_worker_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  request_signing_secret TEXT NOT NULL
);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  8,
  'Add self-bootstrapped request signing secret (bank-feed authentication no longer depends on licensing)',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
