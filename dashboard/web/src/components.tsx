import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, remember, type Agent, type Paused, type Profile, type Status } from './api.ts'
import { ScreenView } from './terminal.tsx'

export const TOOLS = ['claude', 'codex', 'cursor', 'copilot', 'agy'] as const
const TOOL_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', agy: 'Antigravity' }
const GLYPH: Record<string, string> = { claude: '✳', codex: '❯', cursor: '◢', copilot: '◉', agy: 'A' }
export const STATUS_LABEL: Record<Status, string> = {
  needs_you: 'Needs you', working: 'Working', done: 'Done', crashed: 'Crashed', unknown: 'Outside tmux',
}
export const ORDER: Status[] = ['needs_you', 'working', 'done', 'crashed', 'unknown']

export const toolLabel = (t: string) => TOOL_LABEL[t] ?? t

export const age = (s: number) =>
  !s ? '' : s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`

export const activity = (a: Agent) =>
  a.message || (a.status === 'crashed' ? `Crashed · ${a.exit}` : '') || a.task.replace(/^\[[a-z]+\]\s*/, '') || a.last_line

export function Avatar({ tool, status, size }: { tool: string; status?: Status; size?: 'lg' }) {
  return (
    <span className={`tool ${size ?? ''}`}>
      <span className={`av av-${tool}`}>{GLYPH[tool] ?? '?'}</span>
      {status && <span className={`st st-${status}`} aria-label={STATUS_LABEL[status]} />}
    </span>
  )
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

// ---------- sidebar ----------

export function Sidebar(props: {
  route: string; needs: number; paused: number; push: ReactNode
  profiles: Profile[]; onNew: (p?: Profile) => void; onCustom: () => void; onDeleteProfile: (p: Profile) => void
}) {
  return (
    <aside className="nav">
      <div className="brand"><span className="logo">F</span>Fleet</div>
      <NewAgentButton {...props} />
      <a className={`ni ${props.route === 'all' ? 'on' : ''}`} href="#/">
        <span className="sq" style={{ background: 'currentColor', opacity: 0.5 }} />All agents
        {props.needs > 0 && <span className="badge">{props.needs}</span>}
      </a>
      <div className="sec">Later</div>
      <a className={`ni ${props.route === 'paused' ? 'on' : ''}`} href="#/paused">
        <PauseIcon />Paused<b>{props.paused || ''}</b>
      </a>
      <div className="foot">{props.push}</div>
    </aside>
  )
}

export function NewAgentButton({ profiles, onNew, onCustom, onDeleteProfile }: {
  profiles: Profile[]; onNew: (p?: Profile) => void; onCustom: () => void; onDeleteProfile: (p: Profile) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    addEventListener('mousedown', away)
    return () => removeEventListener('mousedown', away)
  }, [open])
  const def = profiles.find(p => p.is_default)
  return (
    <div className="new" ref={ref}>
      <button className="new-main" onClick={() => onNew(def)} title={def ? `Quick start: ${def.name}` : 'Quick start: Claude'}>
        <PlusIcon />New agent
      </button>
      <button className="new-more" aria-label="Profiles and custom" aria-expanded={open} onClick={() => setOpen(!open)}>▾</button>
      {open && (
        <div className="menu" role="menu">
          {profiles.map(p => (
            <div className="menu-row" key={p.name}>
              <button role="menuitem" onClick={() => { setOpen(false); onNew(p) }}>
                <Avatar tool={p.tool} />
                <span className="menu-text"><b>{p.name}</b><small>{[toolLabel(p.tool), p.model, p.effort].filter(Boolean).join(' · ')}</small></span>
                {p.is_default ? <span className="chip">default</span> : null}
              </button>
              <button className="x" aria-label={`Delete profile ${p.name}`} onClick={() => onDeleteProfile(p)}>×</button>
            </div>
          ))}
          {profiles.length > 0 && <div className="menu-sep" />}
          <button role="menuitem" className="menu-custom" onClick={() => { setOpen(false); onCustom() }}>Custom…</button>
        </div>
      )}
    </div>
  )
}

export function CustomForm({ onClose, onStarted, onError }: {
  onClose: () => void; onStarted: (name: string) => void; onError: (e: Error) => void
}) {
  const [f, setF] = useState({
    name: '', tool: 'claude', model: '', effort: '', cwd: remember.get('cwd'), prompt: '', profile: '', isDefault: false,
  })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (f.profile.trim())
        await api.put(`/api/profiles/${encodeURIComponent(f.profile.trim())}`,
          { tool: f.tool, model: f.model, effort: f.effort, cwd: f.cwd, is_default: f.isDefault })
      const { name } = await api.post<{ name: string }>('/api/agents',
        { name: f.name, tool: f.tool, model: f.model, effort: f.effort, cwd: f.cwd, prompt: f.prompt })
      if (f.cwd) remember.set('cwd', f.cwd)
      onStarted(name)
    } catch (err) {
      onError(err as Error)
      setBusy(false)
    }
  }

  return (
    <Dialog title="New agent" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Name<input value={f.name} onChange={set('name')} placeholder="auto, e.g. claude-3f2a" pattern="[A-Za-z0-9._\-]{1,40}" /></label>
        <div className="form-row">
          <label>Tool<select value={f.tool} onChange={set('tool')}>{TOOLS.map(t => <option key={t} value={t}>{toolLabel(t)}</option>)}</select></label>
          <label>Model<input value={f.model} onChange={set('model')} placeholder="tool default" /></label>
          <label>Effort<select value={f.effort} onChange={set('effort')}>
            {['', 'low', 'medium', 'high', 'xhigh', 'max'].map(v => <option key={v} value={v}>{v || 'default'}</option>)}
          </select></label>
        </div>
        <label>Folder<input value={f.cwd} onChange={set('cwd')} placeholder="home folder" /></label>
        <label>First prompt<textarea rows={4} value={f.prompt} onChange={set('prompt')} placeholder="Optional. The agent starts working on this right away." /></label>
        <div className="form-row save">
          <label>Save as profile<input value={f.profile} onChange={set('profile')} placeholder="optional name" /></label>
          <label className="check"><input type="checkbox" checked={f.isDefault} onChange={set('isDefault')} disabled={!f.profile.trim()} />Make default</label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Start agent'}</button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- list ----------

export function AgentList({ agents, selected, header }: { agents: Agent[]; selected: string; header: ReactNode }) {
  return (
    <section className="list">
      {header}
      <div className="scroll">
        {ORDER.map(status => {
          const group = agents.filter(a => a.status === status)
          if (!group.length) return null
          return (
            <div key={status}>
              <div className="grp">{STATUS_LABEL[status]}</div>
              {group.map(a => (
                <a key={a.name} href={`#/agent/${encodeURIComponent(a.name)}`}
                  className={`it ${a.name === selected ? 'on' : ''} ${a.status === 'needs_you' ? 'need' : ''}`}>
                  <Avatar tool={a.tool} status={a.status} />
                  <span className="nm">{a.name}</span>
                  <span className="tm">{age(a.age_s)}</span>
                  <span className="pv">{activity(a)}</span>
                </a>
              ))}
            </div>
          )
        })}
        {!agents.length && <div className="empty">No agents running. Start one with <b>New agent</b>.</div>}
      </div>
    </section>
  )
}

