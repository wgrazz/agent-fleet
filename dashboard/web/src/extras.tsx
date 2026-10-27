import { useEffect, useMemo, useRef, useState } from 'react'
import { joinResults, speechChunks } from './speech.ts'
import { api, remember, type AiBudget, type Conversation, type Idea, type List, type LiveAgent, type Settings } from './api.ts'
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
      <ChatView tool={c.tool} id={c.id} cwd={c.cwd} />
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


const Recognition: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

// British voices that ship with macOS/iOS/Chrome, best first: the closest a browser gets to J.A.R.V.I.S.
const JARVIS_VOICES = ['Daniel (Enhanced)', 'Daniel', 'Arthur', 'Oliver', 'Malcolm', 'Google UK English Male', 'Microsoft Ryan', 'Microsoft George']

export function voices(): SpeechSynthesisVoice[] {
  return 'speechSynthesis' in window ? speechSynthesis.getVoices().filter(v => v.lang.startsWith('en')) : []
}

export function pickVoice(): SpeechSynthesisVoice | undefined {
  const all = voices()
  const saved = remember.get('jarvis.voice')
  return all.find(v => v.name === saved)
    ?? JARVIS_VOICES.map(n => all.find(v => v.name.startsWith(n))).find(Boolean)
    ?? all.find(v => v.lang === 'en-GB')
}

function speakOnDevice(text: string): Promise<void> {
  if (!('speechSynthesis' in window) || !text) return Promise.resolve()
  speechSynthesis.cancel()
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text)
    const v = pickVoice()
    if (v) { u.voice = v; u.lang = v.lang }
    u.rate = 1.02
    u.pitch = 0.92
    u.onend = () => resolve()
    u.onerror = () => resolve()
    speechSynthesis.speak(u)
  })
}

// Natural voices are made on the Mac and played here through Web Audio. Not an <audio> element: on iPhones that
// keeps hold of the audio session after it plays, and the next listen then hears nothing (the second turn of a voice
// conversation went dead). iPhones only let a page make sound after a tap, so the first tap in Jarvis unlocks it.
const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext
let ctx: AudioContext | null = null
let source: AudioBufferSourceNode | null = null
export function unlockAudio() {
  if (!AC) return
  ctx ??= new AC()
  if (ctx.state !== 'running') ctx.resume().catch(() => {})
}

let voiceSettings: Settings | null = null
export const setVoiceSettings = (s: Settings) => { voiceSettings = s }
const loadVoiceSettings = () => voiceSettings ? Promise.resolve(voiceSettings) : api.get<Settings>('/api/settings').then(s => (voiceSettings = s)).catch(() => null)

let speaking = 0 // bumped by stopSpeaking so a reply that's still being made doesn't start playing

export async function speak(text: string, override?: { engine: string; voice: string; speed: number }): Promise<void> {
  if (!text) return
  const me = ++speaking
  const s = override ?? await loadVoiceSettings().then(v => v && { engine: v.voice_engine, voice: v.voice, speed: v.voice_speed })
  if (!s || s.engine === 'device' || !AC) return speakOnDevice(text)
  unlockAudio()
  const ac = ctx!
  const make = (chunk: string) => fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: chunk, engine: s.engine, voice: s.voice, speed: s.speed }) })
    .then(async res => { if (!res.ok) throw new Error(await res.text()); return ac.decodeAudioData(await res.arrayBuffer()) })
  const chunks = speechChunks(text)
  try {
    window.speechSynthesis?.cancel()
    let next = make(chunks[0])
    for (let i = 0; i < chunks.length; i++) {
      const buf = await next
      if (i + 1 < chunks.length) next = make(chunks[i + 1])
      if (me !== speaking) return
      if (ac.state !== 'running') await ac.resume()
      vlog(`play ${i + 1}/${chunks.length} ctx=${ac.state}`)
      source?.stop()
      await new Promise<void>(resolve => {
        const src = ac.createBufferSource()
        src.buffer = buf
        src.connect(ac.destination)
        src.onended = () => resolve() // finished, or stopSpeaking stopped it
        source = src
        src.start()
      })
      if (me !== speaking) return
    }
  } catch (e) {
    vlog(`play failed: ${(e as Error).message}`)
    if (me === speaking) return speakOnDevice(text) // the Mac voice isn't available right now: still answer out loud
  }
}

export const stopSpeaking = () => { speaking++; try { source?.stop() } catch {} ; window.speechSynthesis?.cancel() }

