import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, remember, type Agent, type Folder, type Improved, type List, type Profile, type Route, type Status, type Usage } from './api.ts'

export const TOOLS = ['claude', 'codex', 'cursor', 'copilot', 'agy'] as const
const TOOL_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', agy: 'Antigravity' }
const GLYPH: Record<string, string> = { claude: '✳', codex: '❯', cursor: '◢', copilot: '◉', agy: 'A' }
export const STATUS_LABEL: Record<Status, string> = {
  needs_you: 'Needs you', working: 'Working', waiting: 'Waiting on a job', ready: 'Ready', done: 'Done', crashed: 'Crashed', unknown: 'Outside tmux',
}
export const ORDER: Status[] = ['needs_you', 'working', 'waiting', 'ready', 'done', 'crashed', 'unknown']
export const COLORS = ['#8e8e93', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55']

export const toolLabel = (t: string) => TOOL_LABEL[t] ?? t

export const age = (s: number) =>
  !s ? '' : s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`

export const ago = (ms: number) => age(Math.max(1, Math.floor((Date.now() - ms) / 1000)))

export const activity = (a: Agent) =>
  a.message || (a.status === 'crashed' ? `Crashed · ${a.exit}` : '') || a.task.replace(/^\[[a-z]+\]\s*/, '') || a.last_line

export const isPhone = () => matchMedia('(max-width: 700px)').matches

export function Avatar({ tool, status, size }: { tool: string; status?: Status | 'gone'; size?: 'lg' | 'sm' }) {
  return (
    <span className={`tool ${size ?? ''}`}>
      <span className={`av av-${tool}`}>{GLYPH[tool] ?? '?'}</span>
      {status && status !== 'gone' && <span className={`st st-${status}`} aria-label={STATUS_LABEL[status]} />}
    </span>
  )
}

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

/** Name (and optionally color) for a new or renamed folder, list or agent. */
export function NameDialog({ title, initial = '', color, placeholder, action = 'Save', onSubmit, onClose }: {
  title: string; initial?: string; color?: string; placeholder?: string; action?: string
  onSubmit: (name: string, color: string) => void; onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [c, setC] = useState(color ?? '')
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); if (name.trim()) onSubmit(name.trim(), c) }}>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={placeholder} maxLength={60} />
        {color !== undefined && (
          <div className="swatches" role="radiogroup" aria-label="Color">
            {COLORS.map(x => <button type="button" key={x} role="radio" aria-checked={x === c} aria-label={x} className={x === c ? 'on' : ''}
              style={{ background: x }} onClick={() => setC(x)} />)}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>{action}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function Confirm({ title, text, action, onYes, onClose }: { title: string; text: string; action: string; onYes: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="dialog-text">{text}</p>
      <div className="form-actions">
        <button className="btn" onClick={onClose} autoFocus>Cancel</button>
        <button className="btn danger" onClick={() => { onClose(); onYes() }}>{action}</button>
      </div>
    </Dialog>
  )
}

// ---------- hold / right-click menus ----------

export type MenuItem = { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean; items?: MenuItem[]; swatch?: string; checked?: boolean } | 'sep'
type MenuState = { x: number; y: number; items: MenuItem[]; title?: string; from?: HTMLElement } | null
let showMenu: (m: MenuState) => void = () => {}
let held: HTMLElement | null = null // the row a long press is on: the menu pops out of it, iOS style

export const openMenu = (x: number, y: number, items: MenuItem[], title?: string) => { showMenu({ x, y, items, title, from: held ?? undefined }); held = null }

/** Long-press on touch, right-click with a mouse. The click that follows a long press is swallowed. */
export function useHold(onHold: (x: number, y: number) => void) {
  const timer = useRef<number>(0)
  const fired = useRef(false)
  const start = useRef({ x: 0, y: 0 })
  return {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onHold(e.clientX, e.clientY) },
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false
      const t = e.touches[0]
      const el = e.currentTarget as HTMLElement
      start.current = { x: t.clientX, y: t.clientY }
      timer.current = window.setTimeout(() => {
        fired.current = true
        navigator.vibrate?.(10)
        getSelection()?.removeAllRanges()
        held = el
        onHold(start.current.x, start.current.y)
        held = null
      }, 450)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (Math.abs(t.clientX - start.current.x) + Math.abs(t.clientY - start.current.y) > 10) clearTimeout(timer.current)
    },
    onTouchEnd: () => clearTimeout(timer.current),
    onClickCapture: (e: React.MouseEvent) => { if (fired.current) { e.preventDefault(); e.stopPropagation(); fired.current = false } },
  }
}

/** Where a menu popped from a held row goes: under the row, or above it when there's no room below. */
function anchored(from: HTMLElement, items: number) {
  const r = from.getBoundingClientRect()
  const w = Math.min(260, innerWidth - 24)
  const h = Math.min(innerHeight * 0.6, 16 + items * 44)
  const left = Math.max(12, Math.min(r.left + 8, innerWidth - w - 12))
  if (innerHeight - r.bottom - 12 >= h) return { rect: r, style: { left, top: r.bottom + 8, width: w, transformOrigin: 'top left' } }
  if (r.top - 12 >= h) return { rect: r, style: { left, bottom: innerHeight - r.top + 8, width: w, transformOrigin: 'bottom left' } }
  return null // a tall menu on a small screen: use the bottom sheet
}

export function MenuHost() {
  const [stack, setStack] = useState<MenuState[]>([])
  const openedAt = useRef(0)
  const ghost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    showMenu = m => { openedAt.current = Date.now(); setStack(m ? [m] : []) }
    return () => { showMenu = () => {} }
  }, [])
  // lifting the finger after a long press sends a tap that lands on the backdrop; don't let it close the menu
  const dismiss = (e: React.SyntheticEvent) => { if (e.target === e.currentTarget && Date.now() - openedAt.current > 600) setStack([]) }
  const top = stack.at(-1)
  useEffect(() => {
    if (!top) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setStack([])
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [top])
  const root = stack[0]
  const pop = root?.from && isPhone() ? anchored(root.from, Math.max(...stack.map(m => m!.items.length)) + 1) : null
  // a lifted copy of the held row sits above the dimmed page
  useEffect(() => {
    const box = ghost.current
    if (!box || !root?.from) return
    const copy = root.from.cloneNode(true) as HTMLElement
    copy.removeAttribute('href')
    box.replaceChildren(copy)
  }, [root, pop])
  if (!top) return null
  const sheet = isPhone() && !pop
  const style = pop ? pop.style : sheet ? {} : { left: Math.min(top.x, innerWidth - 240), top: Math.min(top.y, innerHeight - 40 - top.items.length * 34) }
  return (
    <div className={`menu-overlay ${pop ? 'lifted' : ''}`} onMouseDown={dismiss} onTouchEnd={dismiss}>
      {pop && <div className="menu-ghost" ref={ghost} aria-hidden style={{ left: pop.rect.left, top: pop.rect.top, width: pop.rect.width, height: pop.rect.height }} />}
      <div className={`menu ctx ${sheet ? 'sheet' : ''} ${pop ? 'pop' : ''}`} role="menu" style={style}>
        {(top.title || stack.length > 1) && (
          <div className="menu-title">
            {stack.length > 1 && <button className="menu-back" onClick={() => setStack(stack.slice(0, -1))}>‹</button>}
            {top.title}
          </div>
        )}
        {top.items.map((it, i) => it === 'sep' ? <div className="menu-sep" key={i} /> : (
          <button key={i} role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => {
            if (it.items) return setStack([...stack, { ...top, items: it.items, title: it.label }])
            setStack([])
            it.onClick?.()
          }}>
            {it.swatch && <span className="sq" style={{ background: it.swatch }} />}
            <span className="menu-text">{it.label}</span>
            {it.checked && <span className="check-mark">✓</span>}
            {it.items && <span className="chev">›</span>}
          </button>
        ))}
        {sheet && <button className="menu-cancel" onClick={() => setStack([])}>Cancel</button>}
      </div>
    </div>
  )
}

// ---------- pull down to refresh ----------

/** Pull down from the top of any list on a phone to reload: the home-screen app has no browser refresh button. */
export function PullToRefresh() {
  const [pull, setPull] = useState(0)
  useEffect(() => {
    let startY = -1
    let dist = 0
    // only when everything under the finger is scrolled to the top, and not in the terminal, a menu or a text box
    const atTop = (el: Element | null) => {
      for (; el && el !== document.body; el = el.parentElement) {
        if (el.matches('.xterm, .menu-overlay, .dialog, input, textarea, [contenteditable]')) return false
        if (el.scrollTop > 0) return false
      }
      return true
    }
    const down = (e: TouchEvent) => { startY = e.touches.length === 1 && atTop(e.target as Element) ? e.touches[0].clientY : -1; dist = 0 }
    const move = (e: TouchEvent) => {
      if (startY < 0) return
      dist = Math.max(0, e.touches[0].clientY - startY)
      setPull(dist > 12 ? Math.min(dist, 140) : 0)
    }
    const up = () => {
      if (startY >= 0 && dist > 90) { setPull(-1); setTimeout(() => location.reload(), 150) }
      else setPull(0)
      startY = -1
    }
    addEventListener('touchstart', down, { passive: true })
    addEventListener('touchmove', move, { passive: true })
    addEventListener('touchend', up)
    addEventListener('touchcancel', up)
    return () => { removeEventListener('touchstart', down); removeEventListener('touchmove', move); removeEventListener('touchend', up); removeEventListener('touchcancel', up) }
  }, [])
  if (!pull) return null
  const ready = pull < 0 || pull > 90
  return (
    <div className={`ptr ${ready ? 'ready' : ''}`} style={{ transform: `translate(-50%, ${pull < 0 ? 60 : Math.min(pull, 140) * 0.55}px)` }} role="status" aria-label={pull < 0 ? 'Refreshing' : ready ? 'Release to refresh' : 'Pull to refresh'}>
      <span className={pull < 0 ? 'spin' : ''} style={pull < 0 ? undefined : { transform: `rotate(${pull * 2.5}deg)` }}>↻</span>
    </div>
  )
}

// ---------- sidebar ----------

export function Sidebar(props: {
  route: string; needs: number; paused: number; folders: Folder[]; counts: Map<number, number>; lists: List[]; usage: Usage[]
  newButton: ReactNode; push: ReactNode; onJarvis: () => void; onNewFolder: () => void; onFolderMenu: (f: Folder, x: number, y: number) => void
  onNewList: () => void; onListMenu: (l: List, x: number, y: number) => void; onDrop: (folderId: number | null, key: string) => void
}) {
  const [over, setOver] = useState<number | 'all' | null>(null)
  const dropProps = (target: number | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('fleet/key')) { e.preventDefault(); setOver(target ?? 'all') } },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(null); props.onDrop(target, e.dataTransfer.getData('fleet/key')) },
  })
  return (
    <aside className="nav">
      <div className="brand"><span className="logo">F</span>Fleet
        <button className="brand-mic" onClick={props.onJarvis} aria-label="Jarvis (J)" title="Jarvis (J)"><MicIcon /></button>
      </div>
      {props.newButton}
      <a className={`ni ${props.route === 'all' ? 'on' : ''} ${over === 'all' ? 'drop' : ''}`} href="#/" {...dropProps(null)}>
        <span className="sq" style={{ background: 'currentColor', opacity: 0.5 }} />All agents
        {props.needs > 0 && <span className="badge">{props.needs}</span>}
      </a>
      <div className="sec">Folders<button className="sec-add" onClick={props.onNewFolder} aria-label="New folder">+</button></div>
      {props.folders.map(f => (
        <FolderRow key={f.id} f={f} on={props.route === `folder/${f.id}`} drop={over === f.id} count={props.counts.get(f.id) ?? 0}
          dropProps={dropProps(f.id)} onMenu={(x, y) => props.onFolderMenu(f, x, y)} />
      ))}
      {!props.folders.length && <button className="ni ghost" onClick={props.onNewFolder}>New folder…</button>}
      <div className="sec">Ideas<button className="sec-add" onClick={props.onNewList} aria-label="New list">+</button></div>
      <a className={`ni ${props.route === 'prioritized' ? 'on' : ''}`} href="#/prioritized"><span className="prio p3 side">!</span>Prioritized</a>
      {props.lists.map(l => (
        <ListRow key={l.id} l={l} on={props.route === `ideas/${l.name}`} onMenu={(x, y) => props.onListMenu(l, x, y)} />
      ))}
      <div className="sec">Library</div>
      <a className={`ni ${props.route === 'history' ? 'on' : ''}`} href="#/history"><ClockIcon />History</a>
      <a className={`ni ${props.route === 'paused' ? 'on' : ''}`} href="#/paused"><PauseIcon />Paused<b>{props.paused || ''}</b></a>
      <a className={`ni ${props.route === 'settings' ? 'on' : ''}`} href="#/settings"><GearIcon />Settings</a>
      <div className="foot">
        <UsageMeters usage={props.usage} compact />
        {props.push}
      </div>
    </aside>
  )
}

function FolderRow({ f, on, drop, count, dropProps, onMenu }: { f: Folder; on: boolean; drop: boolean; count: number; dropProps: object; onMenu: (x: number, y: number) => void }) {
  const hold = useHold(onMenu)
  return (
    <a className={`ni ${on ? 'on' : ''} ${drop ? 'drop' : ''}`} href={`#/folder/${f.id}`} {...dropProps} {...hold}>
      <span className="sq" style={{ background: f.color }} />{f.name}<b>{count || ''}</b>
    </a>
  )
}

