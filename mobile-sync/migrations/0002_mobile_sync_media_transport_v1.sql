CREATE TABLE mobile_sync_packet_media_objects (
  account_sync_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  payload_object_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (account_sync_id, packet_id, media_id),
  FOREIGN KEY (packet_id) REFERENCES mobile_sync_packets(packet_id)
);

CREATE INDEX idx_mobile_sync_packet_media_retention
  ON mobile_sync_packet_media_objects(account_sync_id, packet_id, deleted_at);
