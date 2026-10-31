// The Docs tab: notes in the folders picked in Settings. Plans waiting to be done (each can start an agent), what changed
// lately, a folder list, search, and a map of which notes link to which. A note opens with the notes linking to it, and
// can be edited by hand; saving refuses if an agent changed the file meanwhile.
import { useEffect, useMemo, useState } from 'react'
import { Markdown } from './agents.tsx'
import { api, usePoll } from './api.ts'
import { ago, COLORS } from './components.tsx'
import { FileOpener, FileViewer } from './files.tsx'

export type Doc = { root: string; rel: string; path: string; title: string; mtime: number; plan: boolean }
type Note = Doc & { text: string; linkedFrom: Doc[] }
export const DOC_VIEWS = ['plans', 'recent', 'folders', 'search', 'map'] as const
export type DocView = (typeof DOC_VIEWS)[number]
const LABEL: Record<DocView, string> = { plans: 'Plans', recent: 'Recent', folders: 'Folders', search: 'Search', map: 'Map' }
export const docHash = (view: string, path = '') => `#/docs/${view}${path ? `/${encodeURIComponent(path)}` : ''}`
const where = (d: Doc) => d.rel.split('/').slice(0, -1).join('/') || d.root.split('/').pop()

function Row({ d, on, extra }: { d: Doc; on: boolean; extra?: string }) {
  return (
    <a className={`file-hit doc-row ${on ? 'on' : ''}`} href={docHash(location.hash.split('/')[2] || 'plans', d.path)}>
      <b>{d.title}</b>
      <span>{where(d)} · {ago(d.mtime)} ago</span>
      {extra && <span className="doc-snip">{extra}</span>}
    </a>
  )
}

/** The middle pane: the views along the top, and the list for the one picked. */
export function DocsPane({ view, selected, onError }: { view: DocView; selected: string; onError: (e: Error) => void }) {
  const docs = usePoll<Doc[]>('/api/docs', 15000, onError)
  const all = docs.data ?? []
  return (
    <section className="list ideas docs">
      <div className="lh"><h4>Docs</h4></div>
      <div className="tabs-row" role="tablist">
        {DOC_VIEWS.map(v => <button key={v} role="tab" aria-selected={v === view} onClick={() => (location.hash = docHash(v))}>{LABEL[v]}</button>)}
      </div>
      <div className="scroll">
        {docs.data && !all.length ? <div className="empty">No notes yet. Add a folder of notes under <a href="#/settings">Settings → Docs folders</a>.</div>
          : !docs.data ? <div className="empty">{docs.error || 'Loading…'}</div>
          : view === 'plans' ? <>{all.filter(d => d.plan).map(d => <Row key={d.path} d={d} on={d.path === selected} />)}
              {!all.some(d => d.plan) && <div className="empty">No plans waiting. Plans are notes in a <code>plans/pending/</code> folder.</div>}</>
          : view === 'recent' ? all.slice(0, 100).map(d => <Row key={d.path} d={d} on={d.path === selected} />)
          : view === 'folders' ? <Folders docs={all} selected={selected} />
          : view === 'search' ? <Search selected={selected} onError={onError} />
          : <div className="empty">The map is on the right. Tap a dot to open that note.</div>}
      </div>
    </section>
  )
}

/** Tap through folders that hold notes. */
function Folders({ docs, selected }: { docs: Doc[]; selected: string }) {
  const roots = [...new Set(docs.map(d => d.root))]
  const [at, setAt] = useState(() => selected ? selected.split('/').slice(0, -1).join('/') : '')
  const dir = at && docs.some(d => d.path.startsWith(at + '/')) ? at : roots.length === 1 ? roots[0] : ''
  if (!dir) return <>{roots.map(r => <button key={r} className="file-hit" onClick={() => setAt(r)}><b>📁 {r.split('/').pop()}</b><span>{r}</span></button>)}</>
  const inside = docs.filter(d => d.path.startsWith(dir + '/')).map(d => ({ d, rest: d.path.slice(dir.length + 1) }))
  const subs = [...new Set(inside.filter(x => x.rest.includes('/')).map(x => x.rest.split('/')[0]))].sort()
  const up = roots.includes(dir) ? (roots.length > 1 ? '' : null) : dir.split('/').slice(0, -1).join('/')
  return (
    <>
      <div className="grp">{up !== null && <button className="btn small" onClick={() => setAt(up)}>‹ Up</button>} {dir.split('/').pop()}</div>
      {subs.map(s => <button key={s} className="file-hit" onClick={() => setAt(`${dir}/${s}`)}><b>📁 {s}</b><span>{((c: number) => `${c} note${c === 1 ? '' : 's'}`)(inside.filter(x => x.rest.startsWith(s + '/')).length)}</span></button>)}
      {inside.filter(x => !x.rest.includes('/')).sort((a, b) => a.rest.localeCompare(b.rest)).map(({ d }) => <Row key={d.path} d={d} on={d.path === selected} />)}
    </>
  )
}

