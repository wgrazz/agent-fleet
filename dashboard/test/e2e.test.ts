// End to end: a real server on a spare port, a fake agent in a real tmux session, driven through the HTTP API.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'fleet-e2e-')) // no spaces: fleet matches agents by their command line
const port = 7900 + Math.floor(Math.random() * 90)
const key = 'e2e'.padEnd(48, '0')
const name = `e2e-${process.pid}`
let server: ChildProcess

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'X-Fleet-Key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: res.status === 204 ? null : await res.json() }
}
const agent = async () => (await api('GET', '/api/agents')).data.find((a: any) => a.name === name)
const screen = () => execFileSync('tmux', ['capture-pane', '-p', '-t', `=${name}:`]).toString()
async function until<T>(get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 250))) {
    const v = await get()
    if (ok(v) || Date.now() > end) return v
  }
}

beforeAll(async () => {
  copyFileSync(join(import.meta.dirname, 'fake-agent.sh'), join(dir, 'fake-agent.sh'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port, key }))
  server = spawn(process.execPath, [join(import.meta.dirname, '..', 'server', 'index.ts')], {
    env: { ...process.env, FLEET_DIR: dir, FLEET_EXTRA_TOOLS: `fake=${join(dir, 'fake-agent.sh')}` }, stdio: 'inherit',
  })
  await until(() => fetch(`http://127.0.0.1:${port}/api/agents`).then(r => r.status).catch(() => 0), s => s === 401)
})

afterAll(() => {
  server?.kill()
  try {
    execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' })
  } catch {}
})

describe('fake agent through the API', () => {
  it('rejects requests without the key', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/api/agents`)).status).toBe(401)
  })

  it('starts, shows needs_you with quick replies, takes an answer', async () => {
    expect((await api('POST', '/api/agents', { name, tool: 'fake', cwd: dir })).data).toEqual({ name })
    const a = await until(agent, a => a?.status === 'needs_you')
    expect(a.status).toBe('needs_you')
    expect(a.quick_replies.map((q: any) => q.key)).toEqual(['1', '2'])
    expect(a.message).toBe('Pick one:')
    await api('POST', `/api/agents/${name}/send`, { key: '1' })
    expect(await until(screen, s => s.includes('got 1'))).toContain('got 1')
  })

  it('refuses keys outside the allowlist', async () => {
    expect((await api('POST', `/api/agents/${name}/send`, { key: 'C-c' })).status).toBe(400)
  })

  it("won't pause an agent with no resumable conversation", async () => {
    const res = await api('POST', `/api/agents/${name}/pause`)
    expect(res.status).toBe(400)
    expect(res.data.error).toMatch(/no resumable session id/)
  })

  it('holds a queued message until the agent is free; send now and remove work', async () => {
    // the fake agent always shows a menu (needs_you), so a queued message has to wait
    expect((await api('POST', `/api/agents/${name}/queue`, { text: 'hello later' })).status).toBe(200)
    await new Promise(r => setTimeout(r, 2500))
    const [q] = (await agent()).queued
    expect(q.text).toBe('hello later')
    expect(screen()).not.toContain('got hello later')
    await api('POST', `/api/queued/${q.id}/send`)
    expect(await until(screen, s => s.includes('got hello later'))).toContain('got hello later')
    await api('POST', `/api/agents/${name}/queue`, { text: 'never mind' })
    const [r] = (await agent()).queued
    await api('DELETE', `/api/queued/${r.id}`)
    expect((await agent()).queued).toEqual([])
  })

  it('reports a crash with its exit code', async () => {
    await api('POST', `/api/agents/${name}/send`, { text: 'crash' })
    const a = await until(agent, a => a?.status === 'crashed')
    expect([a.status, a.exit]).toEqual(['crashed', 'exit 3'])
  })

  it('kills the session', async () => {
    expect((await api('DELETE', `/api/agents/${name}`)).status).toBe(200)
    expect(await agent()).toBeUndefined()
  })
})
