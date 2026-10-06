ALTER TABLE bank_feed_connections
  RENAME COLUMN business_integration_id TO account_integration_id;

ALTER TABLE bank_feed_request_nonces
  RENAME COLUMN business_integration_id TO account_integration_id;

DROP INDEX IF EXISTS idx_bank_feed_connections_business_status;

CREATE INDEX IF NOT EXISTS idx_bank_feed_connections_account_status
  ON bank_feed_connections(account_integration_id, connection_status);

INSERT OR IGNORE INTO bank_feed_schema_versions (
  version,
  description,
  applied_at
) VALUES (
  5,
  'Rename Business Suite account identifiers',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
