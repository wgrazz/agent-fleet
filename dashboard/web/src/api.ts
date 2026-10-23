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
}
export type Paused = { id: number; name: string; tool: string; session_id: string; cwd: string; paused_at: number }
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
