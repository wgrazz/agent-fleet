// Team: your scheduled roles. Each one's page has its questions for you, its tasks for you, a box to tell it
// something, what it did on each run, and its settings. A role reads your answers and messages on its next run.
import { useState, type ReactNode } from 'react'
import { api, usePoll, type Role, type RoleItem, type RoleRun } from './api.ts'
import { AREAS } from './areas.ts'

const enc = encodeURIComponent
const when = (s: number) => new Date(s * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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
        {roles.map(r => (
          <a key={r.name} className={`it plain role-row ${selected === r.name ? 'on' : ''}`} href={`#/team/${enc(r.name)}`}>
            <span className="nm">{r.title}</span>
            <span className="tm">{r.running ? 'Running…' : scheduleText(r)}</span>
            {r.questions > 0 && <span className="badge">{r.questions}</span>}
            <span className="pv">{r.last?.status === 'error' ? `Last run failed: ${r.last.error}` : r.last?.brief || 'Not run yet'}</span>
          </a>
        ))}
        {!roles.length && <div className="empty">No roles yet. A role is an assistant that runs on a schedule and reports back here. Tap + New.</div>}
      </div>
    </section>
  )
}

function Sec({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="set-sec"><h3>{title}</h3>{hint && <p className="hint">{hint}</p>}<div className="set-body">{children}</div></section>
}

type Page = { role: Role; items: RoleItem[]; runs: RoleRun[] }

export function RoleView({ name, onBack, onError, onChanged }: { name: string; onBack: () => void; onError: (e: Error) => void; onChanged: () => void }) {
  const page = usePoll<Page>(`/api/roles/${enc(name)}`, 3000, onError)
  const [settings, setSettings] = useState(false)
  const act = (p: Promise<unknown>) => p.then(() => { page.refresh(); onChanged() }).catch(onError)
  if (name === 'new') return <main className="det settings"><RoleSettings onBack={onBack} onError={onError} onSaved={r => { onChanged(); location.hash = `#/team/${enc(r.name)}` }} /></main>
  if (!page.data) return <main className="det settings"><div className="empty">{page.error || 'Loading…'}</div></main>
  const { role: r, items, runs } = page.data
  if (settings) return <main className="det settings"><RoleSettings role={r} onBack={() => setSettings(false)} onError={onError} onSaved={() => { setSettings(false); act(Promise.resolve()) }} /></main>
  const open = (kind: string) => items.filter(i => i.kind === kind && i.status === 'open')
  const closed = items.filter(i => i.status !== 'open' || i.kind === 'message')
  return (
    <main className="det settings role">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">{r.title}</div>
          <div className="meta">{scheduleText(r)}{r.enabled && r.next_run ? ` · next ${when(r.next_run)}` : ''}</div></div>
        <button className="btn small" onClick={() => setSettings(true)}>Settings</button>
        <button className="btn small primary" disabled={r.running} onClick={() => act(api.post(`/api/roles/${enc(name)}/run`))}>{r.running ? 'Running…' : 'Run now'}</button>
      </header>
      <div className="set-scroll">
        <Sec title={`Questions for you${open('question').length ? ` · ${open('question').length}` : ''}`} hint={open('question').length ? `${r.title} reads your answers on its next run.` : undefined}>
          {open('question').map(q => <QuestionCard key={q.id} q={q} onAnswer={answer => act(api.patch(`/api/role-items/${q.id}`, { answer }))}
            onSkip={() => act(api.patch(`/api/role-items/${q.id}`, { status: 'dismissed' }))} />)}
          {!open('question').length && <p className="hint">Nothing to answer.</p>}
        </Sec>
        <Sec title={`For you to do${open('task').length ? ` · ${open('task').length}` : ''}`}>
          {open('task').map(t => (
            <div key={t.id} className="role-task">
              <button className="check" role="checkbox" aria-checked={false} aria-label="Done" onClick={() => act(api.patch(`/api/role-items/${t.id}`, { status: 'done' }))} />
              <div className="role-text"><div>{t.text}</div>{t.detail && <div className="hint">{t.detail}</div>}</div>
              <button className="btn small ghost" aria-label="Not needed" title="Not needed" onClick={() => act(api.patch(`/api/role-items/${t.id}`, { status: 'dismissed' }))}>✕</button>
            </div>
          ))}
          {!open('task').length && <p className="hint">Nothing waiting on you.</p>}
        </Sec>
        <Sec title={`Tell ${r.title} something`} hint="A correction, a fact it needs, or something to look into. It reads this on its next run; Run now to have it read it right away.">
          <Composer placeholder="e.g. My CPA is Jane at Smith & Co; ask before drafting tax forms" button="Send"
            onSend={text => act(api.post(`/api/roles/${enc(name)}/messages`, { text }))} />
        </Sec>
        <Sec title="Activity">
          {runs.map(run => (
            <div key={run.id} className={`role-run ${run.status}`}>
              <div className="tm">{when(run.started_at)}{run.status === 'running' ? ' · running…' : run.cost ? ` · $${run.cost.toFixed(2)}` : ''}</div>
              <div>{run.status === 'error' ? `Didn't finish: ${run.error}` : run.brief}</div>
            </div>
          ))}
          {!runs.length && <p className="hint">Not run yet. Run now to try it.</p>}
          {closed.length > 0 && (
            <details className="role-closed"><summary className="hint">Answered, done and sent · {closed.length}</summary>
              {closed.map(i => (
                <div key={i.id} className="role-run">
                  <div className="tm">{i.kind === 'message' ? 'You said' : i.status === 'answered' ? 'You answered' : i.status === 'done' ? 'Done' : 'Not needed'}{i.seen ? '' : ' · not read yet'}</div>
                  <div>{i.text}{i.answer && <><br /><b>{i.answer}</b></>}</div>
                  {i.kind !== 'message' && <button className="btn small ghost" onClick={() => act(api.patch(`/api/role-items/${i.id}`, { status: 'open', answer: '' }))}>Reopen</button>}
                </div>
              ))}
            </details>
          )}
        </Sec>
      </div>
    </main>
  )
}

function QuestionCard({ q, onAnswer, onSkip }: { q: RoleItem; onAnswer: (a: string) => void; onSkip: () => void }) {
  return (
    <div className="role-q">
      <div className="role-text"><b>{q.text}</b>{q.detail && <div className="hint">{q.detail}</div>}</div>
      <Composer placeholder="Your answer" button="Answer" onSend={onAnswer} extra={<button className="btn small ghost" onClick={onSkip}>Skip</button>} />
    </div>
  )
}

function Composer({ placeholder, button, onSend, extra }: { placeholder: string; button: string; onSend: (text: string) => void; extra?: ReactNode }) {
  const [text, setText] = useState('')
  const send = () => { if (text.trim()) { onSend(text.trim()); setText('') } }
  return (
    <div className="role-comp">
      <textarea value={text} rows={2} placeholder={placeholder} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
      <div className="set-row">{extra}<button className="btn small primary" disabled={!text.trim()} onClick={send}>{button}</button></div>
    </div>
  )
}

// ---------- settings ----------

const KINDS = [['', 'Only when I run it'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['every', 'Every few days'], ['hours', 'Every few hours']] as const
const has = (csv: string, x: string) => csv.split(',').includes(x)
const toggle = (csv: string, x: string, on: boolean) => [...csv.split(',').filter(v => v && v !== x), ...(on ? [x] : [])].join(',')
const BLANK: Partial<Role> = { title: '', prompt: '', schedule: 'daily', at: '07:00', model: 'sonnet', budget: 1, see: 'ideas,agents', areas: '', tools: '', cwd: '', write_dir: '', git_commit: 0, memory: '', enabled: 1 }

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
        <Sec title="What it can use" hint="With none of these it only reads what Fleet hands it. It never edits or deletes your ideas either way.">
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
