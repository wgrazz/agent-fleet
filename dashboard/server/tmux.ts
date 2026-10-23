// Thin tmux wrappers. Sessions are always targeted as `=NAME:` (exact match) and arguments go in as an argv
// array, never through a shell.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const run = async (cmd: string, args: string[], cwd?: string) =>
  (await execFileP(cmd, args, { cwd, maxBuffer: 16 << 20 })).stdout

const tmux = (...args: string[]) => run('tmux', args)
const target = (name: string) => `=${name}:`

export type Pane = { session: string; paneId: string; pid: number; dead: boolean; exitStatus: number | null; signal: string }

export async function panes(): Promise<Pane[]> {
  let out = ''
  try {
    out = await tmux('list-panes', '-a', '-F',
      '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}')
  } catch {
    return [] // no tmux server running
  }
  return out.split('\n').filter(Boolean).map(line => {
    const [session, paneId, pid, dead, status, signal] = line.split('\t')
    return { session, paneId, pid: Number(pid), dead: dead === '1', exitStatus: status ? Number(status) : null, signal }
  })
}

export const capture = (name: string, ansi = false) =>
  tmux('capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', target(name), '-S', '-200')

export const paneWidth = async (name: string) =>
  Number((await tmux('display-message', '-p', '-t', target(name), '#{pane_width}')).trim())

// Text goes in as a bracketed paste so multi-line replies land as one message, then Enter submits it.
export async function sendText(name: string, text: string) {
  await tmux('set-buffer', '-b', 'fleet-reply', '--', text)
  await tmux('paste-buffer', '-p', '-d', '-b', 'fleet-reply', '-t', target(name))
  await tmux('send-keys', '-t', target(name), 'Enter')
}

export const KEYS = /^(Escape|Enter|Up|Down|Tab|BTab|Space|[1-9]|[a-z])$/

export async function sendKey(name: string, key: string) {
  if (!KEYS.test(key)) throw new Error(`key not allowed: ${key}`)
  return tmux('send-keys', '-t', target(name), key)
}
