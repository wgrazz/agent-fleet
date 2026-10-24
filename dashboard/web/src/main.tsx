import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, remember, Unauthorized, usePoll, type Conversation, type Folder, type Idea, type List, type LiveAgent, type Paused, type Profile, type Usage } from './api.ts'
import { AgentList, AgentView, PausedList } from './agents.tsx'
import {
  COLORS, Confirm, CustomForm, InterviewForm, isPhone, MenuHost, MicIcon, NameDialog, NewAgentButton, openMenu, ORDER, Sidebar, UsageMeters,
  type MenuItem, type StartFields, useHold,
} from './components.tsx'
import { ConversationView, HistoryPane, Jarvis, Palette, speak, spokenAlerts } from './extras.tsx'
import { IdeaDetail, IdeasPane, ImportNotes, QuickCapture, SortMode } from './ideas.tsx'
import { FullTerminal } from './terminal.tsx'
import './styles.css'

// #/ · #/folder/ID · #/agent/NAME (what pushes open) · #/paused · #/ideas/LIST · #/idea/ID · #/history[/TOOL/ID] · #/more
type View = 'all' | 'folder' | 'agent' | 'paused' | 'ideas' | 'idea' | 'history' | 'more'
const parseRoute = () => {
  const [, view = '', a = '', b = ''] = location.hash.split('/')
  const views: View[] = ['folder', 'agent', 'paused', 'ideas', 'idea', 'history', 'more']
  return { view: (views.includes(view as View) ? view : 'all') as View, a: decodeURIComponent(a), b: decodeURIComponent(b) }
}
const go = (hash: string) => (location.hash = hash)
const enc = encodeURIComponent

type Modal =
  | { kind: 'custom'; initial?: Partial<StartFields>; title?: string; ideaId?: number }
  | { kind: 'interview'; topic?: string; ideaId?: number }
  | { kind: 'name'; title: string; initial?: string; color?: string; action?: string; submit: (name: string, color: string) => void }
  | { kind: 'confirm'; title: string; text: string; action: string; yes: () => void }
  | { kind: 'capture' } | { kind: 'import' } | { kind: 'sort' } | { kind: 'palette' }
  | null

