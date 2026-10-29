import { useEffect, useState, type ReactNode } from 'react'
import { api, remember, type AiBudget, type Settings, type Usage } from './api.ts'
import { UsageMeters } from './components.tsx'
import { pickVoice, setVoiceSettings, speak, spokenAlerts, spokenReplies, unlockAudio, voices } from './extras.tsx'

// Kokoro voice ids are <accent><gender>_<name>: bm_george = British male George
const ACCENT: Record<string, string> = { a: 'American', b: 'British' }
const kokoroLabel = (id: string) => {
  const [code, name] = id.split('_')
  return `${name[0].toUpperCase()}${name.slice(1)} · ${ACCENT[code[0]] ?? code[0]} ${code[1] === 'm' ? 'male' : 'female'}`
}
const SAMPLE = 'Good evening. Two agents are working and nothing needs you right now. Shall I start the next one?'

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="set-sec">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      <div className="set-body">{children}</div>
    </section>
  )
}

type ToolUpdate = { tool: string; current: string; latest: string; via: 'brew' | 'npm'; name: string }
const LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', cursor: 'Cursor' }
const newer = (u: ToolUpdate) => {
  const [a, b] = [u.current, u.latest].map(v => v.split(/[.-]/).map(n => Number(n) || 0))
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0)
  return false
}

