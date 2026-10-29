// Team: your scheduled roles, each with a desk built for its job. The chief of staff's desk is cards you accept or
// reject (today's picks, notes to merge or close, work to hand to an agent); the clerk's is the company's deadline
// calendar, paperwork in flight, drafts, questions for a CPA or lawyer and what it knows. Every role reads what you
// do here on its next run.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, usePoll, type ClerkBoard, type Idea, type Proposal, type Role, type RoleItem, type RoleNote, type RoleRun, type Share, type ShareMessage } from './api.ts'
import { Markdown } from './agents.tsx'
import { AREAS } from './areas.ts'
import { FileViewer } from './files.tsx'

const enc = encodeURIComponent
const when = (s: number) => new Date(s * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DESK_NAMES: Record<Role['kind'], string> = { chief: 'Chief of staff desk', clerk: 'Company clerk desk', custom: 'General' }
const data = (i: RoleItem) => JSON.parse(i.data || '{}') as Proposal

/** "Every Monday at 07:00", in words. */
export function scheduleText(r: Pick<Role, 'schedule' | 'at' | 'enabled'>) {
  if (!r.enabled) return 'Paused'
  const [kind, arg] = r.schedule.split(':')
  const n = Number(arg)
  if (!kind) return 'Only when you run it'
  if (kind === 'hours') return `Every ${n === 1 ? 'hour' : `${n} hours`}`
  const day = kind === 'daily' ? 'Every day' : kind === 'weekly' ? `Every ${DAYS[n]}` : kind === 'monthly' ? `Monthly on the ${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}` : `Every ${n} days`
  return `${day} at ${r.at}`
}

export function TeamPane({ roles, selected }: { roles: Role[]; selected: string }) {
  return (
    <section className="list team">
      <div className="lh"><h4>Team</h4><a className="btn small" href="#/team/new">+ New</a></div>
      <div className="scroll">
        {roles.map(r => {
          const waiting = r.questions + r.cards
          return (
            <a key={r.name} className={`it plain role-row ${selected === r.name ? 'on' : ''}`} href={`#/team/${enc(r.name)}`}>
              <span className="nm">{r.title}</span>
              <span className="tm">{r.running ? 'Working…' : scheduleText(r)}</span>
              {waiting > 0 && <span className="badge">{waiting}</span>}
              <span className="pv">{r.last?.status === 'error' ? `Last run failed: ${r.last.error}` : r.last?.brief || 'Not run yet'}</span>
            </a>
          )
        })}
        {!roles.length && <div className="empty">No roles yet. A role is an assistant that works on a schedule and reports back here. Tap + New.</div>}
        <SharedList selected={selected} />
      </div>
    </section>
  )
}

// ---------- Shared: one agent per reel or link you send to Fleet ----------

const VERDICT: Record<string, string> = { 'worth doing': '✅', maybe: '🤔', skip: '⛔', 'just a note': '📝' }
const shareState = (s: Share) => s.status === 'watching' ? 'Watching…' : s.status === 'thinking' ? 'Thinking…' : s.status === 'error' ? `Didn't finish: ${s.error}` : `${VERDICT[s.verdict] ?? ''} ${s.verdict}`

function SharedList({ selected }: { selected: string }) {
  const list = usePoll<Share[]>('/api/shares', 5000, () => {})
  if (!list.data?.length) return null
  return (
    <>
      <div className="lh"><h4>Shared</h4></div>
      {list.data.map(s => (
        <a key={s.id} className={`it plain role-row ${selected === `shared/${s.id}` ? 'on' : ''}`} href={`#/team/shared/${s.id}`}>
          <span className="nm">{s.title || s.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)}</span>
          <span className="tm">{when(s.created_at)}</span>
          <span className="pv">{shareState(s)}</span>
        </a>
      ))}
    </>
  )
}

