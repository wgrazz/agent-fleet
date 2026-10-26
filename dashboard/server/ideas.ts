// Ideas: checklist lists (Priority, Brain Dump, then yours), recurring items, and Brain Dump sorting suggestions.
import { AREAS } from '../web/src/areas.ts'
import { rankIdeas, sortIdeas } from './ai.ts'
import { db } from './store.ts'

export type List = { id: number; name: string; color: string; position: number; archived: number; kind: string; section: string | null; open: number; done: number; unsorted?: number }
export type Idea = {
  id: number; list: string; text: string; notes: string; done: number; done_at: number | null; created_at: number
  position: number | null; repeat: string | null; next_due: number | null; agent: string | null; source: string | null
  suggestion: string | null; suggestion_conf: number | null; priority: number; why: string | null; area: string | null
}

const now = () => Math.floor(Date.now() / 1000)
// Brain Dump is the inbox everything else falls back to, so it can't be renamed or deleted
export const PINNED = ['Brain Dump']
export const KINDS = ['ideas', 'checklist']
export const SECTIONS = ['More']
// in a checklist, a step written "## Something" is a heading: shown as one, never counted or ranked
const STEP = "i.text NOT LIKE '## %'"

// ---------- recurring ----------

// repeat rules: "daily" | "weekly:<0-6, Sunday = 0>" | "monthly:<1-31>" | "every:<days>"
export const REPEAT = /^(daily|weekly:[0-6]|monthly:([1-9]|[12]\d|3[01])|every:([1-9]\d{0,2}))$/

export function nextDue(rule: string, fromS: number): number {
  const d = new Date(fromS * 1000)
  d.setHours(0, 0, 0, 0)
  const [kind, arg] = rule.split(':')
  const n = Number(arg)
  if (kind === 'daily') d.setDate(d.getDate() + 1)
  if (kind === 'every') d.setDate(d.getDate() + n)
  if (kind === 'weekly') d.setDate(d.getDate() + (((n - d.getDay() + 7) % 7) || 7))
  if (kind === 'monthly') {
    d.setMonth(d.getMonth() + (d.getDate() >= n ? 1 : 0))
    d.setDate(Math.min(n, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())) // the 31st in a 30-day month → the 30th
  }
  return Math.floor(d.getTime() / 1000)
}

/** Checked repeating items whose next date has arrived come back unchecked. */
function reopenDue() {
  db.prepare('UPDATE ideas SET done = 0, done_at = NULL, next_due = NULL WHERE done = 1 AND repeat IS NOT NULL AND next_due <= ?').run(now())
}

// ---------- lists ----------

export function lists(): List[] {
  reopenDue()
  const rows = db.prepare(`SELECT l.*, coalesce(sum(i.done = 0 AND ${STEP}), 0) AS open, coalesce(sum(i.done = 1 AND ${STEP}), 0) AS done,
      coalesce(sum(i.done = 0 AND l.name = 'Brain Dump' AND i.suggestion IS NULL), 0) AS unsorted
    FROM lists l LEFT JOIN ideas i ON i.list = l.name WHERE l.archived = 0 GROUP BY l.id ORDER BY l.position, l.id`).all() as List[]
  return rows
}

export function createList(name: string, color?: string, kind = 'ideas') {
  if (!KINDS.includes(kind)) throw new Error('kind: ideas or checklist')
  const pos = (db.prepare('SELECT coalesce(max(position), 0) + 1 AS p FROM lists').get() as { p: number }).p
  db.prepare('INSERT INTO lists (name, color, position, kind) VALUES (?, ?, ?, ?)').run(name, color ?? '#8e8e93', pos, kind)
}

export function updateList(id: number, patch: { name?: string; color?: string; position?: number; archived?: boolean; kind?: string; section?: string | null }) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as List | undefined
  if (!list) throw new Error('no such list')
  if (patch.name !== undefined && patch.name !== list.name) {
    if (PINNED.includes(list.name)) throw new Error(`${list.name} can't be renamed`)
    db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(patch.name, id)
    db.prepare('UPDATE ideas SET list = ? WHERE list = ?').run(patch.name, list.name)
    db.prepare('UPDATE ideas SET suggestion = ? WHERE suggestion = ?').run(patch.name, list.name)
  }
  if (patch.kind !== undefined || patch.section !== undefined) {
    if (PINNED.includes(list.name)) throw new Error(`${list.name} stays where it is`)
    if (patch.kind !== undefined && !KINDS.includes(patch.kind)) throw new Error('kind: ideas or checklist')
    if (patch.section && !SECTIONS.includes(patch.section)) throw new Error('section: More or none')
    if (patch.kind !== undefined) db.prepare('UPDATE lists SET kind = ? WHERE id = ?').run(patch.kind, id)
    if (patch.section !== undefined) db.prepare('UPDATE lists SET section = ? WHERE id = ?').run(patch.section, id)
  }
  if (patch.color) db.prepare('UPDATE lists SET color = ? WHERE id = ?').run(patch.color, id)
  if (patch.position !== undefined) db.prepare('UPDATE lists SET position = ? WHERE id = ?').run(patch.position, id)
  if (patch.archived !== undefined) {
    if (PINNED.includes(list.name)) throw new Error(`${list.name} can't be archived`)
    db.prepare('UPDATE lists SET archived = ? WHERE id = ?').run(patch.archived ? 1 : 0, id)
  }
}

