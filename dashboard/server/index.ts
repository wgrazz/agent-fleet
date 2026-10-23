// Fleet dashboard server: binds to 127.0.0.1 only (`tailscale serve` publishes it to the tailnet over HTTPS)
// and requires the access key from ~/.fleet/config.json on every API and WebSocket request.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { notify, publicKey, subscribe } from './push.ts'
import { alerts, ingestHook, list, startPolling } from './state.ts'
import { config, db, FLEET_BIN } from './store.ts'
import { run, sendKey, sendText } from './tmux.ts'
import { attach } from './ws.ts'

const NAME = /^[A-Za-z0-9._-]{1,40}$/ // same rule as the fleet CLI
const TOOLS = new Set(['claude', 'codex', 'cursor', 'copilot', 'agy', ...(process.env.FLEET_EXTRA_TOOLS ?? '')
  .split(',').filter(Boolean).map(s => s.split('=')[0])])
const DIST = join(import.meta.dirname, '..', 'dist')
const KEY = Buffer.from(config.key)

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const cookies = (req: IncomingMessage) =>
  Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)))

const keyOk = (given: unknown) =>
  typeof given === 'string' && given.length === KEY.length && timingSafeEqual(Buffer.from(given), KEY)

export const authorized = (req: IncomingMessage) => keyOk(req.headers['x-fleet-key']) || keyOk(cookies(req).fleet_key)

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1 << 20) throw new HttpError(413, 'body too large')
  }
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new HttpError(400, 'body must be a JSON object')
  }
}

const send = (res: ServerResponse, status: number, data?: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(data === undefined ? '' : JSON.stringify(data))
}

const fleet = (args: string[], cwd?: string) =>
  run(FLEET_BIN, args, cwd).catch((e: any) => {
    throw new HttpError(400, (e.stderr || e.message || 'fleet failed').trim())
  })

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : '')

const agentOr404 = (name: string) => {
  const a = list().find(a => a.name === name)
  if (!a) throw new HttpError(404, `no agent named ${name}`)
  if (!a.controllable) throw new HttpError(409, `${name} isn't in tmux, so it can't be controlled from here`)
  return a
}

