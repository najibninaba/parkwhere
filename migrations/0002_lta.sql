-- Last good LTA DataMall carpark snapshot (single row): non-HDB carparks, car lots only.
CREATE TABLE IF NOT EXISTS lta_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Refresh bookkeeping for the LTA feed (single row). last_attempt_at doubles as the refresh claim.
CREATE TABLE IF NOT EXISTS lta_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
