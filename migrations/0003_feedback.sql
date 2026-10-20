-- In-app feedback (AGENTS.md rule 12, shared/feedback.ts). One row per report people choose to send.
-- Stored: the SGT date (no time of day), the reason, the carpark and its source, what the card showed
-- (count reports only), the note and the app version. Never an IP address, device, cookie, ID or location.
-- A daily Cron deletes rows 180 days after closed_on, and 12 months after received_on at the latest.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  received_on TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('carpark', 'general')),
  reason      TEXT NOT NULL CHECK (reason IN ('location', 'closed', 'access', 'count', 'rates', 'not-carpark', 'other', 'idea', 'problem', 'praise', 'missing')),
  carpark_id  TEXT,
  source      TEXT CHECK (source IS NULL OR source IN ('hdb', 'lta', 'ura', 'osm')),
  shown       TEXT,
  note        TEXT,
  -- For the same-day duplicate check only.
  note_hash   TEXT NOT NULL,
  app_version TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
  closed_on   TEXT
);

CREATE INDEX IF NOT EXISTS feedback_day ON feedback (received_on);
