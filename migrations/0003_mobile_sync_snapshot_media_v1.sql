-- Desktop -> mobile inline Note media (photos, webpage captures).
-- The desktop uploads each attachment's bytes once (keyed by the shared attachment id
-- + content hash); the phone downloads them on demand after applying a snapshot so a
-- Note that was authored on the desktop renders its images inline, exactly as there.
-- Bytes live in R2 at snapshot-media/<account_sync_id>/<media_id>; this row is the index.
CREATE TABLE mobile_sync_snapshot_media (
  account_sync_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  payload_object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_sync_id, media_id),
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id)
);
