// ~/.fleet: config (port + access key, shared with the fleet CLI) and the SQLite database.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const REPO = join(import.meta.dirname, '..', '..')
export const FLEET_DIR = process.env.FLEET_DIR ?? join(homedir(), '.fleet')
export const FLEET_BIN = process.env.FLEET_BIN ?? join(REPO, 'fleet')
mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 })

export type Config = { port: number; key: string; cwd?: string }

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

export const db = new DatabaseSync(join(FLEET_DIR, 'fleet.db'))
db.exec('PRAGMA journal_mode=WAL')
db.exec(readFileSync(join(REPO, 'schema.sql'), 'utf8'))

// Columns added after the first release. The CLI only ever inserts (list, text, created_at), so they live here.
const IDEA_COLUMNS: Record<string, string> = {
  notes: "TEXT NOT NULL DEFAULT ''", position: 'REAL', done_at: 'INTEGER', repeat: 'TEXT', next_due: 'INTEGER',
  agent: 'TEXT', source: 'TEXT', suggestion: 'TEXT', suggestion_conf: 'REAL',
}
const have = new Set((db.prepare('PRAGMA table_info(ideas)').all() as { name: string }[]).map(c => c.name))
for (const [col, type] of Object.entries(IDEA_COLUMNS)) if (!have.has(col)) db.exec(`ALTER TABLE ideas ADD COLUMN ${col} ${type}`)
// ideas jotted into a list that doesn't exist yet (fleet idea -l NewList) get that list
db.exec("INSERT OR IGNORE INTO lists (name, position) SELECT DISTINCT list, 100 FROM ideas")
