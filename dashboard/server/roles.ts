// Team: roles are scheduled headless Claude runs (a chief of staff, a clerk…) on your own subscription.
// A role only reads and answers in JSON; this file does every write: its tasks and questions for you, its memory,
// and a phone push. Files change only with the write tool, and only inside the role's write_dir.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { askFull } from './ai.ts'
import { DESKS, notesFor } from './desks.ts'
import { nextDue, REPEAT, suggestSorting } from './ideas.ts'
import { pushAll } from './push.ts'
import { db } from './store.ts'

export type Role = {
  name: string; title: string; prompt: string; schedule: string; at: string; model: string; budget: number
  see: string; areas: string; tools: string; cwd: string; write_dir: string; git_commit: number; memory: string
  enabled: number; next_run: number | null; created_at: number; kind: string; board: string
}
export type Item = { id: number; role: string; run_id: number | null; kind: string; text: string; detail: string; answer: string; data: string; status: string; seen: number; created_at: number; closed_at: number | null }
export type Run = { id: number; role: string; started_at: number; finished_at: number | null; status: string; brief: string; error: string; cost: number }
type Out = { brief: string; tasks: { text: string; detail: string }[]; questions: { text: string; detail: string }[]; memory: string } & Record<string, any>

const now = () => Math.floor(Date.now() / 1000)
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
export const SCHEDULE = new RegExp(`^$|^hours:([1-9]|1\\d|2[0-4])$|${REPEAT.source}`)
export const AT = /^([01]\d|2[0-3]):[0-5]\d$/
export const MODELS = ['haiku', 'sonnet', 'opus']
const TOOLS: Record<string, string[]> = { read: ['Read', 'Glob', 'Grep'], web: ['WebSearch', 'WebFetch'], write: ['Write', 'Edit'] }
const running = new Set<string>()

// columns added after Team first shipped
const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name))
if (!cols('roles').has('kind')) db.exec("ALTER TABLE roles ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom'")
if (!cols('roles').has('board')) db.exec("ALTER TABLE roles ADD COLUMN board TEXT NOT NULL DEFAULT ''")
if (!cols('role_items').has('data')) db.exec("ALTER TABLE role_items ADD COLUMN data TEXT NOT NULL DEFAULT ''")

/** When a role next runs: today at its time if the rule allows today and that's still ahead, else the rule's next day. */
export function nextRun(schedule: string, at: string, fromS: number): number | null {
  if (!schedule) return null
  if (schedule.startsWith('hours:')) return fromS + Number(schedule.slice(6)) * 3600
  const [h, m] = at.split(':').map(Number)
  const today = new Date(fromS * 1000)
  today.setHours(h, m, 0, 0)
  const [kind, arg] = schedule.split(':')
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const fits = kind === 'daily' || (kind === 'weekly' && today.getDay() === Number(arg)) || (kind === 'monthly' && today.getDate() === Math.min(Number(arg), lastDay))
  if (fits && today.getTime() / 1000 > fromS) return Math.floor(today.getTime() / 1000)
  const d = new Date(nextDue(schedule, fromS) * 1000)
  d.setHours(h, m, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

// ---------- reading ----------

export const role = (name: string) => db.prepare('SELECT * FROM roles WHERE name = ?').get(name) as Role | undefined

export function roles() {
  return (db.prepare(`SELECT r.*,
      (SELECT count(*) FROM role_items WHERE role = r.name AND status = 'open' AND kind = 'question') AS questions,
      (SELECT count(*) FROM role_items WHERE role = r.name AND status = 'open' AND kind = 'task') AS tasks,
      (SELECT count(*) FROM role_items WHERE role = r.name AND status = 'open' AND kind = 'proposal') AS cards
    FROM roles r ORDER BY r.created_at`).all() as (Role & { questions: number; tasks: number; cards: number })[])
    .map(r => ({ ...r, running: running.has(r.name), last: lastRun(r.name) ?? null }))
}

const lastRun = (name: string) => db.prepare('SELECT * FROM role_runs WHERE role = ? ORDER BY id DESC LIMIT 1').get(name) as Run | undefined

/** One role's page: the role, everything open, the last 30 closed items, and the last 20 runs. */
export function page(name: string) {
  const r = roles().find(x => x.name === name)
  if (!r) return null
  const items = db.prepare(`SELECT * FROM (SELECT * FROM role_items WHERE role = ? AND status = 'open')
    UNION ALL SELECT * FROM (SELECT * FROM role_items WHERE role = ? AND status != 'open' ORDER BY coalesce(closed_at, created_at) DESC LIMIT 30)`).all(name, name) as Item[]
  const runs = db.prepare('SELECT * FROM role_runs WHERE role = ? ORDER BY id DESC LIMIT 20').all(name) as Run[]
  return { role: r, items, runs, notes: notesFor(items) }
}

/** Files in the folder a role writes, newest first: its drafts and status pages. */
export function files(name: string) {
  const r = role(name)
  if (!r?.cwd || !r.write_dir) return []
  const dir = join(r.cwd, r.write_dir)
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).filter(f => !f.split('/').some(p => p.startsWith('.')))
      .map(f => ({ path: join(r.write_dir, f), mtime: Math.floor(statSync(join(dir, f)).mtimeMs / 1000), file: statSync(join(dir, f)).isFile() }))
      .filter(f => f.file).map(({ path, mtime }) => ({ path, mtime })).sort((a, b) => b.mtime - a.mtime).slice(0, 100)
  } catch { return [] }
}

