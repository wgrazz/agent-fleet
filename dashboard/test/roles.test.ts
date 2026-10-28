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

it('the chief desk turns ids into cards; merging and closing change notes, and Undo puts them back', async () => {
  const ideas = await import('../server/ideas.ts')
  const desks = await import('../server/desks.ts')
  const a = ideas.addIdea('Sign up for Twilio', 'Do'), b = ideas.addIdea('Find out why Twilio rejected me', 'Do'), c = ideas.addIdea('Old thing', 'Do')
  m.saveRole('chief', { kind: 'chief', title: 'Chief of staff', see: '' })
  reply = { brief: 'Twilio first.', tasks: [], questions: [], memory: '', today: [{ id: b, why: 'blocks a' }, { id: 99999, why: 'made up' }],
    tidy: [{ type: 'merge', ids: [a, b], keep: b, text: 'Get Twilio approved and set up', why: 'same thing' }, { type: 'close', ids: [c], keep: 0, text: '', why: 'done' }],
    handoffs: [] }
  await m.runRole('chief')
  const page = m.page('chief')!
  const cards = page.items.filter(i => i.kind === 'proposal')
  expect(cards.map(i => JSON.parse(i.data).type)).toEqual(['today', 'merge', 'close']) // the made-up id is dropped
  expect(page.notes[a].text).toBe('Sign up for Twilio')
  const merge = cards[1]
  desks.act(merge.id, 'accept')
  expect([ideas.idea(b)!.text, ideas.idea(a)!.done]).toEqual(['Get Twilio approved and set up', 1])
  expect(ideas.idea(b)!.notes).toContain('Merged in: Sign up for Twilio')
  desks.act(merge.id, 'undo')
  expect([ideas.idea(b)!.text, ideas.idea(a)!.done]).toEqual(['Find out why Twilio rejected me', 0])
  desks.act(cards[2].id, 'reject')
  await m.runRole('chief') // the same merge again isn't filed twice; yesterday's pick expires
  expect(inputs.at(-1)).toContain('- Undid: Merge 2 notes')
  expect(inputs.at(-1)).toContain("- Rejected (don't suggest again): Close \"Old thing\"")
  const open = m.page('chief')!.items.filter(i => i.kind === 'proposal' && i.status === 'open').map(i => JSON.parse(i.data).type)
  expect(open.sort()).toEqual(['merge', 'today'])
})

it('the clerk desk keeps its board; marking a deadline done tells the clerk', async () => {
  const desks = await import('../server/desks.ts')
  m.saveRole('desk', { kind: 'clerk', title: 'Clerk', see: '' })
  const board = { deadlines: [{ title: 'S corp return', due: '2027-03-15', form: '1120-S', source: 'https://irs.gov', status: 'upcoming', note: '' }], inflight: [], cpa: [{ question: 'Gift tax?', why: '', answer: '' }], facts: [] }
  reply = { brief: 'ok', tasks: [], questions: [], memory: '', ...board }
  await m.runRole('desk')
  expect(JSON.parse(m.role('desk')!.board)).toEqual(board)
  desks.boardAct('desk', 'deadlines', 0, { status: 'done' })
  desks.boardAct('desk', 'cpa', 0, { answer: 'No, under the exclusion' })
  expect(JSON.parse(m.role('desk')!.board).deadlines[0].status).toBe('done')
  await m.runRole('desk')
  expect(inputs.at(-1)).toContain('- Message: Done (filed or paid): S corp return')
  expect(inputs.at(-1)).toContain('answer to "Gift tax?": No, under the exclusion')
  expect(inputs.at(-1)).toContain('Your board from last run')
})
