// Jarvis's no-AI side: instant commands (borrowed from Atticus's idea that common requests shouldn't need a model),
// memory ("remember …"), and one conversation per day so follow-up questions have context.
import { readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JarvisAction, JarvisReply } from './ai.ts'
import type { Agent } from './state.ts'
import { FLEET_DIR } from './store.ts'

const MEMORY = join(FLEET_DIR, 'jarvis-memory.md')
const SESSION = join(FLEET_DIR, 'jarvis-session.json')

export function memory(): string {
  try {
    return readFileSync(MEMORY, 'utf8').slice(-6000)
  } catch {
    return ''
  }
}

export const remember = (text: string) => appendFileSync(MEMORY, `- ${text.trim().replace(/\n+/g, ' ')} (${new Date().toLocaleDateString()})\n`)

export function session(): string | undefined {
  try {
    const s = JSON.parse(readFileSync(SESSION, 'utf8'))
    return s.day === new Date().toDateString() ? s.id : undefined
  } catch {
    return undefined
  }
}

export const saveSession = (id: string) => writeFileSync(SESSION, JSON.stringify({ id, day: new Date().toDateString() }))
export const resetSession = () => rmSync(SESSION, { force: true })

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
