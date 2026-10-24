// Fleet dashboard server: binds to 127.0.0.1 only (`tailscale serve` publishes it to the tailnet over HTTPS)
// and requires the access key from ~/.fleet/config.json on every API and WebSocket request.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { improvePrompt, interviewPrompt, jarvisBrain, recommend, type JarvisReply } from './ai.ts'
import { changes } from './git.ts'
import { conversations, transcript } from './history.ts'
import * as ideas from './ideas.ts'
import { notify, publicKey, subscribe } from './push.ts'
import { alerts, ingestHook, list, poll, startPolling } from './state.ts'
import { config, db, FLEET_BIN, saveConfig } from './store.ts'
import { capture, run, sendKey, sendText } from './tmux.ts'
import { liveTail } from './detect.ts'
import { aiBudget, usage } from './usage.ts'
import { kokoroInstalled, speech, voices } from './tts.ts'
import { readFileSync as readFile } from 'node:fs'
import * as J from './jarvis.ts'
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

type StartOpts = { name?: string; profile?: string; tool?: string; model?: string; effort?: string; cwd?: string; prompt?: string; resume?: string; folder_id?: number }

/** Start an agent the same way `fleet new` does; used by New agent, Ideas, Interview, History and Jarvis. */
export async function startAgent(b: StartOpts): Promise<{ name: string }> {
  const profile = str(b.profile, 80)
  const prof = profile ? db.prepare('SELECT * FROM profiles WHERE name = ?').get(profile) as any : null
  if (profile && !prof) throw new HttpError(404, `no profile named ${profile}`)
  const tool = str(b.tool, 20) || prof?.tool || 'claude'
  if (!TOOLS.has(tool)) throw new HttpError(400, `unknown tool ${tool}`)
  let name = str(b.name, 40) || `${tool}-${randomBytes(2).toString('hex')}`
  if (!NAME.test(name)) name = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `${tool}-${randomBytes(2).toString('hex')}`
  if (list().some(a => a.name === name)) name = `${name.slice(0, 35)}-${randomBytes(2).toString('hex')}`
  const cwd = str(b.cwd, 1000) || prof?.cwd || config.cwd || homedir()
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new HttpError(400, `no such folder: ${cwd}`)
  const args = ['new', name, '--detach', ...(profile ? ['--profile', profile] : []), '--tool', tool]
  for (const k of ['model', 'effort', 'resume'] as const) if (str(b[k], 80)) args.push(`--${k}`, str(b[k], 80))
  const prompt = str(b.prompt, 100_000)
  if (prompt) args.push('--', prompt)
  await fleet(args, cwd)
  if (typeof b.folder_id === 'number') place(`name:${name}`, b.folder_id)
  await poll() // so the next list the page sees already reflects this
  return { name }
}

// ---------- folders ----------
// An agent's folder follows its conversation id when it has one (so it survives pause/resume and renames),
// otherwise its session name.
const placements = () => new Map((db.prepare('SELECT key, folder_id FROM placements').all() as { key: string; folder_id: number }[]).map(r => [r.key, r.folder_id]))

function place(key: string, folder: number | null) {
  if (folder === null) db.prepare('DELETE FROM placements WHERE key = ?').run(key)
  else db.prepare('INSERT INTO placements (key, folder_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET folder_id = excluded.folder_id').run(key, folder)
}

const agentKey = (a: { name: string; session_id: string }) => (a.session_id ? `sid:${a.session_id}` : `name:${a.name}`)

function decoratedAgents() {
  const map = placements()
  return list().map(a => {
    let folder = map.get(`sid:${a.session_id}`) ?? map.get(`name:${a.name}`) ?? null
    if (a.session_id && !map.has(`sid:${a.session_id}`) && map.has(`name:${a.name}`)) { // adopt the id once it shows up
      place(`sid:${a.session_id}`, map.get(`name:${a.name}`)!)
      place(`name:${a.name}`, null)
      folder = map.get(`name:${a.name}`)!
    }
    return { ...a, key: agentKey(a), folder_id: folder }
  })
}

