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