/** Agent tool versions, checked once a day on the Mac; Update runs the same upgrade you'd type (brew or npm). */
function Updates({ onError }: { onError: (e: Error) => void }) {
  const [u, setU] = useState<{ at: number; tools: ToolUpdate[] } | null>(null)
  const [busy, setBusy] = useState('')
  const load = (check = false) => {
    if (check) setBusy('check')
    return api.get<typeof u>(`/api/updates${check ? '?check=1' : ''}`).then(setU).catch(onError).finally(() => setBusy(''))
  }
  useEffect(() => { load().then(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const update = (t: ToolUpdate) => {
    setBusy(t.tool)
    api.post<typeof u>(`/api/updates/${t.tool}`).then(setU).catch(onError).finally(() => setBusy(''))
  }
  return (
    <Section title="Agent tools" hint="Checked once a day; your phone gets a notification when one is behind. Agents already running keep their version until you start new ones.">
      {!u ? <p className="hint">Loading…</p> : !u.at ? <p className="hint">Not checked yet.</p> : !u.tools.length && <p className="hint">Nothing installed with Homebrew or npm to keep current.</p>}
      {u?.tools.map(t => (
        <div className="set-row" key={t.tool}>
          <span><b>{LABEL[t.tool] ?? t.tool}</b> {t.current}{newer(t) ? <> → <b>{t.latest}</b></> : ' · up to date'}</span>
          {newer(t) && <button className="btn small primary" disabled={!!busy} onClick={() => update(t)}>{busy === t.tool ? 'Updating…' : 'Update'}</button>}
        </div>
      ))}
      <div className="set-row">
        <span className="hint">{u?.at ? `Checked ${new Date(u.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</span>
        <button className="btn small" disabled={!!busy} onClick={() => load(true)}>{busy === 'check' ? 'Checking…' : 'Check now'}</button>
      </div>
    </Section>
  )
}

export function SettingsPage({ usage, push, onBack, onError }: { usage: Usage[]; push: ReactNode; onBack: () => void; onError: (e: Error) => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [voiceList, setVoiceList] = useState<{ kokoro: string[] | null; mac: string[] }>({ kokoro: null, mac: [] })
  const [deviceVoices, setDeviceVoices] = useState(voices())
  const [budget, setBudget] = useState<AiBudget | null>(null)
  const [cwd, setCwd] = useState('')
  const [talk, setTalk] = useState(spokenReplies.get())
  const [alerts, setAlerts] = useState(spokenAlerts.get())
  const [saved, setSaved] = useState('')

  useEffect(() => {
    api.get<Settings>('/api/settings').then(x => { setS(x); setCwd(x.cwd) }).catch(onError)
    api.get<{ kokoro: string[] | null; mac: string[] }>('/api/tts/voices').then(setVoiceList).catch(() => {})
    api.get<{ budget: AiBudget }>('/api/jarvis/status').then(r => setBudget(r.budget)).catch(() => {})
    if (!('speechSynthesis' in window)) return
    const on = () => setDeviceVoices(voices())
    speechSynthesis.addEventListener('voiceschanged', on)
    return () => speechSynthesis.removeEventListener('voiceschanged', on)
  }, [onError])

  const save = (patch: Partial<Settings>, note = 'Saved') => {
    if (!s) return
    const next = { ...s, ...patch }
    setS(next)
    setVoiceSettings(next)
    api.patch('/api/settings', patch).then(() => { setSaved(note); setTimeout(() => setSaved(''), 1500) }).catch(onError)
  }
  const preview = (patch: Partial<Settings> = {}) => {
    if (!s) return
    unlockAudio()
    const v = { ...s, ...patch }
    speak(SAMPLE, { engine: v.voice_engine, voice: v.voice, speed: v.voice_speed })
  }

  if (!s) return <main className="det settings"><div className="empty">Loading…</div></main>
  const kokoroVoices = (voiceList.kokoro ?? []).filter(v => /^[ab][mf]_/.test(v))
  const britishFirst = (list: string[]) => [...list].sort((a, b) => Number(b.startsWith('b')) - Number(a.startsWith('b')) || a.localeCompare(b))

  return (
    <main className="det settings">
      <header className="dh">
        <button className="back" onClick={onBack} aria-label="Back">‹</button>
        <div className="dh-text"><div className="t">Settings</div></div>
        {saved && <span className="chip ok">{saved}</span>}
      </header>
      <div className="set-scroll">
        <Updates onError={onError} />
        <Section title="Jarvis's voice" hint="Natural voices are made on your Mac and played on whichever device you're using.">
          <div className="seg" role="radiogroup">
            {([['kokoro', 'Natural'], ['mac', 'Mac voices'], ['device', 'This device']] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={s.voice_engine === v} className={s.voice_engine === v ? 'on' : ''} disabled={v === 'kokoro' && !s.kokoro}
                onClick={() => {
                  const voice = v === 'kokoro' ? (s.voice.includes('_') ? s.voice : 'bm_george') : v === 'mac' ? (voiceList.mac.includes(s.voice) ? s.voice : 'Daniel') : s.voice
                  save({ voice_engine: v, voice })
                  preview({ voice_engine: v, voice })
                }}>{label}</button>
            ))}
          </div>
          {!s.kokoro && <p className="hint">Natural voices aren't installed yet: run <code>fleet tts install</code> on your Mac.</p>}
          {s.voice_engine === 'kokoro' && (
            <div className="voice-grid">
              {britishFirst(kokoroVoices).map(v => (
                <button key={v} className={`voice ${s.voice === v ? 'on' : ''}`} onClick={() => { save({ voice: v }); preview({ voice: v }) }}>{kokoroLabel(v)}</button>
              ))}
            </div>
          )}
          {s.voice_engine === 'mac' && (
            <>
              <label>Voice<select value={s.voice} onChange={e => { save({ voice: e.target.value }); preview({ voice: e.target.value }) }}>
                {voiceList.mac.map(v => <option key={v}>{v}</option>)}
              </select></label>
              <p className="hint">For much better Mac voices, download a Premium or Enhanced one (try Jamie or Serena): System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.</p>
            </>
          )}
          {s.voice_engine === 'device' && (
            <label>Voice<select value={pickVoice()?.name ?? ''} onChange={e => { remember.set('jarvis.voice', e.target.value); preview() }}>
              {deviceVoices.map(v => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
            </select></label>
          )}
          {s.voice_engine !== 'device' && (
            <label>Speed <span className="dim">{s.voice_speed.toFixed(2)}×</span>
              <input type="range" min={0.8} max={1.3} step={0.05} value={s.voice_speed} onChange={e => setS({ ...s, voice_speed: Number(e.target.value) })}
                onMouseUp={() => save({ voice_speed: s.voice_speed })} onTouchEnd={() => save({ voice_speed: s.voice_speed })} onKeyUp={() => save({ voice_speed: s.voice_speed })} />
            </label>
          )}
          <div className="set-row">
            <button className="btn primary" onClick={() => preview()}>Preview</button>
            <label className="check"><input type="checkbox" checked={talk} onChange={e => { setTalk(e.target.checked); spokenReplies.set(e.target.checked) }} />Speak replies</label>
            <label className="check"><input type="checkbox" checked={alerts} onChange={e => { setAlerts(e.target.checked); spokenAlerts.set(e.target.checked) }} />Speak alerts</label>
          </div>
        </Section>

        <Section title="Hey Siri" hint="A shortcut called Jarvis: say “Hey Siri, Jarvis”, then talk. Siri reads the answer and listens again until you stop talking. It holds your access key, so keep it to yourself. Tailscale must be on.">
          <div className="set-row">
            <a className="btn primary" href="/api/siri/shortcut" download="Jarvis.shortcut">Add the Jarvis shortcut</a>
          </div>
        </Section>

        <Section title="Share to Fleet" hint="A share-sheet shortcut: in Instagram, TikTok, Safari or any app, tap Share → Save to Fleet and the link lands in Brain Dump. Run on its own, it saves your clipboard. It holds your access key, so keep it to yourself. Tailscale must be on.">
          <div className="set-row">
            <a className="btn primary" href="/api/share/shortcut" download="Save to Fleet.shortcut">Add the Save to Fleet shortcut</a>
          </div>
        </Section>

        <MacAccess />

        <Section title="Jarvis's budget" hint="Jarvis's share of your weekly Claude limit, worked out from what all your Claude sessions cost this week.">
          {budget && <p className="set-stat">This week: <b>{budget.jarvis_pct < 0.1 ? 'under 0.1' : budget.jarvis_pct.toFixed(1)}%</b> of your weekly limit (all smart features: {budget.ai_pct.toFixed(2)}%)</p>}
          <div className="form-row">
            <label>Warn at (%)<input type="number" min={1} max={100} value={s.jarvis_warn_pct} onChange={e => save({ jarvis_warn_pct: Number(e.target.value) })} /></label>
            <label>Stop at (%)<input type="number" min={1} max={100} value={s.jarvis_max_pct} onChange={e => save({ jarvis_max_pct: Number(e.target.value) })} /></label>
          </div>
        </Section>

        <Section title="Smart features model" hint="Used by Jarvis, Improve prompt, Suggest model and Brain Dump sorting. It runs on your Claude subscription.">
          <div className="seg" role="radiogroup">
            {([['sonnet', 'Sonnet (recommended)'], ['haiku', 'Haiku (cheapest)'], ['opus', 'Opus (strongest)']] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={s.ai_model === v} className={s.ai_model === v ? 'on' : ''} onClick={() => save({ ai_model: v })}>{label}</button>
            ))}
          </div>
        </Section>

        <Section title="New agents" hint="Where agents started from the dashboard run, unless you pick another folder.">
          <form className="form-row" onSubmit={e => { e.preventDefault(); save({ cwd }) }}>
            <label>Default folder<input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/Users/you/project" /></label>
            <button className="btn" type="submit" disabled={cwd === s.cwd}>Save</button>
          </form>
        </Section>

        <Section title="Notifications">
          <div className="set-row">
            {push ?? <span className="hint">On for this device.</span>}
            <button className="btn" onClick={() => api.post('/api/push/test').then(() => setSaved('Sent')).catch(onError)}>Send a test notification</button>
          </div>
        </Section>

        <Section title="Usage">
          <UsageMeters usage={usage} />
        </Section>
      </div>
    </main>
  )
}

const ABILITIES: [string, string, string][] = [
  ['calendar', 'Calendar', '“What’s on tomorrow?”, and events you approve'],
  ['reminders', 'Reminders', '“What reminders do I have?”, and ones you approve'],
  ['music', 'Spotify', 'Play, pause, skip, what’s playing, volume'],
  ['apps', 'Apps and windows', 'Open apps, snap windows left/right (also needs Accessibility)'],
  ['screen', 'Your screen', '“What’s on my screen?” (Screen Recording)'],
]

/** Each check runs from the dashboard itself, so the macOS prompt that appears gives Jarvis the access. */
function MacAccess() {
  const [state, setState] = useState<Record<string, { ok: boolean; detail: string } | 'busy'>>({})
  const check = async (what: string) => {
    setState(s => ({ ...s, [what]: 'busy' }))
    const r = await api.post<{ ok: boolean; detail: string }>('/api/mac/check', { what }).catch(e => ({ ok: false, detail: (e as Error).message }))
    setState(s => ({ ...s, [what]: r }))
  }
  const all = async () => { for (const [what] of ABILITIES) await check(what) }
  return (
    <Section title="Mac access" hint="Jarvis can use these on your Mac, from your phone too. Run the checks while you're at the Mac: each one asks macOS once, and you click Allow. Email drafts use Mail the same way.">
      {ABILITIES.map(([what, label, desc]) => {
        const st = state[what]
        return (
          <div className="access" key={what}>
            <div className="access-text"><b>{label}</b><span>{desc}</span>
              {st && st !== 'busy' && <span className={st.ok ? 'ok' : 'bad'}>{st.ok ? '✓ Working' : st.detail}</span>}
            </div>
            <button className="btn small" onClick={() => check(what)} disabled={st === 'busy'}>{st === 'busy' ? 'Checking…' : 'Check'}</button>
          </div>
        )
      })}
      <div className="set-row"><button className="btn primary" onClick={all}>Set up all</button></div>
    </Section>
  )
}
