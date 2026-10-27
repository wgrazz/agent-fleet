import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'

// The screen panel stays dark in both themes: agents pick their colors for a dark terminal.
const THEME: ITheme = {
  background: '#16171a', foreground: '#d7d9de', cursor: '#16171a', selectionBackground: '#3a3f4b',
  black: '#2b2d33', brightBlack: '#6b6f78',
}
const FONT = 'ui-monospace, "SF Mono", Menlo, monospace'

const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`

/** Read-only live view of an agent's screen, laid out at the agent's own width. */
export function ScreenView({ name }: { name: string }) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = box.current!
    const term = new Terminal({
      disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none', fontFamily: FONT,
      fontSize: matchMedia('(max-width: 700px)').matches ? 11 : 12, lineHeight: 1.25, scrollback: 400, theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    let cols = 0
    const layout = () => {
      const rows = fit.proposeDimensions()?.rows ?? 30
      term.resize(cols || fit.proposeDimensions()?.cols || 100, Math.max(rows, 5))
    }
    layout()
    const ro = new ResizeObserver(layout)
    ro.observe(el)

    let ws: WebSocket | null = null
    let closed = false
    const connect = () => {
      ws = new WebSocket(wsUrl(`/ws/screen?name=${encodeURIComponent(name)}`))
      ws.onmessage = ev => {
        const text = String(ev.data)
        if (text.startsWith('{"cols":')) {
          cols = JSON.parse(text).cols
          return layout()
        }
        // clear and redraw as one synchronized frame: reset() blanked the screen until the new text was parsed,
        // so it blinked on every update (twice a second while the agent works)
        const frame = text.replace(/\n$/, '').replace(/\n/g, '\r\n')
        term.write(`\x1b[?2026h\x1b[0m\x1b[H\x1b[2J\x1b[3J${frame}\x1b[?2026l`, () => term.scrollToBottom())
      }
      // the agent may be restarting or the Mac waking up: retry quietly
      ws.onclose = () => !closed && setTimeout(connect, 2000)
    }
    connect()
    return () => {
      closed = true
      ws?.close()
      ro.disconnect()
      term.dispose()
    }
  }, [name])

  return <div className="screen" ref={box} />
}

const ARROWS = { Up: 'A', Down: 'B', Right: 'C', Left: 'D' }
// keys the phone keyboard doesn't have
const KEYBAR: [string, string][] = [['esc', '\x1b'], ['⇥', '\t'], ['⇧⇥', '\x1b[Z'], ['^C', '\x03'], ['←', 'Left'], ['↑', 'Up'], ['↓', 'Down'], ['→', 'Right'], ['⏎', '\r']]

/** A real, typeable terminal attached to the agent's tmux session. Closing it detaches; the agent keeps running. */
export function FullTerminal({ name, onClose }: { name: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const keys = useRef<(k: string) => void>(() => {})
  const [ctrl, setCtrl] = useState(false)
  const ctrlOn = useRef(false)
  ctrlOn.current = ctrl

  useEffect(() => {
    const term = new Terminal({ fontFamily: FONT, fontSize: 13, lineHeight: 1.2, theme: THEME, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(box.current!)
    fit.fit()
    const ws = new WebSocket(wsUrl(`/ws/pty?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`))
    ws.onmessage = ev => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data))
    ws.onclose = () => term.write('\r\n\x1b[2m[disconnected — the agent keeps running]\x1b[0m\r\n')
    const out = (d: string) => ws.readyState === ws.OPEN && ws.send(d)
    // the phone keyboard has no Ctrl: the Ctrl key in the bar turns the next letter typed into its control code
    const input = term.onData(d => {
      if (ctrlOn.current && /^[a-z]$/i.test(d)) { setCtrl(false); return out(String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31)) }
      out(d)
    })
    keys.current = k => {
      const arrow = ARROWS[k as keyof typeof ARROWS]
      out(arrow ? (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrow : k)
      term.focus()
    }
    const resize = term.onResize(({ cols, rows }) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ resize: [cols, rows] })))
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(box.current!)
    term.focus()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && e.metaKey && onClose()
    addEventListener('keydown', esc)
    return () => {
      removeEventListener('keydown', esc)
      input.dispose()
      resize.dispose()
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [name, onClose])

  return (
    <div className="overlay term-overlay" role="dialog" aria-label={`Terminal for ${name}`}>
      <div className="term-bar">
        <span className="term-title">{name}</span>
        <span className="hint">Typing goes straight to the agent · ⌘Esc closes</span>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="term-full" ref={box} />
      <div className="term-keys">
        {KEYBAR.map(([label, k]) => (
          <button key={label} onMouseDown={e => e.preventDefault()} onClick={() => keys.current(k)}>{label}</button>
        ))}
        <button className={ctrl ? 'on' : ''} onMouseDown={e => e.preventDefault()} onClick={() => setCtrl(c => !c)} title="Then type a letter, e.g. Ctrl then c">Ctrl</button>
      </div>
    </div>
  )
}
