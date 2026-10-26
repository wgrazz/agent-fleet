// Past and live conversations from the tools' own logs: Claude Code (~/.claude/projects/*/<id>.jsonl) and Codex
// (~/.codex/state_*.sqlite threads + rollout JSONL). Used by History and by the Chat view.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = homedir()

export type Conversation = { tool: 'claude' | 'codex'; id: string; title: string; prompt: string; cwd: string; updated: number }
export type Message = { role: 'user' | 'assistant' | 'tool'; text: string }

function readSlice(path: string, from: 'head' | 'tail', bytes: number) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const start = from === 'head' ? 0 : Math.max(0, size - bytes)
    const buf = Buffer.alloc(Math.min(bytes, size))
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    return from === 'head' ? lines.slice(0, -1) : lines.slice(1) // drop the partial line at the cut
  } finally {
    closeSync(fd)
  }
}

const parse = (line: string) => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

// Claude's own wrappers (<command-name>, <system-reminder>, …) aren't things you typed
// What you typed, minus Claude's own notes. Pasted text (and everything sent from the dashboard, which arrives as
// a paste) is wrapped in <pasted_content …>; keep its contents.
const typed = (text: string) => text
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g, '$1')
  .trim()
// Claude Code / Codex bookkeeping that isn't something you said
const WRAPPERS = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|task-notification|system-reminder|environment_context|user_instructions|turn_aborted)[ >]/
const isWrapper = (text: string) => WRAPPERS.test(text.trim())

const claudeCache = new Map<string, { key: string; conv: Conversation | null }>()

function claudeConversation(path: string): Conversation | null {
  const st = statSync(path)
  const key = `${st.mtimeMs}:${st.size}`
  const hit = claudeCache.get(path)
  if (hit?.key === key) return hit.conv
  let cwd = '', prompt = '', title = ''
  for (const d of readSlice(path, 'head', 256 << 10).map(parse)) {
    if (!d) continue
    cwd ||= d.cwd ?? ''
    if (!prompt && d.type === 'user' && !d.isMeta && !d.isSidechain) {
      const c = d.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
      if (text && !isWrapper(text)) prompt = typed(text)
    }
  }
  for (const d of readSlice(path, 'tail', 512 << 10).map(parse)) {
    if (d?.type === 'custom-title' || d?.type === 'ai-title') title = d.customTitle ?? d.aiTitle ?? title
  }
  const conv = prompt || title
    ? { tool: 'claude' as const, id: basename(path, '.jsonl'), title, prompt: prompt.slice(0, 300), cwd, updated: st.mtimeMs }
    : null
  claudeCache.set(path, { key, conv })
  return conv
}

