// Fleet dashboard server: binds to 127.0.0.1 only (`tailscale serve` publishes it to the tailnet over HTTPS)
// and requires the access key from ~/.fleet/config.json on every API and WebSocket request.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { improvePrompt, interviewPrompt, jarvisBrain, recommend, type JarvisAction } from './ai.ts'
import { changes } from './git.ts'
import { conversations, transcript } from './history.ts'
import * as ideas from './ideas.ts'
import { notify, publicKey, subscribe } from './push.ts'
import { alerts, answerAsk, ingestHook, list, openAsk, poll, pollAsk, startPolling } from './state.ts'
import { config, dailyBackup, db, FLEET_BIN, FLEET_DIR, saveConfig } from './store.ts'
import { capture, run, sendKey, sendText } from './tmux.ts'
import { liveTail } from './detect.ts'
import { aiBudget, usage } from './usage.ts'
import { kokoroInstalled, speech, voices } from './tts.ts'
import { readFileSync as readFile } from 'node:fs'
import * as J from './jarvis.ts'
import { FileError, findFiles, readText } from './files.ts'
import { AREAS, areaColor, notePrompt } from '../web/src/areas.ts'
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

const efforts = new Map<number, string>()
async function claudeEffort(pid: number | null) {
  if (pid && efforts.has(pid)) return efforts.get(pid)!
  const args = pid ? await run('ps', ['-o', 'args=', '-p', String(pid)]).catch(() => '') : ''
  let e = String(args).match(/--effort[= ](\S+)/)?.[1] ?? ''
  if (!e) try { e = JSON.parse(readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')).effortLevel ?? '' } catch {}
  if (pid) efforts.set(pid, e)
  return e
}

// ---------- folders ----------
// An agent's folder follows its conversation id when it has one (so it survives pause/resume and renames),
// otherwise its session name.
const placements = () => new Map((db.prepare('SELECT key, folder_id FROM placements').all() as { key: string; folder_id: number }[]).map(r => [r.key, r.folder_id]))

function place(key: string, folder: number | null) {
  if (folder === null) db.prepare('DELETE FROM placements WHERE key = ?').run(key)
  else db.prepare('INSERT INTO placements (key, folder_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET folder_id = excluded.folder_id').run(key, folder)
}

/** The folder named after a note's area, made if missing: an agent started from a note lands in it. */
function areaFolder(area: string) {
  const f = db.prepare('SELECT id FROM folders WHERE name = ?').get(area) as { id: number } | undefined
  if (f) return f.id
  const pos = (db.prepare('SELECT coalesce(max(position), 0) + 1 AS p FROM folders').get() as { p: number }).p
  return Number(db.prepare('INSERT INTO folders (name, color, position) VALUES (?, ?, ?)').run(area, areaColor(area) ?? '#8e8e93', pos).lastInsertRowid)
}
// one folder per area, once, so a folder you delete stays deleted (until a note in that area starts an agent)
if (!config.area_folders) { for (const a of AREAS) areaFolder(a.name); saveConfig({ area_folders: true }) }
const ideaFolder = (b: any, area: string | null) => (typeof b.folder_id === 'number' ? b.folder_id : area ? areaFolder(area) : undefined)

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
    return { ...a, key: agentKey(a), folder_id: folder, queued: queue.filter(q => q.agent === a.name).map(({ id, text }) => ({ id, text })) }
  })
}

// ---------- queued messages ----------
// Typed while the agent was busy: each goes out once the agent has finished its turn (and has had a turn since the
// last queued one went out), instead of interrupting it. A message is only removed once it has actually been sent;
// one whose agent has gone stays (Agents shows it) until you send it somewhere else or delete it.
type Queued = { id: number; agent: string; text: string; at: number }
let queue = db.prepare('SELECT id, agent, text, at FROM queued ORDER BY id').all() as Queued[]
const loadQueue = () => { queue = db.prepare('SELECT id, agent, text, at FROM queued ORDER BY id').all() as Queued[] }
async function sendOne(q: Queued, to = q.agent) {
  await sendText(to, q.text)
  db.prepare('DELETE FROM queued WHERE id = ?').run(q.id)
  loadQueue()
}
const sentAt = new Map<string, number>()
const IDLE = new Set(['done', 'ready', 'waiting'])

