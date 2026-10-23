// /ws/screen: a read-only live view of an agent's screen. /ws/pty: a real terminal attached to its tmux session.
import type { IncomingMessage, Server } from 'node:http'
import { homedir } from 'node:os'
import type { Duplex } from 'node:stream'
import pty from 'node-pty'
import { WebSocketServer, type WebSocket } from 'ws'
import { list } from './state.ts'
import { capture } from './tmux.ts'

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

function screen(ws: WebSocket, name: string) {
  let last = ''
  const tick = async () => {
    const now = await capture(name, true).catch(() => null)
    if (now === null) return ws.close(4404, 'session gone')
    if (now !== last && ws.readyState === ws.OPEN) ws.send((last = now))
  }
  tick()
  const timer = setInterval(tick, 500)
  ws.on('close', () => clearInterval(timer))
  ws.on('message', () => {}) // read-only: input never reaches the agent from here
}

function terminal(ws: WebSocket, name: string, cols: number, rows: number) {
  // ponytail: attaching resizes the tmux window to this client (window-size latest); detaching gives it back
  const term = pty.spawn('tmux', ['attach-session', '-t', `=${name}`], {
    name: 'xterm-256color', cols, rows, cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })
  term.onData(d => ws.readyState === ws.OPEN && ws.send(d))
  term.onExit(() => ws.close())
  ws.on('message', (data, isBinary) => {
    const text = data.toString()
    if (!isBinary && text.startsWith('{"resize":')) {
      try {
        const [c, r] = JSON.parse(text).resize
        if (c > 0 && r > 0 && c < 1000 && r < 1000) term.resize(c, r)
        return
      } catch {} // not a resize message after all; treat as typed input
    }
    term.write(text)
  })
  ws.on('close', () => term.kill())
}

export function attach(server: Server, authorized: (req: IncomingMessage) => boolean) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const name = url.searchParams.get('name') ?? ''
    const agent = list().find(a => a.name === name && a.controllable)
    const kind = url.pathname === '/ws/screen' ? 'screen' : url.pathname === '/ws/pty' ? 'pty' : ''
    if (!authorized(req) || !agent || !kind) {
      socket.write(`HTTP/1.1 ${authorized(req) ? 404 : 401} \r\n\r\n`)
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, ws => {
      if (kind === 'screen') return screen(ws, name)
      const num = (k: string, d: number) => Math.min(Math.max(Number(url.searchParams.get(k)) || d, 20), 500)
      terminal(ws, name, num('cols', 120), num('rows', 40))
    })
  })
}