// ---------- changing ----------

export function saveRole(name: string, p: Partial<Role>) {
  if (!NAME.test(name)) throw new Error('name: lowercase letters, digits and dashes, up to 40')
  const cur = role(name)
  const r = { ...(cur ?? { kind: 'custom', board: '', title: name, prompt: '', schedule: '', at: '07:00', model: 'sonnet', budget: 1, see: 'ideas,agents', areas: '', tools: '', cwd: '', write_dir: '', git_commit: 0, memory: '', enabled: 1 }), ...p }
  if (!r.title.trim()) throw new Error('title: required')
  if (!DESKS[r.kind]) throw new Error(`kind: one of ${Object.keys(DESKS).join(', ')}`)
  if (!SCHEDULE.test(r.schedule)) throw new Error('schedule: daily, weekly:<0-6>, monthly:<1-31>, every:<days>, hours:<1-24>, or empty')
  if (!AT.test(r.at)) throw new Error('at: HH:MM')
  if (!MODELS.includes(r.model)) throw new Error(`model: one of ${MODELS.join(', ')}`)
  if (!(r.budget > 0 && r.budget <= 20)) throw new Error('budget: more than 0, at most 20 dollars a run')
  if (r.tools.split(',').some(t => t && !TOOLS[t])) throw new Error('tools: read, web, write')
  if (r.tools.includes('write') && (!r.write_dir || r.write_dir.startsWith('/') || r.write_dir.split('/').includes('..')))
    throw new Error('write_dir: a folder inside the working folder, needed for the write tool')
  if (r.tools.includes('write') && !r.cwd) throw new Error('cwd: the working folder, needed for the write tool')
  const next = r.enabled ? nextRun(r.schedule, r.at, now()) : null
  db.prepare(`INSERT INTO roles (name, title, prompt, schedule, at, model, budget, see, areas, tools, cwd, write_dir, git_commit, memory, enabled, next_run, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, title = excluded.title, prompt = excluded.prompt,
    schedule = excluded.schedule, at = excluded.at, model = excluded.model, budget = excluded.budget, see = excluded.see, areas = excluded.areas,
    tools = excluded.tools, cwd = excluded.cwd, write_dir = excluded.write_dir, git_commit = excluded.git_commit, memory = excluded.memory,
    enabled = excluded.enabled, next_run = excluded.next_run`)
    .run(name, r.title.trim(), r.prompt, r.schedule, r.at, r.model, r.budget, r.see, r.areas, r.tools, r.cwd, r.write_dir, r.git_commit ? 1 : 0, r.memory, r.enabled ? 1 : 0, next, cur?.created_at ?? now(), r.kind)
  return role(name)!
}

export function deleteRole(name: string) {
  for (const t of ['role_items', 'role_runs']) db.prepare(`DELETE FROM ${t} WHERE role = ?`).run(name)
  db.prepare('DELETE FROM roles WHERE name = ?').run(name)
}

export const message = (name: string, text: string) =>
  Number(db.prepare("INSERT INTO role_items (role, kind, text, created_at) VALUES (?, 'message', ?, ?)").run(name, text, now()).lastInsertRowid)

/** Answer a question, check off or dismiss a task, or reopen either. Any change is news the role reads next run. */
export function updateItem(id: number, p: { status?: string; answer?: string }) {
  const it = db.prepare('SELECT * FROM role_items WHERE id = ?').get(id) as Item | undefined
  if (!it) throw new Error('no such item')
  const status = p.answer?.trim() ? 'answered' : p.status ?? it.status
  if (!['open', 'done', 'dismissed', 'answered'].includes(status)) throw new Error('status: open, done, dismissed or answered')
  db.prepare('UPDATE role_items SET status = ?, answer = ?, seen = 0, closed_at = ? WHERE id = ?')
    .run(status, p.answer?.trim() ?? it.answer, status === 'open' ? null : now(), id)
}

