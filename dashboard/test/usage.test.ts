// Claude's weekly spend is summed from transcripts, read in pieces so a log bigger than one read still counts.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-usage-'))
process.env.HOME = mkdtempSync(join(tmpdir(), 'fleet-home-'))
const { aiBudget, usage } = await import('../server/usage.ts')

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

it('paces the Claude week: % of the window elapsed, and points used since today\'s first reading', async () => {
  const now = Date.now() / 1000
  const write = (date: string, start: number, resets = now + 3.5 * 86400) => writeFileSync(join(process.env.FLEET_DIR!, 'claude-usage.json'),
    JSON.stringify({ rate_limits: { seven_day: { used_percentage: 43, resets_at: resets } }, at: now, day: { date, start } }))
  const week = async () => (await usage())[0].windows.find(w => w.label === 'Week')!
  write(new Date().toLocaleDateString('sv'), 38)
  expect(await week()).toMatchObject({ pct: 43, pace: 50, today: 5 })
  write('2000-01-01', 38) // no reading yet today
  expect((await week()).today).toBe(0)
  write(new Date().toLocaleDateString('sv'), 38, now - 60) // window already reset
  expect(await week()).toMatchObject({ pct: 0, pace: 0, today: 0 })
})
