-- AevyCPM database schema (Cloudflare D1 / SQLite)
-- Apply with: npx wrangler d1 execute aevycpm --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  tags          TEXT NOT NULL DEFAULT '',          -- comma separated, lowercase
  version       TEXT NOT NULL DEFAULT '1.0.0',
  author        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  file_key      TEXT NOT NULL,                     -- private R2 object key
  file_type     TEXT NOT NULL,                     -- extension, e.g. lua, zip
  file_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  entries       TEXT,                              -- JSON list of file names (zip only)
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reject_reason TEXT,
  downloads     INTEGER NOT NULL DEFAULT 0,
  ip_hash       TEXT,                              -- keyed hash, never the raw IP
  created_at    INTEGER NOT NULL,                  -- unix ms
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scripts_status_new  ON scripts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scripts_status_pop  ON scripts(status, downloads DESC);
CREATE INDEX IF NOT EXISTS idx_scripts_category    ON scripts(category);
CREATE INDEX IF NOT EXISTS idx_scripts_sha256      ON scripts(sha256);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  details    TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_script ON reports(script_id);

CREATE TABLE IF NOT EXISTS daily_stats (
  day       TEXT PRIMARY KEY,                      -- YYYY-MM-DD (UTC)
  uploads   INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_approve', 'false');

INSERT OR IGNORE INTO categories (slug, name) VALUES
  ('games',      'Games'),
  ('utilities',  'Utilities'),
  ('automation', 'Automation'),
  ('libraries',  'Libraries'),
  ('ui',         'UI & Visual'),
  ('tools',      'Developer tools'),
  ('other',      'Other');