function ListRow({ l, on, onMenu }: { l: List; on: boolean; onMenu: (x: number, y: number) => void }) {
  const hold = useHold(onMenu)
  const icon = l.name === 'Priority' ? <FlagIcon /> : l.name === 'Brain Dump' ? <InboxIcon /> : <span className="sq round" style={{ background: l.color }} />
  return (
    <a className={`ni ${on ? 'on' : ''}`} href={`#/ideas/${encodeURIComponent(l.name)}`} {...hold}>
      {icon}{l.name}
      {l.name === 'Brain Dump' && l.unsorted > 0 ? <span className="badge gray">{l.unsorted}</span> : <b>{l.open || ''}</b>}
    </a>
  )
}

export function UsageMeters({ usage, compact }: { usage: Usage[]; compact?: boolean }) {
  const known = usage.filter(u => u.windows.length)
  const unknown = usage.filter(u => !u.windows.length)
  const resets = (s: number | null) => {
    if (!s) return ''
    const d = new Date(s * 1000)
    const soon = d.getTime() - Date.now() < 86_400_000
    return soon ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short' })
  }
  return (
    <div className={`usage ${compact ? 'compact' : ''}`}>
      {known.map(u => (
        <div className="usage-row" key={u.tool}>
          <div className="usage-tool">{toolLabel(u.tool)}</div>
          {u.windows.map(w => (
            <div className="usage-win" key={w.label} title={w.resets_at ? `resets ${new Date(w.resets_at * 1000).toLocaleString()}` : ''}>
              <span className="usage-label">{w.label}</span>
              <span className="meter"><span className={w.pct >= 85 ? 'hot' : w.pct >= 60 ? 'warm' : ''} style={{ width: `${Math.min(100, w.pct)}%` }} /></span>
              <span className="usage-pct">{w.pct}%</span>
              {!compact && w.resets_at && <span className="usage-reset">resets {resets(w.resets_at)}</span>}
            </div>
          ))}
        </div>
      ))}
      {!compact && unknown.map(u => <div className="hint" key={u.tool}>{toolLabel(u.tool)}: {u.note}</div>)}
    </div>
  )
}

