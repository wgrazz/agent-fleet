-- ~/.fleet/fleet.db: shared by the fleet CLI (Python sqlite3) and the dashboard server (node:sqlite).
-- Both apply this file on every open, so every statement must be idempotent.
CREATE TABLE IF NOT EXISTS profiles (
  name TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  args TEXT,
  cwd TEXT,
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
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8e8e93',
  position INTEGER NOT NULL DEFAULT 0
);
-- which folder an agent or past conversation sits in; key is "sid:<session id>" when known, else "name:<session>"
CREATE TABLE IF NOT EXISTS placements (
  key TEXT PRIMARY KEY,
  folder_id INTEGER NOT NULL
);
-- Ideas lists; ideas.list holds the list's name so `fleet idea -l NAME` needs no lookup
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#8e8e93',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO lists (name, color, position) VALUES ('Priority', '#ff3b30', -2), ('Brain Dump', '#8e8e93', -1);
-- every smart-feature call (Jarvis, Improve, Suggest, Sort): API-equivalent cost as Claude Code reports it
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  feature TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
  persisted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage (at);
-- Jarvis conversations: each has its own Claude session; a new one starts after 2 hours of quiet
CREATE TABLE IF NOT EXISTS jarvis_threads (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jarvis_messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  who TEXT NOT NULL,            -- 'you' | 'bot'
  text TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}', -- done actions, instant, warning
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jarvis_messages_thread ON jarvis_messages (thread_id, id);
-- things Jarvis wants to do to agents, waiting for your OK
CREATE TABLE IF NOT EXISTS jarvis_proposals (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  action TEXT NOT NULL,         -- JSON JarvisAction
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined
  result TEXT,
  created_at INTEGER NOT NULL
);

-- Messages typed while an agent was busy: sent one at a time, each after the agent finishes its turn.
CREATE TABLE IF NOT EXISTS queued (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
