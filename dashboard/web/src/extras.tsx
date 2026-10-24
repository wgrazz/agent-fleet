import { useEffect, useMemo, useRef, useState } from 'react'
import { api, remember, type Conversation, type Idea, type List, type LiveAgent } from './api.ts'
import { ChatView, ConversationRow } from './agents.tsx'
import { activity, ago, Avatar, MicIcon, SearchIcon, toolLabel } from './components.tsx'

// ---------- history ----------

export function HistoryPane({ items, q, setQ, selected, onMenu }: {
  items: Conversation[] | null; q: string; setQ: (q: string) => void; selected: string; onMenu: (c: Conversation, x: number, y: number) => void
}) {
  return (
    <section className="list">
      <div className="lh"><h4>History</h4></div>
      <div className="search"><SearchIcon /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search past conversations" type="search" /></div>
      <div className="scroll">
        {items === null && <div className="empty">Reading conversations…</div>}
        {items?.map(c => <ConversationRow key={c.id} c={c} on={c.id === selected} onMenu={(x, y) => onMenu(c, x, y)} />)}
        {items?.length === 0 && <div className="empty">Nothing matches.</div>}
      </div>
    </section>
  )
}

export function ConversationView({ c, onBack, onResume, onMenu }: { c: Conversation; onBack: () => void; onResume: () => void; onMenu: (x: number, y: number) => void }) {
  return (
    <main className="det">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <Avatar tool={c.tool} size="lg" />
        <div className="dh-text">
          <div className="t">{c.title || c.prompt || 'Untitled'}</div>
          <div className="meta"><span className="ellip">{toolLabel(c.tool)} · {c.cwd.split('/').pop() || '~'} · {ago(c.updated)} ago</span></div>
        </div>
        <div className="acts">
          {c.running ? <a className="btn primary" href={`#/agent/${encodeURIComponent(c.running)}`}>Open {c.running}</a>
            : <button className="btn primary" onClick={onResume}>Resume</button>}
          <button className="btn" aria-label="More" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.right - 220, r.bottom + 4) }}>⋯</button>
        </div>
      </header>
      <ChatView tool={c.tool} id={c.id} />
    </main>
  )
}

// ---------- ⌘K ----------

type Hit = { kind: string; label: string; sub: string; go: () => void; tool?: string }