function App() {
  const [route, setRoute] = useState(parseRoute)
  const [locked, setLocked] = useState(false)
  const [toast, setToast] = useState('')
  const [modal, setModal] = useState<Modal>(null)
  const [terminal, setTerminal] = useState('')
  const [jarvisOpen, setJarvisOpen] = useState(false)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [historyQ, setHistoryQ] = useState('')
  const [history, setHistory] = useState<Conversation[] | null>(null)
  const [sorting, setSorting] = useState(false)
  const lastListRoute = useRef('#/')

  const fail = useCallback((e: Error) => (e instanceof Unauthorized ? setLocked(true) : setToast(e.message)), [])
  const agents = usePoll<LiveAgent[]>('/api/agents', 2000, fail)
  const paused = usePoll<Paused[]>('/api/paused', 5000, fail)
  const folders = usePoll<Folder[]>('/api/folders', 15000, fail)
  const lists = usePoll<List[]>('/api/lists', 5000, fail)
  const usage = usePoll<Usage[]>('/api/usage', 30000, fail)
  const loadProfiles = useCallback(() => api.get<Profile[]>('/api/profiles').then(setProfiles).catch(fail), [fail])

  const allLists = lists.data ?? []
  const all = [...(agents.data ?? [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const folderList = folders.data ?? []

  // which Ideas list is on screen: the route's, or the open idea's
  const [ideaItem, setIdeaItem] = useState<Idea | null>(null)
  const currentListName = route.view === 'ideas' ? route.a : route.view === 'idea' ? ideaItem?.list ?? '' : ''
  const ideas = usePoll<Idea[]>(`/api/ideas?list=${enc(currentListName || '-')}`, currentListName ? 4000 : 3_600_000, fail)
  useEffect(() => {
    if (route.view !== 'idea') return setIdeaItem(null)
    const found = ideas.data?.find(i => i.id === Number(route.a))
    if (found) setIdeaItem(found)
    else api.get<Idea[]>('/api/ideas').then(xs => setIdeaItem(xs.find(i => i.id === Number(route.a)) ?? null)).catch(fail)
  }, [route.view, route.a, ideas.data]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => {
      const r = parseRoute()
      setRoute(r)
      if (['all', 'folder', 'paused', 'history', 'ideas'].includes(r.view)) lastListRoute.current = location.hash || '#/'
    }
    addEventListener('hashchange', on)
    loadProfiles()
    return () => removeEventListener('hashchange', on)
  }, [loadProfiles])

  // history: on the History screen, and for a folder's past conversations
  const folderId = route.view === 'folder' ? Number(route.a) : null
  useEffect(() => {
    if (route.view !== 'history' && folderId === null) return
    const t = setTimeout(() => api.get<Conversation[]>(`/api/history?q=${enc(historyQ)}`).then(setHistory).catch(fail), historyQ ? 200 : 0)
    return () => clearTimeout(t)
  }, [route.view, folderId, historyQ, fail])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(t)
  }, [toast])

  const needs = all.filter(a => a.status === 'needs_you').length
  useEffect(() => {
    document.title = needs ? `(${needs}) Fleet` : 'Fleet'
    ;(navigator as any).setAppBadge?.(needs).catch?.(() => {})
  }, [needs])

  // spoken alerts (Jarvis setting): say it when an agent starts needing you, finishes or crashes
  const prevStatus = useRef(new Map<string, string>())
  useEffect(() => {
    if (!agents.data) return
    const prev = prevStatus.current
    if (prev.size && spokenAlerts.get()) {
      for (const a of agents.data) {
        const before = prev.get(a.name)
        if (before && before !== a.status && ['needs_you', 'done', 'crashed'].includes(a.status))
          speak(`${a.name.replace(/[-_.]/g, ' ')} ${a.status === 'needs_you' ? 'needs you' : a.status === 'done' ? 'is done' : 'crashed'}`)
      }
    }
    prevStatus.current = new Map(agents.data.map(a => [a.name, a.status]))
  }, [agents.data])

  const refreshAll = () => { agents.refresh(); paused.refresh(); folders.refresh(); lists.refresh(); ideas.refresh() }
  const act = (p: Promise<unknown>, after?: () => void) => p.then(() => { refreshAll(); after?.() }).catch(fail)
  const openAgent = (name: string) => go(`#/agent/${enc(name)}`)

  const startAgent = (p?: Profile) => act(api.post<{ name: string }>('/api/agents', {
    ...(p ? { profile: p.name } : { cwd: remember.get('cwd') }), folder_id: folderId ?? undefined,
  }).then(({ name }) => openAgent(name)))

  const send = (name: string) => (body: { text?: string; key?: string }) =>
    api.post<void>(`/api/agents/${enc(name)}/send`, body).then(() => { agents.refresh() }).catch(e => { fail(e); throw e })

  // ---------- menus ----------
  const folderItems = (key: string, current: number | null, after?: () => void): MenuItem[] => [
    ...folderList.map(f => ({ label: f.name, swatch: f.color, checked: f.id === current, onClick: () => act(api.put('/api/placements', { key, folder_id: f.id }), after) })),
    ...(folderList.length ? ['sep' as const] : []),
    { label: 'New folder…', onClick: () => newFolder(id => act(api.put('/api/placements', { key, folder_id: id }), after)) },
    ...(current !== null ? [{ label: 'Remove from folder', onClick: () => act(api.put('/api/placements', { key, folder_id: null }), after) }] : []),
  ]

  const agentMenu = (a: LiveAgent, x: number, y: number) => openMenu(x, y, [
    { label: 'Open', onClick: () => openAgent(a.name) },
    ...(a.controllable ? [{ label: 'Full terminal', onClick: () => setTerminal(a.name) }] : []),
    ...(a.controllable && a.pid !== null ? [{ label: 'Rename…', onClick: () => setModal({ kind: 'name', title: `Rename ${a.name}`, initial: a.name, action: 'Rename',
      submit: (to: string) => { setModal(null); act(api.post<{ name: string }>(`/api/agents/${enc(a.name)}/rename`, { to }).then(r => { if (route.a === a.name) openAgent(r.name) })) } }) }] : []),
    { label: 'Move to folder', items: folderItems(a.key, a.folder_id) },
    ...(a.controllable && a.pid !== null && a.session_id ? [{ label: 'Pause', onClick: () => act(api.post(`/api/agents/${enc(a.name)}/pause`)) }] : []),
    ...(a.controllable ? ['sep' as const, { label: a.pid === null ? 'Close session' : 'Kill…', danger: true, onClick: () => setModal({
      kind: 'confirm', title: `Kill ${a.name}?`, action: 'Kill', text: 'This stops the agent and closes its session. Pause instead if you want to come back to the conversation.',
      yes: () => act(api.del(`/api/agents/${enc(a.name)}`), () => route.a === a.name && go(lastListRoute.current)),
    }) }] : []),
  ], a.name)

  const conversationMenu = (c: Conversation, x: number, y: number) => openMenu(x, y, [
    ...(c.running ? [{ label: `Open ${c.running}`, onClick: () => openAgent(c.running!) }] : [{ label: 'Resume', onClick: () => resume(c) }]),
    { label: 'Move to folder', items: folderItems(c.key, c.folder_id, () => api.get<Conversation[]>(`/api/history?q=${enc(historyQ)}`).then(setHistory)) },
  ], c.title || 'Conversation')

  const resume = (c: Conversation) => act(api.post<{ name: string }>('/api/history/resume', c).then(r => {
    if (c.folder_id !== null) api.put('/api/placements', { key: `name:${r.name}`, folder_id: c.folder_id })
    openAgent(r.name)
  }))

  const newFolder = (then?: (id: number) => void) => setModal({ kind: 'name', title: 'New folder', color: COLORS[6], action: 'Create', submit: (name, color) => {
    setModal(null)
    act(api.post<{ id: number }>('/api/folders', { name, color }).then(r => then?.(r.id)))
  } })

  const folderMenu = (f: Folder, x: number, y: number) => openMenu(x, y, [
    { label: 'Rename…', onClick: () => setModal({ kind: 'name', title: 'Rename folder', initial: f.name, color: f.color, submit: (name, color) => { setModal(null); act(api.patch(`/api/folders/${f.id}`, { name, color })) } }) },
    { label: 'Color', items: COLORS.map(c => ({ label: c === f.color ? 'Current' : ' ', swatch: c, checked: c === f.color, onClick: () => act(api.patch(`/api/folders/${f.id}`, { color: c })) })) },
    'sep',
    { label: 'Delete folder…', danger: true, onClick: () => setModal({ kind: 'confirm', title: `Delete ${f.name}?`, action: 'Delete', text: 'Its agents and conversations go back to All. Nothing else changes.',
      yes: () => act(api.del(`/api/folders/${f.id}`), () => route.view === 'folder' && Number(route.a) === f.id && go('#/')) }) },
  ], f.name)

  const pinned = (l: List) => l.name === 'Priority' || l.name === 'Brain Dump'
  const listMenu = (l: List, x: number, y: number) => openMenu(x, y, [
    ...(!pinned(l) ? [{ label: 'Rename…', onClick: () => setModal({ kind: 'name', title: 'Rename list', initial: l.name, color: l.color, submit: (name: string, color: string) => {
      setModal(null)
      act(api.patch(`/api/lists/${l.id}`, { name, color }), () => route.view === 'ideas' && route.a === l.name && go(`#/ideas/${enc(name)}`))
    } }) }] : []),
    { label: 'Color', items: COLORS.map(c => ({ label: c === l.color ? 'Current' : ' ', swatch: c, checked: c === l.color, onClick: () => act(api.patch(`/api/lists/${l.id}`, { color: c })) })) },
    { label: 'Import from Apple Notes…', onClick: () => setModal({ kind: 'import' }) },
    ...(!pinned(l) ? ['sep' as const, { label: 'Delete list…', danger: true, onClick: () => setModal({ kind: 'confirm', title: `Delete ${l.name}?`, action: 'Delete',
      text: `Open items move to Brain Dump; the ${l.done} done item${l.done === 1 ? '' : 's'} go with the list.`,
      yes: () => act(api.del(`/api/lists/${l.id}`), () => go('#/ideas/Brain%20Dump')) }) }] : []),
  ], l.name)

  const ideaMenu = (i: Idea, x: number, y: number) => openMenu(x, y, [
    { label: i.done ? 'Mark not done' : 'Mark done', onClick: () => act(api.patch(`/api/ideas/${i.id}`, { done: !i.done })) },
    { label: 'Move to', items: allLists.filter(l => l.name !== i.list).map(l => ({ label: l.name, swatch: l.color, onClick: () => act(api.patch(`/api/ideas/${i.id}`, { list: l.name })) })) },
    { label: 'Start an agent on this', onClick: () => startFromIdea(i) },
    { label: 'Interview me about it', onClick: () => setModal({ kind: 'interview', topic: i.text, ideaId: i.id }) },
    'sep',
    { label: 'Delete', danger: true, onClick: () => act(api.del(`/api/ideas/${i.id}`)) },
  ], i.text.slice(0, 40))

  const startFromIdea = (i: Idea) => setModal({ kind: 'custom', title: 'Start an agent on this idea', ideaId: i.id, initial: { prompt: `${i.text}${i.notes ? `\n\n${i.notes}` : ''}` } })

  const runSort = () => {
    setModal({ kind: 'sort' })
    if ((allLists.find(l => l.name === 'Brain Dump')?.unsorted ?? 0) > 0) {
      setSorting(true)
      api.post('/api/ideas/sort').then(() => ideas.refresh()).catch(fail).finally(() => setSorting(false))
    }
  }

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setModal({ kind: 'palette' }); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); setModal({ kind: 'capture' }); return }
      const typing = (e.target as HTMLElement).closest?.('input, textarea, select, .xterm, [role=dialog]')
      if (typing || e.metaKey || e.ctrlKey || e.altKey || terminal || modal) return
      const selected = route.view === 'agent' ? all.find(a => a.name === route.a) : null
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (route.view === 'agent' || route.view === 'all' || route.view === 'folder')) {
        const pool = folderId !== null ? all.filter(a => a.folder_id === folderId) : all
        const i = pool.findIndex(a => a.name === route.a)
        const next = pool[Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), pool.length - 1)]
        if (next) openAgent(next.name)
        e.preventDefault()
      } else if (e.key === '/') {
        document.getElementById('composer')?.focus()
        e.preventDefault()
      } else if (selected?.quick_replies.some(q => q.key === e.key)) {
        send(selected.name)({ key: e.key }).catch(() => {})
      } else if (e.key === 'n') {
        setModal({ kind: 'custom' })
      } else if (e.key === 'j') {
        setJarvisOpen(true)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (locked) return <Locked />

  // ---------- layout ----------
  const push = <PushButton onError={fail} />
  const newButton = <NewAgentButton profiles={profiles} onNew={startAgent} onCustom={() => setModal({ kind: 'custom', initial: { folder_id: folderId } })}
    onInterview={() => setModal({ kind: 'interview' })} onDeleteProfile={p => act(api.del(`/api/profiles/${enc(p.name)}`), loadProfiles)} />
  const counts = new Map<number, number>()
  for (const a of all) if (a.folder_id !== null) counts.set(a.folder_id, (counts.get(a.folder_id) ?? 0) + 1)
  const listHeader = (title: string, color?: string) => (
    <>
      <div className="lh">
        <h4>{color && <span className="sq" style={{ background: color }} />}{title}</h4>
        <div className="lh-mobile">{newButton}</div>
      </div>
      {isPhone() && (route.view === 'all' || route.view === 'folder' || route.view === 'agent') && (
        <div className="chips">
          <a className={`chip-f ${folderId === null ? 'on' : ''}`} href="#/">All</a>
          {folderList.map(f => <FolderChip key={f.id} f={f} on={folderId === f.id} onMenu={(x, y) => folderMenu(f, x, y)} />)}
          <button className="chip-f add" onClick={() => newFolder()} aria-label="New folder">+ Folder</button>
        </div>
      )}
    </>
  )

  const agentFromRoute = route.view === 'agent' ? all.find(a => a.name === route.a) ?? null : null
  const conversation = route.view === 'history' && route.b ? history?.find(c => c.id === route.b) ?? null : null
  const sideRoute = route.view === 'folder' ? `folder/${route.a}` : route.view === 'ideas' ? `ideas/${route.a}` : route.view === 'idea' ? `ideas/${currentListName}` : route.view
  const listShown = allLists.find(l => l.name === currentListName)

  // middle pane: when an agent is open it keeps showing the list it was opened from
  const middleView = route.view === 'agent' ? parseRouteOf(lastListRoute.current) : route
  let middle
  if (middleView.view === 'paused') {
    middle = <PausedList items={paused.data ?? []} header={listHeader('Paused')}
      onResume={p => act(api.post(`/api/paused/${p.id}/resume`), () => openAgent(p.name))} onForget={p => act(api.del(`/api/paused/${p.id}`))} />
  } else if (middleView.view === 'history') {
    middle = <HistoryPane items={history} q={historyQ} setQ={setHistoryQ} selected={route.b} onMenu={conversationMenu} />
  } else if ((route.view === 'ideas' || route.view === 'idea') && listShown) {
    middle = <IdeasPane list={listShown} items={ideas.data ?? []} selected={route.view === 'idea' ? Number(route.a) : null}
      onChange={() => { ideas.refresh(); lists.refresh() }} onError={fail} onSort={runSort} onMenu={ideaMenu}
      onHeaderMenu={(x, y) => listMenu(listShown, x, y)} />
  } else if (middleView.view === 'more') {
    middle = <MorePane usage={usage.data ?? []} push={push} paused={paused.data?.length ?? 0} />
  } else {
    const fid = middleView.view === 'folder' ? Number(middleView.a) : null
    const folder = folderList.find(f => f.id === fid)
    middle = <AgentList agents={fid !== null ? all.filter(a => a.folder_id === fid) : all} selected={route.a} onMenu={agentMenu}
      header={listHeader(folder?.name ?? 'All agents', folder?.color)}
      past={fid !== null ? (history ?? []).filter(c => c.folder_id === fid && !c.running) : undefined}
      empty={fid !== null ? <div className="empty">Nothing in {folder?.name ?? 'this folder'} yet. Drag agents here, or hold one and pick Move to folder.</div> : undefined} />
  }

  let detail
  if (agentFromRoute) {
    detail = <AgentView key={agentFromRoute.name} agent={agentFromRoute} onBack={() => go(lastListRoute.current)} onTerminal={() => setTerminal(agentFromRoute.name)}
      onPause={() => act(api.post(`/api/agents/${enc(agentFromRoute.name)}/pause`), () => go('#/paused'))}
      onMenu={(x, y) => agentMenu(agentFromRoute, x, y)} send={send(agentFromRoute.name)} />
  } else if (route.view === 'idea' && ideaItem) {
    detail = <IdeaDetail key={ideaItem.id} idea={ideaItem} lists={allLists} onBack={() => go(`#/ideas/${enc(ideaItem.list)}`)}
      onChange={() => { ideas.refresh(); lists.refresh(); api.get<Idea[]>(`/api/ideas?list=${enc(ideaItem.list)}`).then(xs => setIdeaItem(xs.find(i => i.id === ideaItem.id) ?? null)) }}
      onError={fail} onStart={startFromIdea} onInterview={i => setModal({ kind: 'interview', topic: i.text, ideaId: i.id })}
      onDelete={i => act(api.del(`/api/ideas/${i.id}`), () => go(`#/ideas/${enc(i.list)}`))} />
  } else if (conversation) {
    detail = <ConversationView key={conversation.id} c={conversation} onBack={() => go('#/history')} onResume={() => resume(conversation)}
      onMenu={(x, y) => conversationMenu(conversation, x, y)} />
  } else {
    const msg = route.view === 'agent' ? `${route.a} isn't running anymore.`
      : route.view === 'ideas' || route.view === 'idea' ? 'Pick an idea, or add one above. ⌘I adds one from anywhere.'
      : route.view === 'history' ? 'Pick a conversation to read it or pick up where you left off.'
      : needs ? `${needs} agent${needs > 1 ? 's' : ''} need${needs > 1 ? '' : 's'} you.` : 'Pick an agent to see what it’s doing.'
    detail = <main className="det placeholder"><div className="empty big">{msg}<div className="hint">⌘K to jump anywhere · N new agent · J Jarvis</div></div></main>
  }

  const hasDetail = !!(agentFromRoute || (route.view === 'idea' && ideaItem) || conversation)
  const tab = ['ideas', 'idea'].includes(route.view) ? 'ideas' : route.view === 'history' ? 'history' : ['more', 'paused'].includes(route.view) ? 'more' : 'agents'
  const brainDump = allLists.find(l => l.name === 'Brain Dump')

  return (
    <div className="app" data-view={hasDetail ? 'detail' : 'list'}>
      <Sidebar route={sideRoute} needs={needs} paused={paused.data?.length ?? 0} folders={folderList} counts={counts} lists={allLists}
        usage={usage.data ?? []} newButton={newButton} push={push} onJarvis={() => setJarvisOpen(true)} onNewFolder={() => newFolder()} onFolderMenu={folderMenu}
        onNewList={() => setModal({ kind: 'name', title: 'New list', color: COLORS[6], action: 'Create', submit: (name, color) => { setModal(null); act(api.post('/api/lists', { name, color }), () => go(`#/ideas/${enc(name)}`)) } })}
        onListMenu={listMenu} onDrop={(fid, key) => key && act(api.put('/api/placements', { key, folder_id: fid }))} />
      {middle}
      {detail}

      <nav className="tabs" aria-label="Sections">
        <a href={lastListRoute.current.startsWith('#/folder') ? lastListRoute.current : '#/'} className={tab === 'agents' ? 'on' : ''}>Agents{needs > 0 && <span className="badge">{needs}</span>}</a>
        <a href={`#/ideas/${enc(remember.get('lastList') || 'Brain Dump')}`} className={tab === 'ideas' ? 'on' : ''}>Ideas{(brainDump?.unsorted ?? 0) > 0 && <span className="badge gray">{brainDump!.unsorted}</span>}</a>
        <button className="tab-mic" onClick={() => setJarvisOpen(true)} aria-label="Jarvis"><MicIcon /></button>
        <a href="#/history" className={tab === 'history' ? 'on' : ''}>History</a>
        <a href="#/more" className={tab === 'more' ? 'on' : ''}>More</a>
      </nav>
      {(route.view === 'ideas' || route.view === 'idea') && <IdeasListPicker lists={allLists} current={currentListName}
        onNew={() => setModal({ kind: 'name', title: 'New list', color: COLORS[6], action: 'Create', submit: (name, color) => { setModal(null); act(api.post('/api/lists', { name, color }), () => go(`#/ideas/${enc(name)}`)) } })} />}

      {jarvisOpen && <Jarvis onClose={() => setJarvisOpen(false)} onChanged={refreshAll} />}

      {modal?.kind === 'custom' && <CustomForm title={modal.title} initial={modal.initial} folders={folderList} onClose={() => setModal(null)} onError={fail}
        onStart={async f => {
          const path = modal.ideaId ? `/api/ideas/${modal.ideaId}/start` : '/api/agents'
          const { name } = await api.post<{ name: string }>(path, { ...f, folder_id: f.folder_id ?? undefined })
          setModal(null)
          loadProfiles()
          refreshAll()
          openAgent(name)
        }} />}
      {modal?.kind === 'interview' && <InterviewForm initial={modal.topic} onClose={() => setModal(null)} onStart={async topic => {
        const { name } = await api.post<{ name: string }>('/api/interview', { topic, idea_id: modal.ideaId, folder_id: folderId ?? undefined }).catch(e => { fail(e); throw e })
        setModal(null)
        refreshAll()
        openAgent(name)
      }} />}
      {modal?.kind === 'name' && <NameDialog title={modal.title} initial={modal.initial} color={modal.color} action={modal.action} onSubmit={modal.submit} onClose={() => setModal(null)} />}
      {modal?.kind === 'confirm' && <Confirm title={modal.title} text={modal.text} action={modal.action} onYes={modal.yes} onClose={() => setModal(null)} />}
      {modal?.kind === 'capture' && <QuickCapture lists={allLists} onClose={() => { setModal(null); refreshAll() }} onError={fail} />}
      {modal?.kind === 'import' && <ImportNotes onClose={() => setModal(null)} onDone={refreshAll} />}
      {modal?.kind === 'sort' && <SortMode items={(currentListName === 'Brain Dump' ? ideas.data : null) ?? []} lists={allLists} loading={sorting}
        onDone={() => { setModal(null); refreshAll() }} onError={fail} onStart={i => startFromIdea(i)} />}
      {modal?.kind === 'palette' && <Palette agents={all} lists={allLists} onClose={() => setModal(null)} actions={[
        { label: 'New agent…', run: () => setModal({ kind: 'custom' }) },
        { label: 'Interview me about an idea…', run: () => setModal({ kind: 'interview' }) },
        { label: 'New idea…', run: () => setModal({ kind: 'capture' }) },
        { label: 'Sort Brain Dump', run: () => { go('#/ideas/Brain%20Dump'); setTimeout(runSort, 300) } },
        { label: 'Talk to Jarvis', run: () => setJarvisOpen(true) },
        { label: 'History', run: () => go('#/history') },
        { label: 'Paused agents', run: () => go('#/paused') },
      ]} />}
      {terminal && <FullTerminal name={terminal} onClose={() => setTerminal('')} />}
      <MenuHost />
      {toast && <div className="toast" role="status" onClick={() => setToast('')}>{toast}</div>}
    </div>
  )
}