// ---------- running ----------

const BASE = {
  brief: { type: 'string' }, memory: { type: 'string' },
  ...Object.fromEntries(['tasks', 'questions'].map(k => [k, { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'detail'], properties: { text: { type: 'string' }, detail: { type: 'string' } } } }])),
}
const outSchema = (kind: string) => {
  const properties = { ...BASE, ...DESKS[kind].schema }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
}

const CONTRACT = `

--- How you work in Fleet ---
You are one of the owner's scheduled assistants in Fleet, their dashboard for AI agents. You run on a schedule; between
runs the owner reads your page in Fleet's Team tab, answers your questions and checks off your tasks there.
Your input has today's date, your memory from your last run, what the owner sent you since (messages, answers, tasks
they finished or dismissed), your tasks and questions still open, and the context you're allowed to see.
Answer with:
- brief: at most 350 characters, sent as a phone notification. The single most useful thing to know. No greeting.
- tasks: new things for the owner to do. text: one short line. detail: a few sentences of how or why, or "".
- questions: what you need the owner to answer. text: the question. detail: why you need it, or "".
- memory: your notes for your next run, replacing the old ones: answers you got, decisions, what you already
  suggested and how it went. At most 2000 characters.
Never repeat an open task or question. Fewer, sharper items beat filler; empty lists are fine.`

function fleetItems(areas: string) {
  const list = areas.split(',').map(a => a.trim()).filter(Boolean)
  const only = list.length ? `AND (i.area IN (${list.map(() => '?').join(', ')}) OR l.kind = 'checklist')` : ''
  const rows = db.prepare(`SELECT i.id, i.list, coalesce(l.kind, 'ideas') AS kind, coalesce(i.area, '') AS area, i.priority,
      date(i.created_at, 'unixepoch') AS created, replace(substr(i.text, 1, 300), char(10), ' ') AS text,
      replace(substr(i.notes, 1, 300), char(10), ' ') AS notes
    FROM ideas i LEFT JOIN lists l ON l.name = i.list
    WHERE i.done = 0 AND coalesce(l.archived, 0) = 0 ${only} ORDER BY i.list, coalesce(i.position, i.id), i.id`).all(...list) as Record<string, unknown>[]
  return 'id\tlist\tkind\tarea\tpriority\tcreated\ttext\tnotes\n' + rows.map(r => Object.values(r).join('\t')).join('\n')
}

function input(r: Role, news: Item[], open: Item[], agents: string) {
  const said = news.map(i => i.kind === 'message' ? `- Message: ${i.text}` : i.kind === 'question' ? `- Answer to "${i.text}": ${i.answer}`
    : i.kind === 'proposal' ? `- ${i.status === 'done' ? 'Accepted' : i.status === 'dismissed' ? 'Rejected (don\'t suggest again)' : 'Undid'}: ${i.text}`
    : `- ${i.status === 'done' ? 'Done' : i.status === 'dismissed' ? 'Dismissed (not wanted)' : 'Reopened'}: ${i.text}`)
  const see = r.see.split(',')
  return [
    `Today is ${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}.`,
    `Your memory from your last run:\n${r.memory || '(empty: this is your first run)'}`,
    `From the owner since your last run:\n${said.join('\n') || '(nothing)'}`,
    `Your open tasks, questions and cards (don't repeat these):\n${open.map(i => `- [${i.kind}] ${i.text}${i.data ? ` ${i.data}` : ''}`).join('\n') || '(none)'}`,
    ...(DESKS[r.kind].board ? [`Your board from last run (update it, then send all of it):\n${r.board || '(empty: first run)'}`] : []),
    ...(see.includes('agents') ? [`Agents running now:\n${agents || '(none)'}`] : []),
    ...(see.includes('ideas') ? [`Open items in Fleet:\n${fleetItems(r.areas)}`] : []),
  ].join('\n\n')
}

const git = promisify(execFile)
async function commit(r: Role) {
  const { stdout } = await git('git', ['status', '--porcelain', '--', r.write_dir], { cwd: r.cwd })
  if (!stdout.trim()) return
  await git('git', ['add', '--', r.write_dir], { cwd: r.cwd })
  await git('git', ['commit', '-q', '-m', `${r.title}: update ${new Date().toLocaleDateString('sv')}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`, '--', r.write_dir], { cwd: r.cwd })
}

