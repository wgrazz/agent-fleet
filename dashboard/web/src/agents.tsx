import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api, remember, type Conversation, type LiveAgent, type Message, type Paused, type RepoChanges } from './api.ts'
import { activity, age, ago, Avatar, isPhone, ORDER, PauseIcon, SendIcon, STATUS_LABEL, TermIcon, toolLabel, useHold } from './components.tsx'
import { ScreenView } from './terminal.tsx'

// ---------- list ----------

export function AgentList({ agents, selected, header, past, onMenu, empty }: {
  agents: LiveAgent[]; selected: string; header: ReactNode; past?: Conversation[]; empty?: ReactNode
  onMenu: (a: LiveAgent, x: number, y: number) => void
}) {
  return (
    <section className="list">
      {header}
      <div className="scroll">
        {ORDER.map(status => {
          const group = agents.filter(a => a.controllable && a.status === status)
          if (!group.length) return null
          return (
            <div key={status}>
              <div className="grp">{STATUS_LABEL[status]}</div>
              {group.map(a => <AgentRow key={a.name} a={a} on={a.name === selected} onMenu={(x, y) => onMenu(a, x, y)} />)}
            </div>
          )
        })}
        {agents.some(a => !a.controllable) && (
          <div className="outside">
            <div className="grp">Outside Fleet<span className="grp-hint">plain terminal windows · hold one to add it</span></div>
            {agents.filter(a => !a.controllable).map(a => <AgentRow key={a.name} a={a} on={a.name === selected} onMenu={(x, y) => onMenu(a, x, y)} />)}
          </div>
        )}
        {past && past.length > 0 && (
          <div>
            <div className="grp">Past conversations</div>
            {past.map(c => <ConversationRow key={c.id} c={c} />)}
          </div>
        )}
        {!agents.length && !past?.length && (empty ?? <div className="empty">No agents running. Start one with <b>New agent</b>.</div>)}
      </div>
    </section>
  )
}

// drag-to-folder is a mouse thing; on a touch screen a draggable link fights the long-press menu
const touch = matchMedia('(pointer: coarse)').matches

function AgentRow({ a, on, onMenu }: { a: LiveAgent; on: boolean; onMenu: (x: number, y: number) => void }) {
  const hold = useHold(onMenu)
  return (
    <a href={`#/agent/${encodeURIComponent(a.name)}`} draggable={!touch} onDragStart={e => e.dataTransfer.setData('fleet/key', a.key)}
      className={`it ${on ? 'on' : ''} ${a.status === 'needs_you' && a.controllable ? 'need' : ''} ${a.controllable ? '' : 'outside-row'}`} {...hold}>
      <Avatar tool={a.tool} status={a.status} />
      <span className="nm">{a.name}</span>
      <span className="tm">{age(a.age_s)}</span>
      <span className="pv">{activity(a)}</span>
    </a>
  )
}

