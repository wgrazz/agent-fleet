import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api, remember, type Ask, type Conversation, type LeftMessage, type LiveAgent, type Message, type Paused, type RepoChanges } from './api.ts'
import { activity, age, ago, Avatar, isPhone, openMenu, ORDER, PauseIcon, SendIcon, STATUS_LABEL, TermIcon, toolLabel, useHold } from './components.tsx'
import { AddTodos } from './ideas.tsx'
import { planSteps } from './steps.ts'
import { ScreenView } from './terminal.tsx'

// ---------- list ----------

/** Queued messages whose agent ended before they went out: send one to another agent (or a new one), copy it, or delete it. */
function LeftMessages({ items, agents, onChange, onError, onNew }: {
  items: LeftMessage[]; agents: LiveAgent[]; onChange: () => void; onError: (e: Error) => void; onNew: (text: string) => void
}) {
  const [open, setOpen] = useState<number | null>(null)
  const done = (p: Promise<unknown>) => p.then(onChange).catch(onError)
  return (
    <div className="queued left">
      <div className="queued-h">Never sent · their agent ended</div>
      {items.map(q => (
        <div className="queued-it" key={q.id}>
          <span className={`queued-text ${open === q.id ? 'open' : ''}`} onClick={() => setOpen(open === q.id ? null : q.id)}><b>{q.agent}</b> · {q.text}</span>
          <button className="btn small" onClick={e => openMenu(e.clientX, e.clientY, [
            ...agents.filter(a => a.controllable).map(a => ({ label: a.name, onClick: () => done(api.post(`/api/queued/${q.id}/send`, { to: a.name })) })),
            { label: 'New agent with this…', onClick: () => onNew(q.text) },
            'sep',
            { label: 'Copy', onClick: () => done(navigator.clipboard.writeText(q.text)) },
          ], 'Send to')}>Send to…</button>
          <button className="x" onClick={() => done(api.del(`/api/queued/${q.id}`))} aria-label="Delete">×</button>
        </div>
      ))}
    </div>
  )
}

export function AgentList({ agents, selected, header, past, onMenu, empty, paused, left }: {
  agents: LiveAgent[]; selected: string; header: ReactNode; past?: Conversation[]; empty?: ReactNode
  onMenu: (a: LiveAgent, x: number, y: number) => void
  paused?: { items: Paused[]; onResume: (p: Paused) => void; onForget: (p: Paused) => void }
  left?: { items: LeftMessage[]; onChange: () => void; onError: (e: Error) => void; onNew: (text: string) => void }
}) {
  const [showPaused, setShowPaused] = useState(remember.get('list.paused') !== 'hide')
  const togglePaused = () => { setShowPaused(!showPaused); remember.set('list.paused', showPaused ? 'hide' : '') }
  return (
    <section className="list">
      {header}
      <div className="scroll">
        {left && left.items.length > 0 && <LeftMessages agents={agents} {...left} />}
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
        {paused && paused.items.length > 0 && (
          <div>
            <button className="grp grp-toggle" onClick={togglePaused} aria-expanded={showPaused}>
              Paused · {paused.items.length}<span className="grp-hint">{showPaused ? '▾' : '▸'}</span>
            </button>
            {showPaused && paused.items.map(p => <PausedRow key={p.id} p={p} onResume={paused.onResume} onForget={paused.onForget} />)}
          </div>
        )}
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
        {items.map(p => <PausedRow key={p.id} p={p} onResume={onResume} onForget={onForget} />)}
        {!items.length && <div className="empty">Nothing paused. Pause an agent to park it here with its conversation.</div>}
      </div>
    </section>
  )
}

