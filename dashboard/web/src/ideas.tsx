import { useEffect, useRef, useState } from 'react'
import { api, isHeading, remember, type Idea, type List } from './api.ts'
import { AREAS, areaColor } from './areas.ts'
import { Dialog, InboxIcon, LinesIcon, isPhone, SparkIcon, STATUS_LABEL, useHold } from './components.tsx'
import type { Step } from './steps.ts'

export const PRIORITY = ['None', 'Low', 'Medium', 'High']

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function repeatLabel(rule: string | null) {
  if (!rule) return ''
  const [kind, n] = rule.split(':')
  if (kind === 'daily') return 'Every day'
  if (kind === 'weekly') return `Every ${DAYS[Number(n)]}`
  if (kind === 'monthly') return `Monthly on the ${n}${['th', 'st', 'nd', 'rd'][Number(n) % 10 > 3 || [11, 12, 13].includes(Number(n)) ? 0 : Number(n) % 10]}`
  return `Every ${n} days`
}

// ---------- the list pane ----------

type Order = (a: Idea, b: Idea) => number
const newest: Order = (a, b) => b.created_at - a.created_at || b.id - a.id
const mine: Order = (a, b) => (a.position ?? a.id) - (b.position ?? b.id)
export const SORTS: Record<string, { label: string; by: Order }> = {
  newest: { label: 'Newest first', by: newest },
  oldest: { label: 'Oldest first', by: (a, b) => -newest(a, b) },
  priority: { label: 'Priority', by: (a, b) => b.priority - a.priority || newest(a, b) },
  manual: { label: 'My order', by: mine },
}

/** The sort you picked, the same in every list and remembered on this device. */
function useSort() {
  const [sort, set] = useState(() => SORTS[remember.get('ideaSort')] ? remember.get('ideaSort') : 'newest')
  return [sort, (s: string) => { set(s); remember.set('ideaSort', s) }] as const
}

function IdeaTools({ sort, setSort, area, setArea }: { sort: string; setSort: (s: string) => void; area: string; setArea: (a: string) => void }) {
  return (
    <div className="idea-tools">
      <select aria-label="Sort" value={sort} onChange={e => setSort(e.target.value)}>
        {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
      </select>
      <select aria-label="Filter by area" value={area} onChange={e => setArea(e.target.value)}>
        <option value="">All areas</option>
        {AREAS.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
      </select>
    </div>
  )
}

/** A shake of the phone, once per shake. iOS only reports motion after askMotion() runs inside a tap. */
function useShake(on: () => void) {
  const cb = useRef(on)
  cb.current = on
  useEffect(() => {
    let last = 0
    const m = (e: DeviceMotionEvent) => {
      const a = e.acceleration
      // ponytail: one threshold (m/s², gravity removed); raise it if walking sets it off, lower if shakes are missed
      if (a && Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) > 18 && Date.now() - last > 1500) { last = Date.now(); cb.current() }
    }
    addEventListener('devicemotion', m)
    return () => removeEventListener('devicemotion', m)
  }, [])
}
let motionAsked = false
const askMotion = () => {
  const D = (globalThis as any).DeviceMotionEvent
  if (!motionAsked && typeof D?.requestPermission === 'function') { motionAsked = true; D.requestPermission().catch(() => {}) }
}

const CopyIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" /></svg>
)

