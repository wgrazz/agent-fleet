// Prep: the chief of staff's follow-through on your notes. Before the chief's run, one call merges notes that say the
// same thing (on its own; Unmerge on the card puts them back for good) and picks up to 5 notes an agent could plan in
// one go, ones needing no answers from you first. After the run, a read-only Claude session reads the code for each
// pick and writes a plan, or the questions it needs answered. Its conversation is kept, so Start opens an agent that
// resumes it, already knowing everything it found. When that agent finishes, `fleet done` leaves a receipt on the card.
import { existsSync, statSync } from 'node:fs'
import { askFull } from './ai.ts'
import * as desks from './desks.ts'
import * as ideas from './ideas.ts'
import { pushAll } from './push.ts'
import { config, db, REPO } from './store.ts'

const now = () => Math.floor(Date.now() / 1000)
const str = { type: 'string' }, int = { type: 'integer' }
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const arr = (items: unknown) => ({ type: 'array', items })
const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
export const PER_RUN = 5

/** Where a prep's agent works: your workspace (Settings → default folder) or, for notes about Fleet, Fleet's repo. */
const roots = () => [...new Set([config.cwd, REPO].filter((d): d is string => !!d && existsSync(d) && statSync(d).isDirectory()))]
const folder = (cwd: string, area: string | null) => roots().includes(cwd) ? cwd : area === 'Fleet' ? REPO : roots()[0] ?? REPO

const cards = (where: string, ...args: (string | number)[]) =>
  (db.prepare(`SELECT id, role, status, data, closed_at FROM role_items WHERE kind = 'proposal' AND ${where}`).all(...args) as { id: number; role: string; status: string; data: string; closed_at: number | null }[])
    .map(c => ({ ...c, p: JSON.parse(c.data) as desks.Proposal }))

/** Notes worth looking at: open, not a checklist step, not already with an agent or a prep. */
function candidates() {
  // a prep you dismissed waits two weeks before it can be picked again, like the chief's rejected cards
  const prepped = new Set(cards("json_extract(data, '$.type') = 'prep' AND (status IN ('open', 'done') OR closed_at > ?)", now() - 14 * 86400).map(c => c.p.ids[0]))
  return (db.prepare(`SELECT i.id, i.list, coalesce(i.area, '') AS area, i.priority, replace(substr(i.text, 1, 400), char(10), ' ') AS text,
      replace(substr(i.notes, 1, 300), char(10), ' ') AS notes FROM ideas i LEFT JOIN lists l ON l.name = i.list
    WHERE i.done = 0 AND i.agent IS NULL AND i.text NOT LIKE '## %' AND coalesce(l.kind, 'ideas') = 'ideas' AND coalesce(l.archived, 0) = 0
    ORDER BY i.id`).all() as { id: number; list: string; area: string; priority: number; text: string; notes: string }[]).filter(i => !prepped.has(i.id))
}

const PICK_SYSTEM = `You help a solo founder get the notes in his Fleet lists moving. Notes are typed fast, often by voice; read past typos.
- merges: groups of two or more notes that say the same thing, so one agent would do them as one task. Be strict: related is
  not the same. Fleet merges these without asking (he can unmerge), so only when you're sure. keep: the id to keep. text: one
  wording that keeps every detail of all of them. Never merge a group listed as not the same.
- picks: up to {N} notes an AI coding agent could plan in one go from his code workspace and notes: a concrete change, fix,
  feature, doc or research question. Put notes it could plan with no questions for him first, best first; add ones that need a
  couple of answers only if there aren't {N} of those. Skip vague musings, personal errands, and anything that needs logins,
  payments, signatures or calls only he can make. For a merged group, pick the kept id. cwd: one of the folders listed (the one
  the work happens in). why: one plain sentence.`

type Picked = { merges: { ids: number[]; keep: number; text: string; why: string }[]; picks: { id: number; cwd: string; why: string }[] }