function PausedRow({ p, onResume, onForget }: { p: Paused; onResume: (p: Paused) => void; onForget: (p: Paused) => void }) {
  return (
    <div className="it paused">
      <Avatar tool={p.tool} />
      <span className="nm">{p.name}</span>
      <span className="tm">{new Date(p.paused_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
      <span className="pv">{p.resume_at ? `Back ${new Date(p.resume_at * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : p.cwd.split('/').slice(-2).join('/')}</span>
      <span className="row-actions">
        <button className="btn small primary" onClick={() => onResume(p)}>Resume</button>
        <button className="btn small" onClick={() => onForget(p)}>Forget</button>
      </span>
    </div>
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
            <ChatView tool={agent.tool} id={agent.session_id} agent={agent.name} live working={agent.status === 'working' ? agent.working_line || 'Working…' : agent.status === 'waiting' ? 'Waiting on a background job, it picks up again when that finishes' : ''} />
            <div className="ended">This one runs in a plain terminal window, so it's read-only here. <b>Add to Fleet</b> moves it into Fleet with the same conversation, so you can answer it from anywhere.</div>
          </>
        ) : (
          <div className="empty big">
            This agent was started in a plain terminal window, so the dashboard can see it but can't type into it.
            Start agents with <b>New agent</b> or <code>fleet new</code> to control them from here.
          </div>
        )
      ) : shown === 'chat' ? (
        <ChatView tool={agent.tool} id={agent.session_id} agent={agent.name} live waiting={agent.status === 'needs_you' && !agent.ask ? agent.message : ''}
          working={agent.status === 'working' ? agent.working_line || 'Working…' : agent.status === 'waiting' ? 'Waiting on a background job, it picks up again when that finishes' : ''} pending={pending} onSeen={() => setPending('')} peek={agent.name} />
      ) : shown === 'changes' ? (
        <ChangesView name={agent.name} />
      ) : (
        <ScreenView name={agent.name} />
      )}
      {agent.ask && <AskForm key={agent.ask.id} ask={agent.ask} />}
      {!agent.ask && agent.controllable && agent.pid !== null && <Composer agent={agent} send={sendTracked} />}
      {agent.controllable && agent.pid === null && <div className="ended">This agent exited ({agent.exit}). Its last screen is kept under Screen.</div>}
    </main>
  )
}

/** Claude's question or plan as a form. What you submit goes straight to Claude; answering in the terminal works too. */
function AskForm({ ask }: { ask: Ask }) {
  const [picks, setPicks] = useState<string[][]>(() => ask.questions.map(() => []))
  const [own, setOwn] = useState<string[]>(() => ask.questions.map(() => ''))
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = (body: object) => {
    setBusy(true)
    setError('')
    api.post(`/api/ask/${ask.id}/answer`, body).catch(e => { setError(e.message); setBusy(false) })
  }
  const set = <T,>(xs: T[], i: number, v: T) => xs.map((x, j) => (j === i ? v : x))
  if (ask.kind === 'plan') return (
    <div className="comp ask">
      <div className="ask-h">Plan for your approval</div>
      {ask.plan && <div className="ask-plan"><Markdown text={ask.plan} /></div>}
      <textarea className="ask-own" placeholder="What should change? (for Keep planning)" value={feedback} onChange={e => setFeedback(e.target.value)} />
      {error && <div className="ask-err">{error}</div>}
      <div className="form-actions">
        <button className="btn" disabled={busy} onClick={() => submit({ feedback })}>Keep planning</button>
        <button className="btn" disabled={busy} onClick={() => submit({ approve: 'default' })}>Approve · ask before edits</button>
        <button className="btn primary" disabled={busy} onClick={() => submit({ approve: 'auto' })}>Approve · auto mode</button>
      </div>
    </div>
  )
  // a single pick and your own text replace each other; with pick-any, your text is one more answer
  const answer = (i: number) => [...picks[i], own[i].trim()].filter(Boolean).join(', ')
  const pick = (i: number, label: string, multi?: boolean) => {
    setPicks(set(picks, i, multi ? (picks[i].includes(label) ? picks[i].filter(x => x !== label) : [...picks[i], label]) : [label]))
    if (!multi) setOwn(set(own, i, ''))
  }
  const ready = ask.questions.every((_, i) => answer(i))
  return (
    <div className="comp ask">
      {ask.questions.map((q, i) => (
        <fieldset key={i} className="ask-q">
          <legend>{q.question}{q.multiSelect && <span className="ask-hint"> · pick any</span>}</legend>
          {q.options.map(o => (
            <label key={o.label} className={`ask-opt ${picks[i].includes(o.label) ? 'on' : ''}`}>
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${ask.id}-${i}`} checked={picks[i].includes(o.label)} onChange={() => pick(i, o.label, q.multiSelect)} />
              <span><b>{o.label}</b>{o.description && <span className="ask-desc">{o.description}</span>}</span>
            </label>
          ))}
          <input className="ask-own" placeholder="Or type your own answer" value={own[i]}
            onChange={e => { setOwn(set(own, i, e.target.value)); if (!q.multiSelect && e.target.value) setPicks(set(picks, i, [])) }} />
        </fieldset>
      ))}
      {error && <div className="ask-err">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !ready}
          onClick={() => submit({ answers: Object.fromEntries(ask.questions.map((q, i) => [q.question, answer(i)])) })}>
          {busy ? 'Sending…' : ask.questions.length > 1 ? 'Submit answers' : 'Submit'}
        </button>
      </div>
    </div>
  )
}

