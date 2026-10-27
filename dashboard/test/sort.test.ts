// Sort tags every untagged open note with an area, but only suggests lists for Brain Dump; checklist steps are left alone.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-sort-'))
const asked: number[][] = []
vi.mock('../server/ai.ts', () => ({
  sortIdeas: async (items: { id: number }[]) => {
    asked.push(items.map(i => i.id))
    return { suggestions: items.map(i => ({ id: i.id, list: 'Do', confidence: 0.9, area: 'Growth' })) }
  },
}))
const m = await import('../server/ideas.ts')
const { notePrompt } = await import('../web/src/areas.ts')

it('tags notes in any list, suggests lists only for Brain Dump, skips checklists', async () => {
  m.createList('Do')
  m.createList('Steps', undefined, 'checklist')
  const inbox = m.addIdea('post on reddit')
  const filed = m.addIdea('landing page copy', 'Do')
  const kept = m.addIdea('already tagged', 'Do', { area: 'Company' })
  const step = m.addIdea('email the bank', 'Steps')
  await m.suggestSorting()
  expect(asked[0].sort()).toEqual([inbox, filed].sort())
  const get = (id: number) => m.idea(id)!
  expect([get(inbox).area, get(inbox).suggestion]).toEqual(['Growth', 'Do'])
  expect([get(filed).area, get(filed).suggestion, get(filed).list]).toEqual(['Growth', null, 'Do'])
  expect(get(kept).area).toBe('Company')
  expect(get(step).area).toBeNull()
  expect(notePrompt(get(filed))).toBe('landing page copy\n\n(From my "Do" list, area: Growth)')
})