export function IdeasPane({ list, items, selected, onChange, onError, onSort, onHeaderMenu, onMenu }: {
  list: List; items: Idea[]; selected: number | null; onChange: () => void; onError: (e: Error) => void
  onSort: () => void; onHeaderMenu: (x: number, y: number) => void; onMenu: (i: Idea, x: number, y: number) => void
}) {
  const [draft, setDraft] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [dragging, setDragging] = useState<number | null>(null)
  const [area, setArea] = useState('')
  const [sort, setSort] = useSort()
  const shown = area ? items.filter(i => i.area === area) : items
  // what Undo (shake, ⌘Z or the button) reverses, newest last: a check or uncheck (done = how it was), or a step you added
  const [undos, setUndos] = useState<{ id: number; done?: boolean }[]>([])
  const [flash, setFlash] = useState('')
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(''), 1500); return () => clearTimeout(t) }, [flash])
  useEffect(() => setUndos([]), [list.id])
  const checklist = list.kind === 'checklist'
  // a checklist keeps its order with checked steps in place; an ideas list moves them under Done
  const order = checklist ? mine : SORTS[sort].by
  const open = (checklist ? [...shown] : shown.filter(i => !i.done)).sort(order)
  const done = checklist ? [] : shown.filter(i => i.done).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0)) // latest finished first
  const canDrag = !isPhone() && (checklist || sort === 'manual')
  const steps = shown.filter(i => !isHeading(i.text))
  const add = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const r = await api.post<{ id: number }>('/api/ideas', { text, list: list.name, area: area || undefined }).catch(onError)
    if (r) setUndos(u => [...u, { id: r.id }])
    onChange()
  }
  const setDone = (i: Idea, done: boolean) => {
    askMotion()
    setUndos(u => [...u, { id: i.id, done: !!i.done }])
    return api.patch(`/api/ideas/${i.id}`, { done }).then(onChange).catch(onError)
  }
  const toggle = (i: Idea) => setDone(i, !i.done)
  const copy = (i: Idea) => {
    askMotion()
    return navigator.clipboard.writeText(i.text).then(() => { setFlash('Copied'); return true }, e => { onError(e); return false })
  }
  const copyAndCheck = (i: Idea) => copy(i).then(ok => { if (ok && !i.done) setDone(i, true) }) // a failed copy leaves it unchecked
  const undo = () => {
    const last = undos.at(-1)
    if (!last) return
    setUndos(u => u.slice(0, -1))
    ;(last.done === undefined ? api.del(`/api/ideas/${last.id}`) : api.patch(`/api/ideas/${last.id}`, { done: last.done }))
      .then(() => { setFlash('Undone'); onChange() }).catch(onError)
  }
  useShake(undo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return // fields keep their own undo
      e.preventDefault()
      undo()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })
  const dropOn = (target: Idea) => {
    if (dragging === null || dragging === target.id) return
    const idx = open.findIndex(i => i.id === target.id)
    const before = open[idx - 1]
    const pos = before ? ((before.position ?? before.id) + (target.position ?? target.id)) / 2 : (target.position ?? target.id) - 1
    api.patch(`/api/ideas/${dragging}`, { position: pos }).then(onChange).catch(onError)
    setDragging(null)
  }
  return (
    <section className="list ideas">
      <div className="lh">
        <h4><span className="sq round" style={{ background: list.color }} />{list.name}</h4>
        {checklist && steps.length > 0 && <span className="progress">{steps.filter(i => i.done).length}/{steps.length}</span>}
        {flash ? <span className="progress">{flash}</span> : undos.length > 0 && <button className="btn small" title="Undo (shake or ⌘Z)" onClick={undo}>Undo</button>}
        {list.name === 'Brain Dump' && open.length > 0 && <button className="btn small primary" onClick={onSort}>Sort {open.length}</button>}
        <button className="btn small" aria-label="List options" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onHeaderMenu(r.right - 220, r.bottom + 4) }}>⋯</button>
      </div>
      {!checklist && <IdeaTools sort={sort} setSort={setSort} area={area} setArea={setArea} />}
      <form className="add" onSubmit={e => { e.preventDefault(); add() }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={checklist ? 'Add a step… (## starts a heading)' : `Add to ${list.name}${area ? ` · ${area}` : ''}…`} enterKeyHint="done" />
      </form>
      <div className="scroll">
        {open.map(i => (
          <IdeaRow key={i.id} i={i} on={i.id === selected} onToggle={() => toggle(i)} onMenu={(x, y) => onMenu(i, x, y)}
            onCopy={checklist ? () => copy(i) : undefined} onCopyCheck={checklist ? () => copyAndCheck(i) : undefined}
            dragProps={{
              draggable: canDrag, onDragStart: () => setDragging(i.id), onDragEnd: () => setDragging(null),
              onDragOver: (e: React.DragEvent) => dragging !== null && e.preventDefault(), onDrop: () => dropOn(i),
            }} />
        ))}
        {!open.length && <div className="empty">{area ? `Nothing open in ${area} here.` : list.name === 'Brain Dump' ? 'Inbox zero. Jot anything here, or say "Jarvis, idea: …".' : 'Nothing open here.'}</div>}
        {done.length > 0 && (
          <>
            <button className="grp done-toggle" onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Done ({done.length})</button>
            {showDone && done.map(i => <IdeaRow key={i.id} i={i} on={i.id === selected} onToggle={() => toggle(i)} onMenu={(x, y) => onMenu(i, x, y)} />)}
          </>
        )}
      </div>
    </section>
  )
}

