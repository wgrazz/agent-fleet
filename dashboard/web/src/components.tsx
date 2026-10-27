import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, listGroups, remember, type Agent, type Folder, type Improved, type List, type Profile, type Route, type Status, type Usage } from './api.ts'

export const TOOLS = ['claude', 'codex', 'cursor', 'copilot', 'agy'] as const
const TOOL_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', agy: 'Antigravity' }
// ponytail: hand-kept copy of the CATALOG in server/ai.ts; "Other…" covers anything missing.
const MODELS: Record<string, [id: string, label: string][]> = {
  claude: [['fable', 'Fable 5.1'], ['opus', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 5.5']],
  codex: [['gpt-6-astra', 'GPT-6 Astra']],
  cursor: ['auto', 'composer-2.5', 'gpt-5.3-codex', 'gpt-5.3-codex-high', 'claude-opus-5-thinking-high', 'claude-sonnet-5-thinking-high',
    'gpt-5.6-sol-high', 'gemini-3.7-flash-high', 'grok-4.7-medium'].map(m => [m, m]),
  copilot: [['auto', 'auto'], ['gpt-5.6-luna', 'gpt-5.6-luna'], ['mai-code-1.1-flash', 'mai-code-1.1-flash']],
}
// Brand marks from simple-icons (CC0); Codex uses OpenAI's mark, Antigravity uses Google's Gemini spark.
const LOGO: Record<string, string> = {
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  cursor: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
  copilot: 'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z',
  agy: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
}
export const STATUS_LABEL: Record<Status, string> = {
  needs_you: 'Needs you', working: 'Working', waiting: 'Waiting on a job', ready: 'Ready', done: 'Done', crashed: 'Crashed', unknown: 'Outside tmux',
}
export const ORDER: Status[] = ['needs_you', 'working', 'waiting', 'ready', 'done', 'crashed', 'unknown']
export const COLORS = ['#8e8e93', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55']

export const toolLabel = (t: string) => TOOL_LABEL[t] ?? t

export const age = (s: number) =>
  !s ? '' : s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`

export const ago = (ms: number) => age(Math.max(1, Math.floor((Date.now() - ms) / 1000)))

export const activity = (a: Agent) =>
  a.message || (a.status === 'crashed' ? `Crashed · ${a.exit}` : '') || a.task.replace(/^\[[a-z]+\]\s*/, '') || a.last_line

export const isPhone = () => matchMedia('(max-width: 700px)').matches

export function Avatar({ tool, status, size }: { tool: string; status?: Status | 'gone'; size?: 'lg' | 'sm' }) {
  return (
    <span className={`tool ${size ?? ''}`}>
      <span className={`av av-${tool}`}>{LOGO[tool] ? <svg viewBox="0 0 24 24" aria-hidden><path d={LOGO[tool]} fill="currentColor" /></svg> : '?'}</span>
      {status && status !== 'gone' && <span className={`st st-${status}`} aria-label={STATUS_LABEL[status]} />}
    </span>
  )
}

export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

/** Name (and optionally color) for a new or renamed folder, list or agent. */
export function NameDialog({ title, initial = '', color, placeholder, action = 'Save', onSubmit, onClose }: {
  title: string; initial?: string; color?: string; placeholder?: string; action?: string
  onSubmit: (name: string, color: string) => void; onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [c, setC] = useState(color ?? '')
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); if (name.trim()) onSubmit(name.trim(), c) }}>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={placeholder} maxLength={60} />
        {color !== undefined && (
          <div className="swatches" role="radiogroup" aria-label="Color">
            {COLORS.map(x => <button type="button" key={x} role="radio" aria-checked={x === c} aria-label={x} className={x === c ? 'on' : ''}
              style={{ background: x }} onClick={() => setC(x)} />)}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>{action}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function Confirm({ title, text, action, onYes, onClose }: { title: string; text: string; action: string; onYes: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="dialog-text">{text}</p>
      <div className="form-actions">
        <button className="btn" onClick={onClose} autoFocus>Cancel</button>
        <button className="btn danger" onClick={() => { onClose(); onYes() }}>{action}</button>
      </div>
    </Dialog>
  )
}

// ---------- hold / right-click menus ----------

export type MenuItem = { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean; items?: MenuItem[]; swatch?: string; checked?: boolean } | 'sep'
type MenuState = { x: number; y: number; items: MenuItem[]; title?: string; from?: HTMLElement } | null
let showMenu: (m: MenuState) => void = () => {}
let held: HTMLElement | null = null // the row a long press is on: the menu pops out of it, iOS style

export const openMenu = (x: number, y: number, items: MenuItem[], title?: string) => { showMenu({ x, y, items, title, from: held ?? undefined }); held = null }

/** Long-press on touch, right-click with a mouse. The click that follows a long press is swallowed. */
export function useHold(onHold: (x: number, y: number) => void) {
  const timer = useRef<number>(0)
  const fired = useRef(false)
  const start = useRef({ x: 0, y: 0 })
  const release = () => {
    clearTimeout(timer.current)
    // once the menu is up it keeps the page unselectable until it closes (MenuHost)
    setTimeout(() => { if (!document.querySelector('.menu-overlay')) document.documentElement.classList.remove('holding') }, 300)
  }
  return {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onHold(e.clientX, e.clientY) },
    onTouchStart: (e: React.TouchEvent) => {
      fired.current = false
      // the row alone being unselectable isn't enough: iOS's own long-press then picks the nearest text it can select
      document.documentElement.classList.add('holding')
      const t = e.touches[0]
      const el = e.currentTarget as HTMLElement
      start.current = { x: t.clientX, y: t.clientY }
      timer.current = window.setTimeout(() => {
        fired.current = true
        navigator.vibrate?.(10)
        getSelection()?.removeAllRanges()
        held = el
        onHold(start.current.x, start.current.y)
        held = null
      }, 450)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (Math.abs(t.clientX - start.current.x) + Math.abs(t.clientY - start.current.y) > 10) clearTimeout(timer.current)
    },
    onTouchEnd: () => release(),
    onTouchCancel: () => release(), // a scroll that took over the touch
    onClickCapture: (e: React.MouseEvent) => { if (fired.current) { e.preventDefault(); e.stopPropagation(); fired.current = false } },
  }
}

/** Where a menu popped from a held row goes: under the row, or above it when there's no room below. */
function anchored(from: HTMLElement, items: number) {
  const r = from.getBoundingClientRect()
  const w = Math.min(260, innerWidth - 24)
  const h = Math.min(innerHeight * 0.6, 16 + items * 44)
  const left = Math.max(12, Math.min(r.left + 8, innerWidth - w - 12))
  if (innerHeight - r.bottom - 12 >= h) return { rect: r, style: { left, top: r.bottom + 8, width: w, transformOrigin: 'top left' } }
  if (r.top - 12 >= h) return { rect: r, style: { left, bottom: innerHeight - r.top + 8, width: w, transformOrigin: 'bottom left' } }
  return null // a tall menu on a small screen: use the bottom sheet
}

export function MenuHost() {
  const [stack, setStack] = useState<MenuState[]>([])
  const openedAt = useRef(0)
  const ghost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    showMenu = m => { openedAt.current = Date.now(); setStack(m ? [m] : []) }
    return () => { showMenu = () => {} }
  }, [])
  const dismiss = (e: React.SyntheticEvent) => {
    if (e.target !== e.currentTarget && !ghost.current?.contains(e.target as Node)) return
    e.preventDefault() // the tap that closes the menu must not also land on the row or button under it
    // lifting the finger after a long press sends a tap that lands on the backdrop; don't let it close the menu
    if (Date.now() - openedAt.current > 600) close()
  }
  // closing removes the backdrop, and iOS can still deliver that tap's click to whatever was under it: eat it
  const close = () => {
    setStack([])
    const eat = (ev: Event) => { ev.preventDefault(); ev.stopPropagation() }
    addEventListener('click', eat, { capture: true, once: true })
    setTimeout(() => removeEventListener('click', eat, { capture: true }), 500)
  }
  const top = stack.at(-1)
  const open = !!top
  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setStack([])
    // holding on past the menu opening is still a long press to iOS: nothing on the page may be selected meanwhile
    const html = document.documentElement
    const unselect = () => getSelection()?.removeAllRanges()
    html.classList.add('holding')
    unselect()
    addEventListener('keydown', esc)
    document.addEventListener('selectionchange', unselect)
    return () => { removeEventListener('keydown', esc); document.removeEventListener('selectionchange', unselect); html.classList.remove('holding') }
  }, [open])
  const root = stack[0]
  const pop = root?.from && isPhone() ? anchored(root.from, Math.max(...stack.map(m => m!.items.length)) + 1) : null
  // a lifted copy of the held row sits above the dimmed page
  useEffect(() => {
    const box = ghost.current
    if (!box || !root?.from) return
    const copy = root.from.cloneNode(true) as HTMLElement
    for (const a of [copy, ...copy.querySelectorAll('[href]')]) a.removeAttribute('href')
    box.replaceChildren(copy)
  }, [root, pop])
  if (!top) return null
  const sheet = isPhone() && !pop
  const style = pop ? pop.style : sheet ? {} : { left: Math.min(top.x, innerWidth - 240), top: Math.min(top.y, innerHeight - 40 - top.items.length * 34) }
  return (
    <div className={`menu-overlay ${pop ? 'lifted' : ''}`} onMouseDown={dismiss} onTouchEnd={dismiss}>
      {pop && <div className="menu-ghost" ref={ghost} aria-hidden style={{ left: pop.rect.left, top: pop.rect.top, width: pop.rect.width, height: pop.rect.height }} />}
      <div className={`menu ctx ${sheet ? 'sheet' : ''} ${pop ? 'pop' : ''}`} role="menu" style={style}>
        {(top.title || stack.length > 1) && (
          <div className="menu-title">
            {stack.length > 1 && <button className="menu-back" onClick={() => setStack(stack.slice(0, -1))}>‹</button>}
            {top.title}
          </div>
        )}
        {top.items.map((it, i) => it === 'sep' ? <div className="menu-sep" key={i} /> : (
          <button key={i} role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => {
            if (it.items) return setStack([...stack, { ...top, items: it.items, title: it.label }])
            setStack([])
            it.onClick?.()
          }}>
            {it.swatch && <span className="sq" style={{ background: it.swatch }} />}
            <span className="menu-text">{it.label}</span>
            {it.checked && <span className="check-mark">✓</span>}
            {it.items && <span className="chev">›</span>}
          </button>
        ))}
        {sheet && <button className="menu-cancel" onClick={() => setStack([])}>Cancel</button>}
      </div>
    </div>
  )
}

// ---------- pull down to refresh ----------

/** Pull down from the top of any list on a phone to reload: the home-screen app has no browser refresh button. */
export function PullToRefresh() {
  const [pull, setPull] = useState(0)
  useEffect(() => {
    let startY = -1, startX = 0
    let dist = 0
    // only when everything under the finger is scrolled to the top, and not in the terminal, a menu or a text box
    const atTop = (el: Element | null) => {
      for (; el && el !== document.body; el = el.parentElement) {
        if (el.matches('.xterm, .menu-overlay, .dialog, input, textarea, [contenteditable]')) return false
        if (el.scrollTop > 0) return false
      }
      return true
    }
    const down = (e: TouchEvent) => { startY = e.touches.length === 1 && atTop(e.target as Element) ? e.touches[0].clientY : -1; startX = e.touches[0]?.clientX ?? 0; dist = 0 }
    let frame = 0
    const move = (e: TouchEvent) => {
      if (startY < 0) return
      const d = e.touches[0].clientY - startY
      const dx = Math.abs(e.touches[0].clientX - startX)
      if (!dist && dx < 8 && Math.abs(d) < 8) return // too small to tell which way the finger is going
      if (!dist && (d < 0 || dx > d)) { startY = -1; return } // scrolling up, or a sideways swipe: not a pull
      // a pull: keep iOS from also rubber-banding the page underneath, which is what jittered
      if (e.cancelable) e.preventDefault()
      dist = Math.max(0, d)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setPull(dist > 12 ? Math.min(dist, 140) : 0))
    }
    const up = () => {
      cancelAnimationFrame(frame)
      if (startY >= 0 && dist > 90) { setPull(-1); setTimeout(() => location.reload(), 150) }
      else setPull(0)
      startY = -1
    }
    addEventListener('touchstart', down, { passive: true })
    addEventListener('touchmove', move, { passive: false }) // passive listeners can't stop the page scrolling
    addEventListener('touchend', up)
    addEventListener('touchcancel', up)
    return () => { removeEventListener('touchstart', down); removeEventListener('touchmove', move); removeEventListener('touchend', up); removeEventListener('touchcancel', up) }
  }, [])
  if (!pull) return null
  const ready = pull < 0 || pull > 90
  return (
    <div className={`ptr ${ready ? 'ready' : ''}`} style={{ transform: `translate(-50%, ${pull < 0 ? 60 : Math.min(pull, 140) * 0.55}px)` }} role="status" aria-label={pull < 0 ? 'Refreshing' : ready ? 'Release to refresh' : 'Pull to refresh'}>
      <span className={pull < 0 ? 'spin' : ''} style={pull < 0 ? undefined : { transform: `rotate(${pull * 2.5}deg)` }}>↻</span>
    </div>
  )
}

// ---------- sidebar ----------

export function Sidebar(props: {
  route: string; needs: number; paused: number; folders: Folder[]; counts: Map<number, number>; lists: List[]; usage: Usage[]
  newButton: ReactNode; push: ReactNode; onJarvis: () => void; onNewFolder: () => void; onFolderMenu: (f: Folder, x: number, y: number) => void
  onNewList: () => void; onNewChecklist: () => void; onListMenu: (l: List, x: number, y: number) => void; onDrop: (folderId: number | null, key: string) => void
}) {
  const [over, setOver] = useState<number | 'all' | null>(null)
  const [ideaLists, checklists, more] = listGroups(props.lists)
  const row = (l: List) => <ListRow key={l.id} l={l} on={props.route === `ideas/${l.name}`} onMenu={(x, y) => props.onListMenu(l, x, y)} />
  const dropProps = (target: number | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('fleet/key')) { e.preventDefault(); setOver(target ?? 'all') } },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(null); props.onDrop(target, e.dataTransfer.getData('fleet/key')) },
  })
  return (
    <aside className="nav">
      <div className="brand"><span className="logo">F</span>Fleet
        <button className="brand-mic" onClick={props.onJarvis} aria-label="Jarvis (J)" title="Jarvis (J)"><MicIcon /></button>
      </div>
      {props.newButton}
      <a className={`ni ${props.route === 'all' ? 'on' : ''} ${over === 'all' ? 'drop' : ''}`} href="#/" {...dropProps(null)}>
        <span className="sq" style={{ background: 'currentColor', opacity: 0.5 }} />All agents
        {props.needs > 0 && <span className="badge">{props.needs}</span>}
      </a>
      <div className="sec">Folders<button className="sec-add" onClick={props.onNewFolder} aria-label="New folder">+</button></div>
      {props.folders.map(f => (
        <FolderRow key={f.id} f={f} on={props.route === `folder/${f.id}`} drop={over === f.id} count={props.counts.get(f.id) ?? 0}
          dropProps={dropProps(f.id)} onMenu={(x, y) => props.onFolderMenu(f, x, y)} />
      ))}
      {!props.folders.length && <button className="ni ghost" onClick={props.onNewFolder}>New folder…</button>}
      <div className="sec">Ideas<button className="sec-add" onClick={props.onNewList} aria-label="New list">+</button></div>
      <a className={`ni ${props.route === 'prioritized' ? 'on' : ''}`} href="#/prioritized"><span className="prio p3 side">!</span>Prioritized</a>
      <a className={`ni ${props.route === 'everything' ? 'on' : ''}`} href="#/everything"><LinesIcon />All notes</a>
      {ideaLists.map(row)}
      <div className="sec">Checklists<button className="sec-add" onClick={props.onNewChecklist} aria-label="New checklist">+</button></div>
      {checklists.map(row)}
      {!checklists.length && <button className="ni ghost" onClick={props.onNewChecklist}>New checklist…</button>}
      {more.length > 0 && <details className="nav-more" open={more.some(l => props.route === `ideas/${l.name}`) || undefined}><summary className="sec">More</summary>{more.map(row)}</details>}
      <div className="sec">Library</div>
      <a className={`ni ${props.route === 'history' ? 'on' : ''}`} href="#/history"><ClockIcon />History</a>
      <a className={`ni ${props.route === 'paused' ? 'on' : ''}`} href="#/paused"><PauseIcon />Paused<b>{props.paused || ''}</b></a>
      <a className={`ni ${props.route === 'settings' ? 'on' : ''}`} href="#/settings"><GearIcon />Settings</a>
      <div className="foot">
        <UsageMeters usage={props.usage} compact />
        {props.push}
      </div>
    </aside>
  )
}

function FolderRow({ f, on, drop, count, dropProps, onMenu }: { f: Folder; on: boolean; drop: boolean; count: number; dropProps: object; onMenu: (x: number, y: number) => void }) {
  const hold = useHold(onMenu)
  return (
    <a className={`ni ${on ? 'on' : ''} ${drop ? 'drop' : ''}`} href={`#/folder/${f.id}`} {...dropProps} {...hold}>
      <span className="sq" style={{ background: f.color }} />{f.name}<b>{count || ''}</b>
    </a>
  )
}

function ListRow({ l, on, onMenu }: { l: List; on: boolean; onMenu: (x: number, y: number) => void }) {
  const hold = useHold(onMenu)
  const icon = l.name === 'Priority' ? <FlagIcon /> : l.name === 'Brain Dump' ? <InboxIcon /> : <span className="sq round" style={{ background: l.color }} />
  return (
    <a className={`ni ${on ? 'on' : ''}`} href={`#/ideas/${encodeURIComponent(l.name)}`} {...hold}>
      {icon}{l.name}
      {l.name === 'Brain Dump' && l.unsorted > 0 ? <span className="badge gray">{l.unsorted}</span> : <b>{l.open || ''}</b>}
    </a>
  )
}

export function UsageMeters({ usage, compact }: { usage: Usage[]; compact?: boolean }) {
  const known = usage.filter(u => u.windows.length)
  const unknown = usage.filter(u => !u.windows.length)
  const resets = (s: number | null) => {
    if (!s) return ''
    const d = new Date(s * 1000)
    const soon = d.getTime() - Date.now() < 86_400_000
    return soon ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short' })
  }
  return (
    <div className={`usage ${compact ? 'compact' : ''}`}>
      {known.map(u => (
        <div className="usage-row" key={u.tool}>
          <div className="usage-tool">{toolLabel(u.tool)}</div>
          {u.windows.map(w => (
            <div className="usage-win" key={w.label} title={w.resets_at ? `resets ${new Date(w.resets_at * 1000).toLocaleString()}` : ''}>
              <span className="usage-label">{w.label}</span>
              <span className="meter"><span className={w.pct >= 85 ? 'hot' : w.pct >= 60 ? 'warm' : ''} style={{ width: `${Math.min(100, w.pct)}%` }} /></span>
              <span className="usage-pct">{w.pct}%</span>
              {!compact && w.resets_at && <span className="usage-reset">resets {resets(w.resets_at)}</span>}
            </div>
          ))}
        </div>
      ))}
      {!compact && unknown.map(u => <div className="hint" key={u.tool}>{toolLabel(u.tool)}: {u.note}</div>)}
    </div>
  )
}

// ---------- new agent ----------

export function NewAgentButton({ profiles, onNew, onCustom, onInterview, onDeleteProfile }: {
  profiles: Profile[]; onNew: (p?: Profile) => void; onCustom: () => void; onInterview: () => void; onDeleteProfile: (p: Profile) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent | TouchEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    addEventListener('mousedown', away)
    addEventListener('touchstart', away)
    return () => { removeEventListener('mousedown', away); removeEventListener('touchstart', away) }
  }, [open])
  const def = profiles.find(p => p.is_default)
  return (
    <div className="new" ref={ref}>
      <button className="new-main" onClick={() => onNew(def)} title={def ? `Quick start: ${def.name}` : 'Quick start: Claude'}>
        <PlusIcon />New agent
      </button>
      <button className="new-more" aria-label="Profiles and more" aria-expanded={open} onClick={() => setOpen(!open)}>▾</button>
      {open && (
        <div className="menu" role="menu">
          {profiles.map(p => (
            <div className="menu-row" key={p.name}>
              <button role="menuitem" onClick={() => { setOpen(false); onNew(p) }}>
                <Avatar tool={p.tool} size="sm" />
                <span className="menu-text"><b>{p.name}</b><small>{[toolLabel(p.tool), p.model, p.effort].filter(Boolean).join(' · ')}</small></span>
                {p.is_default ? <span className="chip">default</span> : null}
              </button>
              <button className="x" aria-label={`Delete profile ${p.name}`} onClick={() => onDeleteProfile(p)}>×</button>
            </div>
          ))}
          {profiles.length > 0 && <div className="menu-sep" />}
          <button role="menuitem" className="menu-custom" onClick={() => { setOpen(false); onCustom() }}>Custom…</button>
          <button role="menuitem" className="menu-custom" onClick={() => { setOpen(false); onInterview() }}>Interview me about an idea…</button>
        </div>
      )}
    </div>
  )
}

