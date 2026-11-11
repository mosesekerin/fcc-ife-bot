-- FCC Ife answers line: D1 schema
-- Apply with: npx wrangler d1 execute fcc-ife-bot --remote --file=schema.sql

-- Everyone who has messaged the answers line
CREATE TABLE IF NOT EXISTS contacts (
  wa_id        TEXT PRIMARY KEY,
  name         TEXT,
  tag          TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,   -- unix seconds
  last_handoff INTEGER             -- unix seconds
);

-- Counters per ISO week (e.g. 2026-W46) and 'ALL', per tag
CREATE TABLE IF NOT EXISTS stats (
  period    TEXT NOT NULL,
  tag       TEXT NOT NULL,
  scans     INTEGER NOT NULL DEFAULT 0,
  chats     INTEGER NOT NULL DEFAULT 0,
  followups INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, tag)
);

-- Follow-ups waiting to be sent by the every-minute cron
CREATE TABLE IF NOT EXISTS followups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_id    TEXT NOT NULL,
  name     TEXT,
  tag      TEXT NOT NULL,
  due_at   INTEGER NOT NULL,       -- unix seconds
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at  INTEGER,                -- unix seconds, NULL until sent
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS followups_due ON followups (sent_at, due_at);