function IdeaRow({ i, on, onToggle, onMenu, dragProps, showList, onCopy, onCopyCheck }: {
  i: Idea; on: boolean; onToggle: () => void; onMenu: (x: number, y: number) => void; dragProps?: object; showList?: boolean
  onCopy?: () => void; onCopyCheck?: () => void
}) {
  const hold = useHold(onMenu)
  if (isHeading(i.text)) return (
    <div className={`idea heading ${on ? 'on' : ''}`} {...dragProps} {...hold}><a href={`#/idea/${i.id}`} className="idea-body">{i.text.slice(3)}</a></div>
  )
  return (
    <div className={`idea ${on ? 'on' : ''} ${i.done ? 'is-done' : ''}`} {...dragProps} {...hold}>
      <button className={`check ${i.done ? 'checked' : ''}`} role="checkbox" aria-checked={!!i.done} aria-label="Done" onClick={onToggle} />
      <a href={`#/idea/${i.id}`} className="idea-body">
        <span className="idea-text">{i.priority > 0 && !i.done && <span className={`prio p${i.priority}`} title={i.why ?? PRIORITY[i.priority]}>{'!'.repeat(i.priority)}</span>}{i.text}</span>
        <span className="idea-meta">
          {i.area && <span className="idea-area"><span className="sq round" style={{ background: areaColor(i.area) }} />{i.area}</span>}
          {showList && <span className="idea-list">{i.list}</span>}
          {showList && i.why && <span className="why">{i.why}</span>}
          {i.repeat && <span title={repeatLabel(i.repeat)}>↻ {repeatLabel(i.repeat)}</span>}
          {i.agent && <span className="idea-agent"><span className={`st-inline st-${i.agent_status}`} />{i.agent}{i.agent_status === 'done' && !i.done ? ' · done?' : ''}</span>}
          {i.notes && <span>✎ note</span>}
          {i.suggestion && !i.done && <span className="sugg">→ {i.suggestion}</span>}
        </span>
      </a>
      {onCopy && (
        <span className="idea-acts">
          <button className="btn small" title="Copy" aria-label="Copy" onClick={onCopy}><CopyIcon /></button>
          {!i.done && onCopyCheck && <button className="btn small" title="Copy and check off" aria-label="Copy and check off" onClick={onCopyCheck}><CopyIcon />✓</button>}
        </span>
      )}
    </div>
  )
}

// ---------- detail ----------

