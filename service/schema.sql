-- Local Music account state. One row set per Freebuff account (sub).
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  name TEXT,
  platform TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL,
  name TEXT,
  platform TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_sub TEXT,
  token_issued_at INTEGER
);

CREATE INDEX IF NOT EXISTS device_codes_ip ON device_codes (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS likes (
  sub TEXT NOT NULL,
  ref TEXT NOT NULL,
  liked_at INTEGER NOT NULL,
  decision_at INTEGER NOT NULL,
  PRIMARY KEY (sub, ref)
);

CREATE TABLE IF NOT EXISTS stats (
  sub TEXT NOT NULL,
  ref TEXT NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  skips INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, ref)
);

CREATE TABLE IF NOT EXISTS playlists (
  sub TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, id)
);

CREATE TABLE IF NOT EXISTS playlist_items (
  sub TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (sub, playlist_id, ref)
);