export function ConversationRow({ c, on, onMenu }: { c: Conversation; on?: boolean; onMenu?: (x: number, y: number) => void }) {
  const hold = useHold(onMenu ?? (() => {}))
  const href = c.running ? `#/agent/${encodeURIComponent(c.running)}` : `#/history/${c.tool}/${c.id}`
  return (
    <a href={href} draggable={!touch} onDragStart={e => e.dataTransfer.setData('fleet/key', c.key)} className={`it ${on ? 'on' : ''}`} {...(onMenu ? hold : {})}>
      <Avatar tool={c.tool} status={c.running ? 'working' : undefined} />
      <span className="nm">{c.title || c.prompt || 'Untitled'}</span>
      <span className="tm">{ago(c.updated)}</span>
      <span className="pv">{c.running ? `Running as ${c.running}` : `${c.cwd.split('/').pop() || '~'}${c.title && c.prompt ? ` · ${c.prompt}` : ''}`}</span>
    </a>
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
            <span className="pv">{p.resume_at ? `Back ${new Date(p.resume_at * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : p.cwd.split('/').slice(-2).join('/')}</span>
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

type Tab = 'chat' | 'terminal' | 'changes'

export function AgentView({ agent, onBack, onTerminal, onPause, onMenu, onAdopt, send }: {
  agent: LiveAgent; onBack: () => void; onTerminal: () => void; onPause: () => void; onMenu: (x: number, y: number) => void
  onAdopt: () => void; send: (body: { text?: string; key?: string }) => Promise<void>
}) {
  const [pending, setPending] = useState('')
  const sendTracked = (body: { text?: string; key?: string }) => {
    if (body.text) setPending(body.text)
    return send(body).catch(e => { setPending(''); throw e })
  }
  const chat = (agent.tool === 'claude' || agent.tool === 'codex') && !!agent.session_id
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = remember.get(isPhone() ? 'tab.phone' : 'tab.desk') as Tab
    return saved === 'chat' && !chat ? 'terminal' : saved || (isPhone() && chat ? 'chat' : 'terminal')
  })
  const setTab = (t: Tab) => { setTabState(t); remember.set(isPhone() ? 'tab.phone' : 'tab.desk', t) }
  const shown = tab === 'chat' && !chat ? 'terminal' : tab
  return (
    <main className="det">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <Avatar tool={agent.tool} size="lg" />
        <div className="dh-text">
          <div className="t">{agent.name}</div>
          <div className="meta">
            <span className={`pill pill-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
            <span className="ellip">{toolLabel(agent.tool)} · {agent.cwd.split('/').pop() || '~'}</span>
          </div>
        </div>
        {!agent.controllable && agent.pid !== null && agent.session_id && (
          <div className="acts"><button className="btn primary" onClick={onAdopt}>Add to Fleet</button></div>
        )}
        {agent.controllable && (
          <div className="acts">
            {agent.pid !== null && <button className="btn" onClick={onPause} disabled={!agent.session_id}
              title={agent.session_id ? 'Stop the agent, keep the conversation' : 'No resumable conversation found yet'}><PauseIcon /><span className="lbl">Pause</span></button>}
            <button className="btn" onClick={onTerminal} title="Full terminal"><TermIcon /><span className="lbl">Terminal</span></button>
            <button className="btn" aria-label="More" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.right - 220, r.bottom + 4) }}>⋯</button>
          </div>
        )}
      </header>
      {agent.controllable && (
        <div className="tabs-row" role="tablist">
          {chat && <button role="tab" aria-selected={shown === 'chat'} onClick={() => setTab('chat')}>Chat</button>}
          <button role="tab" aria-selected={shown === 'terminal'} onClick={() => setTab('terminal')}>Screen</button>
          <button role="tab" aria-selected={shown === 'changes'} onClick={() => setTab('changes')}>Changes</button>
        </div>
      )}
      {!agent.controllable ? (
        chat ? (
          <>
            <ChatView tool={agent.tool} id={agent.session_id} live working={agent.status === 'working' ? agent.working_line || 'Working…' : agent.status === 'waiting' ? 'Waiting on a background job, it picks up again when that finishes' : ''} />
            <div className="ended">This one runs in a plain terminal window, so it's read-only here. <b>Add to Fleet</b> moves it into Fleet with the same conversation, so you can answer it from anywhere.</div>
          </>
        ) : (
          <div className="empty big">
            This agent was started in a plain terminal window, so the dashboard can see it but can't type into it.
            Start agents with <b>New agent</b> or <code>fleet new</code> to control them from here.
          </div>
        )
      ) : shown === 'chat' ? (
        <ChatView tool={agent.tool} id={agent.session_id} live waiting={agent.status === 'needs_you' ? agent.message : ''}
          working={agent.status === 'working' ? agent.working_line || 'Working…' : agent.status === 'waiting' ? 'Waiting on a background job, it picks up again when that finishes' : ''} pending={pending} onSeen={() => setPending('')} peek={agent.name} />
      ) : shown === 'changes' ? (
        <ChangesView name={agent.name} />
      ) : (
        <ScreenView name={agent.name} />
      )}
      {agent.controllable && agent.pid !== null && <Composer agent={agent} send={sendTracked} />}
      {agent.controllable && agent.pid === null && <div className="ended">This agent exited ({agent.exit}). Its last screen is kept under Screen.</div>}
    </main>
  )
}

