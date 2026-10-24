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
  source: string | null; suggestion: string | null; suggestion_conf: number | null
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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new Unauthorized('locked')
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data as T
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