// ---------- new agent ----------

export function NewAgentButton({ profiles, onNew, onCustom, onInterview, onDeleteProfile }: {
  profiles: Profile[]; onNew: (p?: Profile) => void; onCustom: () => void; onInterview: () => void; onDeleteProfile: (p: Profile) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent | TouchEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    addEventListener('mousedown', away)
    addEventListener('touchstart', away)
    return () => { removeEventListener('mousedown', away); removeEventListener('touchstart', away) }
  }, [open])
  const def = profiles.find(p => p.is_default)
  return (
    <div className="new" ref={ref}>
      <button className="new-main" onClick={() => onNew(def)} title={def ? `Quick start: ${def.name}` : 'Quick start: Claude'}>
        <PlusIcon />New agent
      </button>
      <button className="new-more" aria-label="Profiles and more" aria-expanded={open} onClick={() => setOpen(!open)}>▾</button>
      {open && (
        <div className="menu" role="menu">
          {profiles.map(p => (
            <div className="menu-row" key={p.name}>
              <button role="menuitem" onClick={() => { setOpen(false); onNew(p) }}>
                <Avatar tool={p.tool} size="sm" />
                <span className="menu-text"><b>{p.name}</b><small>{[toolLabel(p.tool), p.model, p.effort].filter(Boolean).join(' · ')}</small></span>
                {p.is_default ? <span className="chip">default</span> : null}
              </button>
              <button className="x" aria-label={`Delete profile ${p.name}`} onClick={() => onDeleteProfile(p)}>×</button>
            </div>
          ))}
          {profiles.length > 0 && <div className="menu-sep" />}
          <button role="menuitem" className="menu-custom" onClick={() => { setOpen(false); onCustom() }}>Custom…</button>
          <button role="menuitem" className="menu-custom" onClick={() => { setOpen(false); onInterview() }}>Interview me about an idea…</button>
        </div>
      )}
    </div>
  )
}