export type StartFields = { name: string; tool: string; model: string; effort: string; cwd: string; prompt: string; folder_id: number | null }

/** The full New agent form, also used to start an agent from an idea. Suggest picks a tool/model; Improve rewrites the prompt. */
export function CustomForm({ title = 'New agent', initial, folders, onClose, onStart, onError }: {
  title?: string; initial?: Partial<StartFields>; folders: Folder[]; onClose: () => void
  onStart: (f: StartFields) => Promise<void>; onError: (e: Error) => void
}) {
  const [f, setF] = useState<StartFields & { profile: string; isDefault: boolean }>({
    name: '', tool: 'claude', model: '', effort: '', cwd: remember.get('cwd'), prompt: '', folder_id: null, profile: '', isDefault: false, ...initial,
  })
  const [busy, setBusy] = useState<'' | 'start' | 'suggest' | 'improve'>('')
  const [other, setOther] = useState(false)
  const models = MODELS[f.tool] ?? []
  const typing = other || (!!f.model && !models.some(([id]) => id === f.model))
  const [route, setRoute] = useState<Route | null>(null)
  const [improved, setImproved] = useState<(Improved & { before: string }) | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : k === 'folder_id' ? (e.target.value ? Number(e.target.value) : null) : e.target.value })

  const suggest = async () => {
    setBusy('suggest')
    try {
      const r = await api.post<Route>('/api/ai/recommend', { task: f.prompt })
      setRoute(r)
      setF(x => ({ ...x, tool: r.tool, model: r.model === 'default' ? '' : r.model, effort: r.effort }))
    } catch (e) { onError(e as Error) }
    setBusy('')
  }
  const improve = async () => {
    setBusy('improve')
    try {
      const r = await api.post<Improved>('/api/ai/improve', { text: f.prompt, cwd: f.cwd })
      setImproved({ ...r, before: f.prompt })
      setF(x => ({ ...x, prompt: r.prompt }))
    } catch (e) { onError(e as Error) }
    setBusy('')
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('start')
    try {
      if (f.profile.trim())
        await api.put(`/api/profiles/${encodeURIComponent(f.profile.trim())}`,
          { tool: f.tool, model: f.model, effort: f.effort, cwd: f.cwd, is_default: f.isDefault })
      if (f.cwd) remember.set('cwd', f.cwd)
      await onStart(f)
    } catch (err) {
      onError(err as Error)
      setBusy('')
    }
  }

  return (
    <Dialog title={title} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <label>What should it do?
          <textarea rows={5} value={f.prompt} onChange={set('prompt')} autoFocus
            placeholder="Optional. The agent starts on this right away. Type it rough; Improve can tidy it up." />
        </label>
        <div className="ai-row">
          <button type="button" className="btn" onClick={improve} disabled={!f.prompt.trim() || !!busy}><SparkIcon />{busy === 'improve' ? 'Improving…' : 'Improve prompt'}</button>
          <button type="button" className="btn" onClick={suggest} disabled={!f.prompt.trim() || !!busy}><WandIcon />{busy === 'suggest' ? 'Thinking…' : 'Suggest model'}</button>
          {improved && <button type="button" className="btn ghost" onClick={() => { setF(x => ({ ...x, prompt: improved.before })); setImproved(null) }}>Undo</button>}
        </div>
        {improved && (improved.changes.length > 0 || improved.questions.length > 0) && (
          <details className="ai-note" open={improved.questions.length > 0}>
            <summary>{improved.questions.length ? `${improved.questions.length} question${improved.questions.length > 1 ? 's' : ''} worth answering in the prompt` : 'What changed'}</summary>
            {improved.questions.length > 0 && <ul>{improved.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>}
            {improved.changes.length > 0 && <ul className="dim">{improved.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          </details>
        )}
        {route && (
          <div className="ai-note">
            <b>{toolLabel(route.tool)}{route.model ? ` · ${route.model}` : ''}{route.effort ? ` · ${route.effort}` : ''}</b> — {route.why}
            <button type="button" className="link" onClick={() => setF(x => ({ ...x, tool: route.alternative.tool, model: route.alternative.model, effort: '' }))}>
              Or {toolLabel(route.alternative.tool)} · {route.alternative.model}
            </button>
            <div className="dim">{route.alternative.why}</div>
          </div>
        )}
        <div className="form-row">
          <label>Tool<select value={f.tool} onChange={e => { setF({ ...f, tool: e.target.value, model: '' }); setOther(false) }}>
            {TOOLS.map(t => <option key={t} value={t}>{toolLabel(t)}</option>)}
          </select></label>
          <label>Model{typing
            ? <input value={f.model} onChange={set('model')} placeholder="exact model id" autoFocus={other}
                onBlur={() => !f.model && setOther(false)} />
            : <select value={f.model} onChange={e => e.target.value === '__other' ? setOther(true) : setF({ ...f, model: e.target.value })}>
                <option value="">tool default</option>
                {models.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                <option value={'__other'}>Other…</option>
              </select>}
          </label>
          <label>Effort<select value={f.effort} onChange={set('effort')}>
            {['', 'low', 'medium', 'high', 'xhigh', 'max'].map(v => <option key={v} value={v}>{v || 'default'}</option>)}
          </select></label>
        </div>
        <div className="form-row">
          <label>Name<input value={f.name} onChange={set('name')} placeholder="auto" /></label>
          <label>Folder<select value={f.folder_id ?? ''} onChange={set('folder_id')}>
            <option value="">None</option>
            {folders.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></label>
        </div>
        <label>Runs in<input value={f.cwd} onChange={set('cwd')} placeholder="your project folder (from fleet dash install)" /></label>
        <div className="form-row save">
          <label>Save as profile<input value={f.profile} onChange={set('profile')} placeholder="optional name" /></label>
          <label className="check"><input type="checkbox" checked={f.isDefault} onChange={set('isDefault')} disabled={!f.profile.trim()} />Make default</label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy === 'start'}>{busy === 'start' ? 'Starting…' : 'Start agent'}</button>
        </div>
      </form>
    </Dialog>
  )
}

export function InterviewForm({ initial = '', onClose, onStart }: { initial?: string; onClose: () => void; onStart: (topic: string) => Promise<void> }) {
  const [topic, setTopic] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Interview me about an idea" onClose={onClose}>
      <form className="form" onSubmit={async e => { e.preventDefault(); setBusy(true); await onStart(topic).catch(() => setBusy(false)) }}>
        <p className="dialog-text">A Claude agent asks you one question at a time (mostly multiple choice, so it works from your phone), pushes back where it should, and writes up a plan when you're done.</p>
        <textarea rows={4} autoFocus value={topic} onChange={e => setTopic(e.target.value)} placeholder="The idea, as rough as you like" />
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!topic.trim() || busy}>{busy ? 'Starting…' : 'Start interview'}</button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- icons ----------

const svg = (d: ReactNode, size = 13) => <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>{d}</svg>
export const PlusIcon = () => svg(<path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />)
export const PauseIcon = () => svg(<><rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor" /><rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor" /></>, 12)
export const TermIcon = () => svg(<><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></>, 12)
export const SendIcon = () => svg(<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />)
export const ClockIcon = () => svg(<><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" /></>)
export const FlagIcon = () => svg(<path d="M4 14V2.5M4 3h8l-2 3 2 3H4" stroke="#ff3b30" strokeWidth="1.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />)
export const LinesIcon = () => svg(<path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />)
export const InboxIcon = () => svg(<path d="M2 9.5 4 3h8l2 6.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinejoin="round" />)
export const SparkIcon = () => svg(<path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4z" fill="currentColor" />, 12)
export const WandIcon = () => svg(<><path d="m3 13 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M11 1.5v3M9.5 3h3M13.5 6v2M12.5 7h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>, 12)
export const MicIcon = () => svg(<><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor" /><path d="M3 8a5 5 0 0 0 10 0M8 13v2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></>, 16)
export const SearchIcon = () => svg(<><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>)

/** Pause an agent until a time; it comes back on its own with the same conversation. */
export function PauseUntil({ name, usage, onClose, onPick }: { name: string; usage: Usage[]; onClose: () => void; onPick: (epochS: number) => void }) {
  const at = (h: number, m = 0, dayOffset = 0) => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, m, 0, 0)
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return Math.floor(d.getTime() / 1000)
  }
  const fmt = (s: number) => new Date(s * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  const claude = usage.find(u => u.tool === 'claude')
  const reset5h = claude?.windows.find(w => w.label === '5 hours')?.resets_at
  const now = Math.floor(Date.now() / 1000)
  const presets: [string, number][] = [
    ['In 1 hour', now + 3600], ['In 3 hours', now + 3 * 3600], ['This evening', at(19)], ['Tomorrow morning', at(9, 0, new Date().getHours() < 9 ? 0 : 1)],
    ...(reset5h && reset5h > now ? [[`When Claude's 5-hour limit resets`, reset5h + 60] as [string, number]] : []),
  ]
  const [custom, setCustom] = useState('')
  return (
    <Dialog title={`Pause ${name} until…`} onClose={onClose}>
      <p className="dialog-text">It stops now and comes back on its own with the same conversation (while the dashboard is running on your Mac).</p>
      <div className="presets">
        {presets.map(([label, s]) => (
          <button key={label} className="preset" onClick={() => onPick(s)}><b>{label}</b><span>{fmt(s)}</span></button>
        ))}
      </div>
      <form className="form" onSubmit={e => { e.preventDefault(); const s = Math.floor(new Date(custom).getTime() / 1000); if (s > now) onPick(s) }}>
        <div className="form-row">
          <label>Or pick a time<input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} /></label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!custom}>Pause until then</button>
        </div>
      </form>
    </Dialog>
  )
}
export const GearIcon = () => svg(<><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>)
