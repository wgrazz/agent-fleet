import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planSteps } from '../web/src/steps.ts'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-ideas-'))
const m = await import('../server/ideas.ts')

const at = (y: number, mo: number, d: number) => Math.floor(new Date(y, mo - 1, d, 15, 30).getTime() / 1000)
const day = (s: number) => { const d = new Date(s * 1000); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()] }

describe('nextDue', () => {
  it('daily, every N days', () => {
    expect(day(m.nextDue('daily', at(2026, 10, 23)))).toEqual([2026, 10, 24, 0])
    expect(day(m.nextDue('every:3', at(2026, 10, 30)))).toEqual([2026, 11, 2, 0])
  })
  it('weekly lands on the next such weekday, never today', () => {
    expect(day(m.nextDue('weekly:1', at(2026, 10, 23)))).toEqual([2026, 10, 26, 0]) // Fri → Mon
    expect(day(m.nextDue('weekly:5', at(2026, 10, 23)))).toEqual([2026, 10, 30, 0]) // Fri → next Fri
  })
  it('monthly, clamped to short months', () => {
    expect(day(m.nextDue('monthly:10', at(2026, 10, 23)))).toEqual([2026, 11, 10, 0])
    expect(day(m.nextDue('monthly:31', at(2026, 11, 2)))).toEqual([2026, 11, 30, 0])
    expect(day(m.nextDue('monthly:25', at(2026, 10, 23)))).toEqual([2026, 10, 25, 0])
  })
  it('rejects junk rules', () => {
    for (const bad of ['weekly:7', 'monthly:0', 'every:0', 'hourly']) expect(m.REPEAT.test(bad)).toBe(false)
  })
})

describe('ideas', () => {
  it('a repeating item comes back after its date', () => {
    const id = m.addIdea('Pay rent', 'Errands')
    m.updateIdea(id, { repeat: 'daily' })
    const done = m.updateIdea(id, { done: true })!
    expect(done.done).toBe(1)
    expect(done.next_due).toBeGreaterThan(Date.now() / 1000)
  })
  it('an area is one of AREAS or nothing', () => {
    const id = m.addIdea('Fix duplicate results', 'Build')
    expect(m.updateIdea(id, { area: 'Shopping · Search' })!.area).toBe('Shopping · Search')
    expect(m.updateIdea(id, { area: null })!.area).toBeNull()
    expect(() => m.updateIdea(id, { area: 'Gardening' })).toThrow(/area/)
    expect(m.idea(m.addIdea('Logo sketches', 'Create', { area: 'Brand & Design' }))!.area).toBe('Brand & Design')
    expect(() => m.addIdea('Weeding', 'Do', { area: 'Gardening' })).toThrow(/area/)
  })
  it('deleting a list moves its open ideas to Brain Dump', () => {
    m.createList('Temp')
    const id = m.addIdea('keep me', 'Temp')
    const list = m.lists().find(l => l.name === 'Temp')!
    m.deleteList(list.id)
    expect(m.idea(id)!.list).toBe('Brain Dump')
    expect(() => m.deleteList(m.lists().find(l => l.name === 'Brain Dump')!.id)).toThrow()
  })
  it('renaming a list carries its ideas', () => {
    m.createList('Old')
    const id = m.addIdea('x', 'Old')
    m.updateList(m.lists().find(l => l.name === 'Old')!.id, { name: 'New' })
    expect(m.idea(id)!.list).toBe('New')
  })
})

describe('undo', () => {
  it("puts back one Jarvis turn's changes: edits reverted, additions removed, deletions restored", () => {
    const keep = m.addIdea('buy milk', 'Brain Dump')
    const gone = m.addIdea('call mom', 'Brain Dump')
    const turn = Date.now()
    m.logChange(turn, keep, m.idea(keep)!)
    m.updateIdea(keep, { text: 'buy oat milk', list: 'Groceries', done: true })
    m.logChange(turn, gone, m.idea(gone)!)
    m.deleteIdea(gone)
    m.logChange(turn, m.addIdea('stray', 'Brain Dump'), null)
    expect(m.changedIn(turn)).toBe(true)
    expect(m.undoTurn()).toBe(3)
    expect(m.idea(keep)).toMatchObject({ text: 'buy milk', list: 'Brain Dump', done: 0 })
    expect(m.idea(gone)?.text).toBe('call mom')
    expect(m.ideas().some(i => i.text === 'stray')).toBe(false) // (its id may be the deleted one's again: SQLite reuses the top id)
    expect(m.undoTurn()).toBe(0) // nothing left to undo
  })
})

describe('planSteps', () => {
  it('top-level items are steps; sub-bullets and code under them are notes', () => {
    const r = planSteps([
      '## Vercel setup', '', 'Do these in order:', '',
      '1. **Add the env var** in Vercel', '   - name: `API_URL`', '   - all environments',
      '2. Redeploy:', '```', 'vercel --prod', '```', '',
      '3. Check the site', '', 'That should be it.',
    ].join('\n'))
    expect(r.title).toBe('Vercel setup')
    expect(r.steps).toEqual([
      { text: 'Add the env var in Vercel', notes: '- name: `API_URL`\n- all environments' },
      { text: 'Redeploy:', notes: '```\nvercel --prod\n```' },
      { text: 'Check the site', notes: '' },
    ])
  })
  it('checkboxes and plain bullets; headings split phases without becoming steps', () => {
    const r = planSteps('**Phase 1**\n- [ ] Buy the domain\n- [x] Point DNS\n\n**Phase 2**\n- Launch')
    expect(r.title).toBe('Phase 1')
    expect(r.steps.map(s => s.text)).toEqual(['Buy the domain', 'Point DNS', 'Launch'])
  })
  it('no list, no steps', () => expect(planSteps('All done, pushed as abc123.').steps).toEqual([]))
})