/** Merge duplicates (as done chief cards you can Unmerge) and choose what to prep. Returns the picks, best first. */
export async function mergeAndPick(role: string, runId: number, n = PER_RUN) {
  const pool = candidates()
  if (!pool.length) return []
  const notSame = cards("json_extract(data, '$.type') = 'merge' AND status = 'dismissed'").map(c => c.p.ids)
  const { value } = await askFull<Picked>(
    `Folders: ${roots().map(r => `${r}${r === REPO ? ' (Fleet itself)' : ''}`).join(', ')}\n\nNot the same (never merge these):\n${notSame.map(ids => ids.join(' + ')).join('\n') || '(none)'}\n\nOpen notes (id · list · area · priority · text · notes):\n${pool.map(i => `${i.id} · ${i.list} · ${i.area} · ${i.priority} · ${i.text}${i.notes ? ` · ${i.notes}` : ''}`).join('\n')}`,
    PICK_SYSTEM.replaceAll('{N}', String(n)),
    obj({ merges: arr(obj({ ids: arr(int), keep: int, text: str, why: str })), picks: arr(obj({ id: int, cwd: str, why: str })) }),
    { timeoutMs: 240_000, feature: 'prep:pick' })
  const inPool = new Set(pool.map(i => i.id))
  const rejected = new Set(notSame.map(ids => [...ids].sort().join(',')))
  const add = db.prepare("INSERT INTO role_items (role, run_id, kind, text, detail, data, seen, created_at) VALUES (?, ?, 'proposal', ?, ?, ?, 1, ?)")
  for (const g of (value.merges ?? []).slice(0, 8)) {
    const ids = [...new Set(g.ids)].filter(id => inPool.has(id) && !ideas.idea(id)?.done)
    if (ids.length < 2 || rejected.has([...ids].sort().join(','))) continue
    const keep = ids.includes(g.keep) ? g.keep : ids[0]
    const text = g.text.trim().slice(0, 2000) || ideas.idea(keep)!.text
    const p: desks.Proposal = { type: 'merge', ids, keep, text, why: g.why, auto: true }
    const id = Number(add.run(role, runId, `Merged ${ids.length} notes into "${clip(text)}"`, g.why.slice(0, 1000), JSON.stringify(p), now()).lastInsertRowid)
    desks.act(id, 'accept', { keep, text })
  }
  const open = (id: number) => inPool.has(id) && !ideas.idea(id)?.done // a pick merged away above is gone
  return (value.picks ?? []).filter(p => open(p.id)).slice(0, n).map(p => ({ ...p, cwd: folder(p.cwd, ideas.idea(p.id)!.area) }))
}

const PREP_SYSTEM = `You're getting one of the owner's notes ready for an AI coding agent. Read the code and docs it touches, enough to
know what the work really is, and follow the workspace's agent docs (AGENTS.md, CLAUDE.md) when you plan. You can only read
for now. Later the owner taps Start and this same conversation continues with every tool, so what you learn now carries over.
Answer with:
- summary: 2 to 4 plain sentences a non-technical reader follows: what this is, what you'd do, and what you need from him. If
  it's already done or not worth building, say so plainly. No file paths or jargon.
- plan: the steps you'd take, one short line each (files may be named). Empty if you can't plan until he answers.
- questions: only what you can't settle from the code or a sensible default, at most 4, each with 2 to 4 short options and
  the index of the one you recommend. Empty when the plan is ready.
- size: small (under an hour of agent time), medium or large.`

type Prepped = { summary: string; plan: string[]; questions: { text: string; options: string[]; recommended: number }[]; size: 'small' | 'medium' | 'large' }

