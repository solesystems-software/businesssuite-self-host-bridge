PRAGMA foreign_keys = ON;

-- Bank Connections owns its request-signing secret (Galen, 2026-09-30): nothing about it comes from
-- licensing (no license gate, no device credential). Single-row Worker settings, self-bootstrapped on first
-- use (see getOrCreateRequestSigningSecretBase64 in requestAuthentication.ts); the desktop learns the secret
-- at deploy time or by manual entry.
CREATE TABLE bank_feed_worker_settings (
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
