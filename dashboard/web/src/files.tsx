// Files an agent mentions: tap one in the chat to read it here, or search the agent's folder from the Files tab.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Markdown } from './agents.tsx'
import { api } from './api.ts'
import { Dialog } from './components.tsx'

/** Opens a file from where the conversation runs; null where there's no folder to look in. */
export const FileOpener = createContext<((path: string) => void) | null>(null)

// a/b/c.md, ./x.ts, ~/notes/y.txt, /abs/z.py, optionally :12 or :12-30
export const PATH = /(?:~\/|\.{1,2}\/|\/)?(?:[\w@+-][\w@.+-]*\/)+[\w@+-][\w@.+-]*\.[A-Za-z]\w{0,7}(?::\d+(?:-\d+)?)?/
// a bare doc name in plain text: AGENTS.md, report.md, the-plan.mdx
export const BARE = /\b[\w-][\w.-]*\.(?:md|markdown|mdx)\b(?::\d+(?:-\d+)?)?/
const CODE_PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[^\s`/]+\/)*[^\s`/]+\.[A-Za-z]\w{0,7}(?::\d+(?:-\d+)?)?$|^(?:~\/|\/)?(?:[^`/]+\/)+[^`/]+\.[A-Za-z]\w{0,7}(?::\d+(?:-\d+)?)?$/

/** `inline code` that is a file name: tappable when the chat knows its folder, plain code otherwise. */
export function CodeOrFile({ text }: { text: string }) {
  const open = useContext(FileOpener)
  if (!open || !CODE_PATH.test(text) || /^\d/.test(text)) return <code>{text}</code>
  return <button type="button" className="file-ref code" onClick={() => open(text)} title="Open this file">{text}</button>
}

/** A path in plain text (or a markdown link to one): tappable when the chat knows its folder. */
export function PathRef({ text, label }: { text: string; label?: ReactNode }) {
  const open = useContext(FileOpener)
  if (!open) return <>{label ?? text}</>
  return <button type="button" className="file-ref" onClick={() => open(text)} title={`Open ${text}`}>{label ?? text}</button>
}

/** Taps on file names anywhere inside open them in one viewer, from `cwd`. */
export function FilesHere({ cwd, children }: { cwd: string; children: ReactNode }) {
  const [file, setFile] = useState('')
  return (
    <FileOpener.Provider value={setFile}>
      {children}
      {file && <FileViewer key={file} cwd={cwd} path={file} onClose={() => setFile('')} />}
    </FileOpener.Provider>
  )
}

export function FileViewer({ cwd, path: asked, onClose }: { cwd: string; path: string; onClose: () => void }) {
  const [path, setPath] = useState(asked)
  const [file, setFile] = useState<{ path: string; rel: string; text: string } | null>(null)
  const [error, setError] = useState('')
  const [choices, setChoices] = useState<string[]>([]) // not where it said: files with that name, to pick from
  const [raw, setRaw] = useState(false)
  const at = useRef<HTMLDivElement>(null)
  const [from, to] = (path.match(/:(\d+)(?:-(\d+))?$/)?.slice(1) ?? []).map(Number)
  useEffect(() => {
    setFile(null); setError(''); setChoices([])
    api.get<typeof file>(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`).then(setFile).catch(async e => {
      const name = path.replace(/:\d+(-\d+)?$/, '').split('/').pop()!
      const found = /no such file/.test(e.message) ? await api.get<string[]>(`/api/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(name)}`).catch(() => []) : []
      const exact = found.filter(f => f.split('/').pop() === name)
      if (exact.length === 1) return setPath(exact[0] + (path.match(/:\d+(-\d+)?$/)?.[0] ?? ''))
      setChoices(exact.length ? exact : found)
      setError(e.message)
    })
  }, [cwd, path])
  useEffect(() => { at.current?.scrollIntoView({ block: 'center' }) }, [file, raw])
  const md = !!file && /\.(md|markdown|mdx)$/i.test(file.path) && !from
  return (
    <Dialog title={file?.rel || path} onClose={onClose} wide>
      {error ? (
        <>
          <p className="dialog-text">{choices.length ? `Which ${path.split('/').pop()}?` : error}</p>
          {choices.map(c => <button key={c} className="file-hit" onClick={() => setPath(c)}><b>{c.split('/').pop()}</b><span>{c.split('/').slice(0, -1).join('/')}</span></button>)}
        </>
      ) : !file ? <p className="dialog-text">Opening…</p> : (
        <>
          <div className="file-acts">
            <button className="btn small" onClick={() => navigator.clipboard.writeText(file.path).catch(() => {})}>Copy path</button>
            <button className="btn small" onClick={() => navigator.clipboard.writeText(file.text).catch(() => {})}>Copy text</button>
            {md && <button className="btn small" onClick={() => setRaw(!raw)}>{raw ? 'Formatted' : 'Plain text'}</button>}
            <button className="btn small primary" onClick={onClose}>Close</button>
          </div>
          {md && !raw ? <div className="file-md bubble assistant"><Markdown text={file.text} /></div> : (
            <pre className="file-pre">{file.text.split('\n').map((l, i) => {
              const n = i + 1, hit = !!from && n >= from && n <= (to || from)
              return <div key={i} ref={n === from ? at : undefined} className={hit ? 'hit' : ''}><span className="ln">{n}</span>{l || ' '}</div>
            })}</pre>
          )}
        </>
      )}
    </Dialog>
  )
}

/** Search the agent's folder by file name; tap a result to read it. */
export function FilesView({ cwd, onOpen }: { cwd: string; onOpen: (path: string) => void }) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!q.trim()) { setHits(null); return }
    const t = setTimeout(() => api.get<string[]>(`/api/files/search?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`)
      .then(h => { setHits(h); setError('') }).catch(e => setError(e.message)), 250)
    return () => clearTimeout(t)
  }, [q, cwd])
  return (
    <div className="files-view">
      <div className="search"><input value={q} onChange={e => setQ(e.target.value)} placeholder={`Find a file in ${cwd.split('/').pop() || '~'}… (e.g. spec, plan, README)`} autoFocus enterKeyHint="search" /></div>
      <div className="scroll">
        {error && <div className="empty">{error}</div>}
        {hits?.map(h => <button key={h} className="file-hit" onClick={() => onOpen(h)}><b>{h.split('/').pop()}</b><span>{h.split('/').slice(0, -1).join('/')}</span></button>)}
        {hits && !hits.length && <div className="empty">No file names match “{q}”.</div>}
        {!hits && !error && <div className="empty">Searches file names in this agent's folder (skips node_modules, build output and secrets). Files the agent mentions in Chat open with a tap.</div>}
      </div>
    </div>
  )
}
