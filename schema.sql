-- ~/.fleet/fleet.db: shared by the fleet CLI (Python sqlite3) and the dashboard server (node:sqlite).
-- Both apply this file on every open, so every statement must be idempotent.
CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  args TEXT,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paused (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  paused_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  list TEXT NOT NULL DEFAULT 'Brain Dump',
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  sub TEXT NOT NULL
);