export function IdeaDetail({ idea, lists, onBack, onChange, onError, onStart, onInterview, onDelete }: {
  idea: Idea; lists: List[]; onBack: () => void; onChange: () => void; onError: (e: Error) => void
  onStart: (i: Idea) => void; onInterview: (i: Idea) => void; onDelete: (i: Idea) => void
}) {
  const [text, setText] = useState(idea.text)
  const [notes, setNotes] = useState(idea.notes)
  useEffect(() => { setText(idea.text); setNotes(idea.notes) }, [idea.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (patch: object) => api.patch(`/api/ideas/${idea.id}`, patch).then(onChange).catch(onError)
  const [kind, arg] = (idea.repeat ?? '').split(':')
  const setRepeat = (k: string, a = '') => save({ repeat: k ? (k === 'daily' ? 'daily' : `${k}:${a || defaultArg(k)}`) : null })
  return (
    <main className="det idea-detail">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <button className={`check big ${idea.done ? 'checked' : ''}`} role="checkbox" aria-checked={!!idea.done} aria-label="Done" onClick={() => save({ done: !idea.done })} />
        <div className="dh-text"><div className="t">{idea.list}</div><div className="meta">Added {new Date(idea.created_at * 1000).toLocaleDateString()}</div></div>
        <div className="acts"><button className="btn danger-ghost" onClick={() => onDelete(idea)}>Delete</button></div>
      </header>
      <div className="idea-form">
        <textarea className="idea-title" value={text} rows={3} onChange={e => setText(e.target.value)} onBlur={() => text.trim() && text !== idea.text && save({ text })} />
        <label>Notes<textarea rows={5} value={notes} placeholder="Details, links, anything" onChange={e => setNotes(e.target.value)} onBlur={() => notes !== idea.notes && save({ notes })} /></label>
        <div className="form-row">
          <label>List<select value={idea.list} onChange={e => save({ list: e.target.value })}>
            {lists.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
          </select></label>
          <label>Area<select value={idea.area ?? ''} onChange={e => save({ area: e.target.value || null })}>
            <option value="">None</option>
            {AREAS.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select></label>
          <label>Priority<select value={idea.priority} onChange={e => save({ priority: Number(e.target.value) })}>
            {PRIORITY.map((p, n) => <option key={n} value={n}>{p}</option>)}
          </select></label>
          <label>Repeat<select value={kind || ''} onChange={e => setRepeat(e.target.value)}>
            <option value="">Never</option><option value="daily">Every day</option><option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option><option value="every">Every N days</option>
          </select></label>
          {kind === 'weekly' && <label>On<select value={arg} onChange={e => setRepeat('weekly', e.target.value)}>{DAYS.map((d, n) => <option key={n} value={n}>{d}</option>)}</select></label>}
          {kind === 'monthly' && <label>Day<input type="number" min={1} max={31} defaultValue={arg} onBlur={e => setRepeat('monthly', e.target.value)} /></label>}
          {kind === 'every' && <label>Days<input type="number" min={1} max={999} defaultValue={arg} onBlur={e => setRepeat('every', e.target.value)} /></label>}
        </div>
        {idea.why && idea.priority > 0 && <p className="hint">Claude: {idea.why}</p>}
        {idea.repeat && idea.done && idea.next_due && <p className="hint">Comes back {new Date(idea.next_due * 1000).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}.</p>}
        {idea.suggestion && !idea.done && (
          <div className="ai-note"><SparkIcon /> Looks like it belongs in <b>{idea.suggestion}</b>
            <button className="btn small primary" onClick={() => save({ list: idea.suggestion })}>Move</button>
            <button className="btn small" onClick={() => save({ clearSuggestion: true })}>Keep here</button>
          </div>
        )}
        <div className="idea-actions">
          {idea.agent ? (
            <a className="btn" href={idea.agent_status === 'gone' ? undefined : `#/agent/${encodeURIComponent(idea.agent)}`}>
              <span className={`st-inline st-${idea.agent_status}`} />{idea.agent} · {idea.agent_status === 'gone' ? 'finished' : STATUS_LABEL[idea.agent_status as keyof typeof STATUS_LABEL] ?? idea.agent_status}
            </a>
          ) : null}
          {idea.agent && (idea.agent_status === 'done' || idea.agent_status === 'gone') && !idea.done && (
            <button className="btn primary" onClick={() => save({ done: true })}>Agent's done — mark done?</button>
          )}
          <button className="btn primary" onClick={() => onStart(idea)}>Start an agent on this</button>
          <button className="btn" onClick={() => onInterview(idea)}>Interview me about it</button>
        </div>
      </div>
    </main>
  )
}

const defaultArg = (k: string) => (k === 'weekly' ? String(new Date().getDay()) : k === 'monthly' ? String(new Date().getDate()) : '7')

// ---------- sort mode ----------

/** One Brain Dump item at a time. Enter takes Claude's suggestion, 1-9 picks a list, D deletes, A starts an agent, S skips. */
export function SortMode({ items, lists, onDone, onError, onStart, loading }: {
  items: Idea[]; lists: List[]; onDone: () => void; onError: (e: Error) => void; onStart: (i: Idea) => void; loading: boolean
}) {
  const [skipped, setSkipped] = useState<number[]>([])
  const [handled, setHandled] = useState<number[]>([])
  const queue = items.filter(i => !i.done && !skipped.includes(i.id) && !handled.includes(i.id))
  const cur = queue[0]
  const targets = lists.filter(l => l.name !== 'Brain Dump')
  const touch = useRef<{ x: number; y: number } | null>(null)
  const [swipe, setSwipe] = useState(0)

  const move = (list: string) => { if (!cur) return; setHandled(h => [...h, cur.id]); api.patch(`/api/ideas/${cur.id}`, { list }).catch(onError) }
  const accept = () => cur?.suggestion && cur.suggestion !== 'Brain Dump' ? move(cur.suggestion) : skip()
  const skip = () => cur && setSkipped(s => [...s, cur.id])
  const del = () => { if (!cur) return; setHandled(h => [...h, cur.id]); api.del(`/api/ideas/${cur.id}`).catch(onError) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!cur || e.metaKey || e.ctrlKey) return
      const n = Number(e.key)
      if (e.key === 'Enter') accept()
      else if (n >= 1 && n <= targets.length) move(targets[n - 1].name)
      else if (e.key.toLowerCase() === 's' || e.key === 'ArrowRight') skip()
      else if (e.key.toLowerCase() === 'd' || e.key === 'Backspace') del()
      else if (e.key.toLowerCase() === 'a') { onStart(cur); skip() }
      else return
      e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  return (
    <Dialog title={cur ? `Sorting Brain Dump · ${queue.length} left` : 'Brain Dump sorted'} onClose={onDone} wide>
      {!cur ? (
        <div className="sort-done">
          <InboxIcon /><p>{skipped.length ? `Done. ${skipped.length} skipped item${skipped.length > 1 ? 's stay' : ' stays'} in Brain Dump.` : 'Inbox zero.'}</p>
          <button className="btn primary" onClick={onDone}>Close</button>
        </div>
      ) : (
        <>
          <div className="sort-card" style={{ transform: `translateX(${swipe}px) rotate(${swipe / 30}deg)` }}
            onTouchStart={e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }}
            onTouchMove={e => { if (touch.current) setSwipe(e.touches[0].clientX - touch.current.x) }}
            onTouchEnd={() => { if (swipe > 90) accept(); else if (swipe < -90) skip(); setSwipe(0); touch.current = null }}>
            <p className="sort-text">{cur.text}</p>
            {cur.suggestion && cur.suggestion !== 'Brain Dump' ? (
              <p className="sort-sugg"><SparkIcon /> Claude thinks: <b>{cur.suggestion}</b>{cur.suggestion_conf !== null && cur.suggestion_conf < 0.6 ? ' (not sure)' : ''}</p>
            ) : <p className="sort-sugg dim">{loading ? 'Claude is reading your Brain Dump…' : 'No suggestion. Pick a list.'}</p>}
          </div>
          <div className="sort-lists">
            {targets.map((l, n) => (
              <button key={l.id} className={`q ${cur.suggestion === l.name ? 'primary' : ''}`} onClick={() => move(l.name)}>
                {n < 9 && <kbd>{n + 1}</kbd>}<span className="sq round" style={{ background: l.color }} />{l.name}
              </button>
            ))}
          </div>
          <div className="form-actions sort-actions">
            <button className="btn" onClick={del}><kbd>D</kbd>Delete</button>
            <button className="btn" onClick={() => { onStart(cur); skip() }}><kbd>A</kbd>Start agent</button>
            <button className="btn" onClick={skip}><kbd>S</kbd>Skip</button>
            <button className="btn primary" onClick={accept} disabled={!cur.suggestion || cur.suggestion === 'Brain Dump'}><kbd>⏎</kbd>Accept</button>
          </div>
          {isPhone() && <p className="hint center">Swipe right to accept, left to skip.</p>}
        </>
      )}
    </Dialog>
  )
}

/** ⌘I from anywhere (and the + on the phone): drop a thought into Brain Dump. */
export function QuickCapture({ lists, onClose, onError }: { lists: List[]; onClose: () => void; onError: (e: Error) => void }) {
  const [text, setText] = useState('')
  const [list, setList] = useState('Brain Dump')
  return (
    <Dialog title="New idea" onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); if (text.trim()) api.post('/api/ideas', { text: text.trim(), list }).then(onClose).catch(onError) }}>
        <textarea autoFocus rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Anything. Sort it later."
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || !e.shiftKey) && !isPhone()) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} />
        <div className="form-row">
          <label>List<select value={list} onChange={e => setList(e.target.value)}>{lists.map(l => <option key={l.id}>{l.name}</option>)}</select></label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!text.trim()}>Add</button>
        </div>
      </form>
    </Dialog>
  )
}