type Route = (req: IncomingMessage, params: string[]) => Promise<unknown>
const routes: [string, RegExp, Route][] = [
  ['GET', /^\/api\/agents$/, async () => list()],

  ['POST', /^\/api\/agents$/, async req => {
    const b = await body(req)
    const profile = str(b.profile, 80)
    const prof = profile ? db.prepare('SELECT * FROM profiles WHERE name = ?').get(profile) as any : null
    if (profile && !prof) throw new HttpError(404, `no profile named ${profile}`)
    const tool = str(b.tool, 20) || prof?.tool || 'claude'
    if (!TOOLS.has(tool)) throw new HttpError(400, `unknown tool ${tool}`)
    const name = str(b.name, 40) || `${tool}-${randomBytes(2).toString('hex')}`
    if (!NAME.test(name)) throw new HttpError(400, 'name: letters, digits, . _ - (up to 40)')
    const cwd = str(b.cwd, 1000) || prof?.cwd || config.cwd || homedir()
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `no such folder: ${cwd}`)
    const args = ['new', name, '--detach', ...(profile ? ['--profile', profile] : []), '--tool', tool]
    for (const k of ['model', 'effort'] as const) if (str(b[k], 80)) args.push(`--${k}`, str(b[k], 80))
    const prompt = str(b.prompt, 100_000)
    if (prompt) args.push('--', prompt)
    await fleet(args, cwd)
    return { name }
  }],

  ['POST', /^\/api\/agents\/([^/]+)\/send$/, async (req, [name]) => {
    agentOr404(name)
    const b = await body(req)
    if (typeof b.key === 'string') await sendKey(name, b.key).catch(e => { throw new HttpError(400, e.message) })
    else if (typeof b.text === 'string' && b.text.length <= 100_000) await sendText(name, b.text)
    else throw new HttpError(400, 'send {text} or {key}')
    return { ok: true }
  }],

  ['POST', /^\/api\/agents\/([^/]+)\/pause$/, async (_req, [name]) => {
    agentOr404(name)
    await fleet(['pause', name])
    return { ok: true }
  }],

  ['DELETE', /^\/api\/agents\/([^/]+)$/, async (_req, [name]) => {
    agentOr404(name)
    await fleet(['kill', name])
    return { ok: true }
  }],

  ['GET', /^\/api\/paused$/, async () => db.prepare('SELECT * FROM paused ORDER BY paused_at DESC').all()],

  ['POST', /^\/api\/paused\/(\d+)\/resume$/, async (_req, [id]) => {
    await fleet(['unpause', id, '--detach'])
    return { ok: true }
  }],

  ['DELETE', /^\/api\/paused\/(\d+)$/, async (_req, [id]) => {
    db.prepare('DELETE FROM paused WHERE id = ?').run(Number(id))
    return { ok: true }
  }],

  ['GET', /^\/api\/profiles$/, async () => db.prepare('SELECT * FROM profiles ORDER BY is_default DESC, name').all()],

  ['PUT', /^\/api\/profiles\/([^/]+)$/, async (req, [name]) => {
    const b = await body(req)
    if (!name || name.length > 80) throw new HttpError(400, 'profile name: 1-80 characters')
    if (!TOOLS.has(b.tool)) throw new HttpError(400, `unknown tool ${b.tool}`)
    if (b.is_default) db.prepare('UPDATE profiles SET is_default = 0').run()
    db.prepare(`INSERT INTO profiles (name, tool, model, effort, args, cwd, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET tool = excluded.tool, model = excluded.model, effort = excluded.effort,
      args = excluded.args, cwd = excluded.cwd, is_default = excluded.is_default`)
      .run(name, b.tool, str(b.model, 80) || null, str(b.effort, 20) || null, str(b.args, 1000) || null,
        str(b.cwd, 1000) || null, b.is_default ? 1 : 0)
    return { ok: true }
  }],

  ['DELETE', /^\/api\/profiles\/([^/]+)$/, async (_req, [name]) => {
    db.prepare('DELETE FROM profiles WHERE name = ?').run(name)
    return { ok: true }
  }],

  ['GET', /^\/api\/push\/key$/, async () => ({ key: publicKey })],

  ['POST', /^\/api\/push\/subscribe$/, async req => {
    try {
      subscribe(await body(req))
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    return { ok: true }
  }],

  ['POST', /^\/api\/hook$/, async req => {
    try {
      ingestHook(await body(req))
    } catch (e) {
      console.error('bad hook body:', (e as Error).message) // never let a hook fail; Claude ignores the reply anyway
    }
  }],
]

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2',
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  let file = normalize(join(DIST, path))
  if (!file.startsWith(DIST)) return send(res, 404)
  if (!existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html') // client-side routes
  if (!existsSync(file)) return send(res, 404, { error: 'dashboard not built: npm run build' })
  const hashed = file.includes(`${join(DIST, 'assets')}/`)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    // ?key=… once: remember it in a cookie and drop it from the address bar
    const given = url.searchParams.get('key')
    if (given !== null && keyOk(given)) {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
      url.searchParams.delete('key')
      res.writeHead(302, {
        'Set-Cookie': `fleet_key=${encodeURIComponent(given)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`,
        Location: url.pathname + url.search,
      })
      return res.end()
    }
    if (!url.pathname.startsWith('/api/')) {
      // the page itself is public (it holds no data); everything it fetches needs the key
      if (req.method !== 'GET') return send(res, 405)
      return serveStatic(req, res, url.pathname)
    }
    if (!authorized(req)) return send(res, 401, { error: 'open the dashboard link with ?key= first' })
    for (const [method, pattern, handler] of routes) {
      const m = url.pathname.match(pattern)
      if (m && req.method === method) {
        // names only ever reach tmux/fleet as argv entries or SQL parameters
        const data = await handler(req, m.slice(1).map(decodeURIComponent))
        return data === undefined ? send(res, 204) : send(res, 200, data)
      }
    }
    send(res, 404, { error: 'not found' })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    send(res, status, { error: (e as Error).message })
  }
})

if (import.meta.main) {
  attach(server, authorized)
  alerts.on('alert', a => notify(a).catch(e => console.error('notify failed:', e)))
  startPolling()
  server.listen(config.port, '127.0.0.1', () => console.log(`fleet dashboard on http://127.0.0.1:${config.port}`))
}
