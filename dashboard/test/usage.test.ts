// Claude's weekly spend is summed from transcripts, read in pieces so a log bigger than one read still counts.
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-usage-'))
process.env.HOME = mkdtempSync(join(tmpdir(), 'fleet-home-'))
const { aiBudget } = await import('../server/usage.ts')

it('counts usage on both sides of a 64 MB piece, once per reply', async () => {
  const dir = join(process.env.HOME!, '.claude', 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 's.jsonl')
  const reply = (id: string) => `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-sonnet-5-5', usage: { output_tokens: 1e6 } } })}\n`
  appendFileSync(f, reply('a') + reply('a'))
  appendFileSync(f, `${JSON.stringify({ type: 'user', pad: 'x'.repeat(1 << 20) })}\n`.repeat(70))
  appendFileSync(f, reply('b'))
  const once = (await aiBudget()).claude_usd
  expect(once).toBeGreaterThan(0)
  const [a, b] = await Promise.all([aiBudget(), aiBudget()]) // concurrent checks don't skip or double count
  expect([a.claude_usd, b.claude_usd]).toEqual([once, once])
  appendFileSync(f, reply('c'))
  expect((await aiBudget()).claude_usd).toBeCloseTo(once * 1.5)
})
