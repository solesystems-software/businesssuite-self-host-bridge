CREATE TABLE mobile_sync_accounts (
  account_sync_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE mobile_sync_desktop_clients (
  credential_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  desktop_client_id TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  UNIQUE (account_sync_id, desktop_client_id),
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id)
);

CREATE TABLE mobile_sync_devices (
  credential_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  UNIQUE (account_sync_id, device_id),
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id)
);

CREATE TABLE mobile_sync_pairing_sessions (
  session_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  intended_device_id TEXT,
  pairing_token_hash TEXT NOT NULL UNIQUE,
  created_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_device_id TEXT,
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id),
  FOREIGN KEY (created_by_credential_id) REFERENCES mobile_sync_desktop_clients(credential_id)
);

CREATE TABLE mobile_sync_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  payload_object_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  uploaded_by_credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE (account_sync_id, snapshot_version),
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id)
);

CREATE TABLE mobile_sync_account_sequence (
  account_sync_id TEXT PRIMARY KEY,
  next_sequence INTEGER NOT NULL,
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id)
);

CREATE TABLE mobile_sync_packets (
  packet_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  packet_type TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  client_sequence INTEGER NOT NULL,
  server_sequence INTEGER NOT NULL,
  snapshot_version_seen INTEGER,
  entity_id TEXT,
  entity_revision_seen TEXT,
  idempotency_key TEXT NOT NULL,
  payload_object_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_desktop', 'accepted', 'rejected', 'action_required')),
  UNIQUE (account_sync_id, packet_id),
  UNIQUE (account_sync_id, idempotency_key),
  UNIQUE (account_sync_id, server_sequence),
  FOREIGN KEY (account_sync_id) REFERENCES mobile_sync_accounts(account_sync_id),
  FOREIGN KEY (account_sync_id, device_id) REFERENCES mobile_sync_devices(account_sync_id, device_id)
);

CREATE TABLE mobile_sync_packet_acks (
  packet_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ack_status TEXT NOT NULL CHECK (ack_status IN ('accepted', 'rejected', 'action_required')),
  reason_code TEXT,
  acknowledged_by_credential_id TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  FOREIGN KEY (packet_id) REFERENCES mobile_sync_packets(packet_id),
  FOREIGN KEY (acknowledged_by_credential_id) REFERENCES mobile_sync_desktop_clients(credential_id)
);

CREATE TABLE mobile_sync_media (
  media_id TEXT PRIMARY KEY,
  account_sync_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  payload_object_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (packet_id) REFERENCES mobile_sync_packets(packet_id)
);

CREATE TABLE mobile_sync_nonce_claims (
  credential_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request_timestamp_seconds INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, nonce)
);

CREATE TABLE mobile_sync_retained_backup (
  account_sync_id TEXT PRIMARY KEY,
  packet_id TEXT NOT NULL,
  server_sequence INTEGER NOT NULL,
  payload_object_key TEXT NOT NULL,
  retained_at TEXT NOT NULL,
  FOREIGN KEY (packet_id) REFERENCES mobile_sync_packets(packet_id)
);

CREATE TABLE mobile_sync_rate_limits (
  rate_key TEXT NOT NULL,
  window_started_at_seconds INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (rate_key, window_started_at_seconds)
);

CREATE INDEX idx_mobile_sync_pairing_account ON mobile_sync_pairing_sessions(account_sync_id, expires_at);
CREATE INDEX idx_mobile_sync_snapshots_latest ON mobile_sync_snapshots(account_sync_id, snapshot_version DESC);
CREATE INDEX idx_mobile_sync_packets_pending ON mobile_sync_packets(account_sync_id, status, server_sequence);
CREATE INDEX idx_mobile_sync_acks_device ON mobile_sync_packet_acks(account_sync_id, device_id, acknowledged_at);
CREATE INDEX idx_mobile_sync_nonces_expiry ON mobile_sync_nonce_claims(expires_at);