export type StartFields = { name: string; tool: string; model: string; effort: string; cwd: string; prompt: string; folder_id: number | null }

/** The full New agent form, also used to start an agent from an idea. Suggest picks a tool/model; Improve rewrites the prompt. */
export function CustomForm({ title = 'New agent', initial, folders, onClose, onStart, onError }: {
  title?: string; initial?: Partial<StartFields>; folders: Folder[]; onClose: () => void
  onStart: (f: StartFields) => Promise<void>; onError: (e: Error) => void
}) {
  const [f, setF] = useState<StartFields & { profile: string; isDefault: boolean }>({
    name: '', tool: 'claude', model: '', effort: '', cwd: remember.get('cwd'), prompt: '', folder_id: null, profile: '', isDefault: false, ...initial,
  })
  const [busy, setBusy] = useState<'' | 'start' | 'suggest' | 'improve'>('')
  const [route, setRoute] = useState<Route | null>(null)
  const [improved, setImproved] = useState<(Improved & { before: string }) | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : k === 'folder_id' ? (e.target.value ? Number(e.target.value) : null) : e.target.value })

  const suggest = async () => {
    setBusy('suggest')
    try {
      const r = await api.post<Route>('/api/ai/recommend', { task: f.prompt })
      setRoute(r)
      setF(x => ({ ...x, tool: r.tool, model: r.model === 'default' ? '' : r.model, effort: r.effort }))
    } catch (e) { onError(e as Error) }
    setBusy('')
  }
  const improve = async () => {
    setBusy('improve')
    try {
      const r = await api.post<Improved>('/api/ai/improve', { text: f.prompt, cwd: f.cwd })
      setImproved({ ...r, before: f.prompt })
      setF(x => ({ ...x, prompt: r.prompt }))
    } catch (e) { onError(e as Error) }
    setBusy('')
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('start')
    try {
      if (f.profile.trim())
        await api.put(`/api/profiles/${encodeURIComponent(f.profile.trim())}`,
          { tool: f.tool, model: f.model, effort: f.effort, cwd: f.cwd, is_default: f.isDefault })
      if (f.cwd) remember.set('cwd', f.cwd)
      await onStart(f)
    } catch (err) {
      onError(err as Error)
      setBusy('')
    }
  }

  return (
    <Dialog title={title} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <label>What should it do?
          <textarea rows={5} value={f.prompt} onChange={set('prompt')} autoFocus
            placeholder="Optional. The agent starts on this right away. Type it rough; Improve can tidy it up." />
        </label>
        <div className="ai-row">
          <button type="button" className="btn" onClick={improve} disabled={!f.prompt.trim() || !!busy}><SparkIcon />{busy === 'improve' ? 'Improving…' : 'Improve prompt'}</button>
          <button type="button" className="btn" onClick={suggest} disabled={!f.prompt.trim() || !!busy}><WandIcon />{busy === 'suggest' ? 'Thinking…' : 'Suggest model'}</button>
          {improved && <button type="button" className="btn ghost" onClick={() => { setF(x => ({ ...x, prompt: improved.before })); setImproved(null) }}>Undo</button>}
        </div>
        {improved && (improved.changes.length > 0 || improved.questions.length > 0) && (
          <details className="ai-note" open={improved.questions.length > 0}>
            <summary>{improved.questions.length ? `${improved.questions.length} question${improved.questions.length > 1 ? 's' : ''} worth answering in the prompt` : 'What changed'}</summary>
            {improved.questions.length > 0 && <ul>{improved.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
            {improved.changes.length > 0 && <ul className="dim">{improved.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          </details>
        )}
        {route && (
          <div className="ai-note">
            <b>{toolLabel(route.tool)}{route.model ? ` · ${route.model}` : ''}{route.effort ? ` · ${route.effort}` : ''}</b> — {route.why}
            <button type="button" className="link" onClick={() => setF(x => ({ ...x, tool: route.alternative.tool, model: route.alternative.model, effort: '' }))}>
              Or {toolLabel(route.alternative.tool)} · {route.alternative.model}
            </button>
            <div className="dim">{route.alternative.why}</div>
          </div>
        )}
        <div className="form-row">
          <label>Tool<select value={f.tool} onChange={set('tool')}>{TOOLS.map(t => <option key={t} value={t}>{toolLabel(t)}</option>)}</select></label>
          <label>Model<input value={f.model} onChange={set('model')} placeholder="tool default" /></label>
          <label>Effort<select value={f.effort} onChange={set('effort')}>
            {['', 'low', 'medium', 'high', 'xhigh', 'max'].map(v => <option key={v} value={v}>{v || 'default'}</option>)}
          </select></label>
        </div>
        <div className="form-row">
          <label>Name<input value={f.name} onChange={set('name')} placeholder="auto" /></label>
          <label>Folder<select value={f.folder_id ?? ''} onChange={set('folder_id')}>
            <option value="">None</option>
            {folders.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></label>
        </div>
        <label>Runs in<input value={f.cwd} onChange={set('cwd')} placeholder="your project folder (from fleet dash install)" /></label>
        <div className="form-row save">
          <label>Save as profile<input value={f.profile} onChange={set('profile')} placeholder="optional name" /></label>
          <label className="check"><input type="checkbox" checked={f.isDefault} onChange={set('isDefault')} disabled={!f.profile.trim()} />Make default</label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy === 'start'}>{busy === 'start' ? 'Starting…' : 'Start agent'}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function InterviewForm({ initial = '', onClose, onStart }: { initial?: string; onClose: () => void; onStart: (topic: string) => Promise<void> }) {
  const [topic, setTopic] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Interview me about an idea" onClose={onClose}>
      <form className="form" onSubmit={async e => { e.preventDefault(); setBusy(true); await onStart(topic).catch(() => setBusy(false)) }}>
        <p className="dialog-text">A Claude agent asks you one question at a time (mostly multiple choice, so it works from your phone), pushes back where it should, and writes up a plan when you're done.</p>
        <textarea rows={4} autoFocus value={topic} onChange={e => setTopic(e.target.value)} placeholder="The idea, as rough as you like" />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!topic.trim() || busy}>{busy ? 'Starting…' : 'Start interview'}</button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- icons ----------

const svg = (d: ReactNode, size = 13) => <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>{d}</svg>
export const PlusIcon = () => svg(<path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />)
export const PauseIcon = () => svg(<><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor" /><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor" /></>, 12)
export const TermIcon = () => svg(<><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></>, 12)
export const SendIcon = () => svg(<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />)
export const ClockIcon = () => svg(<><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" /></>)
export const FlagIcon = () => svg(<path d="M4 14V2.5M4 3h8l-2 3 2 3H4" stroke="#ff3b30" strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />)
export const InboxIcon = () => svg(<path d="M2 9.5 4 3h8l2 6.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />)
export const SparkIcon = () => svg(<path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4z" fill="currentColor" />, 12)
export const WandIcon = () => svg(<><path d="m3 13 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M11 1.5v3M9.5 3h3M13.5 6v2M12.5 7h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>, 12)
export const MicIcon = () => svg(<><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor" /><path d="M3 8a5 5 0 0 0 10 0M8 13v2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></>, 16)
export const SearchIcon = () => svg(<><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>)

/** Pause an agent until a time; it comes back on its own with the same conversation. */
export function PauseUntil({ name, usage, onClose, onPick }: { name: string; usage: Usage[]; onClose: () => void; onPick: (epochS: number) => void }) {
  const at = (h: number, m = 0, dayOffset = 0) => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, m, 0, 0)
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return Math.floor(d.getTime() / 1000)
  }
  const fmt = (s: number) => new Date(s * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  const claude = usage.find(u => u.tool === 'claude')
  const reset5h = claude?.windows.find(w => w.label === '5 hours')?.resets_at
  const now = Math.floor(Date.now() / 1000)
  const presets: [string, number][] = [
    ['In 1 hour', now + 3600], ['In 3 hours', now + 3 * 3600], ['This evening', at(19)], ['Tomorrow morning', at(9, 0, new Date().getHours() < 9 ? 0 : 1)],
    ...(reset5h && reset5h > now ? [[`When Claude's 5-hour limit resets`, reset5h + 60] as [string, number]] : []),
  ]
  const [custom, setCustom] = useState('')
  return (
    <Dialog title={`Pause ${name} until…`} onClose={onClose}>
      <p className="dialog-text">It stops now and comes back on its own with the same conversation (while the dashboard is running on your Mac).</p>
      <div className="presets">
        {presets.map(([label, s]) => (
          <button key={label} className="preset" onClick={() => onPick(s)}><b>{label}</b><span>{fmt(s)}</span></button>
        ))}
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); const s = Math.floor(new Date(custom).getTime() / 1000); if (s > now) onPick(s) }}>
        <div className="form-row">
          <label>Or pick a time<input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} /></label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!custom}>Pause until then</button>
        </div>
      </form>
    </Dialog>
  )
}
export const GearIcon = () => svg(<><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>)