function Search({ selected, onError }: { selected: string; onError: (e: Error) => void }) {
  const [q, setQ] = useState(() => sessionStorage.getItem('fleet.docsQ') ?? '')
  const [hits, setHits] = useState<(Doc & { snippet: string })[] | null>(null)
  useEffect(() => {
    try { sessionStorage.setItem('fleet.docsQ', q) } catch {}
    if (!q.trim()) { setHits(null); return }
    const t = setTimeout(() => api.get<typeof hits>(`/api/docs/search?q=${encodeURIComponent(q)}`).then(setHits).catch(onError), 250)
    return () => clearTimeout(t)
  }, [q, onError])
  return (
    <>
      <div className="search"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search inside every note…" autoFocus enterKeyHint="search" /></div>
      {hits?.map(h => <Row key={h.path} d={h} on={h.path === selected} extra={h.snippet} />)}
      {hits && !hits.length && <div className="empty">No notes contain “{q}”.</div>}
    </>
  )
}

/** One note: formatted, with Start agent on a plan, Edit, and the notes that link here. */
export function NoteView({ path, view, onBack, onStart, onError }: {
  path: string; view: DocView; onBack: () => void; onStart: (cwd: string, prompt: string) => void; onError: (e: Error) => void
}) {
  const [n, setN] = useState<Note | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const load = () => api.get<Note>(`/api/docs/note?path=${encodeURIComponent(path)}`).then(x => { setN(x); setError('') }).catch(e => setError(e.message))
  useEffect(() => { setN(null); setDraft(null); load() }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    setSaving(true)
    api.put('/api/docs/file', { path: n!.path, text: draft, mtime: n!.mtime }).then(() => { setDraft(null); load() }).catch(onError).finally(() => setSaving(false))
  }
  const dir = path.split('/').slice(0, -1).join('/')
  // a link to another note opens it here; anything else (code, a note outside home's reach) opens in the file viewer
  const [viewer, setViewer] = useState('')
  const open = (p: string) => api.get<{ path: string }>(`/api/files/read?cwd=${encodeURIComponent(dir)}&path=${encodeURIComponent(p)}`)
    .then(f => /\.md$/i.test(f.path) ? (location.hash = docHash(view, f.path)) : setViewer(p)).catch(() => setViewer(p))
  return (
    <main className="det settings note">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">{n?.title ?? path.split('/').pop()}</div>{n && <div className="meta">{n.rel} · changed {ago(n.mtime)} ago</div>}</div>
        {n && draft === null && <>
          {n.plan && <button className="btn small primary" onClick={() => onStart(n.root, `Carry out the plan in \`${n.rel}\`. Read the project's agent instructions first. Delete the plan file when it's finished.`)}>Start agent</button>}
          {n.root && <button className="btn small" onClick={() => setDraft(n.text)}>Edit</button>}
        </>}
        {draft !== null && <>
          <button className="btn small" onClick={() => setDraft(null)}>Cancel</button>
          <button className="btn small primary" disabled={saving || draft === n?.text} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </>}
      </header>
      <div className="set-scroll">
        {error ? <div className="empty">{error}</div> : !n ? <div className="empty">Opening…</div>
          : draft !== null ? <textarea className="note-edit" value={draft} onChange={e => setDraft(e.target.value)} spellCheck autoFocus />
          : <FileOpener.Provider value={open}><div className="file-md bubble assistant note-md"><Markdown text={n.text} /></div></FileOpener.Provider>}
        {n && draft === null && n.root && <>
          <div className="grp">Linked from {n.linkedFrom.length ? `(${n.linkedFrom.length})` : ''}</div>
          {n.linkedFrom.map(d => <Row key={d.path} d={d} on={false} />)}
          {!n.linkedFrom.length && <p className="hint">No other note links here yet.</p>}
        </>}
      </div>
      {viewer && <FileViewer cwd={dir} path={viewer} onClose={() => setViewer('')} />}
    </main>
  )
}

/** Spring layout: linked notes pull together, every note pushes the others away, and a light pull to the middle
 *  keeps separate clusters on screen. */