function parseRouteOf(hash: string) {
  const [, view = '', a = ''] = hash.split('/')
  return { view: (view || 'all') as View, a: decodeURIComponent(a) }
}

/** Phone: a row of list chips above the Ideas pane, since the sidebar is hidden. */
function FolderChip({ f, on, onMenu }: { f: Folder; on: boolean; onMenu: (x: number, y: number) => void }) {
  const hold = useHold(onMenu)
  return <a className={`chip-f ${on ? 'on' : ''}`} href={`#/folder/${f.id}`} {...hold}><span className="sq" style={{ background: f.color }} />{f.name}</a>
}

function IdeasListPicker({ lists, current, onNew }: { lists: List[]; current: string; onNew: () => void }) {
  useEffect(() => { if (current) remember.set('lastList', current) }, [current])
  return (
    <div className="chips ideas-chips">
      {lists.map(l => (
        <a key={l.id} className={`chip-f ${l.name === current ? 'on' : ''}`} href={`#/ideas/${enc(l.name)}`}>
          <span className="sq round" style={{ background: l.color }} />{l.name}{l.name === 'Brain Dump' && l.unsorted > 0 ? ` ${l.unsorted}` : ''}
        </a>
      ))}
      <button className="chip-f add" onClick={onNew} aria-label="New list">+ List</button>
    </div>
  )
}

function MorePane({ usage, push, paused }: { usage: Usage[]; push: React.ReactNode; paused: number }) {
  return (
    <section className="list more">
      <div className="lh"><h4>More</h4></div>
      <div className="scroll">
        <a className="it plain" href="#/paused"><span className="nm">Paused agents</span><span className="tm">{paused || ''}</span></a>
        <div className="grp">Usage</div>
        <UsageMeters usage={usage} />
        <div className="grp">Notifications</div>
        <div className="more-push">{push ?? <span className="hint">On</span>}</div>
      </div>
    </section>
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
