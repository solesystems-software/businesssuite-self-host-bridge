PRAGMA foreign_keys = ON;

-- Stripe Financial Connections (Bank Connections), parallel to the Plaid tables (which are untouched):
-- one connection per completed Financial Connections Session (one institution link); its accounts
-- carry their own per-account transaction cursor (the last acknowledged Stripe transaction_refresh id)
-- and pending delivery batch, so no Plaid-shaped schema is bent to fit Stripe.
CREATE TABLE stripe_fc_connections (
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

CREATE INDEX idx_stripe_fc_connections_account_status
  ON stripe_fc_connections(account_integration_id, connection_status);

CREATE TABLE stripe_fc_accounts (
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

CREATE UNIQUE INDEX idx_stripe_fc_accounts_provider_account
  ON stripe_fc_accounts(provider_account_id);

CREATE TABLE stripe_fc_delivery_batches (
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

CREATE INDEX idx_stripe_fc_delivery_batches_connection_status
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