async function sendQueued() {
  for (const a of list()) {
    const next = queue.find(q => q.agent === a.name)
    if (!next || !a.controllable || !IDLE.has(a.status)) continue
    const last = sentAt.get(a.name) ?? 0
    if (a.status_since < last && Date.now() - last < 20_000) continue // still hasn't picked up the last one (or the send failed: retry in 20 s)
    sentAt.set(a.name, Date.now())
    await sendOne(next).catch(e => console.error(`couldn't send queued message to ${a.name}, keeping it:`, (e as Error).message))
  }
}

function usageText(u: Awaited<ReturnType<typeof usage>>) {
  return u.map(p => `${p.tool}: ${p.windows.length ? p.windows.map(w => `${w.label} ${w.pct}% used`).join(', ') : 'unknown'}`).join('\n')
}

function jarvisContext() {
  const agents = list().map(a => `- ${a.name} (${a.tool}, ${a.status === 'waiting' ? 'turn done, waiting on its own background job, not on you' : a.status.replace('_', ' ')})${a.message ? `: asking "${a.message}"` : a.task ? `: ${a.task.replace(/^\[[a-z]+\]\s*/, '')}` : ''}${a.quick_replies.length ? ` options: ${a.quick_replies.map(q => `${q.key}=${q.label}`).join(', ')}` : ''}${a.controllable ? '' : ' (read-only)'}`)
  const lists = ideas.lists().map(l => `${l.name} (${l.open} open)`).join(', ')
  return `Agents:\n${agents.join('\n') || '- none running'}\nIdea lists: ${lists}\nTime: ${new Date().toLocaleString()}`
}

const budget = () => aiBudget(config.jarvis_warn_pct ?? 5, config.jarvis_max_pct ?? 10)

type JarvisOpts = { threadId?: number; override?: boolean }

/** Carry out one action. Anything Claude wants to do to an agent only gets here after you approve it. */
async function doAction(a: JarvisAction, turn = Date.now()): Promise<string> {
  const target = a.agent ? list().find(x => x.name === a.agent && x.controllable) : undefined
  if ((a.type === 'reply' || a.type === 'key' || a.type === 'pause') && !target) throw new Error(`no agent named ${a.agent}`)
  if (a.type === 'reply') await sendText(target!.name, a.text)
  if (a.type === 'key') await sendKey(target!.name, a.key)
  if (a.type === 'pause') await fleet(['pause', target!.name, ...(a.text ? ['--until', a.text] : [])])
  if (a.type === 'start') return `started ${(await startAgent({ tool: a.tool || undefined, model: a.model, effort: a.effort, prompt: a.text, name: a.name })).name}`
  if (a.type === 'idea') ideas.logChange(turn, ideas.addIdea(a.text, a.list || 'Brain Dump'), null)
  if (a.type === 'idea_edit') {
    const e = a.edit
    const cur = e && ideas.idea(e.id)
    if (!e || !cur) throw new Error(`no idea #${e?.id}`)
    ideas.logChange(turn, e.id, cur)
    if (e.done === 'delete') { ideas.deleteIdea(e.id); return `deleted “${cur.text.slice(0, 60)}”` }
    ideas.updateIdea(e.id, {
      text: e.text.trim() || undefined, notes: e.notes || undefined, list: e.list.trim() || undefined,
      done: e.done ? e.done === 'done' : undefined, priority: e.priority ? ['none', 'low', 'medium', 'high'].indexOf(e.priority) : undefined,
    })
    return `${e.done === 'done' ? 'checked off' : 'updated'} “${(e.text.trim() || cur.text).slice(0, 60)}”${e.list.trim() && e.list.trim() !== cur.list ? ` → ${e.list.trim()}` : ''}`
  }
  if (a.type === 'remember') J.remember(a.text)
  if (a.type === 'mac' && a.mac) return (await fleet(['mac', ...J.macArgv(a.mac)])).trim()
  return `${a.type === 'remember' ? 'remembered' : a.type}${a.agent ? ` ${a.agent}` : ''}${a.key ? ` ${a.key}` : ''}`
}