/** One read-only Claude session on one note; its result becomes a Ready to start card on the chief's desk. */
export async function prepOne(role: string, runId: number | null, ideaId: number, cwd: string, model = 'sonnet') {
  const i = ideas.idea(ideaId)
  if (!i || i.done) return null
  const a = await askFull<Prepped>(`Note from the "${i.list}" list${i.area ? ` (area: ${i.area})` : ''}:\n<note>\n${i.text}${i.notes ? `\n\n${i.notes}` : ''}\n</note>`,
    PREP_SYSTEM, obj({
      summary: str, plan: arr(str), size: { type: 'string', enum: ['small', 'medium', 'large'] },
      questions: arr(obj({ text: str, options: arr(str), recommended: int })),
    }), { tools: ['Read', 'Glob', 'Grep'], deny: ['Read(**/.env*)'], cwd, model, budgetUsd: 2, persist: true, timeoutMs: 15 * 60_000, feature: 'prep' })
  const v = a.value
  const p: desks.Proposal = {
    type: 'prep', ids: [i.id], why: v.summary, session_id: a.session_id, cwd, size: v.size, answers: {},
    plan: v.plan.slice(0, 20).map(s => s.slice(0, 500)),
    questions: v.questions.slice(0, 4).map(q => ({ text: q.text.slice(0, 500), options: q.options.slice(0, 4).map(o => o.slice(0, 200)), recommended: q.recommended })),
  }
  return Number(db.prepare("INSERT INTO role_items (role, run_id, kind, text, detail, data, seen, created_at) VALUES (?, ?, 'proposal', ?, ?, ?, 1, ?)")
    .run(role, runId, `Ready: ${clip(i.text)}`, v.summary.slice(0, 2000), JSON.stringify(p), now()).lastInsertRowid)
}

/** Prep each pick in turn; one that fails is logged and skipped. Pushes one line when any are ready. */
export async function prepAll(role: string, runId: number | null, picks: { id: number; cwd: string }[], model?: string) {
  let ready = 0
  for (const p of picks) {
    try { if (await prepOne(role, runId, p.id, p.cwd, model)) ready++ } catch (e) { console.error(`prep ${p.id}:`, (e as Error).message) }
  }
  if (ready) await pushAll({ title: 'Ready to start', body: `${ready} note${ready === 1 ? ' is' : 's are'} prepped for an agent.`, url: `/#/team/${role}`, tag: 'prep' }).catch(() => {})
  return ready
}

/** Prep this: one note, right now, on the chief's desk. */
export async function prepNow(ideaId: number) {
  const chief = db.prepare("SELECT name, model FROM roles WHERE kind = 'chief' ORDER BY created_at LIMIT 1").get() as { name: string; model: string } | undefined
  if (!chief) throw new Error('add a chief of staff in Team first')
  const i = ideas.idea(ideaId)
  if (!i) throw new Error('no such note')
  return prepAll(chief.name, null, [{ id: i.id, cwd: folder('', i.area) }], chief.model)
}

/** The first message Start sends into the resumed prep conversation. */
export function startPrompt(p: desks.Proposal) {
  const qs = p.questions ?? []
  const answered = qs.map((q, n) => [q.text, p.answers?.[n]]).filter(([, a]) => a)
  return [
    `The owner tapped Start on this in Fleet. You now have every tool; carry on under the workspace's AGENTS.md.`,
    answered.length ? `His answers:\n${answered.map(([q, a]) => `- ${q} → ${a}`).join('\n')}` : '',
    qs.length > answered.length ? 'Ask what you still need, one question at a time, then show the plan in a few lines and wait for his OK.'
      : qs.length ? 'Update the plan with his answers, show it in a few lines and wait for his OK.'
      : 'Your plan needed no answers, so tapping Start is his OK: build it.',
    `When it's finished (or he drops it), run \`fleet done ${p.ids[0]} "<receipt>"\`: 2 to 4 plain sentences on what you did, what's left, and anything he has to do himself.`,
  ].filter(Boolean).join('\n\n')
}

/** For the home page: preps waiting on you, and ones an agent finished in the last 3 days. */
export function homeList() {
  return cards("json_extract(data, '$.type') = 'prep' AND (status = 'open' OR (status = 'done' AND json_extract(data, '$.receipt') IS NOT NULL AND closed_at > ?))", now() - 3 * 86400)
    .filter(c => c.status !== 'open' || !ideas.idea(c.p.ids[0])?.done) // its note got checked off some other way
    .map(c => ({ id: c.id, idea: c.p.ids[0], role: c.role, status: c.status, text: ideas.idea(c.p.ids[0])?.text ?? '', summary: c.p.why, questions: c.p.questions?.length ?? 0, size: c.p.size, agent: c.p.agent, receipt: c.p.receipt }))
}
