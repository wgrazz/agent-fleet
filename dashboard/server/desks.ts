// Desks: what each kind of role hands back beyond its brief, and what the buttons on its page do.
// chief: picks for today, tidy-ups (merge or close notes) and agent hand-offs, each a card you accept or reject.
// clerk: a board (deadline calendar, paperwork in flight, questions for a CPA or lawyer, facts you told it) that it
// rewrites each run. custom: just the brief, tasks and questions every role has.
import * as ideas from './ideas.ts'
import { db } from './store.ts'

const now = () => Math.floor(Date.now() / 1000)
const str = { type: 'string' }, int = { type: 'integer' }
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const arr = (items: unknown) => ({ type: 'array', items })

export type Proposal = { type: 'today' | 'merge' | 'close' | 'handoff'; ids: number[]; keep?: number; text?: string; why: string; prompt?: string; turn?: number; agent?: string }
type Desk = { schema: Record<string, unknown>; contract: string; apply?: (role: string, runId: number, out: any) => void; board?: boolean }

const CHIEF_CONTRACT = `
Your desk (fill these; Fleet shows each as a card with buttons, so ids must be real open idea ids from the input):
- today: 1 to 3 picks, each { id, why }. why is one sentence. Yesterday's picks are replaced by these.
- tidy: notes to clean up, each { type, ids, keep, text, why }.
  type "merge": two or more ids that are the same thing; keep is the id to keep; text is better wording for the
  kept note that covers all of them, or "" to keep its wording. type "close": ids is one note that looks done or
  obsolete; keep 0, text "". Never repeat a tidy-up that is still open or that the owner rejected.
- handoffs: notes an AI coding agent could finish alone, each { id, prompt, why }. prompt is the complete first
  message for the agent: goal, where to look, what done looks like.
Leave tasks and questions empty unless something truly needs them. Don't write "#id" in any text; Fleet shows the notes.`

const CLERK_CONTRACT = `
Your desk (Fleet shows these as the clerk's board; send the whole board every run, updated from last run's board):
- deadlines: every obligation on your calendar, each { title, due, form, source, status, note }. due is YYYY-MM-DD,
  or "" when it depends on a fact you don't have. status: "upcoming", "needs_info" or "done". source: an official URL.
- inflight: paperwork underway, each { title, next_step, waiting_on }. waiting_on: who or what it waits for, or "".
- cpa: questions for a CPA or lawyer, each { question, why, answer }. Keep answer as the owner recorded it, else "".
- facts: what the owner has told you, each { fact, value }, e.g. { "Incorporation date", "2026-03-04" }.
questions are only for facts the owner knows (one fact each). tasks: drafts to review and deadlines within 45 days.
Never write Fleet note ids or your own codes (like Q-W1) in any text; name things in words.`

export const DESKS: Record<string, Desk> = {
  custom: { schema: {}, contract: '' },
  chief: {
    contract: CHIEF_CONTRACT,
    schema: {
      today: arr(obj({ id: int, why: str })),
      tidy: arr(obj({ type: { type: 'string', enum: ['merge', 'close'] }, ids: arr(int), keep: int, text: str, why: str })),
      handoffs: arr(obj({ id: int, prompt: str, why: str })),
    },
    apply: applyChief,
  },
  clerk: {
    contract: CLERK_CONTRACT, board: true,
    schema: {
      deadlines: arr(obj({ title: str, due: str, form: str, source: str, status: { type: 'string', enum: ['upcoming', 'needs_info', 'done'] }, note: str })),
      inflight: arr(obj({ title: str, next_step: str, waiting_on: str })),
      cpa: arr(obj({ question: str, why: str, answer: str })),
      facts: arr(obj({ fact: str, value: str })),
    },
  },
}

const openIdea = (id: number) => { const i = ideas.idea(id); return i && !i.done ? i : null }
const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function applyChief(role: string, runId: number, out: { today: { id: number; why: string }[]; tidy: { type: 'merge' | 'close'; ids: number[]; keep: number; text: string; why: string }[]; handoffs: { id: number; prompt: string; why: string }[] }) {
  // yesterday's picks give way to today's; that isn't news for the next run
  db.prepare("UPDATE role_items SET status = 'expired', closed_at = ?, seen = 1 WHERE role = ? AND kind = 'proposal' AND status = 'open' AND json_extract(data, '$.type') = 'today'").run(now(), role)
  // a card you rejected stays gone for two weeks even if the chief suggests it again
  const open = (db.prepare("SELECT data FROM role_items WHERE role = ? AND kind = 'proposal' AND (status = 'open' OR status = 'dismissed' AND closed_at > ?)")
    .all(role, now() - 14 * 86400) as { data: string }[]).map(r => JSON.parse(r.data) as Proposal)
  const key = (p: Pick<Proposal, 'type' | 'ids'>) => `${p.type}:${[...p.ids].sort().join(',')}`
  const have = new Set(open.map(key))
  const add = db.prepare("INSERT INTO role_items (role, run_id, kind, text, detail, data, seen, created_at) VALUES (?, ?, 'proposal', ?, ?, ?, 1, ?)")
  const put = (p: Proposal, text: string) => {
    if (have.has(key(p))) return
    have.add(key(p))
    add.run(role, runId, text, p.why.slice(0, 1000), JSON.stringify(p), now())
  }
  for (const t of out.today.slice(0, 3)) {
    const i = openIdea(t.id)
    if (i) put({ type: 'today', ids: [i.id], why: t.why }, `Today: ${clip(i.text)}`)
  }
  for (const t of out.tidy.slice(0, 6)) {
    const ids = [...new Set(t.ids)].filter(id => openIdea(id))
    if (t.type === 'merge' && ids.length >= 2) {
      const keep = ids.includes(t.keep) ? t.keep : ids[0]
      put({ type: 'merge', ids, keep, text: t.text.trim().slice(0, 2000), why: t.why }, `Merge ${ids.length} notes into "${clip(t.text.trim() || openIdea(keep)!.text)}"`)
    }
    if (t.type === 'close' && ids.length) put({ type: 'close', ids: [ids[0]], why: t.why }, `Close "${clip(openIdea(ids[0])!.text)}"`)
  }
  for (const h of out.handoffs.slice(0, 3)) {
    const i = openIdea(h.id)
    if (i && h.prompt.trim()) put({ type: 'handoff', ids: [i.id], prompt: h.prompt.trim().slice(0, 20_000), why: h.why }, `Hand to an agent: ${clip(i.text)}`)
  }
}