async function settle(p: J.Proposal, approve: boolean, turn = Date.now()) {
  if (!approve) { J.settleProposal(p.id, 'declined'); return `declined: ${p.summary}` }
  try {
    const result = await doAction(JSON.parse(p.action), turn)
    J.settleProposal(p.id, 'approved', result)
    return result
  } catch (e) {
    J.settleProposal(p.id, 'approved', `failed: ${(e as Error).message}`)
    return `couldn't: ${(e as Error).message}`
  }
}

async function runJarvis(said: string, opts: JarvisOpts = {}) {
  const t = J.threadFor(opts.threadId)
  J.addMessage(t, 'you', said)
  const done: string[] = []
  const turn = Date.now() // ties this turn's idea changes together for Undo
  const reply = (say: string, meta: object = {}) => {
    const m = { done, ...(ideas.changedIn(turn) ? { undo: turn } : {}), ...meta }
    J.addMessage(t, 'bot', say, m)
    return { thread_id: t.id, say, ...m }
  }

  if (J.isGoodbye(said)) return reply(['Talk soon.', 'Very good.', "I'll be here."][Math.floor(Math.random() * 3)], { mode: 'instant', end: true })

  if (/^(undo( that| it)?|take (that|it) back|put (that|it) back)[.!]*$/i.test(said.trim())) {
    const n = ideas.undoTurn()
    return reply(n ? `Undone. Your ideas are back to how they were before my last change${n === 1 ? '' : `s (${n})`}.` : "There's nothing of mine to undo.", { mode: 'instant' })
  }

  // "yes" / "no" answers whatever is waiting for approval in this conversation
  const pending = J.pendingProposals(t.id)
  const word = pending.length ? J.approvalWord(said) : null
  if (word) {
    for (const p of pending) done.push(await settle(p, word === 'yes', turn))
    await poll()
    return reply(word === 'yes' ? (pending.length === 1 ? 'Done.' : `Done, all ${pending.length}.`) : 'Cancelled.', { mode: 'instant' })
  }

  // "what should I do next?" / "rank my notes": Claude sets priorities on every open idea
  if (J.wantsRanking(said)) {
    const b0 = await budget()
    if (b0.jarvis_pct >= b0.max_pct && !opts.override)
      return reply(`That needs Claude, and I'm past the ${b0.max_pct} percent weekly cap. Tap Allow once to go ahead.`, { blocked: said, mode: 'claude' })
    for (const i of ideas.ideas().filter(i => !i.done)) ideas.logChange(turn, i.id, i) // ranking rewrites priorities: keep them for Undo
    const r = await ideas.rankAll(jarvisContext())
    done.push(`ranked: ${r.counts[0]} high, ${r.counts[1]} medium, ${r.counts[2]} low`)
    const top = r.next.slice(0, 3).map((i, n) => `${n + 1}, ${i.text.replace(/\s+/g, ' ').slice(0, 80)}`).join('; ')
    return reply(`${r.summary}${top ? ` Next up: ${top}.` : ''}`, { mode: 'claude' })
  }

  // music, "what's playing", "what's on today", "open Spotify": straight to the Mac, no Claude
  const mac = J.instantMac(said)
  if (mac) {
    try {
      const out = (await fleet(['mac', ...mac.argv])).trim()
      return reply(out.replace(/\n/g, '. ').replace(/\s*\[[^\]]+\]/g, ''), { mode: 'instant' })
    } catch (e) {
      return reply((e as Error).message, { mode: 'instant' })
    }
  }

  // things you said directly ("tell walmart yes") happen right away
  const quick = J.instant(said, list())
  if (quick) {
    for (const a of quick.actions) done.push(await doAction(a, turn).catch(e => `couldn't ${a.type}: ${(e as Error).message}`))
    if (quick.actions.length) await poll()
    return reply(quick.say, { mode: 'instant' })
  }

  const b = await budget()
  if (b.jarvis_pct >= b.max_pct && !opts.override)
    return reply(`I've used about ${b.jarvis_pct.toFixed(1)} percent of your weekly Claude limit this week, past the ${b.max_pct} percent cap you set. Quick commands still work; tap Allow once to go past it.`, { blocked: said, mode: 'claude' })
  const project = config.cwd && existsSync(config.cwd) ? config.cwd : homedir()
  const context = jarvisContext()
  let answer
  try {
    answer = await jarvisBrain(said, context, J.memory(), { cwd: project, resume: t.session_id ?? undefined })
  } catch (e) {
    if (!t.session_id) throw e
    answer = await jarvisBrain(said, context, J.memory(), { cwd: project }) // the old session is gone: carry on fresh
  }
  if (answer.session_id) J.setThreadSession(t.id, answer.session_id)

  // Jarvis only reads; anything that changes an agent becomes a proposal you approve
  const proposed = []
  for (const a of answer.value.actions) {
    if (!J.needsApproval(a)) done.push(await doAction(a, turn).catch(e => `couldn't ${a.type}: ${(e as Error).message}`))
    else proposed.push(J.propose(t.id, a))
  }
  const after = await budget()
  return reply(answer.value.say, {
    mode: 'claude', proposals: proposed, end: answer.value.end,
    warning: after.jarvis_pct >= after.warn_pct ? `Jarvis has used ${after.jarvis_pct.toFixed(1)}% of your weekly Claude limit this week.` : undefined,
  })
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

  ['POST', /^\/api\/agents\/([^/]+)\/queue$/, async (req, [name]) => {
    const a = agentOr404(name)
    const text = (await body(req)).text
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new HttpError(400, 'queue {text}')
    db.prepare('INSERT INTO queued (agent, text, at) VALUES (?, ?, ?)').run(a.name, text, Math.floor(Date.now() / 1000))
    loadQueue()
    await sendQueued() // it may already be free
    return { ok: true }
  }],
  // messages whose agent has gone: kept so you can send them elsewhere or delete them
  ['GET', /^\/api\/queued\/left$/, async () => { const live = new Set(list().map(a => a.name)); return queue.filter(q => !live.has(q.agent)) }],
  ['DELETE', /^\/api\/queued\/(\d+)$/, async (_req, [id]) => { db.prepare('DELETE FROM queued WHERE id = ?').run(int(id)); loadQueue(); return { ok: true } }],
  ['POST', /^\/api\/queued\/(\d+)\/send$/, async (req, [id]) => {
    const q = queue.find(x => x.id === int(id)) ?? (() => { throw new HttpError(404, 'already sent') })()
    const to = str((await body(req)).to, 40) || q.agent // {to}: another agent, for one whose agent has gone
    agentOr404(to) // gone: 404, so the message stays
    await sendOne(q, to)
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
    const outside = list().find(a => a.name === name && !a.controllable && a.pid)
    // outside Fleet there's no session to close, so stop the process itself (its conversation stays in History)
    if (outside) await fleet(['kill', String(outside.pid)])
    else { agentOr404(name); await fleet(['kill', name]) }
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
  // ---------- files an agent mentions ----------
  ['GET', /^\/api\/files\/read$/, async req => {
    const sp = new URL(req.url ?? '', 'http://x').searchParams
    try { return readText(sp.get('cwd') ?? '', sp.get('path') ?? '') } catch (e) { throw e instanceof FileError ? new HttpError(e.status, e.message) : e }
  }],
  ['GET', /^\/api\/files\/search$/, async req => {
    const sp = new URL(req.url ?? '', 'http://x').searchParams
    try { return await findFiles(sp.get('cwd') ?? '', str(sp.get('q'), 200)) } catch (e) { throw e instanceof FileError ? new HttpError(e.status, e.message) : e }
  }],
  ['GET', /^\/api\/transcript$/, async req => {
    const sp = new URL(req.url ?? '', 'http://x').searchParams
    const t = await transcript(sp.get('tool') ?? '', sp.get('id') ?? '')
    if (!t) throw new HttpError(404, 'no transcript for that conversation')
    if (t.version === sp.get('v')) return { version: t.version, same: true }
    // Claude doesn't log its effort: the live agent's --effort, else your Claude Code default
    const a = sp.get('agent') ? list().find(x => x.name === sp.get('agent')) : undefined
    return t.status && !t.status.effort && sp.get('tool') === 'claude' ? { ...t, status: { ...t.status, effort: await claudeEffort(a?.pid ?? null) } } : t
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
  ['POST', /^\/api\/mac\/check$/, async req => {
    const what = str((await body(req)).what, 20)
    const argv: Record<string, string[]> = { calendar: ['calendar', 'today'], reminders: ['reminders'], music: ['music', 'now'], apps: ['apps'], screen: ['screen'] }
    if (!argv[what]) throw new HttpError(400, 'check one of calendar, reminders, music, apps, screen')
    try {
      const out = await run(FLEET_BIN, ['mac', ...argv[what]])
      return { ok: true, detail: out.trim().split('\n')[0].slice(0, 120) }
    } catch (e: any) {
      return { ok: false, detail: (e.stderr || e.message || '').trim().split('\n').pop() }
    }
  }],
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
    const started = await startAgent({ tool: 'claude', name: `interview-${slug}`, prompt: interviewPrompt(topic), cwd: str(b.cwd, 1000),
      folder_id: typeof b.idea_id === 'number' ? ideaFolder(b, ideas.idea(b.idea_id)?.area ?? null) : b.folder_id })
    if (typeof b.idea_id === 'number') ideas.updateIdea(b.idea_id, { agent: started.name })
    return started
  }],
  ['POST', /^\/api\/jarvis$/, async req => {
    const b = await body(req)
    const said = str(b.text, 2000).trim()
    if (!said) throw new HttpError(400, "didn't catch that")
    return runJarvis(said, { threadId: typeof b.thread_id === 'number' ? b.thread_id : undefined, override: b.override === true })
  }],
  ['GET', /^\/api\/jarvis\/status$/, async () => ({ budget: await budget(), memory: J.memory() })],
  ['GET', /^\/api\/jarvis\/threads$/, async () => J.threads()],
  ['POST', /^\/api\/jarvis\/threads$/, async () => J.newThread()],
  ['GET', /^\/api\/jarvis\/threads\/(\d+)$/, async (_req, [id]) => {
    const t = J.thread(int(id))
    if (!t) throw new HttpError(404, 'no such conversation')
    return { thread: t, messages: J.messages(t.id), proposals: J.proposals(t.id) }
  }],
  ['DELETE', /^\/api\/jarvis\/threads\/(\d+)$/, async (_req, [id]) => { J.deleteThread(int(id)); return { ok: true } }],
  ['POST', /^\/api\/jarvis\/proposals\/(\d+)\/(approve|decline)$/, async (_req, [id, verb]) => {
    const p = J.proposal(int(id))
    if (!p) throw new HttpError(404, 'no such proposal')
    if (p.state !== 'pending') return { state: p.state, result: p.result }
    const turn = Date.now()
    const result = await settle(p, verb === 'approve', turn)
    const t = J.thread(p.thread_id)
    if (t) J.addMessage(t, 'bot', verb === 'approve' ? `Done: ${result}` : 'Cancelled.', { done: [result], mode: 'instant', ...(ideas.changedIn(turn) ? { undo: turn } : {}) })
    await poll()
    return { state: verb === 'approve' ? 'approved' : 'declined', result }
  }],

  ['POST', /^\/api\/jarvis\/undo$/, async req => ({ undone: ideas.undoTurn(Number((await body(req)).turn) || undefined) })],
  ['POST', /^\/api\/jarvis\/log$/, async req => {
    console.log(`jarvis voice: ${str((await body(req)).event, 200)}`)
    return { ok: true }
  }],

  // ---------- ideas ----------
  ['GET', /^\/api\/lists$/, async () => ideas.lists()],
  ['POST', /^\/api\/lists$/, async req => {
    const b = await body(req)
    const name = str(b.name, 60).trim()
    if (!name) throw new HttpError(400, 'list name: 1-60 characters')
    if (b.kind !== undefined && !ideas.KINDS.includes(b.kind)) throw new HttpError(400, 'kind: ideas or checklist')
    try { ideas.createList(name, str(b.color, 20) || undefined, b.kind) } catch { throw new HttpError(409, `there's already a list called ${name}`) }
    return { ok: true }
  }],
  ['PATCH', /^\/api\/lists\/(\d+)$/, async (req, [id]) => {
    const b = await body(req)
    try {
      ideas.updateList(int(id), { name: str(b.name, 60).trim() || undefined, color: str(b.color, 20) || undefined,
        position: typeof b.position === 'number' ? b.position : undefined, archived: typeof b.archived === 'boolean' ? b.archived : undefined,
        kind: str(b.kind, 20) || undefined, section: b.section === null ? null : str(b.section, 20) || undefined })
    } catch (e) { throw new HttpError(400, (e as Error).message) }
    return { ok: true }
  }],
  ['DELETE', /^\/api\/lists\/(\d+)$/, async (_req, [id]) => {
    try { ideas.deleteList(int(id)) } catch (e) { throw new HttpError(400, (e as Error).message) }
    return { ok: true }
  }],
  ['GET', /^\/api\/ideas$/, async req => {
    const sp = new URL(req.url ?? '', 'http://x').searchParams
    const agents = new Map(list().map(a => [a.name, a.status]))
    // open=1: only open ones (All notes), a fraction of everything
    const rows = sp.get('priority') ? ideas.prioritized() : ideas.ideas(sp.get('list') ?? undefined).filter(i => !sp.get('open') || !i.done)
    return rows.map(i => ({ ...i, agent_status: i.agent ? agents.get(i.agent) ?? 'gone' : null }))
  }],
  ['POST', /^\/api\/ideas\/rank$/, async () => ideas.rankAll(jarvisContext())],
  ['POST', /^\/api\/ideas$/, async req => {
    const b = await body(req)
    const text = str(b.text, 10_000).trim()
    if (!text) throw new HttpError(400, 'empty idea')
    try {
      return { id: ideas.addIdea(text, str(b.list, 60).trim() || 'Brain Dump', { area: str(b.area, 40) || undefined }) }
    } catch (e) { throw new HttpError(400, (e as Error).message) }
  }],
  // steps picked out of an agent's reply ("Add to-dos" under a chat message)
  ['POST', /^\/api\/ideas\/many$/, async req => {
    const b = await body(req)
    const list = str(b.list, 60).trim() || 'For you'
    const agent = str(b.agent, 80) || undefined
    const items = (Array.isArray(b.items) ? b.items.slice(0, 200) : []).map((i: any) => ({ text: str(i?.text, 10_000).trim(), notes: str(i?.notes, 50_000) })).filter((i: { text: string }) => i.text)
    if (!items.length) throw new HttpError(400, 'no to-dos')
    if (b.checklist === true) ideas.ensureList(list, 'checklist')
    for (const i of items) ideas.addIdea(i.text, list, { notes: i.notes, agent })
    return { list, added: items.length }
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
        priority: typeof b.priority === 'number' ? b.priority : undefined,
        area: b.area === null ? null : str(b.area, 40) || undefined,
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
    const started = await startAgent({ ...b, folder_id: ideaFolder(b, item.area), name: str(b.name, 40) || slug, prompt: str(b.prompt, 100_000) || notePrompt(item) })
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

  // Claude's questions and plans as a form: `fleet hook ask` opens one and polls it, the chat answers it
  ['POST', /^\/api\/ask$/, async req => openAsk(await body(req))],
  ['GET', /^\/api\/ask\/([\w-]+)$/, async (_req, [id]) => pollAsk(id)],
  ['POST', /^\/api\/ask\/([\w-]+)\/answer$/, async (req, [id]) => {
    const err = answerAsk(id, await body(req))
    if (err) throw new HttpError(409, err)
    await poll()
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

// Photos from the phone, kept on the Mac. sips (built into macOS) turns HEIC and huge camera shots into a JPEG at
// most 2000 px wide, which every agent's image reader takes; the agent gets the file's path.
const UPLOADS = join(FLEET_DIR, 'uploads')
async function upload(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 50 << 20) throw new HttpError(413, 'photo too large')
    chunks.push(c)
  }
  if (!size) throw new HttpError(400, 'no photo')
  mkdirSync(UPLOADS, { recursive: true, mode: 0o700 })
  const name = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomBytes(3).toString('hex')}`
  const raw = join(UPLOADS, `${name}.in`)
  writeFileSync(raw, Buffer.concat(chunks), { mode: 0o600 })
  try {
    await run('sips', ['-Z', '2000', '-s', 'format', 'jpeg', raw, '--out', join(UPLOADS, `${name}.jpg`)])
  } catch {
    throw new HttpError(400, "that file isn't a photo")
  } finally {
    unlinkSync(raw)
  }
  return join(UPLOADS, `${name}.jpg`)
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost'), t0 = Date.now()
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
    // the Siri shortcut's two calls are logged, so a run that goes quiet on the phone shows where it stopped
    const siri = url.pathname === '/api/jarvis/say' || url.pathname === '/api/tts'
    if (!authorized(req)) {
      if (siri) console.log(`${url.pathname}: refused, wrong or missing key (an old shortcut? add it again from Settings)`)
      return send(res, 401, { error: 'open the dashboard link with ?key= first' })
    }
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const b = await body(req)
      const text = str(b.text, 2000).replace(/\u2063/g, '').trim() // (the Siri shortcut's end-of-conversation mark)
      if (!text) { console.log('/api/tts: nothing to say'); throw new HttpError(400, 'nothing to say') }
      const engine = ['kokoro', 'mac'].includes(b.engine) ? b.engine : config.voice_engine === 'mac' ? 'mac' : 'kokoro'
      if (engine === 'kokoro' && !kokoroInstalled()) throw new HttpError(409, 'natural voice not installed: run fleet tts install')
      const file = await speech(text, engine, str(b.voice, 60) || config.voice || (engine === 'kokoro' ? 'bm_george' : ''), Number(b.speed) || config.voice_speed || 1)
      console.log(`/api/tts: ${text.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Cache-Control': 'private, max-age=3600' })
      return res.end(readFile(file))
    }
    const END = '\u2063'
// Siri's shortcut: plain text in, plain text out, so Shortcuts can speak the reply with nothing in between.
    // Always 200: whatever comes back is what Siri says.
    if (url.pathname === '/api/jarvis/say' && req.method === 'POST') {
      const said = str((await body(req)).text, 2000).trim()
      console.log(`/api/jarvis/say: heard ${said.length} chars`)
      const say = !said ? `Okay.${END}` : await runJarvis(said) // silence ends the conversation (and the shortcut resumes your music)
        // a trailing invisible separator (U+2063) tells the shortcut the conversation is over; Siri doesn't read it out
        .then(r => r.say + ((r as { proposals?: unknown[] }).proposals?.length ? ' That needs your OK in Fleet.' : '') + ((r as { end?: boolean }).end ? END : ''))
        .catch(e => `Sorry, that didn't work: ${(e as Error).message}`)
      console.log(`/api/jarvis/say: answered ${say.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(say)
    }
    // the "Hey Siri, Jarvis" shortcut, signed by macOS, with this dashboard's address and key inside
    if (url.pathname === '/api/siri/shortcut' && req.method === 'GET') {
      const file = join(FLEET_DIR, 'Jarvis.shortcut')
      // the address the phone used to get here (Tailscale serve's name), so the shortcut calls back the same way
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim()
      if (!/\.ts\.net$/.test(host.replace(/:\d+$/, ''))) throw new HttpError(400, 'open the dashboard through your tailnet address (on your phone) to make the Siri shortcut')
      await run(FLEET_BIN, ['dash', 'siri', file, host]).catch(e => { throw new HttpError(500, String(e.stderr || e.message).trim().slice(0, 300)) })
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Jarvis.shortcut"', 'Cache-Control': 'no-store' })
      return res.end(readFile(file))
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') return send(res, 200, { path: await upload(req) })
    const photo = url.pathname.match(/^\/api\/uploads\/([\w-]+\.jpg)$/)
    if (photo && req.method === 'GET') {
      const file = join(UPLOADS, photo[1])
      if (!existsSync(file)) throw new HttpError(404, 'no such photo')
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
      return createReadStream(file).pipe(res)
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
  setInterval(() => sendQueued().catch(e => console.error('queue check failed:', e)), 2000)
  dailyBackup()
  setInterval(dailyBackup, 3600_000)
  server.listen(config.port, '127.0.0.1', () => console.log(`fleet dashboard on http://127.0.0.1:${config.port}`))
}
