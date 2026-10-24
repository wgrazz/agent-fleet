import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
  it('deleting a list moves its open ideas to Brain Dump', () => {
    m.createList('Temp')
    const id = m.addIdea('keep me', 'Temp')
    const list = m.lists().find(l => l.name === 'Temp')!
    m.deleteList(list.id)
    expect(m.idea(id)!.list).toBe('Brain Dump')
    expect(() => m.deleteList(m.lists().find(l => l.name === 'Priority')!.id)).toThrow()
  })
  it('renaming a list carries its ideas', () => {
    m.createList('Old')
    const id = m.addIdea('x', 'Old')
    m.updateList(m.lists().find(l => l.name === 'Old')!.id, { name: 'New' })
    expect(m.idea(id)!.list).toBe('New')
  })
})
