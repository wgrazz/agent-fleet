import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'

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
        term.reset()
        term.write(text.replace(/\n$/, '').replace(/\n/g, '\r\n'), () => term.scrollToBottom())
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

/** A real, typeable terminal attached to the agent's tmux session. Closing it detaches; the agent keeps running. */
export function FullTerminal({ name, onClose }: { name: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({ fontFamily: FONT, fontSize: 13, lineHeight: 1.2, theme: THEME, cursorBlink: true })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(box.current!)
    fit.fit()
    const ws = new WebSocket(wsUrl(`/ws/pty?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`))
    ws.onmessage = ev => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data))
    ws.onclose = () => term.write('\r\n\x1b[2m[disconnected — the agent keeps running]\x1b[0m\r\n')
    const input = term.onData(d => ws.readyState === ws.OPEN && ws.send(d))
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
    </div>
  )
}
