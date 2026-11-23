-- Additive upgrade for databases created before schema version 7 (site publishing: the live-token registry); safe to re-run.
CREATE TABLE IF NOT EXISTS portal_live_registrations (
  access_grant_id TEXT PRIMARY KEY REFERENCES portal_access_grants(id),
  business_id TEXT NOT NULL,
  allowed_origin TEXT NOT NULL,
  allowed_refs_json TEXT NOT NULL DEFAULT '{}',
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_portal_live_registrations_business ON portal_live_registrations(business_id);
INSERT OR IGNORE INTO portal_schema_versions (version, description)
VALUES (7, 'Site publishing (D6/D7): bridge only; portal_live_registrations is the live-token registry; no published content is stored.');
