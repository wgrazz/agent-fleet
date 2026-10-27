import { expect, it, vi } from 'vitest'

// a change checked off offline, then the page reloads (or the PWA relaunches) once the Mac is back
const store = new Map([['fleet.outbox', JSON.stringify([{ method: 'PATCH', path: '/api/ideas/2', body: { done: true }, at: 0 }])]])
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
const sent: string[] = []
vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
  sent.push(`${init?.method ?? 'GET'} ${path}`)
  return Response.json(path === '/api/lists' ? [] : { ok: true })
})
const { api } = await import('../web/src/api.ts')

it('replays a queued change once the Mac answers, even without an offline → online flip', async () => {
  await api.get('/api/lists')
  await vi.waitFor(() => expect(store.get('fleet.outbox')).toBe('[]'))
  expect(sent).toContain('PATCH /api/ideas/2')
})