function layout(n: number, edges: [number, number][]) {
  const k = 40
  const p = Array.from({ length: n }, (_, i) => [Math.cos(i * 2.4) * 8 * Math.sqrt(i + 1), Math.sin(i * 2.4) * 8 * Math.sqrt(i + 1)])
  // ponytail: all pairs every step, fine for a few hundred notes; a quadtree past that
  for (let step = 0, t = 40; step < 300; step++, t *= 0.985) {
    const d = p.map(() => [0, 0])
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const x = p[i][0] - p[j][0], y = p[i][1] - p[j][1], f = (k * k) / Math.max(x * x + y * y, 0.01)
      d[i][0] += x * f; d[i][1] += y * f; d[j][0] -= x * f; d[j][1] -= y * f
    }
    for (const [a, b] of edges) {
      const x = p[a][0] - p[b][0], y = p[a][1] - p[b][1], f = 0.1 * Math.hypot(x, y) / k // weak springs, or busy notes crush their cluster
      d[a][0] -= x * f; d[a][1] -= y * f; d[b][0] += x * f; d[b][1] += y * f
    }
    for (let i = 0; i < n; i++) {
      d[i][0] -= p[i][0] * 0.5; d[i][1] -= p[i][1] * 0.5
      const m = Math.hypot(d[i][0], d[i][1]) || 1, s = Math.min(m, t) / m
      p[i][0] += d[i][0] * s; p[i][1] += d[i][1] * s
    }
  }
  return p
}

/** Every note that links or is linked, as dots joined by lines, colored by top folder. Tap a dot to open it. */
export function DocsMap({ onBack, onError }: { onBack: () => void; onError: (e: Error) => void }) {
  const [g, setG] = useState<{ nodes: Doc[]; edges: [number, number][]; unlinked: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [hover, setHover] = useState(-1)
  useEffect(() => { api.get<typeof g>('/api/docs/graph').then(setG).catch(onError) }, [onError])
  const pos = useMemo(() => (g ? layout(g.nodes.length, g.edges) : []), [g])
  if (!g) return <main className="det settings"><div className="empty">Drawing the map…</div></main>
  if (!g.nodes.length) return <main className="det settings"><div className="empty">No notes link to each other yet. When a note mentions another note's file name or path, they're joined here.</div></main>
  const degree = g.nodes.map((_, i) => g.edges.filter(([a, b]) => a === i || b === i).length)
  const xs = pos.map(p => p[0]), ys = pos.map(p => p[1])
  const pad = 60, x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) + pad - x0, h = Math.max(...ys) + pad - y0
  const tops = [...new Set(g.nodes.map(d => `${d.root}|${d.rel.includes('/') ? d.rel.split('/')[0] : ''}`))]
  const color = (d: Doc) => COLORS[1 + (tops.indexOf(`${d.root}|${d.rel.includes('/') ? d.rel.split('/')[0] : ''}`) % (COLORS.length - 1))]
  const labelled = new Set([...degree.keys()].sort((a, b) => degree[b] - degree[a]).slice(0, 8))
  const near = hover >= 0 ? new Set(g.edges.filter(([a, b]) => a === hover || b === hover).flat()) : null
  const font = Math.max(w, h) / 70
  return (
    <main className="det settings docs-map">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">Map</div><div className="meta">{g.nodes.length} linked notes · {g.unlinked} with no links</div></div>
        <button className="btn small" onClick={() => setZoom(z => Math.max(1, z / 1.5))} aria-label="Zoom out">−</button>
        <button className="btn small" onClick={() => setZoom(z => Math.min(6, z * 1.5))} aria-label="Zoom in">+</button>
      </header>
      <div className="map-scroll">
        <svg viewBox={`${x0} ${y0} ${w} ${h}`} style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }} role="img" aria-label="Map of linked notes">
          {g.edges.map(([a, b], i) => <line key={i} x1={pos[a][0]} y1={pos[a][1]} x2={pos[b][0]} y2={pos[b][1]}
            className={near && (a === hover || b === hover) ? 'edge on' : 'edge'} strokeWidth={font / 8} />)}
          {g.nodes.map((d, i) => (
            <a key={d.path} href={docHash('map', d.path)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}>
              <circle cx={pos[i][0]} cy={pos[i][1]} r={font * (0.35 + Math.sqrt(degree[i]) * 0.18)} fill={color(d)} opacity={near && !near.has(i) ? 0.25 : 1}><title>{d.title} ({d.rel})</title></circle>
              {(labelled.has(i) || hover === i || near?.has(i)) && <text x={pos[i][0]} y={pos[i][1] - font * 0.9} fontSize={font} textAnchor="middle" className="map-label">{d.title}</text>}
            </a>
          ))}
        </svg>
      </div>
    </main>
  )
}
