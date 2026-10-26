// The agent list and each agent's status. `fleet json` is the source of truth for which agents exist; tmux panes
// add the screen and the exit code; Claude Code hooks (via `fleet hook`) give exact status for Claude.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { busy, detect, mode, question, quickReplies, workingLine, type QuickReply, type Status } from './detect.ts'
import { FLEET_BIN, REPO } from './store.ts'
import { capture, panes, run } from './tmux.ts'

export type Agent = {
  name: string            // tmux session name, or `pid-<pid>` for agents outside tmux (read-only)
  controllable: boolean   // in tmux, so the dashboard can type into it
  tool: string
  pid: number | null
  cwd: string
  task: string
  age_s: number
  session_id: string
  status: Status
  status_since: number
  quick_replies: QuickReply[]
  last_line: string
  message: string         // what a hook said, e.g. "Claude needs your permission to use Bash"
  exit: string            // "exit 1" / "killed by kill" for a dead pane
  mode: string            // footer mode, e.g. "auto mode" (Shift+Tab cycles it)
  working_line: string    // spinner line while busy, e.g. "Catapulting… (4s · ↓ 24 tokens)"
  ask: Ask | null         // a question or plan Claude is waiting on, answerable as a form (see openAsk)
}

export type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
export type Ask = { id: string; kind: 'question' | 'plan'; questions: Question[]; plan: string }

type FleetRow = { pid: number; tool: string; age_s: number; cwd: string; session: string | null; task: string; session_id: string }
type Hook = { status: Status; at: number; message: string }

export const alerts = new EventEmitter() // 'alert' (agent: Agent) on entering needs_you, done or crashed

let agents: Agent[] = []
let polled = false // true after the first refresh
const screens = new Map<string, { text: string; changedAt: number }>()
const tools = new Map<string, string>()           // session -> tool, remembered so dead panes keep their tool
const hooksBySession = new Map<string, Hook>()    // Claude session_id -> latest hook
const hooksByPane = new Map<string, Hook>()       // tmux pane id -> latest hook
const lastAlert = new Map<string, number>()       // `${name}:${status}` -> time
// An agent that appeared while we were watching (started, or a chat resumed into Fleet) is 'ready', not 'done',
// until it does real work: its screen redraws while it opens, which alone would read as working and then done.
const fresh = new Set<string>()

export const list = () => agents

const NOTIFY_NEEDS = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input'])

// Claude's questions and plans, held while `fleet hook ask` (a PermissionRequest hook) waits for the dashboard's
// answer. The terminal shows its own prompt meanwhile; once Claude moves on (any later hook from that session)
// the ask is dropped and the waiting hook exits.
type OpenAsk = Ask & { sid: string; pane: string; input: Record<string, unknown>; decision?: Record<string, unknown> }
const asks = new Map<string, OpenAsk>()
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

const dropAsks = (sid: string, pane: string) => {
  for (const [id, a] of asks) if ((sid && a.sid === sid) || (pane && a.pane === pane)) asks.delete(id)
}

export function openAsk(body: Record<string, unknown>) {
  const sid = String(body.session_id ?? ''), pane = typeof body.tmux_pane === 'string' ? body.tmux_pane : ''
  const input = (body.tool_input ?? {}) as Record<string, any>
  dropAsks(sid, pane)
  const id = randomUUID()
  const plan = body.tool_name === 'ExitPlanMode'
  asks.set(id, { id, kind: plan ? 'plan' : 'question', questions: plan ? [] : (input.questions ?? []), plan: plan ? String(input.plan ?? '') : '', sid, pane, input })
  poll().catch(() => {}) // show the form now, not on the next tick
  return { id }
}

/** The waiting hook asks every second: a decision once, then gone. */
export function pollAsk(id: string) {
  const a = asks.get(id)
  if (!a) return { gone: true }
  if (!a.decision) return {}
  asks.delete(id)
  return { decision: a.decision }
}

/** The form's answer: answers maps each question to a label (several joined with ", ") or your own text; a plan is
 * approved into auto or default (ask before edits) mode, like the terminal's two Yes options, or sent back with feedback. */
