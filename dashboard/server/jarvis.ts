// Jarvis's no-AI side: instant commands (borrowed from Atticus's idea that common requests shouldn't need a model),
// memory ("remember …"), conversations (threads, each with its own Claude session), and proposals: things Jarvis
// wants to do to your agents, which wait for your OK.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JarvisAction, JarvisReply, MacAction } from './ai.ts'
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

const MAC_NEEDS_OK = new Set(['event', 'remind', 'draft'])
/** Mac actions that write something (calendar, reminders, an email draft) wait for your OK; music and windows don't. */
export const needsApproval = (a: JarvisAction) =>
  a.type === 'mac' ? MAC_NEEDS_OK.has(a.mac?.command ?? '') : a.type === 'idea_edit' ? a.edit?.done === 'delete' : !['idea', 'remember', 'role'].includes(a.type)

/** `fleet mac …` argv for a Mac action. Only known commands; values go in as separate arguments. */
export function macArgv(m: MacAction): string[] {
  const v = (x: string) => (x ?? '').trim()
  switch (m.command) {
    case 'music_play': return ['music', 'play', ...(v(m.value).startsWith('spotify:') ? [v(m.value)] : [])]
    case 'music_pause': return ['music', 'pause']
    case 'music_next': return ['music', 'next']
    case 'music_previous': return ['music', 'previous']
    case 'music_volume': return ['music', 'volume', String(Math.max(0, Math.min(100, Number(v(m.value)) || 50)))]
    case 'music_search': return ['music', 'search', v(m.value) || v(m.title)]
    case 'open_app': return ['open', v(m.app)]
    case 'window': return ['window', ['left', 'right', 'full', 'center'].includes(v(m.where)) ? v(m.where) : 'center', ...(v(m.app) ? [v(m.app)] : [])]
    case 'event': return ['event', v(m.title), '--at', v(m.when), '--minutes', String(Number(v(m.minutes)) || 30), ...(v(m.calendar) ? ['--calendar', v(m.calendar)] : [])]
    case 'remind': return ['remind', v(m.title), ...(v(m.when) ? ['--due', v(m.when)] : []), ...(v(m.calendar) ? ['--list', v(m.calendar)] : [])]
    case 'draft': return ['draft', '--to', v(m.to), '--subject', v(m.subject), '--body', m.body ?? '']
    default: throw new Error(`unknown Mac command ${m.command}`)
  }
}

const ideaText = (id?: number) => (db.prepare('SELECT text FROM ideas WHERE id = ?').get(id ?? -1) as { text: string } | undefined)?.text.slice(0, 80) ?? `#${id}`

export function summarize(a: JarvisAction): string {
  if (a.type === 'mac' && a.mac) {
    const m = a.mac
    if (m.command === 'event') return `Add to your calendar: “${m.title}”, ${m.when}${m.minutes ? ` for ${m.minutes} min` : ''}${m.calendar ? ` (${m.calendar})` : ''}`
    if (m.command === 'remind') return `Add a reminder: “${m.title}”${m.when ? `, ${m.when}` : ''}${m.calendar ? ` in ${m.calendar}` : ''}`
    if (m.command === 'draft') return `Save an email draft${m.to ? ` to ${m.to}` : ''}: “${m.subject}”\n\n${m.body.slice(0, 600)}`
    return `${m.command.replace('_', ' ')} ${m.app || m.value || m.title}`.trim()
  }
  if (a.type === 'start') return `Start a ${a.tool ? a.tool[0].toUpperCase() + a.tool.slice(1) : 'Claude'} agent${a.name ? ` called ${a.name}` : ''}${a.model ? ` (${a.model})` : ''}: “${a.text.slice(0, 160)}”`
  if (a.type === 'reply') return `Send to ${a.agent}: “${a.text.slice(0, 160)}”`
  if (a.type === 'key') return `Press ${a.key} in ${a.agent}`
  if (a.type === 'pause') return `Pause ${a.agent}${a.text ? ` until ${a.text}` : ''}`
  if (a.type === 'idea_edit') return `Delete the idea “${ideaText(a.edit?.id)}”`
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

/** "Bye", "that's all", "go away": the conversation is over, no need to ask Claude. */
export const isGoodbye = (said: string) =>
  /^(ok(ay)?,? )?(stop|bye|goodbye|good ?night|see ya|later|that'?s (all|it)|that is all|go away|never ?mind|no thanks|nothing( else)?|i'?m (done|good)|we'?re done|end( conversation)?|thanks?( you)?( jarvis)?( that'?s (all|it))?)[.!]*$/i.test(said.trim())

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
  const waiting = agents.filter(a => a.status === 'waiting')
  const crashed = agents.filter(a => a.status === 'crashed')
  const asks = db.prepare("SELECT r.title, count(*) AS n FROM role_items i JOIN roles r ON r.name = i.role WHERE i.status = 'open' AND i.kind = 'question' GROUP BY r.name").all() as { title: string; n: number }[]
  const parts: string[] = []
  if (needs.length === 0) parts.push(asks.length ? 'No agent needs you.' : 'Nothing needs you right now.')
  else parts.push(`${needs.length === 1 ? 'One agent needs' : `${needs.length} agents need`} you: ${needs.map(a => `${a.name}${a.message ? `, asking ${a.message.replace(/[?.]+$/, '')}` : ''}`).join('; ')}.`)
  if (working.length) parts.push(`${working.length} working${working.length <= 3 ? `: ${working.map(a => a.name).join(', ')}` : ''}.`)
  if (waiting.length) parts.push(`${waiting.map(a => a.name).join(' and ')} ${waiting.length === 1 ? 'is' : 'are'} waiting on a background job.`)
  if (crashed.length) parts.push(`${crashed.map(a => a.name).join(' and ')} crashed.`)
  if (asks.length) parts.push(`${asks.map(q => `${q.title} has ${q.n === 1 ? 'a question' : `${q.n} questions`}`).join(' and ')} for you.`)
  return parts.join(' ')
}

