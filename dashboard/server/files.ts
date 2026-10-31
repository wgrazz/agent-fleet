// Read and find files an agent mentions, so a spec it points to opens right in Fleet. Anything under your home folder
// except secrets (keys, .env files, credential folders); text only, up to 2 MB.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const HOME = homedir()
export const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.fleet', '.config', '.docker', '.kube', '.password-store', 'Keychains'])
export const SECRET_FILE = /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore))$/i
export const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.turbo', '.expo', 'Library', '.Trash',
  'Pods', 'DerivedData', '.gradle', 'target', 'coverage', 'vendor', 'google-cloud-sdk', 'site-packages', '.cache', '.pnpm-store'])

export class FileError extends Error {
  status: number
  constructor(status: number, msg: string) { super(msg); this.status = status }
}

/** Refuses paths outside home and anything that looks like a secret. */
export function allowed(path: string) {
  const rel = relative(HOME, path)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new FileError(403, 'only files in your home folder')
  const parts = rel.split(sep)
  if (parts.slice(0, -1).some(p => SECRET_DIRS.has(p)) || SECRET_FILE.test(parts.at(-1)!)) throw new FileError(403, "that looks like a secret, so Fleet won't show it")
}

/** `path` as the agent wrote it: absolute, ~/…, or relative to its folder or a folder above it (up to home). */
export function resolve(cwd: string, path: string) {
  const p = path.trim().replace(/^~(?=\/)/, HOME).replace(/:\d+(-\d+)?$/, '') // file.ts:12 → file.ts
  if (isAbsolute(p)) return p
  for (let d = cwd || HOME; ; d = dirname(d)) {
    if (existsSync(join(d, p))) return join(d, p)
    if (d === HOME || d === dirname(d)) return join(cwd || HOME, p)
  }
}

export function readText(cwd: string, path: string) {
  const full = resolve(cwd, path)
  if (!existsSync(full)) throw new FileError(404, `no such file: ${path}`)
  const real = realpathSync(full) // a link can't lead out to a secret
  allowed(real)
  const st = statSync(real)
  if (!st.isFile()) throw new FileError(400, `${path} is a folder`)
  if (st.size > 2 << 20) throw new FileError(413, `${path} is over 2 MB`)
  const buf = readFileSync(real)
  if (buf.subarray(0, 8000).includes(0)) throw new FileError(415, `${path} isn't a text file`)
  return { path: real, rel: relative(cwd || HOME, real), text: buf.toString('utf8'), mtime: st.mtimeMs }
}

/** File names under `cwd` containing every word of `q` (case-insensitive), best (shortest path) first. */
export async function findFiles(cwd: string, q: string, limit = 50) {
  const root = cwd || HOME
  allowed(realpathSync(root))
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hits: string[] = []
  let seen = 0
  // ponytail: a walk capped at 60k entries; swap in an index if folders get bigger than that
  // the second pattern reaches hidden folders (.agents, .plans…), which ** skips; a Set drops any repeats
  const done = new Set<string>()
  for await (const f of glob(['**/*', '**/.*/**/*'], { cwd: root, exclude: (d: any) => SKIP.has(typeof d === 'string' ? d.split(sep).pop()! : d.name) || SECRET_DIRS.has(typeof d === 'string' ? d.split(sep).pop()! : d.name) })) {
    if (++seen > 60_000) break
    const name = String(f)
    if (done.has(name)) continue
    done.add(name)
    const low = name.toLowerCase()
    if (words.every(w => low.includes(w)) && !SECRET_FILE.test(name.split(sep).pop()!) && statSync(join(root, name), { throwIfNoEntry: false })?.isFile()) hits.push(name)
  }
  return hits.sort((a, b) => a.length - b.length).slice(0, limit)
}