export function Palette({ agents, lists, actions, onClose }: {
  agents: LiveAgent[]; lists: List[]; actions: { label: string; run: () => void }[]; onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [history, setHistory] = useState<Conversation[]>([])
  const [i, setI] = useState(0)
  useEffect(() => { api.get<Idea[]>('/api/ideas').then(setIdeas).catch(() => {}) }, [])
  useEffect(() => {
    const t = setTimeout(() => api.get<Conversation[]>(`/api/history?q=${encodeURIComponent(q)}`).then(h => setHistory(h.slice(0, 8))).catch(() => {}), 150)
    return () => clearTimeout(t)
  }, [q])
  const go = (hash: string) => () => { location.hash = hash; onClose() }
  const hits = useMemo(() => {
    const m = (s: string) => s.toLowerCase().includes(q.toLowerCase().trim())
    const out: Hit[] = [
      ...actions.filter(a => m(a.label)).map(a => ({ kind: 'Action', label: a.label, sub: '', go: () => { onClose(); a.run() } })),
      ...agents.filter(a => m(`${a.name} ${a.task} ${a.tool}`)).map(a => ({ kind: 'Agent', label: a.name, sub: activity(a), tool: a.tool, go: go(`#/agent/${encodeURIComponent(a.name)}`) })),
      ...lists.filter(l => m(l.name)).map(l => ({ kind: 'List', label: l.name, sub: `${l.open} open`, go: go(`#/ideas/${encodeURIComponent(l.name)}`) })),
      ...(q.trim() ? ideas.filter(x => m(x.text)).slice(0, 8).map(x => ({ kind: x.done ? 'Done' : 'Idea', label: x.text, sub: x.list, go: go(`#/idea/${x.id}`) })) : []),
      ...history.map(c => ({ kind: 'History', label: c.title || c.prompt, sub: `${c.cwd.split('/').pop()} · ${ago(c.updated)}`, tool: c.tool, go: go(c.running ? `#/agent/${encodeURIComponent(c.running)}` : `#/history/${c.tool}/${c.id}`) })),
    ]
    return out.slice(0, 40)
  }, [q, agents, lists, ideas, history, actions]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setI(0), [q])
  return (
    <div className="overlay palette-overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <div className="palette-in"><SearchIcon />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Agents, ideas, past conversations, actions…"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { setI(Math.min(i + 1, hits.length - 1)); e.preventDefault() }
              if (e.key === 'ArrowUp') { setI(Math.max(i - 1, 0)); e.preventDefault() }
              if (e.key === 'Enter') hits[i]?.go()
              if (e.key === 'Escape') onClose()
            }} />
        </div>
        <div className="palette-hits">
          {hits.map((h, n) => (
            <button key={n} className={`hit ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={h.go}>
              {h.tool ? <Avatar tool={h.tool} size="sm" /> : <span className="hit-kind">{h.kind[0]}</span>}
              <span className="hit-text"><span className="hit-label">{h.label}</span>{h.sub && <span className="hit-sub">{h.sub}</span>}</span>
              <span className="hit-tag">{h.kind}</span>
            </button>
          ))}
          {!hits.length && <div className="empty">Nothing found.</div>}
        </div>
      </div>
    </div>
  )
}

// ---------- Jarvis ----------

type Said = { who: 'you' | 'jarvis'; text: string; done?: string[] }

const Recognition: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

export function speak(text: string) {
  if (!('speechSynthesis' in window) || !text) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.05
  speechSynthesis.speak(u)
}

export const spokenAlerts = { get: () => remember.get('jarvis.alerts') === '1', set: (on: boolean) => remember.set('jarvis.alerts', on ? '1' : '') }

export function Jarvis({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [log, setLog] = useState<Said[]>([])
  const [listening, setListening] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [draft, setDraft] = useState('')
  const [alerts, setAlerts] = useState(spokenAlerts.get())
  const rec = useRef<any>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight) }, [log, thinking])
  useEffect(() => () => rec.current?.abort?.(), [])

  const ask = async (text: string) => {
    if (!text.trim()) return
    setLog(l => [...l, { who: 'you', text }])
    setThinking(true)
    try {
      const r = await api.post<{ say: string; done: string[] }>('/api/jarvis', { text })
      setLog(l => [...l, { who: 'jarvis', text: r.say, done: r.done }])
      speak(r.say)
      if (r.done.length) onChanged()
    } catch (e) {
      setLog(l => [...l, { who: 'jarvis', text: `Sorry, that didn't work: ${(e as Error).message}` }])
    }
    setThinking(false)
  }

  const listen = () => {
    if (!Recognition) return
    speechSynthesis?.cancel()
    const r = new Recognition()
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = false
    let final = ''
    r.onresult = (e: any) => {
      let text = ''
      for (const res of e.results) text += res[0].transcript
      setDraft(text)
      if (e.results[e.results.length - 1].isFinal) final = text
    }
    r.onend = () => { setListening(false); if (final) { setDraft(''); ask(final) } }
    r.onerror = () => setListening(false)
    rec.current = r
    setListening(true)
    r.start()
  }

  return (
    <div className="jarvis" role="dialog" aria-label="Jarvis">
      <div className="jarvis-h">
        <b>Jarvis</b>
        <label className="check small"><input type="checkbox" checked={alerts} onChange={e => { setAlerts(e.target.checked); spokenAlerts.set(e.target.checked) }} />Speak alerts</label>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="jarvis-log" ref={box}>
        {!log.length && <div className="hint">Try “what needs me?”, “tell target-px yes”, “pause the UI agents”, “start a Claude agent to fix Walmart pagination”, or “idea: add Costco to store types”.</div>}
        {log.map((m, i) => (
          <div key={i} className={`said ${m.who}`}>{m.text}{m.done?.length ? <div className="said-done">{m.done.join(' · ')}</div> : null}</div>
        ))}
        {thinking && <div className="said jarvis dim">…</div>}
      </div>
      <form className="jarvis-in" onSubmit={e => { e.preventDefault(); const t = draft; setDraft(''); ask(t) }}>
        {Recognition && <button type="button" className={`mic ${listening ? 'on' : ''}`} onClick={() => (listening ? rec.current?.stop() : listen())} aria-label={listening ? 'Stop listening' : 'Talk'}><MicIcon /></button>}
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={listening ? 'Listening…' : Recognition ? 'Talk or type' : 'Type to Jarvis'} />
      </form>
    </div>
  )
}
