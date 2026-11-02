// Prep: the chief merges duplicates on its own (Unmerge sticks), picks notes to prep, and a prep's card carries your
// answers into the prompt Start sends.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-prep-'))
const inputs: string[] = []
const replies: Record<string, unknown> = {}
vi.mock('../server/ai.ts', () => ({
  askFull: async (task: string, _s: string, _schema: unknown, o: { feature: string }) => { inputs.push(task); return { value: replies[o.feature], session_id: 'sess-1', cost: 0.1 } },
}))
vi.mock('../server/push.ts', () => ({ pushAll: async () => {} }))
const prep = await import('../server/prep.ts')
const desks = await import('../server/desks.ts')
const ideas = await import('../server/ideas.ts')
const { db, REPO } = await import('../server/store.ts')

const cardOf = (type: string) => db.prepare("SELECT * FROM role_items WHERE json_extract(data, '$.type') = ? ORDER BY id DESC").get(type) as { id: number; status: string; data: string }

it('merges on its own, Unmerge puts them back for good, and picks skip what was merged away', async () => {
  const a = ideas.addIdea('live activity while shopping'), b = ideas.addIdea('start a live activity when I shop'), c = ideas.addIdea('add a /health route')
  ideas.addIdea('step one', 'Errands')
  db.prepare("UPDATE lists SET kind = 'checklist' WHERE name = 'Errands'").run()
  replies['prep:pick'] = { merges: [{ ids: [a, b], keep: a, text: 'Live Activity while shopping', why: 'same' }], picks: [{ id: b, cwd: '/x', why: '' }, { id: c, cwd: '/nope', why: 'small' }] }
  const picks = await prep.mergeAndPick('chief', 1)
  expect(inputs.at(-1)).not.toMatch(/step one/)
  expect(picks).toEqual([{ id: c, cwd: REPO, why: 'small' }]) // b was merged into a; an unknown folder falls back
  expect(ideas.idea(b)!.done).toBe(1)
  expect(ideas.idea(a)!.text).toBe('Live Activity while shopping')
  const merge = cardOf('merge')
  expect(merge.status).toBe('done')
  desks.act(merge.id, 'undo')
  expect(cardOf('merge').status).toBe('dismissed')
  expect(ideas.idea(b)!.done).toBe(0)
  expect(ideas.idea(a)!.text).toBe('live activity while shopping')
  await prep.mergeAndPick('chief', 2) // the same merge again is refused
  expect(inputs.at(-1)).toMatch(new RegExp(`${a} \\+ ${b}`))
  expect(ideas.idea(b)!.done).toBe(0)
})

it('a prep becomes a card; answers go into the Start prompt, and a started note is not picked again', async () => {
  const id = ideas.addIdea('add a /health route')
  replies.prep = { summary: 'Adds a health check.', plan: ['Add the route'], size: 'small', questions: [{ text: 'JSON or plain text?', options: ['JSON', 'Plain'], recommended: 0 }] }
  const card = (await prep.prepOne('chief', null, id, REPO))!
  const p = () => JSON.parse(cardOf('prep').data) as import('../server/desks.ts').Proposal
  expect(p()).toMatchObject({ session_id: 'sess-1', cwd: REPO, plan: ['Add the route'] })
  expect(prep.startPrompt(p())).toMatch(/Ask what you still need/)
  desks.act(card, 'answer', { index: 0, answer: 'JSON' })
  expect(prep.startPrompt(p())).toMatch(/JSON or plain text\? → JSON[\s\S]*wait for his OK[\s\S]*fleet done \d+/)
  expect(() => desks.act(card, 'answer', { index: 3, answer: 'x' })).toThrow(/no such question/)
  expect(prep.homeList().map(r => r.idea)).toContain(id)
  desks.act(card, 'started', { agent: 'health' })
  expect(prep.homeList().map(r => r.idea)).not.toContain(id) // started, no receipt yet
  replies['prep:pick'] = { merges: [], picks: [{ id, cwd: REPO, why: '' }] }
  expect(await prep.mergeAndPick('chief', 3)).toEqual([])
  expect(inputs.at(-1)).not.toMatch(new RegExp(`^${id} ·`, 'm'))
})
