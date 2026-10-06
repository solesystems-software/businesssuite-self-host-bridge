PRAGMA foreign_keys = ON;

ALTER TABLE bank_feed_connections
ADD COLUMN webhook_url TEXT;

ALTER TABLE bank_feed_connections
ADD COLUMN webhook_configured_at TEXT;

ALTER TABLE bank_feed_sync_state
ADD COLUMN last_webhook_code TEXT;

ALTER TABLE bank_feed_sync_state
ADD COLUMN last_webhook_request_id TEXT;

CREATE INDEX idx_bank_feed_sync_automatic_updates
  ON bank_feed_sync_state(updates_available, pending_batch_id, updated_at);

CREATE INDEX idx_bank_feed_connections_webhook_registration
  ON bank_feed_connections(
    business_integration_id,
    connection_status,
    webhook_configured_at,
    updated_at
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