function usageText(u: Awaited<ReturnType<typeof usage>>) {
  return u.map(p => `${p.tool}: ${p.windows.length ? p.windows.map(w => `${w.label} ${w.pct}% used`).join(', ') : 'unknown'}`).join('\n')
}

function jarvisContext() {
  const agents = list().map(a => `- ${a.name} (${a.tool}, ${a.status.replace('_', ' ')})${a.message ? `: asking "${a.message}"` : a.task ? `: ${a.task.replace(/^\[[a-z]+\]\s*/, '')}` : ''}${a.quick_replies.length ? ` options: ${a.quick_replies.map(q => `${q.key}=${q.label}`).join(', ')}` : ''}${a.controllable ? '' : ' (read-only)'}`)
  const lists = ideas.lists().map(l => `${l.name} (${l.open} open)`).join(', ')
  return `Agents:\n${agents.join('\n') || '- none running'}\nIdea lists: ${lists}\nTime: ${new Date().toLocaleString()}`
}

const budget = () => aiBudget(config.jarvis_warn_pct ?? 5, config.jarvis_max_pct ?? 10)

async function runJarvis(said: string, override = false) {
  let reply: JarvisReply | null = J.instant(said, list())
  let used: 'instant' | 'claude' = 'instant'
  if (!reply) {
    const b = await budget()
    if (b.jarvis_pct >= b.max_pct && !override)
      return { say: `I've used about ${b.jarvis_pct.toFixed(1)} percent of your weekly Claude limit this week, past the ${b.max_pct} percent cap you set. Quick commands still work; say "allow" in the panel to go past it once.`, done: [], blocked: true, mode: used }
    const project = config.cwd && existsSync(config.cwd) ? config.cwd : homedir()
    const prior = J.session()
    try {
      const a = await jarvisBrain(said, jarvisContext(), J.memory(), { cwd: project, resume: prior })
      reply = a.value
      if (a.session_id) J.saveSession(a.session_id)
    } catch (e) {
      if (!prior) throw e
      J.resetSession() // yesterday's or a broken conversation: start fresh once
      const a = await jarvisBrain(said, jarvisContext(), J.memory(), { cwd: project })
      reply = a.value
      if (a.session_id) J.saveSession(a.session_id)
    }
    used = 'claude'
  }
  const done: string[] = []
  for (const a of reply.actions) {
    try {
      const target = a.agent ? list().find(x => x.name === a.agent && x.controllable) : undefined
      if ((a.type === 'reply' || a.type === 'key' || a.type === 'pause') && !target) throw new Error(`no agent named ${a.agent}`)
      if (a.type === 'reply') await sendText(target!.name, a.text)
      if (a.type === 'key') await sendKey(target!.name, a.key)
      if (a.type === 'pause') await fleet(['pause', target!.name, ...(a.text ? ['--until', a.text] : [])])
      if (a.type === 'start') done.push(`started ${(await startAgent({ tool: a.tool || undefined, model: a.model, effort: a.effort, prompt: a.text, name: a.name })).name}`)
      if (a.type === 'idea') ideas.addIdea(a.text, a.list || 'Brain Dump')
      if (a.type === 'remember') J.remember(a.text)
      if (a.type !== 'start') done.push(`${a.type}${a.agent ? ` ${a.agent}` : ''}${a.key ? ` ${a.key}` : ''}`)
    } catch (e) {
      done.push(`couldn't ${a.type}: ${(e as Error).message}`)
    }
  }
  if (reply.actions.length) await poll()
  const b = used === 'claude' ? await budget() : null
  return { say: reply.say, done, mode: used, warning: b && b.jarvis_pct >= b.warn_pct ? `Jarvis has used ${b.jarvis_pct.toFixed(1)}% of your weekly Claude limit this week.` : undefined }
}