/** The notes a desk's cards point at, so the page shows their words, not numbers. */
export function notesFor(items: { kind: string; data: string }[]) {
  const ids = new Set(items.filter(i => i.kind === 'proposal' && i.data).flatMap(i => (JSON.parse(i.data) as Proposal).ids))
  return Object.fromEntries([...ids].map(id => ideas.idea(id)).filter(Boolean).map(i => [i!.id, { id: i!.id, text: i!.text, notes: i!.notes, list: i!.list, area: i!.area, done: i!.done }]))
}

/** A button on a chief card. Changes to notes go through idea history, so Undo puts them back exactly. */
export function act(itemId: number, action: string, o: { text?: string; keep?: number; agent?: string } = {}) {
  const it = db.prepare('SELECT * FROM role_items WHERE id = ?').get(itemId) as { status: string; data: string } | undefined
  if (!it?.data) throw new Error('no such card')
  const p = JSON.parse(it.data) as Proposal
  const close = (status: string, extra: Partial<Proposal> = {}) =>
    db.prepare('UPDATE role_items SET status = ?, seen = 0, closed_at = ?, data = ? WHERE id = ?').run(status, status === 'open' ? null : now(), JSON.stringify({ ...p, ...extra }), itemId)
  if (action === 'undo') {
    if (p.turn) ideas.undoTurn(p.turn)
    return close('open', { turn: undefined, agent: undefined })
  }
  if (it.status !== 'open') throw new Error('that card is already done')
  if (action === 'reject') return close('dismissed')
  if (p.type === 'handoff' && action === 'started') return close('done', { agent: String(o.agent ?? '').slice(0, 80) })
  const turn = Date.now()
  const change = (id: number, patch: Parameters<typeof ideas.updateIdea>[1]) => {
    const before = ideas.idea(id)
    if (!before) return
    ideas.logChange(turn, id, before)
    ideas.updateIdea(id, patch)
  }
  if ((p.type === 'today' || p.type === 'close') && action === 'accept') change(p.ids[0], { done: true })
  else if (p.type === 'merge' && action === 'accept') {
    const keep = o.keep && p.ids.includes(o.keep) ? o.keep : p.keep!
    const k = ideas.idea(keep)
    if (!k) throw new Error('that note is gone')
    const text = (o.text ?? p.text ?? '').trim() || k.text
    const others = p.ids.filter(id => id !== keep).map(id => ideas.idea(id)).filter(i => i && !i.done)
    change(keep, { text, notes: [k.notes, ...others.map(x => `Merged in: ${x!.text}${x!.notes ? `\n${x!.notes}` : ''}`)].filter(Boolean).join('\n\n') })
    for (const x of others) change(x!.id, { done: true, notes: [x!.notes, `Merged into: ${text}`].filter(Boolean).join('\n\n') })
    return close('done', { turn, keep, text })
  } else throw new Error(`can't ${action} this card`)
  close('done', { turn })
}

/** A button on the clerk's board: mark a deadline done, record a CPA's answer, or correct a fact. It tells the clerk too. */
export function boardAct(role: string, section: string, index: number, p: { status?: string; answer?: string; value?: string }) {
  const r = db.prepare('SELECT board FROM roles WHERE name = ?').get(role) as { board: string } | undefined
  const board = JSON.parse(r?.board || '{}') as Record<string, Record<string, string>[]>
  const row = board[section]?.[index]
  if (!row) throw new Error('no such row')
  let said = ''
  if (section === 'deadlines' && p.status && ['upcoming', 'done'].includes(p.status)) {
    row.status = p.status
    said = p.status === 'done' ? `Done (filed or paid): ${row.title}` : `Not done after all: ${row.title}`
  } else if (section === 'cpa' && typeof p.answer === 'string') {
    row.answer = p.answer.trim()
    said = `The CPA or lawyer's answer to "${row.question}": ${row.answer}`
  } else if (section === 'facts' && typeof p.value === 'string') {
    said = `Correction: ${row.fact} is ${p.value.trim()} (you had ${row.value})`
    row.value = p.value.trim()
  } else throw new Error('nothing to change')
  db.prepare('UPDATE roles SET board = ? WHERE name = ?').run(JSON.stringify(board), role)
  db.prepare("INSERT INTO role_items (role, kind, text, created_at) VALUES (?, 'message', ?, ?)").run(role, said.slice(0, 5000), now())
}