export function answerAsk(id: string, b: { answers?: unknown; approve?: unknown; feedback?: unknown }): string {
  const a = asks.get(id)
  if (!a || a.decision) return 'already answered'
  if (a.kind === 'plan') {
    const feedback = typeof b.feedback === 'string' ? b.feedback.trim() : ''
    a.decision = b.approve === 'auto' || b.approve === 'default'
      ? { behavior: 'allow', updatedInput: a.input, updatedPermissions: [{ type: 'setMode', mode: b.approve, destination: 'session' }] }
      : { behavior: 'deny', message: feedback || 'Not approved yet. Keep planning and ask me what to change.' }
    return ''
  }
  const given = (b.answers ?? {}) as Record<string, unknown>
  const answers: Record<string, string> = {}
  for (const q of a.questions) {
    const v = given[q.question]
    if (typeof v !== 'string' || !v.trim()) return `answer "${q.question}"`
    answers[q.question] = v.trim()
  }
  a.decision = { behavior: 'allow', updatedInput: { ...a.input, answers } }
  return ''
}

// What a `fleet hook` event means for the agent's status; null = no change, 'end' = forget this session.
export function hookStatus(body: Record<string, unknown>): Status | 'end' | null {
  const event = String(body.event ?? '')
  if (event === 'working') return 'working'
  if (event === 'done') return 'done'
  if (event === 'end') return 'end'
  if (event === 'notify') {
    const type = String(body.notification_type ?? '')
    // idle_prompt fires ~60 s after Claude finishes; that is still "done", not "needs you"
    if (NOTIFY_NEEDS.has(type)) return 'needs_you'
    if (type === 'agent_completed') return 'done'
  }
  return null
}

export function ingestHook(body: Record<string, unknown>) {
  const sid = String(body.session_id ?? '')
  const pane = typeof body.tmux_pane === 'string' ? body.tmux_pane : ''
  const status = hookStatus(body)
  // anything else this session does means its question was answered or dismissed, here or in the terminal
  if (status && status !== 'needs_you' && !ASK_TOOLS.has(String(body.tool_name ?? ''))) dropAsks(sid, pane)
  if (status === 'end') {
    hooksBySession.delete(sid)
    if (pane) hooksByPane.delete(pane)
    return
  }
  if (!status) return
  const hook = { status, at: Date.now(), message: status === 'needs_you' ? String(body.message ?? '') : '' }
  if (sid) hooksBySession.set(sid, hook)
  if (pane) hooksByPane.set(pane, hook)
}

function shownAsk(sid: string, pane: string): Ask | null {
  const a = [...asks.values()].find(x => !x.decision && ((sid && x.sid === sid) || (pane && x.pane === pane)))
  return a ? { id: a.id, kind: a.kind, questions: a.questions, plan: a.plan } : null
}

const lastLine = (screen: string) => screen.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? ''

