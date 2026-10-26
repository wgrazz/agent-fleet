// ~/.fleet: config (port + access key, shared with the fleet CLI) and the SQLite database.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const REPO = join(import.meta.dirname, '..', '..')
export const FLEET_DIR = process.env.FLEET_DIR ?? join(homedir(), '.fleet')
export const FLEET_BIN = process.env.FLEET_BIN ?? join(REPO, 'fleet')
mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 })

export type Config = {
  port: number; key: string; cwd?: string; jarvis_warn_pct?: number; jarvis_max_pct?: number
  ai_model?: string; voice_engine?: 'kokoro' | 'mac' | 'device'; voice?: string; voice_speed?: number
}

// Same format and creation rule as config() in the fleet CLI: whoever runs first writes it, readable only by you.
export function readSecret<T>(file: string, make: () => T): T {
  const path = join(FLEET_DIR, file)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    try {
      writeFileSync(path, JSON.stringify(make()), { mode: 0o600, flag: 'wx' })
    } catch {} // the CLI won the race; read its file
    return JSON.parse(readFileSync(path, 'utf8'))
  }
}

export const config = readSecret<Config>('config.json', () => ({ port: 7878, key: randomBytes(24).toString('hex') }))

/** Save changed settings; the port and key never change from here. */
export function saveConfig(patch: Partial<Config>) {
  Object.assign(config, patch)
  writeFileSync(join(FLEET_DIR, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 })
}

export const db = new DatabaseSync(join(FLEET_DIR, 'fleet.db'))
db.exec('PRAGMA journal_mode=WAL')
db.exec(readFileSync(join(REPO, 'schema.sql'), 'utf8'))

// Columns added after the first release. The CLI only ever inserts (list, text, created_at), so they live here.
const IDEA_COLUMNS: Record<string, string> = {
  notes: "TEXT NOT NULL DEFAULT ''", position: 'REAL', done_at: 'INTEGER', repeat: 'TEXT', next_due: 'INTEGER',
  agent: 'TEXT', source: 'TEXT', suggestion: 'TEXT', suggestion_conf: 'REAL', priority: 'INTEGER NOT NULL DEFAULT 0', why: 'TEXT', area: 'TEXT',
}
const have = new Set((db.prepare('PRAGMA table_info(ideas)').all() as { name: string }[]).map(c => c.name))
for (const [col, type] of Object.entries(IDEA_COLUMNS)) if (!have.has(col)) db.exec(`ALTER TABLE ideas ADD COLUMN ${col} ${type}`)
// kind 'checklist': steps stay in order and checked ones stay put; section 'More': tucked into the sidebar's collapsed More group
const listCols = new Set((db.prepare('PRAGMA table_info(lists)').all() as { name: string }[]).map(c => c.name))
if (!listCols.has('kind')) db.exec("ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'ideas'")
if (!listCols.has('section')) db.exec('ALTER TABLE lists ADD COLUMN section TEXT')
if (!(db.prepare('PRAGMA table_info(paused)').all() as { name: string }[]).some(c => c.name === 'resume_at')) db.exec('ALTER TABLE paused ADD COLUMN resume_at INTEGER')
/** A copy of the whole database once a day, last 30 kept, in ~/.fleet/backups. `fleet restore` brings ideas back from one. */
export function dailyBackup() {
  const dir = join(FLEET_DIR, 'backups')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `fleet-${new Date().toLocaleDateString('sv')}.db`) // sv: YYYY-MM-DD in local time
  if (existsSync(file)) return
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  for (const old of readdirSync(dir).filter(f => /^fleet-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -30)) unlinkSync(join(dir, old))
}

// ideas jotted into a list that doesn't exist yet (fleet idea -l NewList) get that list
db.exec("INSERT OR IGNORE INTO lists (name, position) SELECT DISTINCT list, 100 FROM ideas")