/** One shared post: the video at the top, then a conversation with the agent that watched it. */
export function ShareView({ id, onBack, onError }: { id: number; onBack: () => void; onError: (e: Error) => void }) {
  const page = usePoll<{ share: Share & { video: boolean; note: Idea | null }; messages: ShareMessage[] }>(`/api/shares/${id}`, 2500, onError)
  const box = useRef<HTMLDivElement>(null)
  // opens at the top (the video), then follows the conversation as new replies come in
  const count = page.data?.messages.length ?? 0, seen = useRef(-1)
  useEffect(() => {
    if (seen.current >= 0 && count > seen.current) box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' })
    if (page.data) seen.current = count
  }, [count, page.data])
  if (!page.data) return <main className="det settings"><div className="empty">{page.error || 'Loading…'}</div></main>
  const { share: s, messages } = page.data
  const busy = s.status === 'watching' || s.status === 'thinking'
  const act = (p: Promise<unknown>) => p.then(page.refresh).catch(onError)
  return (
    <main className="det settings share">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">{s.title || 'Shared'}</div><div className="meta">{when(s.created_at)}</div></div>
        <a className="btn small" href={s.url} target="_blank" rel="noreferrer">Original</a>
        {s.note && <a className="btn small" href={`#/idea/${s.id}`}>Note</a>}
      </header>
      <div className="set-scroll" ref={box}>
        {s.video ? <video className="share-video" src={`/api/shares/${s.id}/video#t=0.1`} controls playsInline preload="metadata" />
          : !busy && <p className="hint">No video to show here; Open original has it.</p>}
        <div className="chat share-chat">
          {messages.map(m => <div key={m.id} className={`bubble ${m.who === 'you' ? 'user' : 'assistant'}`}>{m.who === 'you' ? m.text : <Markdown text={m.text} />}</div>)}
          {busy && <div className="bubble working"><span className="dots"><i /><i /><i /></span>{s.status === 'watching' ? 'Watching it…' : 'Thinking…'}</div>}
          {s.status === 'error' && <div className="bubble waiting">Didn't finish: {s.error} <button className="btn small" onClick={() => act(api.post(`/api/shares/${s.id}/watch`))}>Watch again</button></div>}
        </div>
        {!busy && s.status !== 'error' && <Composer placeholder="Ask about it, or tell it what to do with it" button="Send" onSend={text => act(api.post(`/api/shares/${s.id}/messages`, { text }))} />}
      </div>
    </main>
  )
}

function Sec({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return <section className="set-sec"><div className="sec-head"><h3>{title}</h3>{right}</div>{hint && <p className="hint">{hint}</p>}<div className="set-body">{children}</div></section>
}

type Page = { role: Role; items: RoleItem[]; runs: RoleRun[]; notes: Record<number, RoleNote> }
type Ctx = Page & { name: string; act: (p: Promise<unknown>) => Promise<void>; onError: (e: Error) => void }

export function RoleView({ name, onBack, onError, onChanged }: { name: string; onBack: () => void; onError: (e: Error) => void; onChanged: () => void }) {
  const page = usePoll<Page>(`/api/roles/${enc(name)}`, 3000, onError)
  const [settings, setSettings] = useState(false)
  const act = (p: Promise<unknown>) => p.then(() => { page.refresh(); onChanged() }).catch(onError)
  if (name === 'new') return <main className="det settings"><RoleSettings onBack={onBack} onError={onError} onSaved={r => { onChanged(); location.hash = `#/team/${enc(r.name)}` }} /></main>
  if (!page.data) return <main className="det settings"><div className="empty">{page.error || 'Loading…'}</div></main>
  const { role: r, runs } = page.data
  if (settings) return <main className="det settings"><RoleSettings role={r} onBack={() => setSettings(false)} onError={onError} onSaved={() => { setSettings(false); act(Promise.resolve()) }} /></main>
  const ctx: Ctx = { ...page.data, name, act, onError }
  const last = runs.find(x => x.status !== 'running')
  return (
    <main className={`det settings role desk-${r.kind}`}>
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">{r.title}</div>
          <div className="meta">{scheduleText(r)}{r.enabled && r.next_run ? ` · next ${when(r.next_run)}` : ''}</div></div>
        <button className="btn small" onClick={() => setSettings(true)}>Settings</button>
        <button className="btn small primary" disabled={r.running} onClick={() => act(api.post(`/api/roles/${enc(name)}/run`))}>{r.running ? 'Working…' : 'Run now'}</button>
      </header>
      <div className="set-scroll">
        <div className={`brief ${last?.status === 'error' ? 'error' : ''}`}>
          <div className="brief-when">{r.running ? `${r.title} is working on it…` : last ? when(last.finished_at ?? last.started_at) : 'Not run yet'}</div>
          <div className="brief-text">{last ? (last.status === 'error' ? `Didn't finish: ${last.error}` : last.brief) : `Press Run now to see what ${r.title} does.`}</div>
        </div>
        {r.kind === 'chief' ? <ChiefDesk {...ctx} /> : r.kind === 'clerk' ? <ClerkDesk {...ctx} /> : <Questions {...ctx} />}
        <Tasks {...ctx} />
        <Sec title={`Tell ${r.title} something`} hint="A correction, a fact it needs, or something to look into. It reads this on its next run; Run now to have it read it right away.">
          <Composer placeholder="e.g. Ignore the Someday list" button="Send" onSend={text => act(api.post(`/api/roles/${enc(name)}/messages`, { text }))} />
        </Sec>
        <Activity {...ctx} />
      </div>
    </main>
  )
}

// ---------- pieces every desk has ----------

function Questions({ items, act, role, title = 'Questions for you', hint }: Ctx & { title?: string; hint?: string }) {
  const qs = items.filter(i => i.kind === 'question' && i.status === 'open')
  if (!qs.length && role.kind !== 'custom') return null
  return (
    <Sec title={`${title}${qs.length ? ` · ${qs.length}` : ''}`} hint={qs.length ? hint ?? `${role.title} reads your answers on its next run.` : undefined}>
      {qs.map(q => (
        <div key={q.id} className="card">
          <div className="card-title">{q.text}</div>
          {q.detail && <div className="card-why">{q.detail}</div>}
          <Composer placeholder="Your answer" button="Answer" onSend={answer => act(api.patch(`/api/role-items/${q.id}`, { answer }))}
            extra={<button className="btn small ghost" onClick={() => act(api.patch(`/api/role-items/${q.id}`, { status: 'dismissed' }))}>Skip</button>} />
        </div>
      ))}
      {!qs.length && <p className="hint">Nothing to answer.</p>}
    </Sec>
  )
}

function Tasks({ items, act, role }: Ctx) {
  const ts = items.filter(i => i.kind === 'task' && i.status === 'open')
  if (!ts.length && role.kind !== 'custom') return null
  return (
    <Sec title={`For you to do${ts.length ? ` · ${ts.length}` : ''}`}>
      {ts.map(t => (
        <div key={t.id} className="role-task">
          <button className="check" role="checkbox" aria-checked={false} aria-label="Done" onClick={() => act(api.patch(`/api/role-items/${t.id}`, { status: 'done' }))} />
          <div className="role-text"><div>{t.text}</div>{t.detail && <div className="hint">{t.detail}</div>}</div>
          <button className="btn small ghost" aria-label="Not needed" title="Not needed" onClick={() => act(api.patch(`/api/role-items/${t.id}`, { status: 'dismissed' }))}>✕</button>
        </div>
      ))}
      {!ts.length && <p className="hint">Nothing waiting on you.</p>}
    </Sec>
  )
}

function Activity({ items, runs, act }: Ctx) {
  const closed = items.filter(i => (i.status !== 'open' && i.status !== 'expired') || i.kind === 'message')
  return (
    <Sec title="History">
      <details className="role-closed"><summary className="hint">Runs · {runs.length}</summary>
        {runs.map(run => (
          <div key={run.id} className={`role-run ${run.status}`}>
            <div className="tm">{when(run.started_at)}{run.status === 'running' ? ' · working…' : run.cost ? ` · $${run.cost.toFixed(2)}` : ''}</div>
            <div>{run.status === 'error' ? `Didn't finish: ${run.error}` : run.brief}</div>
          </div>
        ))}
      </details>
      {closed.length > 0 && (
        <details className="role-closed"><summary className="hint">What you've answered, done and sent · {closed.length}</summary>
          {closed.map(i => (
            <div key={i.id} className="role-run">
              <div className="tm">{i.kind === 'message' ? 'You said' : i.status === 'answered' ? 'You answered' : i.status === 'done' ? (i.kind === 'proposal' ? 'Accepted' : 'Done') : i.kind === 'proposal' ? 'Rejected' : 'Not needed'}{i.seen ? '' : ' · not read yet'}</div>
              <div>{i.text}{i.answer && <><br /><b>{i.answer}</b></>}</div>
              {i.kind === 'proposal' ? <button className="btn small ghost" onClick={() => act(api.post(`/api/role-items/${i.id}/act`, { action: 'undo' }))}>Undo</button>
                : i.kind !== 'message' && <button className="btn small ghost" onClick={() => act(api.patch(`/api/role-items/${i.id}`, { status: 'open', answer: '' }))}>Reopen</button>}
            </div>
          ))}
        </details>
      )}
    </Sec>
  )
}

function Composer({ placeholder, button, onSend, extra, initial = '', rows = 2 }: { placeholder: string; button: string; onSend: (text: string) => void; extra?: ReactNode; initial?: string; rows?: number }) {
  const [text, setText] = useState(initial)
  const send = () => { if (text.trim()) { onSend(text.trim()); setText('') } }
  return (
    <div className="role-comp">
      <textarea value={text} rows={rows} placeholder={placeholder} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
      <div className="set-row">{extra}<button className="btn small primary" disabled={!text.trim()} onClick={send}>{button}</button></div>
    </div>
  )
}

// ---------- chief of staff ----------

function Note({ n, id }: { n?: RoleNote; id: number }) {
  if (!n) return <div className="note gone">That note is gone</div>
  return (
    <a className={`note ${n.done ? 'done' : ''}`} href={`#/idea/${id}`} title="Open the note">
      <span className="note-text">{n.text}</span>
      <span className="note-list"><span className="sq round" style={{ background: AREAS.find(a => a.name === n.area)?.color ?? 'var(--faint)' }} />{n.list}</span>
    </a>
  )
}

function ChiefDesk(ctx: Ctx) {
  const cards = ctx.items.filter(i => i.kind === 'proposal' && i.status === 'open')
  const of = (t: Proposal['type'][]) => cards.filter(c => t.includes(data(c).type))
  const today = of(['today']), tidy = of(['merge', 'close']), hand = of(['handoff'])
  const handled = ctx.items.filter(i => i.kind === 'proposal' && (i.status === 'done' || i.status === 'dismissed') && (i.closed_at ?? 0) > Date.now() / 1000 - 86400)
  const post = (c: RoleItem, body: object) => ctx.act(api.post(`/api/role-items/${c.id}/act`, body))
  return (
    <>
      <Sec title="Today" hint={today.length ? 'The chief\'s picks for today. Done checks the note off.' : undefined}>
        {today.map(c => (
          <div key={c.id} className="card pick">
            <Note n={ctx.notes[data(c).ids[0]]} id={data(c).ids[0]} />
            <div className="card-why">{c.detail}</div>
            <div className="card-acts">
              <button className="btn small ghost" onClick={() => post(c, { action: 'reject' })}>Not today</button>
              <button className="btn small primary" onClick={() => post(c, { action: 'accept' })}>Done</button>
            </div>
          </div>
        ))}
        {!today.length && <p className="hint">No picks right now. The chief chooses again on its next run.</p>}
      </Sec>
      {hand.length > 0 && <Sec title="Hand to an agent" hint="Work an agent can finish without you. Check the prompt, then start it.">
        {hand.map(c => <HandoffCard key={c.id} c={c} ctx={ctx} />)}
      </Sec>}
      <Sec title="Tidy up" hint={tidy.length ? 'Notes that say the same thing, or look finished. Undo puts them back exactly.' : undefined}>
        {tidy.map(c => data(c).type === 'merge' ? <MergeCard key={c.id} c={c} ctx={ctx} /> : (
          <div key={c.id} className="card">
            <div className="card-kicker">Looks finished</div>
            <Note n={ctx.notes[data(c).ids[0]]} id={data(c).ids[0]} />
            <div className="card-why">{c.detail}</div>
            <div className="card-acts">
              <button className="btn small ghost" onClick={() => post(c, { action: 'reject' })}>Keep it</button>
              <button className="btn small primary" onClick={() => post(c, { action: 'accept' })}>Check it off</button>
            </div>
          </div>
        ))}
        {!tidy.length && <p className="hint">Your lists look tidy.</p>}
      </Sec>
      {handled.length > 0 && <Sec title="Handled today">
        {handled.map(c => (
          <div key={c.id} className="handled">
            <span>{c.status === 'done' ? '✓' : '–'} {c.text}{data(c).agent ? ` · ${data(c).agent}` : ''}</span>
            {data(c).agent ? <a className="btn small ghost" href={`#/agent/${enc(data(c).agent!)}`}>Open agent</a>
              : <button className="btn small ghost" onClick={() => post(c, { action: 'undo' })}>Undo</button>}
          </div>
        ))}
      </Sec>}
      <Questions {...ctx} />
    </>
  )
}

function MergeCard({ c, ctx }: { c: RoleItem; ctx: Ctx }) {
  const p = data(c)
  const [keep, setKeep] = useState(p.keep ?? p.ids[0])
  const [text, setText] = useState(p.text || ctx.notes[keep]?.text || '')
  return (
    <div className="card">
      <div className="card-kicker">Same thing, {p.ids.length} notes</div>
      {p.ids.map(id => (
        <label key={id} className={`merge-row ${keep === id ? 'keep' : ''}`}>
          <input type="radio" name={`keep-${c.id}`} checked={keep === id} onChange={() => setKeep(id)} />
          <Note n={ctx.notes[id]} id={id} />
          {keep === id && <span className="chip ok">keep</span>}
        </label>
      ))}
      <div className="card-why">{c.detail}</div>
      <label className="merge-text">Merged note<textarea value={text} rows={2} onChange={e => setText(e.target.value)} /></label>
      <div className="card-acts">
        <button className="btn small ghost" onClick={() => ctx.act(api.post(`/api/role-items/${c.id}/act`, { action: 'reject' }))}>Keep separate</button>
        <button className="btn small primary" onClick={() => ctx.act(api.post(`/api/role-items/${c.id}/act`, { action: 'accept', keep, text }))}>Merge</button>
      </div>
    </div>
  )
}

function HandoffCard({ c, ctx }: { c: RoleItem; ctx: Ctx }) {
  const p = data(c)
  const [prompt, setPrompt] = useState(p.prompt ?? '')
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const start = () => {
    setBusy(true)
    api.post<{ name: string }>(`/api/ideas/${p.ids[0]}/start`, { prompt })
      .then(({ name }) => ctx.act(api.post(`/api/role-items/${c.id}/act`, { action: 'started', agent: name })).then(() => { location.hash = `#/agent/${enc(name)}` }))
      .catch(ctx.onError).finally(() => setBusy(false))
  }
  return (
    <div className="card">
      <Note n={ctx.notes[p.ids[0]]} id={p.ids[0]} />
      <div className="card-why">{c.detail}</div>
      {edit ? <textarea className="role-prompt" value={prompt} rows={8} onChange={e => setPrompt(e.target.value)} />
        : <button className="prompt-peek" onClick={() => setEdit(true)} title="Edit the prompt">{prompt}</button>}
      <div className="card-acts">
        <button className="btn small ghost" onClick={() => ctx.act(api.post(`/api/role-items/${c.id}/act`, { action: 'reject' }))}>Not now</button>
        <button className="btn small primary" disabled={busy || !prompt.trim()} onClick={start}>{busy ? 'Starting…' : 'Start agent'}</button>
      </div>
    </div>
  )
}

// ---------- clerk ----------

// irs-name-change-letter.md → IRS name change letter
const SMALL = new Set(['and', 'the', 'for', 'of', 'to', 'a', 'an', 'on', 'in'])
const fileTitle = (path: string) => {
  const words = path.split('/').pop()!.replace(/\.\w+$/, '').split(/[-_ ]+/)
  const out = words.map(w => (w.length <= 3 && !SMALL.has(w.toLowerCase()) && /^[a-z]+$/i.test(w) ? w.toUpperCase() : w.toLowerCase())).join(' ')
  return out[0].toUpperCase() + out.slice(1)
}
const daysTo = (due: string) => Math.round((new Date(`${due}T12:00:00`).getTime() - Date.now()) / 86400_000)
const dueText = (due: string) => new Date(`${due}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

function ClerkDesk(ctx: Ctx) {
  const { role: r, name } = ctx
  const b: ClerkBoard = { deadlines: [], inflight: [], cpa: [], facts: [], ...JSON.parse(r.board || '{}') }
  const files = usePoll<{ path: string; mtime: number }[]>(`/api/roles/${enc(name)}/files`, 30_000, ctx.onError)
  const [open, setOpen] = useState('')
  const board = (section: string, index: number, body: object) => ctx.act(api.post(`/api/roles/${enc(name)}/board`, { section, index, ...body }))
  const order = (d: ClerkBoard['deadlines'][number]) => (d.status === 'done' ? 3 : !d.due ? 1 : 0) * 1e6 + (d.due ? daysTo(d.due) : 0)
  const deadlines = b.deadlines.map((d, i) => ({ ...d, i })).sort((x, y) => order(x) - order(y))
  const copyCpa = () => navigator.clipboard.writeText(b.cpa.map((q, n) => `${n + 1}. ${q.question}${q.why ? `\n   (${q.why})` : ''}`).join('\n\n')).catch(ctx.onError)
  return (
    <>
      <Questions {...ctx} title="The clerk needs to know" hint="Facts only you have. Each answer fixes a date on the calendar below." />
      <Sec title="Deadlines" hint={b.deadlines.length ? undefined : 'The clerk builds this calendar on its first run.'}>
        {deadlines.map(d => {
          const n = d.due ? daysTo(d.due) : null
          return (
            <div key={d.i} className={`deadline ${d.status} ${n !== null && n <= 30 && d.status !== 'done' ? 'soon' : ''}`}>
              <div className="countdown">{d.status === 'done' ? '✓' : n === null ? '?' : n < 0 ? 'late' : n}<span>{d.status === 'done' ? 'done' : n === null ? 'needs a date' : n < 0 ? `${-n} days` : n === 1 ? 'day' : 'days'}</span></div>
              <div className="deadline-body">
                <div className="card-title">{d.title}</div>
                <div className="hint">{[d.form, d.due && dueText(d.due)].filter(Boolean).join(' · ')}{d.source && <> · <a href={d.source} target="_blank" rel="noreferrer">source ↗</a></>}</div>
                {d.note && <div className="card-why">{d.note}</div>}
              </div>
              <button className="btn small ghost" onClick={() => board('deadlines', d.i, { status: d.status === 'done' ? 'upcoming' : 'done' })}>{d.status === 'done' ? 'Not done' : 'Mark done'}</button>
            </div>
          )
        })}
      </Sec>
      {b.inflight.length > 0 && <Sec title="In progress">
        {b.inflight.map((f, i) => (
          <div key={i} className="card">
            <div className="card-title">{f.title}</div>
            <div><span className="hint">Next:</span> {f.next_step}</div>
            {f.waiting_on && <div className="chip warn waiting">Waiting on {f.waiting_on}</div>}
          </div>
        ))}
      </Sec>}
      <Sec title="Drafts and files" hint={files.data?.length ? 'Drafts are for you to review, never signed or filed by the clerk.' : 'Nothing written yet.'}>
        {files.data?.map(f => (
          <button key={f.path} className="file-row" onClick={() => setOpen(f.path)}>
            <b>{fileTitle(f.path)}</b><span className="hint">updated {when(f.mtime)}</span>
          </button>
        ))}
        {open && <FileViewer cwd={r.cwd} path={open} onClose={() => setOpen('')} />}
      </Sec>
      {b.cpa.length > 0 && <Sec title="For your CPA or lawyer" right={<button className="btn small" onClick={copyCpa}>Copy for email</button>}
        hint="Questions the clerk won't answer itself. Record what they tell you and the clerk files it.">
        {b.cpa.map((q, i) => (
          <div key={i} className="card">
            <div className="card-title">{q.question}</div>
            {q.why && <div className="card-why">{q.why}</div>}
            {q.answer ? <div className="answer"><span className="hint">Their answer:</span> {q.answer}</div>
              : <Composer placeholder="What they said" button="Save answer" rows={1} onSend={answer => board('cpa', i, { answer })} />}
          </div>
        ))}
      </Sec>}
      {b.facts.length > 0 && <Sec title="What the clerk knows" hint="From your answers. Fix one if it's wrong.">
        {b.facts.map((f, i) => <Fact key={i} f={f} onFix={value => board('facts', i, { value })} />)}
      </Sec>}
    </>
  )
}

function Fact({ f, onFix }: { f: { fact: string; value: string }; onFix: (v: string) => void }) {
  const [v, setV] = useState<string | null>(null)
  return (
    <div className="fact">
      <span className="hint">{f.fact}</span>
      {v === null ? <><b>{f.value}</b><button className="btn small ghost" onClick={() => setV(f.value)}>Fix</button></>
        : <><input value={v} onChange={e => setV(e.target.value)} autoFocus /><button className="btn small primary" onClick={() => { if (v.trim() && v !== f.value) onFix(v); setV(null) }}>Save</button></>}
    </div>
  )
}

// ---------- settings ----------

const KINDS = [['', 'Only when I run it'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['every', 'Every few days'], ['hours', 'Every few hours']] as const
const has = (csv: string, x: string) => csv.split(',').includes(x)
const toggle = (csv: string, x: string, on: boolean) => [...csv.split(',').filter(v => v && v !== x), ...(on ? [x] : [])].join(',')
const BLANK: Partial<Role> = { kind: 'custom', title: '', prompt: '', schedule: 'daily', at: '07:00', model: 'sonnet', budget: 1, see: 'ideas,agents', areas: '', tools: '', cwd: '', write_dir: '', git_commit: 0, memory: '', enabled: 1 }

function RoleSettings({ role, onBack, onSaved, onError }: { role?: Role; onBack: () => void; onSaved: (r: Role) => void; onError: (e: Error) => void }) {
  const [r, setR] = useState<Partial<Role>>(role ?? BLANK)
  const [sure, setSure] = useState(false)
  const set = (p: Partial<Role>) => setR({ ...r, ...p })
  const [kind, arg = ''] = (r.schedule ?? '').split(':')
  const setKind = (k: string) => set({ schedule: k === 'daily' || !k ? k : `${k}:${k === 'weekly' ? 1 : k === 'monthly' ? 1 : k === 'hours' ? 4 : 2}` })
  const name = role?.name ?? (r.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const save = () => api.put<Role>(`/api/roles/${enc(name)}`, { ...r, enabled: !!r.enabled, git_commit: !!r.git_commit }).then(onSaved).catch(onError)
  return (
    <>
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">{role ? `${role.title} settings` : 'New role'}</div></div>
        <button className="btn small primary" disabled={!name} onClick={save}>{role ? 'Save' : 'Create'}</button>
      </header>
      <div className="set-scroll">
        <Sec title="Role">
          <label>Name<input value={r.title} onChange={e => set({ title: e.target.value })} placeholder="Chief of staff" maxLength={60} /></label>
          <label>Desk<select value={r.kind} onChange={e => set({ kind: e.target.value as Role['kind'] })}>
            {(Object.keys(DESK_NAMES) as Role['kind'][]).map(k => <option key={k} value={k}>{DESK_NAMES[k]}</option>)}</select></label>
          <p className="hint">The desk decides what its page shows and what its buttons do. General: a summary, questions and tasks.</p>
          <label>Instructions<textarea className="role-prompt" value={r.prompt} onChange={e => set({ prompt: e.target.value })} rows={12}
            placeholder="What this role is for, what to look at each run, and what it should never do." /></label>
        </Sec>
        <Sec title="When it runs" hint="Fleet on your Mac runs it. A run missed while the Mac was asleep happens when it wakes.">
          <div className="set-row">
            <label>Repeat<select value={kind} onChange={e => setKind(e.target.value)}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            {kind === 'weekly' && <label>On<select value={arg} onChange={e => set({ schedule: `weekly:${e.target.value}` })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
            {(kind === 'monthly' || kind === 'every' || kind === 'hours') && <label>{kind === 'monthly' ? 'Day of month' : kind === 'hours' ? 'Hours' : 'Days'}
              <input type="number" min={1} max={kind === 'monthly' ? 31 : kind === 'hours' ? 24 : 365} value={arg} onChange={e => set({ schedule: `${kind}:${e.target.value}` })} /></label>}
            {kind && kind !== 'hours' && <label>At<input type="time" value={r.at} onChange={e => set({ at: e.target.value })} /></label>}
          </div>
          <label className="check"><input type="checkbox" checked={!!r.enabled} onChange={e => set({ enabled: e.target.checked ? 1 : 0 })} />Runs on this schedule (off: paused)</label>
        </Sec>
        <Sec title="Model and cost" hint="Runs on your Claude subscription. The cap stops a run that goes past it (API-equivalent dollars).">
          <div className="seg" role="radiogroup">
            {['haiku', 'sonnet', 'opus'].map(m => <button key={m} role="radio" aria-checked={r.model === m} className={r.model === m ? 'on' : ''} onClick={() => set({ model: m })}>{m[0].toUpperCase() + m.slice(1)}</button>)}
          </div>
          <label>Cap per run ($)<input type="number" min={0.1} max={20} step={0.1} value={r.budget} onChange={e => set({ budget: Number(e.target.value) })} /></label>
        </Sec>
        <Sec title="What it can see">
          <label className="check"><input type="checkbox" checked={has(r.see ?? '', 'ideas')} onChange={e => set({ see: toggle(r.see ?? '', 'ideas', e.target.checked) })} />Your open ideas and checklists</label>
          <label className="check"><input type="checkbox" checked={has(r.see ?? '', 'agents')} onChange={e => set({ see: toggle(r.see ?? '', 'agents', e.target.checked) })} />The agents running now</label>
          {has(r.see ?? '', 'ideas') && <>
            <p className="hint">Only ideas in these areas (plus all checklists). None picked: everything.</p>
            <div className="set-row">{AREAS.map(a => (
              <label key={a.name} className="check"><input type="checkbox" checked={has(r.areas ?? '', a.name)} onChange={e => set({ areas: toggle(r.areas ?? '', a.name, e.target.checked) })} />{a.name}</label>
            ))}</div>
          </>}
        </Sec>
        <Sec title="What it can use" hint="With none of these it only reads what Fleet hands it. Notes change only when you press a button on its desk.">
          <label className="check"><input type="checkbox" checked={has(r.tools ?? '', 'read')} onChange={e => set({ tools: toggle(r.tools ?? '', 'read', e.target.checked) })} />Read files in its working folder (never .env files)</label>
          <label className="check"><input type="checkbox" checked={has(r.tools ?? '', 'web')} onChange={e => set({ tools: toggle(r.tools ?? '', 'web', e.target.checked) })} />Search and read the web</label>
          <label className="check"><input type="checkbox" checked={has(r.tools ?? '', 'write')} onChange={e => set({ tools: toggle(r.tools ?? '', 'write', e.target.checked) })} />Write files, only in one folder</label>
          {(has(r.tools ?? '', 'read') || has(r.tools ?? '', 'write')) && <label>Working folder<input value={r.cwd} onChange={e => set({ cwd: e.target.value })} placeholder="/Users/you/project" /></label>}
          {has(r.tools ?? '', 'write') && <>
            <label>Folder it may write, inside the working folder<input value={r.write_dir} onChange={e => set({ write_dir: e.target.value })} placeholder="notes/clerk" /></label>
            <label className="check"><input type="checkbox" checked={!!r.git_commit} onChange={e => set({ git_commit: e.target.checked ? 1 : 0 })} />Commit that folder to git after each run</label>
          </>}
        </Sec>
        {role && <Sec title="What it remembers" hint="Its own notes, rewritten each run. Edit to correct it.">
          <textarea className="role-prompt" value={r.memory} onChange={e => set({ memory: e.target.value })} rows={6} />
        </Sec>}
        {role && <Sec title="Remove">
          <div className="set-row"><button className="btn small danger-ghost" onClick={() => sure ? api.del(`/api/roles/${enc(role.name)}`).then(() => { location.hash = '#/team' }).catch(onError) : setSure(true)}>
            {sure ? 'Tap again to delete this role and its history' : 'Delete role'}</button></div>
        </Sec>}
      </div>
    </>
  )
}
