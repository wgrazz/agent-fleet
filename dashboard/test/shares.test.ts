// Save note: the share's agent's write-up lands in the notes folder, appended to a same-topic note or as a new file, never outside it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-shares-'))
let reply = { file: '', note: '' }
vi.mock('../server/ai.ts', () => ({ askFull: async () => ({ value: reply, session_id: 's1', cost: 0 }) }))
vi.mock('../server/push.ts', () => ({ pushAll: async () => {} }))
const m = await import('../server/shares.ts')
const { db } = await import('../server/store.ts')

it('appends to a same-topic note, starts a new one otherwise, and keeps the file inside the folder', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'notes-'))
  writeFileSync(join(folder, 'jarvis.md'), '# Jarvis\n')
  db.prepare("INSERT INTO shares (id, url, status, session_id, created_at, updated_at) VALUES (1, 'https://x/r', 'ready', 's0', 0, 0)").run()
  reply = { file: '../../jarvis.md', note: '## Reference 2\n- song A' }
  expect(await m.saveNote(1, folder)).toBe('jarvis.md')
  expect(readFileSync(join(folder, 'jarvis.md'), 'utf8')).toBe('# Jarvis\n\n\n## Reference 2\n- song A\n')
  reply = { file: 'Songs for moods', note: '# Songs\n- B' }
  expect(await m.saveNote(1, folder)).toBe('Songs-for-moods.md')
  expect(readFileSync(join(folder, 'Songs-for-moods.md'), 'utf8')).toBe('# Songs\n- B\n')
  expect(m.share(1)!.status).toBe('ready')
  expect(m.fileName('...')).toBe('shared.md')
})