// Paused agents with a resume time come back on their own (checked every 30 s while the dashboard runs).
async function resumeDue() {
  const due = db.prepare('SELECT id, name FROM paused WHERE resume_at IS NOT NULL AND resume_at <= ?').all(Math.floor(Date.now() / 1000)) as { id: number; name: string }[]
  for (const p of due) {
    try {
      await run(FLEET_BIN, ['unpause', String(p.id), '--detach'])
      notify({ name: p.name, status: 'resumed', message: 'Back from its scheduled pause', exit: '', last_line: '', task: '' } as any).catch(() => {})
    } catch (e) {
      console.error(`couldn't resume ${p.name}:`, (e as Error).message)
      db.prepare('UPDATE paused SET resume_at = NULL WHERE id = ?').run(p.id) // don't retry forever; it stays in Paused
    }
  }
  if (due.length) await poll()
}

const int = (v: string) => Number.parseInt(v, 10)
const ideaOr404 = (id: string) => ideas.idea(int(id)) ?? (() => { throw new HttpError(404, 'no such idea') })()

type Route = (req: IncomingMessage, params: string[]) => Promise<unknown>
const routes: [string, RegExp, Route][] = [
  ['GET', /^\/api\/agents$/, async () => decoratedAgents()],

  ['POST', /^\/api\/agents$/, async req => startAgent(await body(req))],

  ['POST', /^\/api\/agents\/([^/]+)\/send$/, async (req, [name]) => {
    agentOr404(name)
    const b = await body(req)
    if (typeof b.key === 'string') await sendKey(name, b.key).catch(e => { throw new HttpError(400, e.message) })
    else if (typeof b.text === 'string' && b.text.length <= 100_000) await sendText(name, b.text)
    else throw new HttpError(400, 'send {text} or {key}')
    return { ok: true }
  }],

  ['POST', /^\/api\/agents\/([^/]+)\/pause$/, async (req, [name]) => {
    agentOr404(name)
    const until = (await body(req)).until
    await fleet(['pause', name, ...(typeof until === 'number' && until > Date.now() / 1000 ? ['--until', String(Math.floor(until))] : [])])
    await poll() // so the next list the page sees already reflects this
    return { ok: true }
  }],

  ['DELETE', /^\/api\/agents\/([^/]+)$/, async (_req, [name]) => {
    agentOr404(name)
    await fleet(['kill', name])
    await poll() // so the next list the page sees already reflects this
    return { ok: true }
  }],

  ['POST', /^\/api\/agents\/([^/]+)\/rename$/, async (req, [name]) => {
    agentOr404(name)
    const to = str((await body(req)).to, 40)
    if (!NAME.test(to)) throw new HttpError(400, 'name: letters, digits, . _ - (up to 40)')
    await fleet(['rename', name, to])
    const map = placements()
    if (map.has(`name:${name}`)) { place(`name:${to}`, map.get(`name:${name}`)!); place(`name:${name}`, null) }
    db.prepare('UPDATE ideas SET agent = ? WHERE agent = ?').run(to, name)
    await poll()
    return { name: to }
  }],

  ['POST', /^\/api\/agents\/([^/]+)\/adopt$/, async (req, [name]) => {
    const a = list().find(a => a.name === name)
    if (!a?.pid || a.controllable) throw new HttpError(400, `${name} isn't an agent outside Fleet`)
    const b = await body(req)
    const out = await fleet(['adopt', String(a.pid), ...(str(b.name, 40) ? [str(b.name, 40)] : []), ...(b.force ? ['--force'] : [])])
    await poll()
    const moved = out.match(/into Fleet as (\S+)\./)?.[1]
    return { name: moved ?? name }
  }],

  ['GET', /^\/api\/agents\/([^/]+)\/peek$/, async (_req, [name]) => {
    agentOr404(name)
    return { lines: liveTail(await capture(name).catch(() => '')) }
  }],

  ['GET', /^\/api\/agents\/([^/]+)\/changes$/, async (_req, [name]) => {
    const a = list().find(a => a.name === name)
    if (!a?.cwd) throw new HttpError(404, `no agent named ${name}`)
    return changes(a.cwd, Math.floor(Date.now() / 1000) - a.age_s)
  }],

  // ---------- folders ----------
  ['GET', /^\/api\/folders$/, async () => db.prepare('SELECT * FROM folders ORDER BY position, id').all()],
  ['POST', /^\/api\/folders$/, async req => {
    const b = await body(req)
    const name = str(b.name, 60).trim()
    if (!name) throw new HttpError(400, 'folder name: 1-60 characters')
    const pos = (db.prepare('SELECT coalesce(max(position), 0) + 1 AS p FROM folders').get() as { p: number }).p
    const r = db.prepare('INSERT INTO folders (name, color, position) VALUES (?, ?, ?)').run(name, str(b.color, 20) || '#8e8e93', pos)
    return { id: Number(r.lastInsertRowid) }
  }],
  ['PATCH', /^\/api\/folders\/(\d+)$/, async (req, [id]) => {
    const b = await body(req)
    if (str(b.name, 60).trim()) db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(str(b.name, 60).trim(), int(id))
    if (str(b.color, 20)) db.prepare('UPDATE folders SET color = ? WHERE id = ?').run(str(b.color, 20), int(id))
    if (typeof b.position === 'number') db.prepare('UPDATE folders SET position = ? WHERE id = ?').run(b.position, int(id))
    return { ok: true }
  }],
  ['DELETE', /^\/api\/folders\/(\d+)$/, async (_req, [id]) => {
    db.prepare('DELETE FROM placements WHERE folder_id = ?').run(int(id)) // its agents go back to All, nothing else changes
    db.prepare('DELETE FROM folders WHERE id = ?').run(int(id))
    return { ok: true }
  }],
  ['PUT', /^\/api\/placements$/, async req => {
    const b = await body(req)
    if (!/^(sid|name):[\w.-]{1,80}$/.test(String(b.key))) throw new HttpError(400, 'bad key')
    place(b.key, typeof b.folder_id === 'number' ? b.folder_id : null)
    return { ok: true }
  }],

  // ---------- history + chat ----------
  ['GET', /^\/api\/history$/, async req => {
    const q = new URL(req.url ?? '', 'http://x').searchParams.get('q')?.toLowerCase().trim() ?? ''
    const map = placements()
    const running = new Map(list().filter(a => a.session_id).map(a => [a.session_id, a.name]))
    return (await conversations())
      .filter(c => !q || `${c.title} ${c.prompt} ${c.cwd}`.toLowerCase().includes(q))
      .map(c => ({ ...c, key: `sid:${c.id}`, folder_id: map.get(`sid:${c.id}`) ?? null, running: running.get(c.id) ?? null }))
  }],
  ['GET', /^\/api\/transcript$/, async req => {
    const sp = new URL(req.url ?? '', 'http://x').searchParams
    const t = await transcript(sp.get('tool') ?? '', sp.get('id') ?? '')
    if (!t) throw new HttpError(404, 'no transcript for that conversation')
    return t.version === sp.get('v') ? { version: t.version, same: true } : t
  }],
  ['POST', /^\/api\/history\/resume$/, async req => {
    const b = await body(req)
    if (b.tool !== 'claude' && b.tool !== 'codex') throw new HttpError(400, 'only Claude and Codex conversations can be resumed from here')
    const slug = String(b.title || b.tool).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
    return startAgent({ tool: b.tool, resume: str(b.id, 80), cwd: str(b.cwd, 1000), name: slug || undefined })
  }],

  // ---------- usage + smart features ----------
  ['GET', /^\/api\/usage$/, async () => usage()],
  ['GET', /^\/api\/settings$/, async () => {
    const { key, port, ...rest } = config
    return { ...rest, cwd: config.cwd ?? '', ai_model: config.ai_model ?? 'sonnet', jarvis_warn_pct: config.jarvis_warn_pct ?? 5,
      jarvis_max_pct: config.jarvis_max_pct ?? 10, voice_engine: config.voice_engine ?? (kokoroInstalled() ? 'kokoro' : 'device'),
      voice: config.voice ?? 'bm_george', voice_speed: config.voice_speed ?? 1, kokoro: kokoroInstalled() }
  }],
  ['PATCH', /^\/api\/settings$/, async req => {
    const b = await body(req)
    const patch: Record<string, unknown> = {}
    if (typeof b.cwd === 'string') {
      if (b.cwd && (!existsSync(b.cwd) || !statSync(b.cwd).isDirectory())) throw new HttpError(400, `no such folder: ${b.cwd}`)
      patch.cwd = b.cwd || undefined
    }
    if (['sonnet', 'haiku', 'opus'].includes(b.ai_model)) patch.ai_model = b.ai_model
    for (const k of ['jarvis_warn_pct', 'jarvis_max_pct'] as const) if (typeof b[k] === 'number' && b[k] > 0 && b[k] <= 100) patch[k] = b[k]
    if (['kokoro', 'mac', 'device'].includes(b.voice_engine)) patch.voice_engine = b.voice_engine
    if (typeof b.voice === 'string' && b.voice.length <= 60) patch.voice = b.voice
    if (typeof b.voice_speed === 'number' && b.voice_speed >= 0.6 && b.voice_speed <= 1.6) patch.voice_speed = b.voice_speed
    saveConfig(patch)
    return { ok: true }
  }],
  ['GET', /^\/api\/tts\/voices$/, async () => voices()],
  ['POST', /^\/api\/ai\/improve$/, async req => {
    const b = await body(req)
    if (!str(b.text, 20_000).trim()) throw new HttpError(400, 'nothing to improve')
    const project = str(b.cwd, 1000) || config.cwd || ''
    return improvePrompt(b.text, project && existsSync(project) ? project : '')
  }],
  ['POST', /^\/api\/ai\/recommend$/, async req => {
    const b = await body(req)
    if (!str(b.task, 20_000).trim()) throw new HttpError(400, 'describe the task first')
    return recommend(b.task, usageText(await usage()))
  }],
  ['POST', /^\/api\/interview$/, async req => {
    const b = await body(req)
    const topic = str(b.topic, 20_000).trim()
    if (!topic) throw new HttpError(400, 'what should the interview be about?')
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    const started = await startAgent({ tool: 'claude', name: `interview-${slug}`, prompt: interviewPrompt(topic), cwd: str(b.cwd, 1000), folder_id: b.folder_id })
    if (typeof b.idea_id === 'number') ideas.updateIdea(b.idea_id, { agent: started.name })
    return started
  }],
  ['POST', /^\/api\/jarvis$/, async req => {
    const b = await body(req)
    const said = str(b.text, 2000).trim()
    if (!said) throw new HttpError(400, "didn't catch that")
    return runJarvis(said, b.override === true)
  }],
  ['GET', /^\/api\/jarvis\/status$/, async () => ({ budget: await budget(), memory: J.memory(), session: !!J.session() })],
  ['POST', /^\/api\/jarvis\/reset$/, async () => { J.resetSession(); return { ok: true } }],

  // ---------- ideas ----------
  ['GET', /^\/api\/lists$/, async () => ideas.lists()],
  ['POST', /^\/api\/lists$/, async req => {
    const b = await body(req)
    const name = str(b.name, 60).trim()
    if (!name) throw new HttpError(400, 'list name: 1-60 characters')
    try { ideas.createList(name, str(b.color, 20) || undefined) } catch { throw new HttpError(409, `there's already a list called ${name}`) }
    return { ok: true }
  }],
  ['PATCH', /^\/api\/lists\/(\d+)$/, async (req, [id]) => {
    const b = await body(req)
    try {
      ideas.updateList(int(id), { name: str(b.name, 60).trim() || undefined, color: str(b.color, 20) || undefined,
        position: typeof b.position === 'number' ? b.position : undefined, archived: typeof b.archived === 'boolean' ? b.archived : undefined })
    } catch (e) { throw new HttpError(400, (e as Error).message) }
    return { ok: true }
  }],
  ['DELETE', /^\/api\/lists\/(\d+)$/, async (_req, [id]) => {
    try { ideas.deleteList(int(id)) } catch (e) { throw new HttpError(400, (e as Error).message) }
    return { ok: true }
  }],
  ['GET', /^\/api\/ideas$/, async req => {
    const listName = new URL(req.url ?? '', 'http://x').searchParams.get('list') ?? undefined
    const agents = new Map(list().map(a => [a.name, a.status]))
    return ideas.ideas(listName).map(i => ({ ...i, agent_status: i.agent ? agents.get(i.agent) ?? 'gone' : null }))
  }],
  ['POST', /^\/api\/ideas$/, async req => {
    const b = await body(req)
    const text = str(b.text, 10_000).trim()
    if (!text) throw new HttpError(400, 'empty idea')
    return { id: ideas.addIdea(text, str(b.list, 60).trim() || 'Brain Dump') }
  }],
  ['PATCH', /^\/api\/ideas\/(\d+)$/, async (req, [id]) => {
    ideaOr404(id)
    const b = await body(req)
    try {
      return ideas.updateIdea(int(id), {
        text: typeof b.text === 'string' && b.text.trim() ? b.text.trim().slice(0, 10_000) : undefined,
        notes: typeof b.notes === 'string' ? b.notes.slice(0, 50_000) : undefined,
        list: str(b.list, 60).trim() || undefined, done: typeof b.done === 'boolean' ? b.done : undefined,
        repeat: b.repeat === null ? null : str(b.repeat, 20) || undefined, position: typeof b.position === 'number' ? b.position : undefined,
        agent: b.agent === null ? null : undefined, clearSuggestion: b.clearSuggestion === true,
      })
    } catch (e) { throw new HttpError(400, (e as Error).message) }
  }],
  ['DELETE', /^\/api\/ideas\/(\d+)$/, async (_req, [id]) => {
    ideas.deleteIdea(int(id))
    return { ok: true }
  }],
  ['POST', /^\/api\/ideas\/sort$/, async () => ({ suggested: await ideas.suggestSorting() })],
  ['POST', /^\/api\/ideas\/(\d+)\/start$/, async (req, [id]) => {
    const item = ideaOr404(id)
    const b = await body(req)
    const slug = item.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28)
    const started = await startAgent({ ...b, name: str(b.name, 40) || slug, prompt: str(b.prompt, 100_000) || `${item.text}${item.notes ? `\n\n${item.notes}` : ''}` })
    ideas.updateIdea(item.id, { agent: started.name })
    return started
  }],
  ['POST', /^\/api\/ideas\/import$/, async () => {
    try {
      return { output: (await run(FLEET_BIN, ['import-notes'])).trim() }
    } catch (e: any) {
      throw new HttpError(403, (e.stderr || e.message || 'import failed').trim())
    }
  }],

  ['GET', /^\/api\/paused$/, async () => db.prepare('SELECT * FROM paused ORDER BY paused_at DESC').all()],

  ['POST', /^\/api\/paused\/(\d+)\/resume$/, async (_req, [id]) => {
    await fleet(['unpause', id, '--detach'])
    await poll() // so the next list the page sees already reflects this
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
  ['POST', /^\/api\/push\/test$/, async () => {
    await notify({ name: 'Fleet', status: 'test', message: 'Notifications work. This is what an agent alert looks like.', exit: '', last_line: '', task: '' } as any)
    return { ok: true }
  }],

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
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const b = await body(req)
      const text = str(b.text, 2000).trim()
      if (!text) throw new HttpError(400, 'nothing to say')
      const engine = ['kokoro', 'mac'].includes(b.engine) ? b.engine : config.voice_engine === 'mac' ? 'mac' : 'kokoro'
      if (engine === 'kokoro' && !kokoroInstalled()) throw new HttpError(409, 'natural voice not installed: run fleet tts install')
      const file = await speech(text, engine, str(b.voice, 60) || config.voice || (engine === 'kokoro' ? 'bm_george' : ''), Number(b.speed) || config.voice_speed || 1)
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Cache-Control': 'private, max-age=3600' })
      return res.end(readFile(file))
    }
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
  setInterval(() => resumeDue().catch(e => console.error('resume check failed:', e)), 30_000)
  server.listen(config.port, '127.0.0.1', () => console.log(`fleet dashboard on http://127.0.0.1:${config.port}`))
}