/** Run a role now. Resolves when it's done; failures are recorded on the run and pushed, never thrown. */
export async function runRole(name: string, agents: () => string = () => '') {
  const r = role(name)
  if (!r) throw new Error(`no role named ${name}`)
  if (running.has(name)) throw new Error(`${r.title} is already running`)
  running.add(name)
  const runId = Number(db.prepare('INSERT INTO role_runs (role, started_at) VALUES (?, ?)').run(name, now()).lastInsertRowid)
  // the role's own items are born seen and any change of yours unsees them, so unseen = news. Read now, so
  // whatever you send mid-run is news next time.
  const news = db.prepare('SELECT * FROM role_items WHERE role = ? AND seen = 0 ORDER BY id').all(name) as Item[]
  const open = db.prepare("SELECT * FROM role_items WHERE role = ? AND status = 'open' AND kind != 'message' ORDER BY id").all(name) as Item[]
  const tools = r.tools.split(',').filter(Boolean).flatMap(t => TOOLS[t])
  try {
    if (r.see.split(',').includes('ideas') && !r.areas) await suggestSorting().catch(() => 0) // Fleet's Brain Dump sorter: suggestions only
    const a = await askFull<Out>(input(r, news, open, agents()), r.prompt + CONTRACT + DESKS[r.kind].contract, outSchema(r.kind), {
      tools, model: r.model, budgetUsd: r.budget, cwd: r.cwd || undefined, timeoutMs: 15 * 60_000, feature: `role:${name}`,
      allow: tools.map(t => (t === 'Write' || t === 'Edit') ? `${t}(${r.write_dir}/**)` : t),
      deny: tools.includes('Read') ? ['Read(**/.env*)'] : [],
    })
    const add = db.prepare('INSERT INTO role_items (role, run_id, kind, text, detail, seen, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    const out = a.value
    const fresh = (xs: { text: string; detail: string }[]) => xs.filter(x => x.text.trim()).slice(0, 10)
    db.exec('BEGIN')
    try {
      for (const t of fresh(out.tasks)) add.run(name, runId, 'task', t.text.trim().slice(0, 300), t.detail.slice(0, 3000), now())
      for (const q of fresh(out.questions)) add.run(name, runId, 'question', q.text.trim().slice(0, 300), q.detail.slice(0, 3000), now())
      for (const i of news) db.prepare('UPDATE role_items SET seen = 1 WHERE id = ?').run(i.id)
      db.prepare('UPDATE roles SET memory = ? WHERE name = ?').run(out.memory.slice(0, 4000), name)
      DESKS[r.kind].apply?.(name, runId, out)
      if (DESKS[r.kind].board) db.prepare('UPDATE roles SET board = ? WHERE name = ?').run(JSON.stringify(Object.fromEntries(Object.keys(DESKS[r.kind].schema).map(k => [k, out[k]]))), name)
      db.prepare("UPDATE role_runs SET status = 'ok', finished_at = ?, brief = ?, cost = ? WHERE id = ?").run(now(), out.brief.slice(0, 1000), a.cost, runId)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    if (r.git_commit && r.write_dir && r.cwd) await commit(r).catch(e => console.error(`${name}: commit failed:`, e.message))
    const cards = Array.isArray(out.today) ? out.today.length + out.tidy.length + out.handoffs.length : 0
    const counts = [[fresh(out.questions).length, 'question'], [fresh(out.tasks).length, 'task'], [cards, 'card']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
    await pushAll({ title: r.title, body: out.brief.slice(0, 600) + (counts.length ? `\n${counts.join(', ')} for you` : ''), url: `/#/team/${name}`, tag: `role-${name}` }).catch(() => {})
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500)
    db.prepare("UPDATE role_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(now(), msg, runId)
    await pushAll({ title: `${r.title} didn't finish`, body: msg, url: `/#/team/${name}`, tag: `role-${name}` }).catch(() => {})
  } finally {
    running.delete(name)
  }
}

/** Every minute: start each enabled role whose time has come. A run missed while the Mac slept happens on wake, once. */
export function due(agents: () => string) {
  for (const r of db.prepare('SELECT * FROM roles WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?').all(now()) as Role[]) {
    if (running.has(r.name)) continue
    db.prepare('UPDATE roles SET next_run = ? WHERE name = ?').run(nextRun(r.schedule, r.at, now()), r.name)
    runRole(r.name, agents).catch(e => console.error(`role ${r.name}:`, e))
  }
}