export function PausedList({ items, header, onResume, onForget }: {
  items: Paused[]; header: ReactNode; onResume: (p: Paused) => void; onForget: (p: Paused) => void
}) {
  return (
    <section className="list">
      {header}
      <div className="scroll">
        {items.map(p => (
          <div className="it paused" key={p.id}>
            <Avatar tool={p.tool} />
            <span className="nm">{p.name}</span>
            <span className="tm">{new Date(p.paused_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            <span className="pv">{p.cwd.split('/').slice(-2).join('/')}</span>
            <span className="row-actions">
              <button className="btn small primary" onClick={() => onResume(p)}>Resume</button>
              <button className="btn small" onClick={() => onForget(p)}>Forget</button>
            </span>
          </div>
        ))}
        {!items.length && <div className="empty">Nothing paused. Pause an agent to park it here with its conversation.</div>}
      </div>
    </section>
  )
}

// ---------- agent view ----------

export function AgentView({ agent, onBack, onTerminal, onPause, onKill, send }: {
  agent: Agent; onBack: () => void; onTerminal: () => void; onPause: () => void; onKill: () => void
  send: (body: { text?: string; key?: string }) => Promise<void>
}) {
  const [menu, setMenu] = useState(false)
  return (
    <main className="det">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back to agents">‹</button>
        <Avatar tool={agent.tool} size="lg" />
        <div className="dh-text">
          <div className="t">{agent.name}</div>
          <div className="meta">
            <span className={`pill pill-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
            <span className="ellip">{toolLabel(agent.tool)} · {agent.cwd.split('/').pop() || '~'}</span>
          </div>
        </div>
        {agent.controllable && (
          <div className="acts">
            {agent.pid !== null && <button className="btn" onClick={onPause} disabled={!agent.session_id}
              title={agent.session_id ? 'Stop the agent, keep the conversation' : 'No resumable conversation found yet'}><PauseIcon /><span className="lbl">Pause</span></button>}
            <button className="btn" onClick={onTerminal}><TermIcon /><span className="lbl">Full terminal</span></button>
            <div className="more">
              <button className="btn" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
              {menu && (
                <div className="menu right" role="menu" onMouseLeave={() => setMenu(false)}>
                  <button role="menuitem" className="danger" onClick={() => { setMenu(false); onKill() }}>
                    {agent.pid === null ? 'Close session' : 'Kill agent'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </header>
      {agent.controllable ? (
        <>
          <ScreenView name={agent.name} />
          {agent.pid !== null && <Composer agent={agent} send={send} />}
          {agent.pid === null && <div className="ended">This agent exited ({agent.exit}). Its last screen is above.</div>}
        </>
      ) : (
        <div className="empty big">
          This agent was started in a plain terminal window, so the dashboard can see it but can't type into it.
          Start agents with <b>New agent</b> or <code>fleet new</code> to control them from here.
        </div>
      )}
    </main>
  )
}

function Composer({ agent, send }: { agent: Agent; send: (body: { text?: string; key?: string }) => Promise<void> }) {
  const [text, setText] = useState('')
  const replies = agent.quick_replies
  const nav = agent.status === 'needs_you' && !replies.length
  const submit = () => {
    if (!text.trim()) return
    const t = text
    setText('')
    send({ text: t }).catch(() => setText(t))
  }
  return (
    <div className="comp">
      <div className="qr">
        {replies.map(q => (
          <button key={q.key} className="q" onClick={() => send({ key: q.key })}><kbd>{q.key}</kbd>{q.label}</button>
        ))}
        {nav && <>
          <button className="q" onClick={() => send({ key: 'Up' })} aria-label="Up">↑</button>
          <button className="q" onClick={() => send({ key: 'Down' })} aria-label="Down">↓</button>
          <button className="q" onClick={() => send({ key: 'Enter' })}><kbd>⏎</kbd>Select</button>
        </>}
        <button className="q" onClick={() => send({ key: 'Escape' })}><kbd>esc</kbd>Interrupt</button>
      </div>
      <div className="row">
        <textarea id="composer" rows={1} value={text} placeholder={`Reply to ${agent.name}…`}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') e.currentTarget.blur()
          }} />
        <button className="send" onClick={submit} aria-label="Send" disabled={!text.trim()}><SendIcon /></button>
      </div>
    </div>
  )
}

// ---------- icons ----------

const PlusIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
const PauseIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor" /><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor" /></svg>
const TermIcon = () => <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
const SendIcon = () => <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
