-- Single-row Worker-wide settings, self-bootstrapped on first use instead of supplied as a
-- Worker secret. Currently holds only the credential encryption key (see importEncryptionKey in
-- mobileSyncSecurity.ts): 32 random bytes generated with crypto.getRandomValues on first request,
-- base64-encoded, inserted with ON CONFLICT DO NOTHING, then re-read -- so a first-request race
-- lands on whichever insert won rather than two different keys.
CREATE TABLE mobile_sync_worker_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  credential_encryption_key_b64 TEXT NOT NULL
);
