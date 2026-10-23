import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, remember, Unauthorized, usePoll, type Agent, type Paused, type Profile } from './api.ts'
import { AgentList, AgentView, CustomForm, Dialog, NewAgentButton, ORDER, PausedList, Sidebar } from './components.tsx'
import { FullTerminal } from './terminal.tsx'
import './styles.css'

// #/ all agents · #/paused · #/agent/NAME (also what push notifications open)
const parseRoute = () => {
  const [, view = '', name = ''] = location.hash.split('/')
  return { view: view === 'paused' ? 'paused' : view === 'agent' ? 'agent' : 'all', name: decodeURIComponent(name) }
}

const sortAgents = (agents: Agent[]) =>
  [...agents].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))

function App() {
  const [route, setRoute] = useState(parseRoute)
  const [locked, setLocked] = useState(false)
  const [toast, setToast] = useState('')
  const [custom, setCustom] = useState(false)
  const [terminal, setTerminal] = useState('')
  const [confirmKill, setConfirmKill] = useState<Agent | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])

  const fail = useCallback((e: Error) => (e instanceof Unauthorized ? setLocked(true) : setToast(e.message)), [])
  const agents = usePoll<Agent[]>('/api/agents', 2000, fail)
  const paused = usePoll<Paused[]>('/api/paused', 5000, fail)
  const loadProfiles = useCallback(() => api.get<Profile[]>('/api/profiles').then(setProfiles).catch(fail), [fail])

  useEffect(() => {
    const on = () => setRoute(parseRoute())
    addEventListener('hashchange', on)
    loadProfiles()
    return () => removeEventListener('hashchange', on)
  }, [loadProfiles])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const list = sortAgents(agents.data ?? [])
  const selected = route.view === 'agent' ? list.find(a => a.name === route.name) ?? null : null
  const needs = list.filter(a => a.status === 'needs_you').length

  useEffect(() => {
    document.title = needs ? `(${needs}) Fleet` : 'Fleet'
    ;(navigator as any).setAppBadge?.(needs).catch?.(() => {})
  }, [needs])

  const go = (hash: string) => (location.hash = hash)
  const act = (p: Promise<unknown>, after?: () => void) => p.then(() => { agents.refresh(); paused.refresh(); after?.() }).catch(fail)

  const startAgent = (p?: Profile) =>
    act(api.post<{ name: string }>('/api/agents', p ? { profile: p.name } : { cwd: remember.get('cwd') })
      .then(({ name }) => go(`#/agent/${encodeURIComponent(name)}`)))

  const send = (name: string) => (body: { text?: string; key?: string }) =>
    api.post<void>(`/api/agents/${encodeURIComponent(name)}/send`, body).then(() => { agents.refresh() }).catch(e => {
      fail(e)
      throw e
    })

  // keyboard: ↑/↓ move through agents, 1-9 / letters answer the selected agent's menu, / focuses the reply box, n = new
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select, .xterm, [role=dialog]')
      if (typing || e.metaKey || e.ctrlKey || e.altKey || terminal || custom) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = list.findIndex(a => a.name === route.name)
        const next = list[Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), list.length - 1)]
        if (next) go(`#/agent/${encodeURIComponent(next.name)}`)
        e.preventDefault()
      } else if (e.key === '/') {
        document.getElementById('composer')?.focus()
        e.preventDefault()
      } else if (selected?.quick_replies.some(q => q.key === e.key)) {
        send(selected.name)({ key: e.key }).catch(() => {})
      } else if (e.key === 'n') {
        setCustom(true)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (locked) return <Locked />

  const push = <PushButton onError={fail} />
  const newButton = <NewAgentButton profiles={profiles} onNew={startAgent} onCustom={() => setCustom(true)}
    onDeleteProfile={p => act(api.del(`/api/profiles/${encodeURIComponent(p.name)}`), loadProfiles)} />
  const listHeader = (title: string) => (
    <div className="lh">
      <h4>{title}</h4>
      <div className="lh-mobile">{newButton}</div>
    </div>
  )
  const pausedCount = paused.data?.length ?? 0

  return (
    <div className="app" data-view={route.view === 'agent' && selected ? 'agent' : 'list'}>
      <Sidebar route={route.view === 'paused' ? 'paused' : 'all'} needs={needs} paused={pausedCount} push={push}
        profiles={profiles} onNew={startAgent} onCustom={() => setCustom(true)}
        onDeleteProfile={p => act(api.del(`/api/profiles/${encodeURIComponent(p.name)}`), loadProfiles)} />

      {route.view === 'paused' ? (
        <PausedList items={paused.data ?? []} header={listHeader('Paused')}
          onResume={p => act(api.post(`/api/paused/${p.id}/resume`), () => go(`#/agent/${encodeURIComponent(p.name)}`))}
          onForget={p => act(api.del(`/api/paused/${p.id}`))} />
      ) : (
        <AgentList agents={list} selected={route.name} header={listHeader('All agents')} />
      )}

      {selected ? (
        <AgentView key={selected.name} agent={selected} onBack={() => go('#/')} onTerminal={() => setTerminal(selected.name)}
          onPause={() => act(api.post(`/api/agents/${encodeURIComponent(selected.name)}/pause`), () => go('#/paused'))}
          onKill={() => setConfirmKill(selected)} send={send(selected.name)} />
      ) : (
        <main className="det placeholder">
          <div className="empty big">
            {route.view === 'agent' ? `${route.name} isn't running anymore.` : needs ? `${needs} agent${needs > 1 ? 's' : ''} need${needs > 1 ? '' : 's'} you.` : 'Pick an agent to see its screen.'}
          </div>
        </main>
      )}

      <nav className="tabs" aria-label="Sections">
        <a href="#/" className={route.view !== 'paused' ? 'on' : ''}>Agents{needs > 0 && <span className="badge">{needs}</span>}</a>
        <a href="#/paused" className={route.view === 'paused' ? 'on' : ''}>Paused{pausedCount > 0 && <b> {pausedCount}</b>}</a>
        <span className="tab-push">{push}</span>
      </nav>

      {custom && <CustomForm onClose={() => setCustom(false)} onError={fail}
        onStarted={name => { setCustom(false); loadProfiles(); agents.refresh(); go(`#/agent/${encodeURIComponent(name)}`) }} />}
      {terminal && <FullTerminal name={terminal} onClose={() => setTerminal('')} />}
      {confirmKill && (
        <Dialog title={`Kill ${confirmKill.name}?`} onClose={() => setConfirmKill(null)}>
          <p className="dialog-text">This stops the agent and closes its session. Pause instead if you want to come back to the conversation.</p>
          <div className="form-actions">
            <button className="btn" onClick={() => setConfirmKill(null)} autoFocus>Cancel</button>
            <button className="btn danger" onClick={() => {
              const a = confirmKill
              setConfirmKill(null)
              act(api.del(`/api/agents/${encodeURIComponent(a.name)}`), () => go('#/'))
            }}>Kill</button>
          </div>
        </Dialog>
      )}
      {toast && <div className="toast" role="status" onClick={() => setToast('')}>{toast}</div>}
    </div>
  )
}

