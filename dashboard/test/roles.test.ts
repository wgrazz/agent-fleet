// Team roles: when they run, and the loop of a run's questions and tasks → your answers → the next run.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-roles-'))
const inputs: string[] = []
const pushes: string[] = []
let reply: Record<string, unknown> = {}
vi.mock('../server/ai.ts', () => ({
  askFull: async (task: string) => { inputs.push(task); return { value: reply, session_id: '', cost: 0.05 } },
  sortIdeas: async () => ({ suggestions: [] }),
}))
vi.mock('../server/push.ts', () => ({ pushAll: async (p: { body: string }) => { pushes.push(p.body) } }))
const m = await import('../server/roles.ts')

const at = (d: number, h: number, min = 0) => Math.floor(new Date(2026, 9, d, h, min).getTime() / 1000) // Oct 2026; the 26th is a Monday
const when = (s: number | null) => { const d = new Date(s! * 1000); return [d.getDate(), d.getHours(), d.getMinutes()] }

it('runs today if the time is still ahead, else on the next day the rule allows', () => {
  expect(when(m.nextRun('daily', '06:30', at(27, 5)))).toEqual([27, 6, 30])
  expect(when(m.nextRun('daily', '06:30', at(27, 7)))).toEqual([28, 6, 30])
  expect(when(m.nextRun('weekly:1', '07:00', at(26, 6)))).toEqual([26, 7, 0])
  expect(when(m.nextRun('weekly:1', '07:00', at(26, 8)))).toEqual([2, 7, 0])
  expect(m.nextRun('hours:3', '07:00', at(27, 5))).toBe(at(27, 8))
  expect(m.nextRun('', '07:00', at(27, 5))).toBeNull()
  expect(m.SCHEDULE.test('hours:25')).toBe(false)
})

it('the write tool needs a folder inside the working folder', () => {
  expect(() => m.saveRole('w', { tools: 'write', cwd: '/tmp', write_dir: '../x' })).toThrow(/write_dir/)
  expect(() => m.saveRole('w', { tools: 'write', cwd: '/tmp', write_dir: 'notes' })).not.toThrow()
})

it('a run files its questions and tasks; your answers, check-offs and messages reach the next run once', async () => {
  m.saveRole('clerk', { title: 'Clerk', prompt: 'Keep deadlines.', see: '' })
  reply = { brief: 'Need a date.', tasks: [{ text: 'Sign the resolution', detail: '' }], questions: [{ text: 'When did the shares move?', detail: 'Starts a 60-day clock.' }], memory: 'asked for transfer date' }
  m.message('clerk', 'I have a CPA now')
  await m.runRole('clerk')
  expect(inputs[0]).toContain('- Message: I have a CPA now')
  expect(inputs[0]).toContain('(empty: this is your first run)')
  const { items, runs } = m.page('clerk')!
  expect(runs[0]).toMatchObject({ status: 'ok', brief: 'Need a date.', cost: 0.05 })
  expect(pushes[0]).toBe('Need a date.\n1 question, 1 task for you')
  const q = items.find(i => i.kind === 'question')!, t = items.find(i => i.kind === 'task')!
  m.updateItem(q.id, { answer: 'Oct 12' })
  m.updateItem(t.id, { status: 'done' })
  reply = { brief: 'Logged.', tasks: [], questions: [], memory: 'transfer Oct 12' }
  await m.runRole('clerk')
  expect(inputs[1]).toContain('- Answer to "When did the shares move?": Oct 12')
  expect(inputs[1]).toContain('- Done: Sign the resolution')
  expect(inputs[1]).toContain('asked for transfer date')
  expect(inputs[1]).not.toContain('I have a CPA now')
  await m.runRole('clerk')
  expect(inputs[2]).toContain('From the owner since your last run:\n(nothing)')
  expect(m.role('clerk')!.memory).toBe('transfer Oct 12')
})

it('a failed run is recorded and pushed, not thrown', async () => {
  reply = {} as never // no brief: reading it throws inside the run
  await m.runRole('clerk')
  expect(m.page('clerk')!.runs[0].status).toBe('error')
  expect(pushes.at(-1)).toBeTruthy()
})