/** Deleting a list never deletes its ideas: open ones move to Brain Dump, done ones go with the list. */
export function deleteList(id: number) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as List | undefined
  if (!list) return
  if (PINNED.includes(list.name)) throw new Error(`${list.name} can't be deleted`)
  db.prepare("UPDATE ideas SET list = 'Brain Dump', suggestion = NULL WHERE list = ? AND done = 0").run(list.name)
  db.prepare('DELETE FROM ideas WHERE list = ? AND done = 1').run(list.name)
  db.prepare('DELETE FROM lists WHERE id = ?').run(id)
}

export const ensureList = (name: string, kind = 'ideas') => db.prepare('INSERT OR IGNORE INTO lists (name, position, kind) VALUES (?, 100, ?)').run(name, kind)

// ---------- items ----------

export function ideas(list?: string): Idea[] {
  reopenDue()
  const sql = `SELECT * FROM ideas ${list ? 'WHERE list = ?' : ''} ORDER BY done, coalesce(position, id), id`
  return (list ? db.prepare(sql).all(list) : db.prepare(sql).all()) as Idea[]
}

export const idea = (id: number) => db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as Idea | undefined

const checkArea = (area: string | null) => {
  if (area !== null && !AREAS.some(a => a.name === area)) throw new Error(`area: one of ${AREAS.map(a => a.name).join(', ')}`)
}