function Composer({ agent, send }: { agent: LiveAgent; send: (body: { text?: string; key?: string }) => Promise<void> }) {
  const [text, setText] = useState(() => remember.get(`draft.${agent.name}`))
  const replies = agent.quick_replies
  const nav = agent.status === 'needs_you' && !replies.length
  const keep = (t: string) => { setText(t); remember.set(`draft.${agent.name}`, t) }
  // while it's busy, a reply waits its turn instead of landing mid-task; it goes out when the agent finishes
  const busy = agent.status === 'working'
  const [queuing, setQueuing] = useState<string[]>([]) // shown until the next poll lists them
  useEffect(() => setQueuing([]), [agent.queued.length])
  // photos upload as soon as you pick them; the agent gets their paths on the Mac
  const [photos, setPhotos] = useState<{ preview: string; path?: string; failed?: boolean }[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const addPhotos = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const preview = URL.createObjectURL(f)
      const set = (patch: object) => setPhotos(p => p.map(x => (x.preview === preview ? { ...x, ...patch } : x)))
      setPhotos(p => [...p, { preview }])
      fetch('/api/uploads', { method: 'POST', body: f })
        .then(async r => { if (!r.ok) throw new Error(); set({ path: (await r.json()).path }) })
        .catch(() => set({ failed: true }))
    }
  }
  const dropPhoto = (preview: string) => { URL.revokeObjectURL(preview); setPhotos(p => p.filter(x => x.preview !== preview)) }
  const uploading = photos.some(p => !p.path && !p.failed)
  const ready = photos.filter(p => p.path)
  const submit = () => {
    if ((!text.trim() && !ready.length) || uploading) return
    const t = [text.trim(), ...ready.map(p => `[Photo: ${p.path}]`)].filter(Boolean).join('\n\n')
    photos.forEach(p => URL.revokeObjectURL(p.preview))
    setPhotos([])
    keep('')
    if (busy || agent.queued.length) {
      setQueuing(q => [...q, t])
      api.post(`/api/agents/${encodeURIComponent(agent.name)}/queue`, { text: t }).catch(() => { keep(t); setQueuing(q => q.filter(x => x !== t)) })
    } else send({ text: t }).catch(() => keep(t))
  }
  return (
    <div className="comp">
      {(agent.queued.length > 0 || queuing.length > 0) && (
        <div className="queued">
          <div className="queued-h">Queued · sends when {agent.name} finishes</div>
          {agent.queued.map(q => (
            <div className="queued-it" key={q.id}>
              <span className="queued-text">{q.text}</span>
              <button className="btn small" onClick={() => api.post(`/api/queued/${q.id}/send`).catch(() => {})} title="Send it now, while it works">Send now</button>
              <button className="x" onClick={() => api.del(`/api/queued/${q.id}`).catch(() => {})} aria-label="Remove from queue">×</button>
            </div>
          ))}
          {queuing.map((t, i) => <div className="queued-it pending" key={`p${i}`}><span className="queued-text">{t}</span></div>)}
        </div>
      )}
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
      {photos.length > 0 && (
        <div className="photos">
          {photos.map(p => (
            <span key={p.preview} className={`photo ${p.path ? '' : p.failed ? 'failed' : 'busy'}`} title={p.failed ? "Couldn't upload this one" : undefined}>
              <img src={p.preview} alt="" />
              <button className="x" onClick={() => dropPhoto(p.preview)} aria-label="Remove photo">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <button className="attach" onClick={() => picker.current?.click()} aria-label="Add a photo" title="Take a photo or pick one"><PhotoIcon /></button>
        <input ref={picker} type="file" accept="image/*" multiple hidden onChange={e => { addPhotos(e.target.files); e.target.value = '' }} />
        <textarea id="composer" rows={1} value={text} placeholder={busy ? `Queue a message for when ${agent.name} finishes…` : `Reply to ${agent.name}…`} enterKeyHint={busy ? 'done' : 'send'}
          onChange={e => keep(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isPhone()) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') e.currentTarget.blur()
          }} />
        <button className={`send ${busy ? 'queue' : ''}`} onClick={submit} aria-label={busy ? 'Queue' : 'Send'} title={busy ? 'Queue: sends when it finishes' : 'Send'} disabled={(!text.trim() && !ready.length) || uploading}>{busy ? <QueueIcon /> : <SendIcon />}</button>
      </div>
    </div>
  )
}

const PhotoIcon = () => <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><rect x="1.8" y="3.8" width="12.4" height="9.4" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><circle cx="8" cy="8.5" r="2.4" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M5.5 3.8 6.5 2.3h3l1 1.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /></svg>
// a photo sent from the composer, as it appears in the agent's log
const PHOTO = /\[Photo: [^\]]*\/\.fleet\/uploads\/([\w-]+\.jpg)\]/g

const QueueIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M8 4.8V8l2.2 1.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" /></svg>

// ---------- chat ----------

/** A conversation as chat bubbles, read from the tool's own log. Live views poll and stick to the bottom. */
export function ChatView({ tool, id, live, waiting, working, pending, onSeen, peek, agent }: {
  tool: string; id: string; live?: boolean; waiting?: string; working?: string; pending?: string; onSeen?: () => void; peek?: string; agent?: string
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [todos, setTodos] = useState<ReturnType<typeof planSteps> | null>(null)
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
      {blocks.map((b, i) => {
        if (Array.isArray(b)) return <ToolRun key={i} tools={b} />
        const plan = b.role === 'assistant' ? planSteps(b.text) : null
        return (
          <Fragment key={i}>
            <Bubble m={b} />
            {plan && plan.steps.length > 1 && <button className="todo-add" onClick={() => setTodos(plan)}>＋ Add {plan.steps.length} to-dos</button>}
          </Fragment>
        )
      })}
      {pending && !seen && <div className="bubble user sending">{pending}</div>}
      {working && <div className="bubble working"><span className="dots"><i /><i /><i /></span>{working}</div>}
      {working && peek && <LivePeek name={peek} />}
      {waiting && <div className="bubble waiting">Waiting for you: {waiting}</div>}
      {!messages.length && <div className="empty">No messages yet.</div>}
      {todos && <AddTodos plan={todos} agent={agent} onClose={() => setTodos(null)} />}
    </div>
  )
}

function Bubble({ m }: { m: Message }) {
  const photos = m.role === 'user' ? [...m.text.matchAll(PHOTO)].map(x => x[1]) : []
  const text = photos.length ? m.text.replace(PHOTO, '').trim() : m.text
  return (
    <div className={`bubble ${m.role} ${photos.length && !text ? 'only-photos' : ''}`}>
      {text && <Markdown text={text} />}
      {photos.map(p => <a key={p} href={`/api/uploads/${p}`} target="_blank" rel="noreferrer"><img className="bubble-photo" src={`/api/uploads/${p}`} alt="Photo you sent" /></a>)}
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
