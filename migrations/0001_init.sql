-- Last good HDB availability snapshot (single row).
CREATE TABLE IF NOT EXISTS feed_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT NOT NULL,
  feed_timestamp TEXT,
  payload TEXT NOT NULL
);

-- Refresh bookkeeping (single row). last_attempt_at doubles as the refresh claim.
CREATE TABLE IF NOT EXISTS feed_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Cached OneMap API token (single row), only used when OneMap credentials are configured.
CREATE TABLE IF NOT EXISTS onemap_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