export function addIdea(text: string, list = 'Brain Dump', extra: { source?: string; done?: boolean; notes?: string; agent?: string; area?: string } = {}) {
  checkArea(extra.area ?? null)
  ensureList(list)
  const pos = (db.prepare('SELECT coalesce(max(position), max(id), 0) + 1 AS p FROM ideas WHERE list = ?').get(list) as { p: number }).p
  const r = db.prepare('INSERT INTO ideas (list, text, created_at, position, source, done, done_at, notes, agent, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(list, text, now(), pos, extra.source ?? null, extra.done ? 1 : 0, extra.done ? now() : null, extra.notes ?? '', extra.agent ?? null, extra.area ?? null)
  return Number(r.lastInsertRowid)
}

export function updateIdea(id: number, p: Partial<Pick<Idea, 'text' | 'notes' | 'list' | 'repeat' | 'position' | 'agent' | 'priority' | 'area'>> & { done?: boolean; clearSuggestion?: boolean }) {
  const cur = idea(id)
  if (!cur) throw new Error('no such idea')
  if (p.area !== undefined) {
    checkArea(p.area)
    db.prepare('UPDATE ideas SET area = ? WHERE id = ?').run(p.area, id)
  }
  if (p.text !== undefined) db.prepare('UPDATE ideas SET text = ? WHERE id = ?').run(p.text, id)
  if (p.notes !== undefined) db.prepare('UPDATE ideas SET notes = ? WHERE id = ?').run(p.notes, id)
  if (p.list !== undefined && p.list !== cur.list) {
    ensureList(p.list)
    db.prepare('UPDATE ideas SET list = ?, suggestion = NULL, suggestion_conf = NULL, position = NULL WHERE id = ?').run(p.list, id)
  }
  if (p.repeat !== undefined) {
    if (p.repeat !== null && !REPEAT.test(p.repeat)) throw new Error('repeat: daily, weekly:0-6, monthly:1-31 or every:N')
    db.prepare('UPDATE ideas SET repeat = ?, next_due = NULL WHERE id = ?').run(p.repeat, id)
  }
  if (p.position !== undefined) db.prepare('UPDATE ideas SET position = ? WHERE id = ?').run(p.position, id)
  if (p.agent !== undefined) db.prepare('UPDATE ideas SET agent = ? WHERE id = ?').run(p.agent, id)
  if (p.priority !== undefined) db.prepare('UPDATE ideas SET priority = ?, why = NULL WHERE id = ?').run(Math.max(0, Math.min(3, Math.round(p.priority))), id)
  if (p.clearSuggestion) db.prepare('UPDATE ideas SET suggestion = NULL, suggestion_conf = NULL WHERE id = ?').run(id)
  if (p.done !== undefined) {
    const repeat = (idea(id) as Idea).repeat
    db.prepare('UPDATE ideas SET done = ?, done_at = ?, next_due = ? WHERE id = ?')
      .run(p.done ? 1 : 0, p.done ? now() : null, p.done && repeat ? nextDue(repeat, now()) : null, id)
  }
  return idea(id)
}

export const deleteIdea = (id: number) => db.prepare('DELETE FROM ideas WHERE id = ?').run(id)

// ---------- undo: Jarvis's changes ----------

/** Record an idea as it was just before Jarvis changes it (null when Jarvis just added it). */
export function logChange(turn: number, ideaId: number, before: Idea | null) {
  db.prepare('INSERT INTO idea_history (turn, idea_id, before, at) VALUES (?, ?, ?, ?)').run(turn, ideaId, before ? JSON.stringify(before) : null, now())
}

export const changedIn = (turn: number) => !!db.prepare('SELECT 1 FROM idea_history WHERE turn = ? AND undone = 0').get(turn)

/** Put back everything one Jarvis turn changed (the latest one by default). Returns how many ideas it touched. */
export function undoTurn(turn?: number) {
  const t = turn ?? (db.prepare('SELECT max(turn) AS t FROM idea_history WHERE undone = 0').get() as { t: number | null }).t
  if (!t) return 0
  const rows = db.prepare('SELECT * FROM idea_history WHERE turn = ? AND undone = 0 ORDER BY id DESC').all(t) as { idea_id: number; before: string | null }[]
  for (const r of rows) {
    if (!r.before) { deleteIdea(r.idea_id); continue }
    const was = JSON.parse(r.before) as Record<string, string | number | null>
    ensureList(String(was.list))
    const cols = Object.keys(was)
    db.prepare(`INSERT OR REPLACE INTO ideas (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => was[c]))
  }
  db.prepare('UPDATE idea_history SET undone = 1 WHERE turn = ?').run(t)
  return rows.length
}

// ---------- sorting ----------

/** Ask Claude where each unsorted Brain Dump note belongs; list suggestions are stored on the items, never applied.
 *  The area is just a tag you can change, so it's filled in when the note has none. */
export async function suggestSorting(limit = 40) {
  const pending = db.prepare("SELECT id, text FROM ideas WHERE list = 'Brain Dump' AND done = 0 AND suggestion IS NULL ORDER BY id LIMIT ?").all(limit) as { id: number; text: string }[]
  if (!pending.length) return 0
  const targets = lists().filter(l => l.name !== 'Brain Dump' && l.kind !== 'checklist').map(l => ({
    name: l.name,
    examples: (db.prepare('SELECT text FROM ideas WHERE list = ? ORDER BY done, id DESC LIMIT 3').all(l.name) as { text: string }[]).map(r => r.text),
  }))
  const { suggestions } = await sortIdeas(pending, targets)
  const set = db.prepare("UPDATE ideas SET suggestion = ?, suggestion_conf = ?, area = coalesce(area, ?) WHERE id = ? AND list = 'Brain Dump'")
  for (const s of suggestions) if (pending.some(p => p.id === s.id)) set.run(s.list, Math.max(0, Math.min(1, s.confidence)), AREAS.some(a => a.name === s.area) ? s.area : null, s.id)
  return suggestions.length
}

// ---------- priorities ----------

export const prioritized = () => {
  reopenDue()
  return db.prepare('SELECT * FROM ideas WHERE done = 0 AND priority > 0 ORDER BY priority DESC, coalesce(position, id), id').all() as Idea[]
}

/** Claude reads every open idea (and what your agents are doing) and sets a priority with a one-line reason. */
export async function rankAll(context: string) {
  // checklist steps are done in order, not ranked
  const open = db.prepare(`SELECT id, list, text, priority FROM ideas i WHERE done = 0 AND ${STEP}
    AND list NOT IN (SELECT name FROM lists WHERE kind = 'checklist') ORDER BY id DESC LIMIT 200`).all() as { id: number; list: string; text: string; priority: number }[]
  if (!open.length) return { summary: 'You have no open ideas to rank.', next: [] as Idea[], counts: [0, 0, 0] }
  const r = await rankIdeas(open, context)
  const set = db.prepare('UPDATE ideas SET priority = ?, why = ? WHERE id = ? AND done = 0')
  const ids = new Set(open.map(o => o.id))
  for (const x of r.ranked) if (ids.has(x.id)) set.run(Math.max(0, Math.min(3, x.priority)), x.reason.slice(0, 200), x.id)
  const next = r.next.filter(id => ids.has(id)).slice(0, 5).map(id => idea(id)!).filter(Boolean)
  const counts = [3, 2, 1].map(p => r.ranked.filter(x => x.priority === p).length)
  return { summary: r.summary, next, counts }
}
