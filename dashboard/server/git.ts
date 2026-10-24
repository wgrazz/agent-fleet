// The Changes tab: for an agent's folder, every git repo at or below it (a monorepo root often holds several
// separate repos) with uncommitted files, commits since the agent started, and whether they're pushed.
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { run } from './tmux.ts'

export type RepoChanges = {
  repo: string            // path relative to the agent's folder ('.' for the folder's own repo)
  branch: string
  files: { status: string; path: string }[]
  commits: { hash: string; subject: string; pushed: boolean }[]
  unpushed: number
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv', 'on-hold', 'Library'])

function repos(root: string, depth = 4): string[] {
  const found: string[] = []
  const walk = (dir: string, d: number) => {
    if (existsSync(join(dir, '.git'))) found.push(dir)
    if (d === 0) return
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), d - 1)
  }
  walk(root, depth)
  // the folder itself may sit inside a repo
  let up = dirname(root)
  while (up !== dirname(up) && !found.length) {
    if (existsSync(join(up, '.git'))) found.push(up)
    up = dirname(up)
  }
  return found
}

const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]).catch(() => '')

async function repoChanges(dir: string, root: string, sinceS: number): Promise<RepoChanges | null> {
  const [status, branch, log, upstream] = await Promise.all([
    git(dir, 'status', '--porcelain=v1', '-uall'),
    git(dir, 'branch', '--show-current'),
    git(dir, 'log', `--since=${sinceS}`, '--format=%h\t%s', '-n', '30'),
    git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'),
  ])
  const unpushedList = upstream.trim() ? (await git(dir, 'rev-list', '--abbrev-commit', '@{upstream}..HEAD')).split('\n').filter(Boolean) : []
  const files = status.split('\n').filter(Boolean).slice(0, 200).map(l => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }))
  const commits = log.split('\n').filter(Boolean).map(l => {
    const [hash, subject] = l.split('\t')
    return { hash, subject, pushed: !!upstream.trim() && !unpushedList.some(u => u.startsWith(hash) || hash.startsWith(u)) }
  })
  if (!files.length && !commits.length) return null
  return { repo: relative(root, dir) || '.', branch: branch.trim(), files, commits, unpushed: upstream.trim() ? unpushedList.length : commits.length }
}

const cache = new Map<string, { at: number; data: RepoChanges[] }>()

export async function changes(cwd: string, startedS: number): Promise<RepoChanges[]> {
  const key = `${cwd}:${startedS}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 10_000) return hit.data
  const data = (await Promise.all(repos(cwd).map(r => repoChanges(r, cwd, startedS)))).filter(Boolean) as RepoChanges[]
  cache.set(key, { at: Date.now(), data })
  return data
}