/** Common requests answered instantly without a model call. Anything it doesn't recognise goes to Claude. */
export function instant(said: string, agents: Agent[]): JarvisReply | null {
  const t = said.trim().replace(/[.!]+$/, '')
  // "what does the clerk need from me?": read its open questions out, no model needed
  const asked = /^(what|which|any|does|has)\b.*\b(needs?|wants?|ask(ing|ed)?|questions?)\b/i.test(t) && (db.prepare('SELECT name, title FROM roles').all() as { name: string; title: string }[])
    .find(r => new RegExp(`\\b(${[r.name, r.title].map(s => s.replace(/[^\w ]/g, '')).join('|')})\\b`, 'i').test(t))
  if (asked) {
    const qs = db.prepare("SELECT text FROM role_items WHERE role = ? AND kind = 'question' AND status = 'open' ORDER BY id").all(asked.name) as { text: string }[]
    const cards = (db.prepare("SELECT count(*) AS n FROM role_items WHERE role = ? AND kind = 'proposal' AND status = 'open'").get(asked.name) as { n: number }).n
    return { say: `${qs.length ? `${asked.title} has ${qs.length === 1 ? 'one question' : `${qs.length} questions`}. ${qs.map((q, n) => `${qs.length > 1 ? `${n + 1}: ` : ''}${q.text.replace(/[?.]*$/, '?')}`).join(' ')} You can answer me here.` : `${asked.title} has no questions for you right now.`}${cards ? ` ${cards === 1 ? 'One card waits' : `${cards} cards wait`} on its desk in the Team tab.` : ''}`, actions: [] }
  }
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

/** "what should I do next", "rank my notes", "prioritize my ideas", "sort my notes by importance" */
export const wantsRanking = (said: string) =>
  /\b(what should i (do|work on|tackle) (next|first|now)|what('?s| is) (most )?important|(rank|prioriti[sz]e|triage)\b.*\b(notes?|ideas?|todos?|tasks?|lists?)|sort\b.*\b(notes?|ideas?|tasks?)\b.*\b(importan|priorit))/i.test(said)

/** Mac requests answered without Claude: music controls, what's playing, today's/tomorrow's calendar, opening an app. */
export function instantMac(said: string): { argv: string[]; say?: string } | null {
  const t = said.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/^(jarvis,?\s*)?(please\s+)?/, '')
  if (/^(pause|stop)( the)?( music| spotify| song)?$/.test(t)) return { argv: ['music', 'pause'] }
  if (/^(play|resume|unpause)( the)?( music| spotify)?$/.test(t)) return { argv: ['music', 'play'] }
  if (/^(next|skip)( this)?( song| track)?$/.test(t)) return { argv: ['music', 'next'] }
  if (/^(previous|go back|last)( song| track)$/.test(t)) return { argv: ['music', 'previous'] }
  if (/^(what'?s|what is) (playing|this song)$|^what song is this$/.test(t)) return { argv: ['music', 'now'] }
  let m = t.match(/^(?:set )?(?:the )?volume (?:to )?(\d{1,3})( percent)?$/)
  if (m) return { argv: ['music', 'volume', m[1]] }
  m = t.match(/^what'?s on (?:my )?(?:calendar )?(today|tomorrow|this week)$|^what do i have (today|tomorrow|this week)$/)
  if (m) return { argv: ['calendar', (m[1] ?? m[2]).replace('this week', 'week')] }
  m = t.match(/^open ([a-z0-9 .&-]{2,40})$/)
  if (m && !/\b(agent|idea|note|list|folder)\b/.test(m[1])) return { argv: ['open', m[1].replace(/\b\w/g, c => c.toUpperCase())] }
  return null
}