/** Voice-loop events go to the Mac's server log, so a conversation that dies on the phone can be traced afterwards. */
export const vlog = (event: string) => { api.post('/api/jarvis/log', { event }).catch(() => {}) }


export const spokenAlerts = { get: () => remember.get('jarvis.alerts') === '1', set: (on: boolean) => remember.set('jarvis.alerts', on ? '1' : '') }
export const spokenReplies = { get: () => remember.get('jarvis.quiet') !== '1', set: (on: boolean) => remember.set('jarvis.quiet', on ? '' : '1') }

type Proposal = { id: number; summary: string; state: 'pending' | 'approved' | 'declined'; result?: string | null }
type Line = { who: 'you' | 'bot'; text: string; meta?: { done?: string[]; mode?: string; warning?: string; blocked?: string; proposals?: Proposal[]; undo?: number; undone?: boolean } }
type Thread = { id: number; title: string; updated_at: number; count?: number }

const IDLE_MS = 2 * 3600 * 1000
const HOLD_LINES = ['One moment.', 'Let me check.', 'Just a second.', 'Looking into it.']
type VoiceState = 'off' | 'listening' | 'thinking' | 'speaking' | 'tap'

export function Jarvis({ onClose, onChanged, asPage, autoTalk }: { onClose: () => void; onChanged: () => void; asPage?: boolean; autoTalk?: boolean }) {
  const [threadId, setThreadId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [proposals, setProposals] = useState<Record<number, Proposal>>({})
  const [list, setList] = useState<Thread[] | null>(null)
  const [thinking, setThinking] = useState(false)
  const [draft, setDraft] = useState('')
  const [muted, setMuted] = useState(!spokenReplies.get())
  const [budget, setBudget] = useState<AiBudget | null>(null)
  const [voice, setVoiceState] = useState<VoiceState>('off')
  const [caption, setCaption] = useState('')
  const voiceRef = useRef<VoiceState>('off')
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const threadRef = useRef<number | null>(null)
  threadRef.current = threadId
  const rec = useRef<any>(null)
  const box = useRef<HTMLDivElement>(null)
  const quiet = useRef(0)
  const ended = useRef(false) // the last reply closed the conversation
  const setVoice = (v: VoiceState) => { voiceRef.current = v; setVoiceState(v) }
  const voiceNow = (): VoiceState => voiceRef.current // read fresh: it changes while we await

  const loadBudget = () => api.get<{ budget: AiBudget }>('/api/jarvis/status').then(r => setBudget(r.budget)).catch(() => {})
  const openThread = (id: number) => api.get<{ thread: Thread; messages: { who: 'you' | 'bot'; text: string; meta: string }[]; proposals: Proposal[] }>(`/api/jarvis/threads/${id}`)
    .then(r => {
      setThreadId(r.thread.id)
      setTitle(r.thread.title)
      remember.set('jarvis.thread', String(r.thread.id))
      setLines(r.messages.map(m => ({ who: m.who, text: m.text, meta: JSON.parse(m.meta || '{}') })))
      setProposals(Object.fromEntries(r.proposals.map(p => [p.id, p])))
      setList(null)
    }).catch(() => fresh())
  const fresh = () => { setThreadId(null); setTitle(''); setLines([]); setProposals({}); setList(null); remember.set('jarvis.thread', '') }

  useEffect(() => {
    loadBudget()
    // pick up where you left off if the last conversation was recent; otherwise start clean
    const id = Number(remember.get('jarvis.thread'))
    if (id) api.get<{ thread: Thread }>(`/api/jarvis/threads/${id}`).then(r => (Date.now() - r.thread.updated_at * 1000 < IDLE_MS ? openThread(id) : fresh())).catch(fresh)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { box.current?.scrollTo(0, box.current.scrollHeight) }, [lines, thinking, proposals])
  useEffect(() => () => { try { rec.current?.abort() } catch {} ; stopSpeaking() }, [])
  // opened by ⌃⌥Space: start listening straight away (the browser may still want a tap first)
  useEffect(() => {
    if (!autoTalk) return
    history.replaceState(null, '', '#/jarvis')
    const t = setTimeout(() => startVoice(), 400)
    return () => clearTimeout(t)
  }, [autoTalk]) // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async (text: string, override = false): Promise<string> => {
    if (!text.trim()) return ''
    if (!mutedRef.current) unlockAudio()
    if (!override) setLines(l => [...l, { who: 'you', text }])
    setThinking(true)
    try {
      const r = await api.post<{ thread_id: number; say: string; done: string[]; mode: string; blocked?: string; warning?: string; proposals?: Proposal[]; undo?: number; end?: boolean }>(
        '/api/jarvis', { text, override, thread_id: threadRef.current ?? undefined })
      if (r.thread_id !== threadRef.current) { setThreadId(r.thread_id); remember.set('jarvis.thread', String(r.thread_id)); if (!title) setTitle(text.slice(0, 70)) }
      setLines(l => [...l, { who: 'bot', text: r.say, meta: { done: r.done, mode: r.mode, warning: r.warning, blocked: r.blocked, proposals: r.proposals, undo: r.undo } }])
      if (r.proposals?.length) setProposals(p => ({ ...p, ...Object.fromEntries(r.proposals!.map(x => [x.id, x])) }))
      if (r.done.length) onChanged()
      if (r.mode !== 'instant') loadBudget()
      ended.current = !!r.end
      setThinking(false)
      return r.say
    } catch (e) {
      const msg = `Sorry, that didn't work: ${(e as Error).message}`
      setLines(l => [...l, { who: 'bot', text: msg }])
      setThinking(false)
      return msg
    }
  }

  // put back the ideas a turn changed; the line remembers it was undone until the conversation reloads
  const undo = (i: number, turn: number) => api.post('/api/jarvis/undo', { turn })
    .then(() => { setLines(l => l.map((x, j) => (j === i ? { ...x, meta: { ...x.meta, undone: true } } : x))); onChanged() })
    .catch(e => setLines(l => [...l, { who: 'bot', text: `Couldn't undo: ${(e as Error).message}` }]))

  const decide = (p: Proposal, approve: boolean) => {
    setProposals(x => ({ ...x, [p.id]: { ...p, state: approve ? 'approved' : 'declined' } }))
    api.post<{ state: Proposal['state']; result: string }>(`/api/jarvis/proposals/${p.id}/${approve ? 'approve' : 'decline'}`)
      .then(r => { setProposals(x => ({ ...x, [p.id]: { ...p, state: r.state, result: r.result } })); onChanged() })
      .catch(e => setProposals(x => ({ ...x, [p.id]: { ...p, state: 'pending', result: (e as Error).message } })))
  }

  // ---------- voice mode: listen → think → speak → listen again ----------
  // iPhones are the hard case: Safari often ends listening without marking anything "final", may refuse to restart
  // the mic without a fresh tap, and sometimes never fires onend at all. So: keep what was heard even if it never
  // went final, decide "done talking" ourselves after a pause, and when the mic won't come back, wait for a tap
  // ('tap' state) instead of silently giving up.
  const talked = useRef(false) // a turn has worked this session, so a mic refusal now means "needs a tap", not "blocked"
  const listenOnce = () => {
    if (voiceRef.current === 'off') return
    let r: any
    try { r = new Recognition() } catch { return endVoice("Voice input isn't available here. Use the keyboard's mic key to dictate instead.") }
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = true // we end the turn on a pause ourselves; Safari's own end-of-speech cuts people off mid-sentence
    let heard = ''
    let finished = false
    let started = false
    let pause = 0
    const timers: number[] = []
    const finish = (said: string) => {
      if (finished) return
      finished = true
      timers.forEach(clearTimeout)
      clearTimeout(pause)
      try { r.abort() } catch {}
      setCaption('')
      if (voiceRef.current === 'listening') turn(said.trim())
    }
    const stopSoon = (ms: number) => { clearTimeout(pause); pause = window.setTimeout(() => { try { r.stop() } catch {} ; timers.push(window.setTimeout(() => finish(heard), 1200)) }, ms) }
    r.onstart = () => { started = true; vlog('mic open') }
    r.onresult = (e: any) => {
      heard = joinResults(Array.from(e.results, (x: any) => x[0].transcript as string))
      setCaption(heard)
      stopSoon(1400) // 1.4 s without new words = done talking
    }
    r.onerror = (e: any) => {
      const err = e?.error ?? ''
      vlog(`mic error ${err}`)
      if (err === 'no-speech' || err === 'aborted') return // onend follows
      if ((err === 'not-allowed' || err === 'service-not-allowed') && !talked.current)
        return (finished = true, endVoice("I can't use the microphone here. Allow it in Settings, or type instead."))
      finished = true
      needTap() // the mic is busy or iOS wants a tap before listening again
    }
    r.onend = () => { vlog(`mic end, heard ${heard.length} chars`); finish(heard) }
    rec.current = r
    try { r.start() } catch (e) { vlog(`mic start threw ${(e as Error).message}`); return needTap() }
    timers.push(window.setTimeout(() => { if (!started && !finished) { vlog('mic never opened'); finished = true; try { r.abort() } catch {} ; needTap() } }, 2500))
    timers.push(window.setTimeout(() => { if (!heard) stopSoon(0) }, 9000)) // nothing said: count it as a silence
  }
  const turn = async (said: string) => {
    if (!said) {
      // two silences in a row: stop listening, but stay in the conversation until you tap
      if (++quiet.current >= 2) return needTap()
      return listenOnce()
    }
    quiet.current = 0
    talked.current = true
    setVoice('thinking')
    // a lookup can take a while: say so, like a person would, instead of going quiet
    const hold = mutedRef.current ? 0 : window.setTimeout(() => { if (voiceNow() === 'thinking') speak(HOLD_LINES[Math.floor(Math.random() * HOLD_LINES.length)]) }, 2500)
    const reply = await ask(said)
    clearTimeout(hold)
    if (voiceNow() === 'off') return
    if (!mutedRef.current) {
      setVoice('speaking')
      await speak(reply)
    }
    if (ended.current) return endVoice() // you said goodbye (or Jarvis heard you were done)
    const now = voiceNow()
    if (now !== 'speaking' && now !== 'thinking') return // ended, or you tapped to interrupt (that already started listening)
    setVoice('listening')
    setTimeout(listenOnce, 250) // let the speaker go quiet so the mic doesn't hear the end of the reply
  }
  const needTap = () => { vlog('needs a tap'); if (voiceRef.current !== 'off') { setCaption(''); setVoice('tap') } }
  const startVoice = () => {
    if (!Recognition) return setLines(l => [...l, { who: 'bot', text: "Voice conversations aren't available in this browser. Type, or use the keyboard's mic key." }])
    unlockAudio()
    stopSpeaking()
    quiet.current = 0
    setVoice('listening')
    listenOnce()
  }
  const endVoice = (why?: string) => {
    setVoice('off')
    setCaption('')
    try { rec.current?.abort() } catch {}
    stopSpeaking()
    if (why) setLines(l => [...l, { who: 'bot', text: why }])
  }
  const tapOrb = () => {
    if (voice === 'speaking') { stopSpeaking(); setVoice('listening'); listenOnce() } // interrupt and talk
    else if (voice === 'listening') { try { rec.current?.stop() } catch {} } // done talking: send now
    else if (voice === 'tap') { unlockAudio(); quiet.current = 0; setVoice('listening'); listenOnce() } // this tap lets iOS open the mic
  }
  const close = () => { endVoice(); onClose() }
  const toggleMute = () => { const m = !muted; setMuted(m); spokenReplies.set(!m); if (m) stopSpeaking() }

  const pct = budget ? budget.jarvis_pct : 0
  return (
    <>
    {!asPage && <div className="jarvis-backdrop" onClick={close} />}
    <div className={`jarvis ${asPage ? 'page' : ''}`} role={asPage ? undefined : 'dialog'} aria-label="Jarvis">
      <div className="jarvis-h">
        <button className="jarvis-title" onClick={() => (list ? setList(null) : api.get<Thread[]>('/api/jarvis/threads').then(setList))} aria-expanded={!!list}>
          <b>Jarvis</b><span>{title || 'New conversation'} ▾</span>
        </button>
        <button className={`icon-btn ${muted ? 'off' : ''}`} onClick={toggleMute} aria-label={muted ? 'Unmute Jarvis' : 'Mute Jarvis'} title={muted ? 'Muted: replies are text only' : 'Speaking replies'}>
          {muted ? <SpeakerOffIcon /> : <SpeakerIcon />}
        </button>
        <button className="jarvis-done" onClick={close}>{asPage ? 'Close' : 'Done'}</button>
      </div>
      {budget && budget.weekly_pct !== null && (
        <div className={`jarvis-budget ${pct >= budget.max_pct ? 'over' : pct >= budget.warn_pct ? 'warn' : ''}`}
          title={`Jarvis ≈ $${budget.jarvis_usd.toFixed(2)} of $${budget.claude_usd.toFixed(0)} Claude use this week (API prices)`}>
          {pct < 0.1 ? 'under 0.1' : pct.toFixed(1)}% of your weekly limit · stops at {budget.max_pct}%
        </div>
      )}
      {list ? (
        <div className="jarvis-threads">
          <button className="thread new" onClick={fresh}>＋ New conversation</button>
          {list.map(t => (
            <button key={t.id} className={`thread ${t.id === threadId ? 'on' : ''}`} onClick={() => openThread(t.id)}>
              <span className="thread-title">{t.title || 'Untitled'}</span>
              <span className="thread-meta">{ago(t.updated_at * 1000) === 'now' ? 'just now' : `${ago(t.updated_at * 1000)} ago`} · {t.count} messages</span>
            </button>
          ))}
          {!list.length && <div className="hint">No conversations yet.</div>}
          <a className="hint" href="#/settings" onClick={() => !asPage && onClose()}>Voice and budget settings ›</a>
        </div>
      ) : (
        <div className="jarvis-log" ref={box}>
          {!lines.length && <div className="hint">Tap <b>Talk</b> for a back-and-forth voice conversation, or type. Instant: “what needs me?”, “tell walmart yes”, “pause walmart until 18:30”, “idea: …”, “remember …”. Ask anything else, like “where are we on the Target scraper?”; Jarvis can read your project and the web, and asks before it starts or touches an agent.</div>}
          {lines.map((m, i) => (
            <div key={i} className={`said ${m.who}`}>
              {m.text}
              {(m.meta?.done?.length || m.meta?.mode === 'instant') ? <div className="said-done">{[m.meta?.mode === 'instant' && 'instant', ...(m.meta?.done ?? [])].filter(Boolean).join(' · ')}</div> : null}
              {m.meta?.warning && <div className="said-warn">{m.meta.warning}</div>}
              {m.meta?.undo && (m.meta.undone ? <div className="said-done">undone</div>
                : <button className="btn small" onClick={() => undo(i, m.meta!.undo!)}>Undo</button>)}
              {m.meta?.blocked && <button className="btn small" onClick={() => ask(m.meta!.blocked!, true)}>Allow once</button>}
              {m.meta?.proposals?.map(x => {
                const p = proposals[x.id] ?? x
                return (
                  <div key={p.id} className={`proposal ${p.state}`}>
                    <div className="proposal-text">{p.summary}</div>
                    {p.state === 'pending' ? (
                      <div className="proposal-actions">
                        <button className="btn small primary" onClick={() => decide(p, true)}>Approve</button>
                        <button className="btn small" onClick={() => decide(p, false)}>No</button>
                      </div>
                    ) : <div className="said-done">{p.state === 'approved' ? (p.result || 'approved') : 'declined'}</div>}
                  </div>
                )
              })}
            </div>
          ))}
          {thinking && voice === 'off' && <div className="said bot dim"><span className="dots"><i /><i /><i /></span></div>}
        </div>
      )}
      {voice !== 'off' ? (
        <div className="voice-mode">
          <button className={`orb ${voice}`} onClick={tapOrb} aria-label={voice === 'speaking' ? 'Interrupt' : voice === 'listening' ? 'Done talking' : voice === 'tap' ? 'Talk' : 'Thinking'}>
            <span /><span /><span />
          </button>
          <div className="voice-state">{voice === 'listening' ? (caption || 'Listening…') : voice === 'thinking' ? 'Thinking…' : voice === 'tap' ? 'Tap to talk' : 'Speaking · tap to interrupt'}</div>
          <button className="btn" onClick={() => endVoice()}>End</button>
        </div>
      ) : (
        <form className="jarvis-in" onSubmit={e => { e.preventDefault(); const t = draft; setDraft(''); ask(t).then(r => { if (!mutedRef.current && r) speak(r) }) }}>
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Message Jarvis" enterKeyHint="send" autoComplete="off" />
          {draft.trim()
            ? <button type="submit" className="send" aria-label="Send"><SendIconSmall /></button>
            : Recognition && <button type="button" className="talk" onClick={startVoice}><MicIcon />Talk</button>}
        </form>
      )}
    </div>
    </>
  )
}

const SpeakerIcon = () => <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor" /><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.8a6 6 0 0 1 0 8.4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" /></svg>
const SpeakerOffIcon = () => <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" fill="currentColor" /><path d="m10.5 6 3.5 4M14 6l-3.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
const SendIconSmall = () => <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
