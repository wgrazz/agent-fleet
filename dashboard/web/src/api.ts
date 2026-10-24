import { useCallback, useEffect, useRef, useState } from 'react'

export type Status = 'working' | 'needs_you' | 'done' | 'crashed' | 'unknown'
export type Agent = {
  name: string
  controllable: boolean
  tool: string
  pid: number | null
  cwd: string
  task: string
  age_s: number
  session_id: string
  status: Status
  status_since: number
  quick_replies: { key: string; label: string }[]
  last_line: string
  message: string
  exit: string
  mode: string
  working_line: string
}
export type Placed = { key: string; folder_id: number | null }
export type LiveAgent = Agent & Placed
export type Folder = { id: number; name: string; color: string; position: number }
export type List = { id: number; name: string; color: string; position: number; archived: number; open: number; done: number; unsorted: number }
export type Idea = {
  id: number; list: string; text: string; notes: string; done: number; done_at: number | null; created_at: number
  position: number | null; repeat: string | null; next_due: number | null; agent: string | null; agent_status: Status | 'gone' | null
  source: string | null; suggestion: string | null; suggestion_conf: number | null; priority: number; why: string | null
}
export type Conversation = Placed & { tool: 'claude' | 'codex'; id: string; title: string; prompt: string; cwd: string; updated: number; running: string | null }
export type Message = { role: 'user' | 'assistant' | 'tool'; text: string }
export type Usage = { tool: string; windows: { label: string; pct: number; resets_at: number | null }[]; updated: number | null; note?: string }
export type RepoChanges = { repo: string; branch: string; files: { status: string; path: string }[]; commits: { hash: string; subject: string; pushed: boolean }[]; unpushed: number }
export type Route = { tool: string; model: string; effort: string; why: string; alternative: { tool: string; model: string; why: string } }
export type Improved = { prompt: string; changes: string[]; questions: string[] }

export type Paused = { id: number; name: string; tool: string; session_id: string; cwd: string; paused_at: number; resume_at: number | null }
export type Profile = { name: string; tool: string; model: string | null; effort: string | null; args: string | null; cwd: string | null; is_default: number }

export class Unauthorized extends Error {}

// ---------- offline: the Mac isn't reachable ----------
// The service worker answers GETs for lists and ideas from its copy (marked X-Fleet-Offline). Changes to ideas
// made while offline wait in an outbox here and are replayed, in order, as soon as the Mac answers again.

type Op = { method: string; path: string; body?: any; temp?: number; at: number }
const OUTBOX = 'fleet.outbox'
const readBox = (): Op[] => { try { return JSON.parse(localStorage.getItem(OUTBOX) ?? '[]') } catch { return [] } }
const writeBox = (ops: Op[]) => { try { localStorage.setItem(OUTBOX, JSON.stringify(ops)) } catch {} }
const QUEUEABLE = /^\/api\/ideas(\/-?\d+)?$/ // add, edit, check, delete an idea

let offline = false
const listeners = new Set<(off: boolean, pending: number) => void>()
export const onOffline = (f: (off: boolean, pending: number) => void) => { listeners.add(f); f(offline, readBox().length); return () => { listeners.delete(f) } }
const announce = () => listeners.forEach(f => f(offline, readBox().length))
function setOffline(off: boolean) {
  if (off === offline) return
  offline = off
  announce()
  if (!off) flush()
}

let flushing = false
async function flush() {
  if (flushing) return
  flushing = true
  const ids = new Map<number, number>() // temporary id → real id
  try {
    for (let ops = readBox(); ops.length; ops = readBox()) {
      const op = ops[0]
      const path = op.path.replace(/-\d+$/, m => String(ids.get(Number(m)) ?? m))
      if (/-\d+$/.test(path)) { writeBox(ops.slice(1)); continue } // edit of an idea whose add failed: drop it
      const res = await fetch(path, { method: op.method, headers: { 'Content-Type': 'application/json' }, body: op.body === undefined ? undefined : JSON.stringify(op.body) })
      if (res.headers.get('X-Fleet-Offline') || res.status >= 500) break // still away: try later
      if (op.temp && res.ok) ids.set(op.temp, (await res.json()).id)
      writeBox(readBox().slice(1))
      announce()
    }
  } catch {
    // network dropped mid-flush: the rest stays queued
  } finally {
    flushing = false
    announce()
  }
}

/** Show queued offline changes in the ideas a GET returned. */
function withOutbox(path: string, data: any) {
  if (!Array.isArray(data) || !path.startsWith('/api/ideas?')) return data
  const list = new URLSearchParams(path.split('?')[1]).get('list')
  let items = [...data]
  for (const op of readBox()) {
    const id = Number(op.path.split('/').pop())
    if (op.method === 'POST' && op.temp && (!list || op.body?.list === list || (!op.body?.list && list === 'Brain Dump')))
      items.push({ id: op.temp, list: op.body?.list ?? 'Brain Dump', text: op.body?.text ?? '', notes: '', done: 0, created_at: op.at / 1000, priority: 0, pending: true })
    if (op.method === 'PATCH') items = items.map(i => (i.id === id ? { ...i, ...op.body, done: op.body?.done === undefined ? i.done : op.body.done ? 1 : 0, pending: true } : i))
    if (op.method === 'DELETE') items = items.filter(i => i.id !== id)
  }
  return items
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    setOffline(true)
    if (method !== 'GET' && QUEUEABLE.test(path)) {
      const temp = method === 'POST' ? -Date.now() : undefined
      writeBox([...readBox(), { method, path, body, temp, at: Date.now() }])
      announce()
      return (temp ? { id: temp } : { ok: true, queued: true }) as T
    }
    throw new Error("Your Mac isn't reachable right now. Notes still work; everything else needs the Mac.")
  }
  if (res.status === 401) throw new Unauthorized('locked')
  if (res.headers.get('X-Fleet-Offline')) setOffline(true)
  else if (method === 'GET' && res.ok) setOffline(false)
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return (method === 'GET' ? withOutbox(path, data) : data) as T
}

export const api = {
  get: <T,>(path: string) => call<T>('GET', path),
  post: <T,>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T,>(path: string, body: unknown) => call<T>('PUT', path, body),
  del: <T,>(path: string) => call<T>('DELETE', path),
  patch: <T,>(path: string, body: unknown) => call<T>('PATCH', path, body),
}

// ponytail: polling; switch to a WebSocket event feed if 2 s ever feels slow
export function usePoll<T>(path: string, ms: number, onError: (e: Error) => void) {
  const [data, setData] = useState<T | null>(null)
  const errRef = useRef(onError)
  errRef.current = onError
  const refresh = useCallback(() => api.get<T>(path).then(setData).catch(e => errRef.current(e)), [path])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, ms)
    return () => clearInterval(t)
  }, [refresh, ms])
  return { data, refresh }
}

// localStorage can be missing or throw (private mode); these are conveniences only
export const remember = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`fleet.${k}`) ?? ''
    } catch {
      return ''
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`fleet.${k}`, v)
    } catch {}
  },
}

export type AiBudget = { weekly_pct: number | null; jarvis_pct: number; ai_pct: number; jarvis_usd: number; ai_usd: number; claude_usd: number; warn_pct: number; max_pct: number; since: number }
export type Settings = {
  cwd: string; ai_model: string; jarvis_warn_pct: number; jarvis_max_pct: number
  voice_engine: 'kokoro' | 'mac' | 'device'; voice: string; voice_speed: number; kokoro: boolean
}
