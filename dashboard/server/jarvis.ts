// Jarvis's no-AI side: instant commands (borrowed from Atticus's idea that common requests shouldn't need a model),
// memory ("remember …"), conversations (threads, each with its own Claude session), and proposals: things Jarvis
// wants to do to your agents, which wait for your OK.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JarvisAction, JarvisReply } from './ai.ts'
import type { Agent } from './state.ts'
import { db, FLEET_DIR } from './store.ts'

const MEMORY = join(FLEET_DIR, 'jarvis-memory.md')

export function memory(): string {
  try {
    return readFileSync(MEMORY, 'utf8').slice(-6000)
  } catch {
    return ''
  }
}

export const remember = (text: string) => appendFileSync(MEMORY, `- ${text.trim().replace(/\n+/g, ' ')} (${new Date().toLocaleDateString()})\n`)

// ---------- conversations ----------

export type Thread = { id: number; title: string; session_id: string | null; created_at: number; updated_at: number }
export type Msg = { id: number; thread_id: number; who: 'you' | 'bot'; text: string; meta: string; at: number }
const IDLE_S = 2 * 3600
const now = () => Math.floor(Date.now() / 1000)

export const thread = (id: number) => db.prepare('SELECT * FROM jarvis_threads WHERE id = ?').get(id) as Thread | undefined

export function newThread(): Thread {
  const r = db.prepare('INSERT INTO jarvis_threads (created_at, updated_at) VALUES (?, ?)').run(now(), now())
  return thread(Number(r.lastInsertRowid))!
}

/** The conversation to talk in: the one asked for, else the latest if it was active in the last 2 hours, else a new one. */
export function threadFor(id?: number): Thread {
  if (id) {
    const t = thread(id)
    if (t) return t
  }
  const latest = db.prepare('SELECT * FROM jarvis_threads ORDER BY updated_at DESC LIMIT 1').get() as Thread | undefined
  return latest && now() - latest.updated_at < IDLE_S && !id ? latest : newThread()
}

export const threads = (limit = 60) =>
  db.prepare(`SELECT t.*, (SELECT count(*) FROM jarvis_messages m WHERE m.thread_id = t.id) AS count
    FROM jarvis_threads t WHERE EXISTS (SELECT 1 FROM jarvis_messages m WHERE m.thread_id = t.id) ORDER BY updated_at DESC LIMIT ?`).all(limit)

export const messages = (threadId: number) =>
  db.prepare('SELECT * FROM jarvis_messages WHERE thread_id = ? ORDER BY id').all(threadId) as Msg[]

export function addMessage(t: Thread, who: 'you' | 'bot', text: string, meta: object = {}) {
  db.prepare('INSERT INTO jarvis_messages (thread_id, who, text, meta, at) VALUES (?, ?, ?, ?, ?)').run(t.id, who, text, JSON.stringify(meta), now())
  db.prepare("UPDATE jarvis_threads SET updated_at = ?, title = CASE WHEN title = '' AND ? = 'you' THEN ? ELSE title END WHERE id = ?")
    .run(now(), who, text.replace(/\s+/g, ' ').slice(0, 70), t.id)
}

export const setThreadSession = (id: number, sid: string) => db.prepare('UPDATE jarvis_threads SET session_id = ? WHERE id = ?').run(sid, id)
export const deleteThread = (id: number) => {
  db.prepare('DELETE FROM jarvis_messages WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM jarvis_proposals WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM jarvis_threads WHERE id = ?').run(id)
}

// ---------- proposals: changes to agents wait for your OK ----------

export type Proposal = { id: number; thread_id: number; action: string; summary: string; state: 'pending' | 'approved' | 'declined'; result: string | null; created_at: number }

export function summarize(a: JarvisAction): string {
  if (a.type === 'start') return `Start a ${a.tool ? a.tool[0].toUpperCase() + a.tool.slice(1) : 'Claude'} agent${a.name ? ` called ${a.name}` : ''}${a.model ? ` (${a.model})` : ''}: “${a.text.slice(0, 160)}”`
  if (a.type === 'reply') return `Send to ${a.agent}: “${a.text.slice(0, 160)}”`
  if (a.type === 'key') return `Press ${a.key} in ${a.agent}`
  if (a.type === 'pause') return `Pause ${a.agent}${a.text ? ` until ${a.text}` : ''}`
  return `${a.type} ${a.text}`
}

export function propose(threadId: number, a: JarvisAction) {
  const summary = summarize(a)
  const r = db.prepare('INSERT INTO jarvis_proposals (thread_id, action, summary, created_at) VALUES (?, ?, ?, ?)').run(threadId, JSON.stringify(a), summary, now())
  return { id: Number(r.lastInsertRowid), summary, state: 'pending' as const }
}

export const proposals = (threadId: number) => db.prepare('SELECT * FROM jarvis_proposals WHERE thread_id = ? ORDER BY id').all(threadId) as Proposal[]
export const pendingProposals = (threadId: number) => proposals(threadId).filter(p => p.state === 'pending')
export const proposal = (id: number) => db.prepare('SELECT * FROM jarvis_proposals WHERE id = ?').get(id) as Proposal | undefined
export const settleProposal = (id: number, state: 'approved' | 'declined', result = '') =>
  db.prepare('UPDATE jarvis_proposals SET state = ?, result = ? WHERE id = ?').run(state, result, id)