async function refresh() {
  const [rows, paneList] = await Promise.all([
    run(FLEET_BIN, ['json'], REPO).then(out => JSON.parse(out) as FleetRow[]).catch(() => null),
    panes(),
  ])
  if (!rows) return // keep the last good list if fleet itself failed
  const now = Date.now()
  const prev = new Map(agents.map(a => [a.name, a]))
  const next: Agent[] = []
  const live = new Set<string>()

  for (const r of rows) {
    const name = r.session ?? `pid-${r.pid}`
    const pane = paneList.find(p => p.session === r.session)
    live.add(name)
    if (r.session) tools.set(r.session, r.tool)
    let screen = ''
    if (r.session) {
      screen = await capture(r.session).catch(() => '')
      const seen = screens.get(name)
      if (!seen || seen.text !== screen) screens.set(name, { text: screen, changedAt: now })
    }
    const quietMs = now - (screens.get(name)?.changedAt ?? 0)
    const hook = (pane && hooksByPane.get(pane.paneId)) || hooksBySession.get(r.session_id)
    const seen = r.session ? detect(r.tool, screen, quietMs) : null
    // outside tmux there is no screen; Claude's own session file still says busy/idle
    let status: Status = seen ?? (/^\[busy\]/.test(r.task) ? 'working' : /^\[(idle|waiting)\]/.test(r.task) ? 'done' : 'unknown')
    if (hook && seen !== 'needs_you') {
      // a needs_you hook goes stale once the screen moves on (answered from a real terminal); a working hook goes
      // stale when the screen has been quiet with no busy spinner (e.g. a conversation resumed into Fleet after its
      // old window was stopped mid-turn, so its last hook said "working")
      const stale = (hook.status === 'needs_you' && (screens.get(name)?.changedAt ?? 0) > hook.at + 1000)
        || (hook.status === 'working' && seen === 'done' && quietMs > 8000 && Date.now() - hook.at > 8000)
      if (!stale) status = hook.status
      if (status === 'done' && seen === 'waiting') status = 'waiting' // Stop hook fired, but a background job will wake it
    }
    if (!prev.has(name) && polled) fresh.add(name)
    const worked = (hook?.status === 'working' && status === 'working') || (r.session ? busy(r.tool, screen) : /^\[busy\]/.test(r.task))
    if (worked) fresh.delete(name) // answering a startup question (trust this folder?) isn't work
    if (status === 'done' && fresh.has(name)) status = 'ready'
    const ask = shownAsk(r.session_id, pane?.paneId ?? '')
    if (ask) status = 'needs_you' // the plan prompt has no menu hint the screen check knows
    next.push({
      name, controllable: !!r.session, tool: r.tool, pid: r.pid, cwd: r.cwd, task: r.task, age_s: r.age_s,
      session_id: r.session_id, status, status_since: now, quick_replies: status === 'needs_you' ? quickReplies(screen) : [],
      last_line: lastLine(screen), exit: '',
      message: ask ? (ask.kind === 'plan' ? 'Plan ready for your approval' : ask.questions[0]?.question ?? '') : status === 'needs_you' ? (hook?.message || question(screen)) : '',
      mode: mode(screen), working_line: status === 'working' ? workingLine(r.tool, screen) : '',
      ask,
    })
  }

  // Panes whose agent exited: fleet json no longer lists them, but the pane stays (remain-on-exit) with its exit code.
  for (const p of paneList.filter(p => p.dead && !live.has(p.session))) {
    const crashed = !!p.signal || (p.exitStatus ?? 0) !== 0
    const screen = await capture(p.session).catch(() => '')
    next.push({
      name: p.session, controllable: true, tool: tools.get(p.session) ?? prev.get(p.session)?.tool ?? 'unknown', pid: null,
      cwd: prev.get(p.session)?.cwd ?? '', task: prev.get(p.session)?.task ?? '', age_s: 0, session_id: '',
      status: crashed ? 'crashed' : 'done', status_since: now, quick_replies: [], last_line: lastLine(screen),
      message: '', exit: p.signal ? `killed by ${p.signal}` : `exit ${p.exitStatus ?? 0}`, mode: '', working_line: '', ask: null,
    })
  }

  for (const a of next) {
    const before = prev.get(a.name)
    if (before && before.status === a.status) a.status_since = before.status_since
    // Agents already running when the server starts don't alert; one started later alerts even on first sight
    // (it often opens straight into a question). A status re-entered within 30 s doesn't alert twice.
    const changed = before ? before.status !== a.status : polled
    if (changed && ['needs_you', 'done', 'crashed'].includes(a.status)) {
      const key = `${a.name}:${a.status}`
      if (now - (lastAlert.get(key) ?? 0) > 30_000) {
        lastAlert.set(key, now)
        alerts.emit('alert', a)
      }
    }
  }
  for (const name of screens.keys()) if (!next.some(a => a.name === name)) screens.delete(name)
  for (const name of fresh) if (!next.some(a => a.name === name)) fresh.delete(name)
  agents = next
  polled = true
}

// One refresh at a time: the timer and actions (new, pause, kill) both call this.
let inflight: Promise<void> | null = null
export async function poll() {
  while (inflight) await inflight.catch(() => {})
  inflight = refresh().finally(() => (inflight = null))
  return inflight
}

export function startPolling(ms = 2000) {
  const tick = () => poll().catch(err => console.error('poll failed:', err)).finally(() => setTimeout(tick, ms))
  tick()
}