function Composer({ agent, send }: { agent: LiveAgent; send: (body: { text?: string; key?: string }) => Promise<void> }) {
  const [text, setText] = useState(() => remember.get(`draft.${agent.name}`))
  const replies = agent.quick_replies
  const nav = agent.status === 'needs_you' && !replies.length
  const keep = (t: string) => { setText(t); remember.set(`draft.${agent.name}`, t) }
  const submit = () => {
    if (!text.trim()) return
    const t = text
    keep('')
    send({ text: t }).catch(() => keep(t))
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
        {(agent.mode || ['claude', 'copilot', 'agy'].includes(agent.tool)) && (
          <button className="q mode" onClick={() => send({ key: 'BTab' })} title="Shift+Tab: cycle the agent's mode"><kbd>⇧⇥</kbd>{agent.mode || 'Mode'}</button>
        )}
      </div>
      <div className="row">
        <textarea id="composer" rows={1} value={text} placeholder={`Reply to ${agent.name}…`} enterKeyHint="send"
          onChange={e => keep(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isPhone()) {
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

// ---------- chat ----------

/** A conversation as chat bubbles, read from the tool's own log. Live views poll and stick to the bottom. */
export function ChatView({ tool, id, live, waiting, working, pending, onSeen, peek }: {
  tool: string; id: string; live?: boolean; waiting?: string; working?: string; pending?: string; onSeen?: () => void; peek?: string
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    let version = ''
    let stop = false
    const load = () => api.get<{ version: string; same?: boolean; messages?: Message[] }>(`/api/transcript?tool=${tool}&id=${encodeURIComponent(id)}&v=${version}`)
      .then(r => { if (!stop && !r.same && r.messages) { version = r.version; setMessages(r.messages) } })
      .catch(e => !stop && setError(e.message))
    load()
    const t = live ? setInterval(load, 2000) : 0
    return () => { stop = true; clearInterval(t) }
  }, [tool, id, live])

  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, waiting, working, pending])

  // what you just sent shows right away, until it appears in the agent's own log
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
  const seen = !!pending && !!messages?.some(m => m.role === 'user' && norm(m.text).includes(norm(pending).slice(0, 60)))
  useEffect(() => { if (seen) onSeen?.() }, [seen]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="empty big">{error}</div>
  if (!messages) return <div className="chat"><div className="empty">Loading…</div></div>
  // runs of tool calls collapse into one line
  const blocks: (Message | Message[])[] = []
  for (const m of messages) {
    const last = blocks.at(-1)
    if (m.role === 'tool' && Array.isArray(last)) last.push(m)
    else blocks.push(m.role === 'tool' ? [m] : m)
  }
  return (
    <div className="chat" ref={box} onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {blocks.map((b, i) => Array.isArray(b) ? <ToolRun key={i} tools={b} /> : (
        <div key={i} className={`bubble ${b.role}`}><Markdown text={b.text} /></div>
      ))}
      {pending && !seen && <div className="bubble user sending">{pending}</div>}
      {working && <div className="bubble working"><span className="dots"><i /><i /><i /></span>{working}</div>}
      {working && peek && <LivePeek name={peek} />}
      {waiting && <div className="bubble waiting">Waiting for you: {waiting}</div>}
      {!messages.length && <div className="empty">No messages yet.</div>}
    </div>
  )
}

/** The last lines of the agent's screen while it works: the closest thing to watching it think. */
function LivePeek({ name }: { name: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let stop = false
    const load = () => api.get<{ lines: string[] }>(`/api/agents/${encodeURIComponent(name)}/peek`).then(r => !stop && setLines(r.lines)).catch(() => {})
    load()
    const t = setInterval(load, 1500)
    return () => { stop = true; clearInterval(t) }
  }, [name])
  if (!lines.length) return null
  return (
    <button className={`peek ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label={open ? 'Show less' : 'Show more of the live screen'}>
      <span className="peek-label">Live</span>
      <pre>{lines.slice(open ? -20 : -5).join('\n')}</pre>
    </button>
  )
}

function ToolRun({ tools }: { tools: Message[] }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 1) return <div className="toolline">⚙ {tools[0].text}</div>
  return (
    <div className="toolline">
      <button className="link" onClick={() => setOpen(!open)}>⚙ {tools.length} tool calls · {tools.at(-1)!.text.split(' · ')[0]}{open ? '' : '…'}</button>
      {open && tools.map((t, i) => <div key={i} className="toolline sub">{t.text}</div>)}
    </div>
  )
}

/** Just enough markdown for agent replies: code blocks, inline code, bold, headings, lists, links. */
export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?/)
  return (
    <>
      {parts.map((part, i) => i % 2 ? <pre key={i}><code>{part.replace(/\n$/, '')}</code></pre> : (
        <Fragment key={i}>{part.split(/\n{2,}/).filter(p => p.trim()).map((para, j) => {
          const lines = para.split('\n')
          if (lines.every(l => /^\s*([-*•]|\d+\.)\s/.test(l)))
            return <ul key={j}>{lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s/, ''))}</li>)}</ul>
          const h = para.match(/^#{1,4}\s+(.*)$/)
          if (h && lines.length === 1) return <p key={j} className="md-h">{inline(h[1])}</p>
          return <p key={j}>{lines.map((l, k) => <Fragment key={k}>{k > 0 && <br />}{inline(l)}</Fragment>)}</p>
        })}</Fragment>
      ))}
    </>
  )
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:[^)\s]+\)|https?:\/\/[^\s)]+)/g
  let last = 0
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={m.index}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<b key={m.index}>{t.slice(2, -2)}</b>)
    else if (t.startsWith('[')) {
      const [, label, url] = t.match(/^\[([^\]]+)\]\((.+)\)$/)!
      out.push(<a key={m.index} href={url} target="_blank" rel="noreferrer">{label}</a>)
    } else out.push(<a key={m.index} href={t} target="_blank" rel="noreferrer">{t}</a>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

// ---------- changes ----------

export function ChangesView({ name }: { name: string }) {
  const [repos, setRepos] = useState<RepoChanges[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const load = () => api.get<RepoChanges[]>(`/api/agents/${encodeURIComponent(name)}/changes`).then(setRepos).catch(e => setError(e.message))
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [name])
  if (error) return <div className="empty big">{error}</div>
  if (!repos) return <div className="changes"><div className="empty">Checking git…</div></div>
  if (!repos.length) return <div className="changes"><div className="empty">No uncommitted files and no commits since this agent started.</div></div>
  return (
    <div className="changes">
      <p className="hint">Everything in the repos under this agent's folder, so it can include other agents' work too.</p>
      {repos.map(r => (
        <div className="repo" key={r.repo}>
          <div className="repo-h">
            <b>{r.repo === '.' ? 'this folder' : r.repo}</b>
            <span className="chip">{r.branch || 'detached'}</span>
            {r.unpushed > 0 ? <span className="chip warn">{r.unpushed} not pushed</span> : r.commits.length > 0 && <span className="chip ok">pushed</span>}
          </div>
          {r.commits.map(c => (
            <div className="commit" key={c.hash}><code>{c.hash}</code> {c.subject}{!c.pushed && <span className="dot-warn" title="not pushed" />}</div>
          ))}
          {r.files.length > 0 && <div className="files">{r.files.map(f => (
            <div className="file" key={f.path}><span className={`fs fs-${f.status.replace('?', 'u')}`}>{f.status === '??' ? 'new' : f.status}</span>{f.path}</div>
          ))}</div>}
        </div>
      ))}
    </div>
  )
}
