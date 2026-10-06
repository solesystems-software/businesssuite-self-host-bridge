PRAGMA foreign_keys = ON;

ALTER TABLE bank_feed_accounts
ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (sync_enabled IN (0, 1));

CREATE TABLE bank_feed_account_sync_state (
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

CREATE TABLE bank_feed_delivery_batch_accounts (
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

INSERT INTO bank_feed_account_sync_state (
  connection_id,
  provider_account_id,
  acknowledged_cursor,
  pending_batch_id,
  pending_cursor,
  last_sync_started_at,
  last_sync_completed_at,
  last_acknowledged_at,
  updated_at
)
SELECT
  account.connection_id,
  account.provider_account_id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bank_feed_accounts AS account;

CREATE INDEX idx_bank_feed_accounts_sync_enabled
  ON bank_feed_accounts(connection_id, is_active, sync_enabled, provider_account_id);

CREATE INDEX idx_bank_feed_account_sync_pending
  ON bank_feed_account_sync_state(connection_id, pending_batch_id, provider_account_id);

CREATE INDEX idx_bank_feed_delivery_batch_accounts_connection
  ON bank_feed_delivery_batch_accounts(connection_id, batch_id, provider_account_id);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  3,
  'Add per-account Bank Feed synchronization preferences and cursors',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