function codexDb() {
  const dbs = [...readdirSafe(join(HOME, '.codex'))].filter(f => /^state_.*\.sqlite$/.test(f)).sort()
  return dbs.length ? new DatabaseSync(join(HOME, '.codex', dbs.at(-1)!), { readOnly: true }) : null
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function codexConversations(): Conversation[] {
  const db = codexDb()
  if (!db) return []
  try {
    const rows = db.prepare(`SELECT id, coalesce(nullif(name, ''), nullif(title, ''), '') AS title, first_user_message, cwd,
      updated_at_ms FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT 300`).all() as any[]
    return rows.map(r => ({ tool: 'codex' as const, id: r.id, title: r.title, prompt: String(r.first_user_message ?? '').slice(0, 300), cwd: r.cwd ?? '', updated: r.updated_at_ms }))
  } catch {
    return []
  } finally {
    db.close()
  }
}

export async function conversations(): Promise<Conversation[]> {
  const claude: Conversation[] = []
  for await (const path of glob(join(HOME, '.claude', 'projects', '*', '*.jsonl'))) {
    try {
      const c = claudeConversation(path)
      if (c) claude.push(c)
    } catch {} // file vanished mid-scan
  }
  return [...claude, ...codexConversations()].sort((a, b) => b.updated - a.updated).slice(0, 400)
}

// ---------- transcripts ----------

const MAX = 300

function summarizeTool(name: string, input: any): string {
  const pick = input && (input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt)
  const detail = typeof pick === 'string' ? pick : typeof input === 'string' ? input : ''
  return `${name}${detail ? ` · ${detail.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`
}

function push(out: Message[], m: Message) {
  const last = out.at(-1)
  if (last && last.role === m.role && m.role === 'assistant') last.text += `\n\n${m.text}`
  else out.push(m)
}

function claudeMessages(path: string): Message[] {
  const out: Message[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const d = parse(line)
    if (!d || d.isSidechain || d.isMeta || (d.type !== 'user' && d.type !== 'assistant')) continue
    if (d.isCompactSummary) { out.push({ role: 'tool', text: 'Earlier conversation was summarized here to save space' }); continue }
    const c = d.message?.content
    if (typeof c === 'string') {
      if (d.type === 'user' && !isWrapper(c) && typed(c)) push(out, { role: 'user', text: typed(c) })
      continue
    }
    for (const b of Array.isArray(c) ? c : []) {
      if (d.type === 'user' && b.type === 'text' && /^\[Request interrupted/.test(b.text ?? '')) push(out, { role: 'tool', text: 'Interrupted' })
      else if (b.type === 'text' && b.text?.trim() && !(d.type === 'user' && isWrapper(b.text)))
        push(out, { role: d.type === 'user' ? 'user' : 'assistant', text: d.type === 'user' ? typed(b.text) : b.text.trim() })
      else if (b.type === 'tool_use') push(out, asked(b.name, b.input) ?? { role: 'tool', text: summarizeTool(b.name, b.input) })
    }
  }
  return out.slice(-MAX)
}

// Claude's questions and plans are the conversation, not tool noise: show them in full so they can be read and
// answered from the chat. Option numbers match the screen's menu, so the quick-reply buttons line up.
export function asked(name: string, input: any): Message | null {
  if (name === 'ExitPlanMode' && typeof input?.plan === 'string') return { role: 'assistant', text: `**Plan for your approval**\n\n${input.plan}` }
  if (name !== 'AskUserQuestion' || !Array.isArray(input?.questions)) return null
  const text = input.questions.map((q: any) => {
    const opts = (q.options ?? []).map((o: any, i: number) => `- **${i + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`)
    return [`**${q.question}**${q.multiSelect ? ' (pick any)' : ''}`, opts.join('\n')].filter(Boolean).join('\n\n')
  })
  return { role: 'assistant', text: text.join('\n\n') }
}

function codexMessages(path: string): Message[] {
  const out: Message[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const p = parse(line)?.payload
    if (!p) continue
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = (p.content ?? []).map((b: any) => b.text ?? '').join('\n').trim()
      if (text && !(p.role === 'user' && isWrapper(text))) push(out, { role: p.role, text })
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      let input = p.input ?? p.arguments
      try {
        input = typeof input === 'string' && input.startsWith('{') ? JSON.parse(input) : input
      } catch {}
      push(out, { role: 'tool', text: summarizeTool(p.name, input) })
    }
  }
  return out.slice(-MAX)
}

async function transcriptPath(tool: string, id: string): Promise<string | null> {
  if (!/^[\w-]{8,64}$/.test(id)) return null
  if (tool === 'claude') {
    for await (const p of glob(join(HOME, '.claude', 'projects', '*', `${id}.jsonl`))) return p
    return null
  }
  if (tool === 'codex') {
    const db = codexDb()
    try {
      return (db?.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id) as any)?.rollout_path ?? null
    } catch {
      return null
    } finally {
      db?.close()
    }
  }
  return null
}

const transcriptCache = new Map<string, { version: string; messages: Message[] }>()

/** Messages for a conversation, plus a version that changes whenever the log grows (so pollers can skip repeats). */
export async function transcript(tool: string, id: string) {
  const path = await transcriptPath(tool, id)
  if (!path) return null
  const st = statSync(path)
  const version = `${st.size}`
  const hit = transcriptCache.get(path)
  if (hit?.version === version) return hit
  const result = { version, messages: tool === 'claude' ? claudeMessages(path) : codexMessages(path) }
  transcriptCache.set(path, result)
  return result
}

export const hasTranscript = (tool: string) => tool === 'claude' || tool === 'codex'