/** Spoken or typed yes/no when something is waiting for approval. */
export function approvalWord(said: string): 'yes' | 'no' | null {
  const t = said.trim().toLowerCase().replace(/[.!,]+$/, '')
  if (/^(yes|yeah|yep|yup|sure|ok(ay)?|go( ahead)?|do it|approve( it)?|approved|sounds good|go for it|please do)( please)?$/.test(t)) return 'yes'
  if (/^(no|nope|nah|cancel|don'?t|stop|never ?mind|decline)( thanks)?$/.test(t)) return 'no'
  return null
}

const action = (a: Partial<JarvisAction>): JarvisAction =>
  ({ type: 'idea', agent: '', text: '', key: '', tool: '', model: '', effort: '', list: '', name: '', ...a })

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** "walmart" finds "scraper-walmart"; an exact match wins; two partial matches is ambiguous (null). */
export function findAgent(agents: Agent[], said: string): Agent | null | 'ambiguous' {
  const want = squash(said)
  if (!want) return null
  const live = agents.filter(a => a.controllable)
  const exact = live.find(a => squash(a.name) === want)
  if (exact) return exact
  const partial = live.filter(a => squash(a.name).includes(want) || want.includes(squash(a.name)))
  return partial.length === 1 ? partial[0] : partial.length > 1 ? 'ambiguous' : null
}

export function summary(agents: Agent[]): string {
  const needs = agents.filter(a => a.status === 'needs_you')
  const working = agents.filter(a => a.status === 'working')
  const crashed = agents.filter(a => a.status === 'crashed')
  const parts: string[] = []
  if (needs.length === 0) parts.push('Nothing needs you right now.')
  else parts.push(`${needs.length === 1 ? 'One agent needs' : `${needs.length} agents need`} you: ${needs.map(a => `${a.name}${a.message ? `, asking ${a.message.replace(/[?.]+$/, '')}` : ''}`).join('; ')}.`)
  if (working.length) parts.push(`${working.length} working${working.length <= 3 ? `: ${working.map(a => a.name).join(', ')}` : ''}.`)
  if (crashed.length) parts.push(`${crashed.map(a => a.name).join(' and ')} crashed.`)
  return parts.join(' ')
}

/** Common requests answered instantly without a model call. Anything it doesn't recognise goes to Claude. */
export function instant(said: string, agents: Agent[]): JarvisReply | null {
  const t = said.trim().replace(/[.!]+$/, '')
  if (/^(status|what'?s (going on|happening|up)|(what|who|which agents?)\b.*\b(needs?|waiting)\b.*\bme\b|anything need(s)? me)\??$/i.test(t))
    return { say: summary(agents), actions: [] }

  let m = t.match(/^(?:idea|note|todo|add (?:an )?idea)\s*[:,-]?\s+(.+)$/i)
  if (m) return { say: 'Noted, in Brain Dump.', actions: [action({ type: 'idea', text: m[1] })] }

  m = t.match(/^remember(?: that)?\s*[:,]?\s+(.+)$/i)
  if (m) return { say: "I'll remember that.", actions: [action({ type: 'remember', text: m[1] })] }

  m = t.match(/^pause\s+([\w.-]+)(?:\s+(?:until|till|til)\s+(\d{1,2}:\d{2}|\+\d+[mhd]))?$/i)
  if (m) {
    const a = findAgent(agents, m[1])
    if (a === 'ambiguous') return { say: `More than one agent matches ${m[1]}. Which one?`, actions: [] }
    if (a) return { say: `Pausing ${a.name}${m[2] ? `, back at ${m[2]}` : ''}.`, actions: [action({ type: 'pause', agent: a.name, text: m[2] ?? '' })] }
  }

  m = t.match(/^(?:tell|answer|reply to|say to)\s+([\w.-]+)\s*[:,]?\s+(.+)$/i)
  if (m) {
    const a = findAgent(agents, m[1])
    if (a === 'ambiguous') return { say: `More than one agent matches ${m[1]}. Which one?`, actions: [] }
    if (a) {
      const reply = m[2].trim()
      const yes = /^(yes|yeah|yep|sure|ok(ay)?|go( ahead)?|do it|approve)$/i.test(reply)
      const no = /^(no|nope|don'?t|stop|cancel|deny)$/i.test(reply)
      const pick = a.quick_replies.find(q => q.key === reply)
        ?? (yes ? a.quick_replies.find(q => /^yes\b/i.test(q.label)) : no ? a.quick_replies.find(q => /^no\b/i.test(q.label)) : undefined)
      if (pick) return { say: `Told ${a.name}: ${pick.label}.`, actions: [action({ type: 'key', agent: a.name, key: pick.key })] }
      if (a.quick_replies.length && (yes || no)) return null // a menu without an obvious yes/no option: let Claude read it
      return { say: `Sent to ${a.name}.`, actions: [action({ type: 'reply', agent: a.name, text: reply })] }
    }
  }
  return null
}