export function ImportNotes({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle')
  const [output, setOutput] = useState('')
  const run = () => {
    setState('busy')
    api.post<{ output: string }>('/api/ideas/import').then(r => { setOutput(r.output); setState('ok'); onDone() })
      .catch(e => { setOutput(e.message); setState('error') })
  }
  return (
    <Dialog title="Import from Apple Notes" onClose={onClose}>
      <p className="dialog-text">Copies your numbered checklist notes (000 Brain Dump, 001 PRIORITY, …) into Ideas, one list per note. Checked items go to each list's Done. Running it again only adds new items. Apple Notes isn't changed.</p>
      {output && <pre className={`import-out ${state}`}>{output}</pre>}
      {state === 'error' && <p className="hint">macOS lets only apps with Full Disk Access read Notes. Either give it to the dashboard (System Settings → Privacy &amp; Security → Full Disk Access → + → press ⌘⇧G, type /opt/homebrew/bin/node), or run <code>fleet import-notes</code> in a terminal app that has it.</p>}
      <div className="form-actions">
        <button className="btn" onClick={onClose}>{state === 'ok' ? 'Close' : 'Cancel'}</button>
        {state !== 'ok' && <button className="btn primary" onClick={run} disabled={state === 'busy'}>{state === 'busy' ? 'Importing…' : state === 'error' ? 'Try again' : 'Import'}</button>}
      </div>
    </Dialog>
  )
}


/** Every open note in every ideas list (checklist steps stay in their checklists), sorted and filtered like a list. */
export function AllNotesPane({ items, lists, selected, onChange, onError, onMenu }: {
  items: Idea[]; lists: List[]; selected: number | null; onChange: () => void; onError: (e: Error) => void; onMenu: (i: Idea, x: number, y: number) => void
}) {
  const [sort, setSort] = useSort()
  const [area, setArea] = useState('')
  const checklists = new Set(lists.filter(l => l.kind === 'checklist').map(l => l.name))
  const open = items.filter(i => !i.done && !checklists.has(i.list) && !isHeading(i.text) && (!area || i.area === area))
    .sort(sort === 'manual' ? (a, b) => a.list.localeCompare(b.list) || SORTS.manual.by(a, b) : SORTS[sort].by)
  const toggle = (i: Idea) => api.patch(`/api/ideas/${i.id}`, { done: !i.done }).then(onChange).catch(onError)
  return (
    <section className="list ideas">
      <div className="lh"><h4><LinesIcon />All notes</h4><span className="progress">{open.length}</span></div>
      <IdeaTools sort={sort} setSort={setSort} area={area} setArea={setArea} />
      <div className="scroll">
        {open.map(i => <IdeaRow key={i.id} i={i} on={i.id === selected} showList onToggle={() => toggle(i)} onMenu={(x, y) => onMenu(i, x, y)} />)}
        {!open.length && <div className="empty">{area ? `No open notes in ${area}.` : 'No open notes.'}</div>}
      </div>
    </section>
  )
}

/** Every open idea that has a priority, across all lists, most important first. */
export function PriorityPane({ items, selected, onChange, onError, onMenu }: {
  items: Idea[]; selected: number | null; onChange: () => void; onError: (e: Error) => void; onMenu: (i: Idea, x: number, y: number) => void
}) {
  const [ranking, setRanking] = useState(false)
  const [summary, setSummary] = useState('')
  const rank = () => {
    setRanking(true)
    api.post<{ summary: string; counts: number[] }>('/api/ideas/rank').then(r => { setSummary(r.summary); onChange() }).catch(onError).finally(() => setRanking(false))
  }
  const toggle = (i: Idea) => api.patch(`/api/ideas/${i.id}`, { done: !i.done }).then(onChange).catch(onError)
  return (
    <section className="list ideas">
      <div className="lh">
        <h4><span className="prio p3">!</span>Prioritized</h4>
        <button className="btn small primary" onClick={rank} disabled={ranking}><SparkIcon />{ranking ? 'Ranking…' : 'Rank with Claude'}</button>
      </div>
      <div className="scroll">
        {summary && <div className="ai-note rank-note"><SparkIcon /> {summary}</div>}
        {[3, 2, 1].map(p => {
          const group = items.filter(i => i.priority === p)
          if (!group.length) return null
          return (
            <div key={p}>
              <div className="grp">{PRIORITY[p]}</div>
              {group.map(i => <IdeaRow key={i.id} i={i} on={i.id === selected} showList onToggle={() => toggle(i)} onMenu={(x, y) => onMenu(i, x, y)} />)}
            </div>
          )
        })}
        {!items.length && <div className="empty">Nothing has a priority yet. Tap <b>Rank with Claude</b> to rank all your open ideas, ask Jarvis “what should I do next?”, or set one on any idea.</div>}
      </div>
    </section>
  )
}

/** Steps from an agent's reply become a checklist. Untick any you don't want; a new list name makes that list. */
export function AddTodos({ plan, agent, onClose }: { plan: { title: string; steps: Step[] }; agent?: string; onClose: () => void }) {
  const [keep, setKeep] = useState(() => plan.steps.map(() => true))
  const [list, setList] = useState(plan.title.slice(0, 60) || 'For you')
  const [names, setNames] = useState<string[]>([])
  const [asChecklist, setAsChecklist] = useState(true)
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState('')
  useEffect(() => { api.get<List[]>('/api/lists').then(ls => setNames(ls.map(l => l.name))).catch(() => {}) }, [])
  const picked = plan.steps.filter((_, n) => keep[n])
  const add = () => {
    setState('busy')
    api.post('/api/ideas/many', { list: list.trim(), agent, items: picked, checklist: asChecklist }).then(() => setState('done')).catch(e => { setError(e.message); setState('idle') })
  }
  return (
    <Dialog title={state === 'done' ? 'Added' : 'Add to-dos'} onClose={onClose}>
      {state === 'done' ? (
        <>
          <p className="dialog-text">{picked.length} to-do{picked.length > 1 ? 's' : ''} in {list.trim() || 'For you'}{agent ? `, each linked back to ${agent}` : ''}.</p>
          <div className="form-actions">
            <button className="btn" onClick={onClose}>Close</button>
            <a className="btn primary" href={`#/ideas/${encodeURIComponent(list.trim() || 'For you')}`} onClick={onClose}>Open {asChecklist ? 'checklist' : 'list'}</a>
          </div>
        </>
      ) : (
        <form className="form" onSubmit={e => { e.preventDefault(); add() }}>
          <div className="todo-pick">
            {plan.steps.map((s, n) => (
              <label key={n}><input type="checkbox" checked={keep[n]} onChange={() => setKeep(k => k.map((v, j) => j === n ? !v : v))} />
                <span>{s.text}{s.notes && <small> · with notes</small>}</span></label>
            ))}
          </div>
          <label className="check-row"><input type="checkbox" checked={asChecklist} onChange={e => setAsChecklist(e.target.checked)} />As a checklist (keeps the steps in order)</label>
          <label>{asChecklist ? 'Checklist' : 'List'}<input list="todo-lists" value={list} onChange={e => setList(e.target.value)} maxLength={60} placeholder="For you" /></label>
          <datalist id="todo-lists">{names.map(n => <option key={n} value={n} />)}</datalist>
          {error && <p className="hint">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!picked.length || state === 'busy'}>Add {picked.length}</button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
