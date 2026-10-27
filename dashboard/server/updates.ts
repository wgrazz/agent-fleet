// Keeping the agent tools current: once a day, see whether Claude Code, Codex and friends have a newer version,
// and update one when you tap Update in Settings. How each was installed (a Homebrew cask, or a global npm package)
// is read from where its program really lives; anything else (a self-updating installer) is left alone.
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './tmux.ts'

const BINS: Record<string, string> = { claude: 'claude', codex: 'codex', copilot: 'copilot', cursor: 'cursor-agent' }
const DIRS = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]

export type Update = { tool: string; current: string; latest: string; via: 'brew' | 'npm'; name: string }

/** Where a tool came from: brew cask NAME (…/Caskroom/NAME/…) or npm package NAME (…/node_modules/NAME/…). */
export function source(real: string): { via: 'brew' | 'npm'; name: string } | null {
  const cask = real.match(/\/Caskroom\/([^/]+)\//)
  if (cask) return { via: 'brew', name: cask[1] }
  const pkg = real.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  return pkg ? { via: 'npm', name: pkg[1] } : null
}

const version = (s: string) => s.match(/\d+\.\d+\.\d+(?:[-.][\w.]+)?/)?.[0] ?? ''
const find = (bin: string) => DIRS.map(d => join(d, bin)).find(existsSync)
const brew = () => ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync) ?? 'brew'
const npm = () => join(process.execPath, '..', 'npm')

async function check(tool: string): Promise<Update | null> {
  const bin = find(BINS[tool])
  const from = bin ? source(realpathSync(bin)) : null
  if (!bin || !from) return null
  const current = version(await run(bin, ['--version']).catch(() => ''))
  const latest = from.via === 'brew'
    ? (JSON.parse(await run(brew(), ['info', '--cask', '--json=v2', from.name])).casks?.[0]?.version ?? '')
    : (await run(npm(), ['view', from.name, 'version'])).trim()
  return current && latest ? { tool, current, latest: version(latest), ...from } : null
}

let last: { at: number; tools: Update[] } = { at: 0, tools: [] }
export const updates = () => last

/** Look again now (the daily poll, Check now, and after an update). */
export async function checkAll() {
  if (existsSync(brew())) await run(brew(), ['update', '--quiet']).catch(() => '') // brew's version list is otherwise only as fresh as your last brew command
  const tools = (await Promise.all(Object.keys(BINS).map(t => check(t).catch(e => { console.error(`update check for ${t} failed:`, e.message); return null })))).filter(Boolean) as Update[]
  last = { at: Date.now(), tools }
  return last
}

const parts = (v: string) => v.split(/[.-]/).map(n => Number(n) || 0)
/** latest is newer than current (numerically, so 2.1.10 beats 2.1.9, and a stale brew answer never says 'older'). */
export const behind = (u: Update) => {
  const [a, b] = [parts(u.current), parts(u.latest)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0)
  return false
}

/** Upgrade one tool the way it was installed. Agents already running keep the version they started with. */
export async function upgrade(tool: string) {
  const u = last.tools.find(x => x.tool === tool) ?? (await checkAll()).tools.find(x => x.tool === tool)
  if (!u) throw new Error(`${tool} isn't installed with Homebrew or npm, so Fleet can't update it`)
  if (u.via === 'brew') await run(brew(), ['upgrade', '--cask', u.name])
  else await run(npm(), ['install', '-g', `${u.name}@latest`])
  return checkAll()
}