function Locked() {
  return (
    <div className="locked">
      <div className="logo big">F</div>
      <h2>Fleet is locked</h2>
      <p>Open the link that <code>fleet dash install</code> printed (it ends in <code>?key=…</code>) once on this device.</p>
    </div>
  )
}

const urlB64 = (s: string) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true
const isIOS = () => /iPhone|iPad/.test(navigator.userAgent)

async function subscribe() {
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    const { key } = await api.get<{ key: string }>('/api/push/key')
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) })
  }
  await api.post('/api/push/subscribe', sub.toJSON())
}

function PushButton({ onError }: { onError: (e: Error) => void }) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [state, setState] = useState(supported ? Notification.permission : 'unsupported')
  // already allowed: make sure the server has this device's subscription (it may have been reset)
  useEffect(() => {
    if (state === 'granted') subscribe().catch(() => {})
  }, [state])
  if (state === 'granted') return null
  if (!supported) return isIOS() && !standalone()
    ? <span className="hint">For alerts: Share → Add to Home Screen, then open Fleet from there.</span>
    : null
  if (state === 'denied') return <span className="hint">Notifications are blocked in settings.</span>
  const enable = async () => {
    try {
      const perm = await Notification.requestPermission() // must run inside the tap
      setState(perm)
      if (perm !== 'granted') return
      await subscribe()
    } catch (e) {
      onError(e as Error)
    }
  }
  return <button className="btn small" onClick={enable}>Enable notifications</button>
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
