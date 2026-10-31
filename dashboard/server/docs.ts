// The Docs tab: Markdown notes in the folders you pick, the plans waiting in plans/pending/, search across them,
// which notes link to which, and saving a hand edit. Read from disk on every call, so nothing goes stale.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { posix, sep } from 'node:path'
import { allowed, FileError, readText, SECRET_DIRS, SECRET_FILE, SKIP } from './files.ts'

export type Doc = { root: string; rel: string; path: string; title: string; mtime: number; plan: boolean }
type Loaded = Doc & { text: string }

// agent tool config: their skill and rule files would swamp the notes
const TOOL_DIRS = new Set(['.claude', '.cursor', '.codex', '.gemini', '.continue', '.github'])
const PLAN = /(^|\/)\.?plans\/pending\/[^/]+\.md$/
const SKILLS = /(^|\/)\.[^/]+\/skills\// // .agents/skills/…: skills for agents, not notes
// a note mentioned in text: plans/pending/x.md, ../docs/y.md, README.md
const REF = /[\w@.+\-/]*[\w@+-]\.(?:md|markdown|mdx)\b/g

/** `.md` files under `root` as paths relative to it, hidden folders included, minus `skip` (folder names, or paths from the root). */
async function files(root: string, skip: string[]) {
  allowed(realpathSync(root))
  const names = new Set([...SKIP, ...SECRET_DIRS, ...TOOL_DIRS, ...skip.filter(s => !s.includes('/'))])
  const under = skip.filter(s => s.includes('/')).map(s => s.replace(/^\/+|\/+$/g, '') + '/')
  const out = new Set<string>()
  // ponytail: a walk on every call, fine for thousands of notes; an index if it gets slow
  // the second pattern reaches hidden folders (.agents, .plans…), which ** skips
  for await (const f of glob(['**/*.md', '**/.*/**/*.md'], { cwd: root, exclude: (d: any) => names.has(typeof d === 'string' ? d.split(sep).pop()! : d.name) })) {
    const rel = String(f).split(sep).join('/')
    if (!under.some(u => rel.startsWith(u)) && !SKILLS.test(rel) && !SECRET_FILE.test(posix.basename(rel))) out.add(rel)
    if (out.size >= 20_000) break
  }
  return [...out]
}

async function load(folders: string[], skip: string[]): Promise<Loaded[]> {
  const out: Loaded[] = []
  for (const folder of folders) {
    let root: string, rels: string[]
    try { root = realpathSync(folder); rels = await files(root, skip) } catch { continue } // a folder that's gone is left out
    for (const rel of rels) {
      const path = posix.join(root, rel)
      try {
        allowed(realpathSync(path)) // a link can't lead out to a secret
        const st = statSync(path)
        if (!st.isFile() || st.size > 2 << 20) continue
        const text = readFileSync(path, 'utf8')
        if (text.slice(0, 8000).includes('\0')) continue
        out.push({ root, rel, path, text, title: text.slice(0, 4096).match(/^# +(.+)$/m)?.[1].trim() || posix.basename(rel, '.md'), mtime: st.mtimeMs, plan: PLAN.test(rel) })
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

const meta = ({ text, ...d }: Loaded): Doc => d

/** Every note, most recently changed first. */
export async function listDocs(folders: string[], skip: string[] = []) {
  return (await load(folders, skip)).map(meta)
}

/** Notes containing every word of `q` (in the text or path), with the first line that matches. */
export async function searchDocs(folders: string[], skip: string[], q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hits: (Doc & { snippet: string })[] = []
  for (const d of await load(folders, skip)) {
    if (!words.every(w => `${d.rel}\n${d.text}`.toLowerCase().includes(w))) continue
    const line = d.text.split('\n').find(l => words.some(w => l.toLowerCase().includes(w))) ?? ''
    hits.push({ ...meta(d), snippet: line.trim().slice(0, 200) })
    if (hits.length >= 50) break
  }
  return hits
}

/** The note a reference in `from` points at, within one docs folder. */
function target(ref: string, from: Loaded, byRel: Map<string, Loaded>, byName: Map<string, Loaded[]>) {
  const near = posix.normalize(posix.join(posix.dirname(from.rel), ref)) // relative to the note: clerk/x.md, ../y.md
  if (byRel.has(near)) return byRel.get(near)
  const bare = ref.replace(/^(\.{0,2}\/)+/, '')
  if (bare.includes('/') && byRel.has(bare)) return byRel.get(bare) // from the folder root: plans/pending/x.md
  const named = byName.get(posix.basename(bare)) ?? []
  if (named.length === 1) return named[0] // a file name only one note has, however the path was written
  // several notes share the name (README.md): the longest note path the reference ends with, folders included
  return named.filter(d => d.rel.includes('/') && bare.endsWith('/' + d.rel)).sort((a, b) => b.rel.length - a.rel.length)[0]
}

/** Which note links to which, as [from path, to path]. Links stay inside one docs folder. */
function edges(docs: Loaded[]) {
  const out: [string, string][] = []
  for (const root of new Set(docs.map(d => d.root))) {
    const group = docs.filter(d => d.root === root)
    const byRel = new Map(group.map(d => [d.rel, d]))
    const byName = new Map<string, Loaded[]>()
    for (const d of group) byName.set(posix.basename(d.rel), [...(byName.get(posix.basename(d.rel)) ?? []), d])
    for (const a of group) {
      const to = new Set<string>()
      for (const ref of a.text.match(REF) ?? []) {
        const t = target(ref, a, byRel, byName)
        if (t && t.path !== a.path) to.add(t.path)
      }
      for (const p of to) out.push([a.path, p])
    }
  }
  return out
}

/** One note to read: its text, `mtime` for saving an edit, and the notes that link to it. Outside the docs folders it
 *  still opens (a link can lead anywhere in home) but has no links, and isn't a plan. */
export async function note(folders: string[], skip: string[], path: string) {
  const f = readText(posix.dirname(path), path)
  const docs = await load(folders, skip)
  const d = docs.find(x => x.path === f.path)
  const from = new Set(d ? edges(docs).filter(([, to]) => to === d.path).map(([a]) => a) : [])
  return { ...(d ? meta(d) : { root: '', rel: f.path, path: f.path, title: posix.basename(f.path), plan: false }), text: f.text, mtime: f.mtime,
    linkedFrom: docs.filter(x => from.has(x.path)).map(meta) }
}

/** The map: notes with at least one link, and the links as index pairs into `nodes`. */
export async function graph(folders: string[], skip: string[]) {
  const docs = await load(folders, skip)
  const links = edges(docs)
  const linked = new Set(links.flat())
  const nodes = docs.filter(d => linked.has(d.path)).map(meta)
  const at = new Map(nodes.map((d, i) => [d.path, i]))
  return { nodes, edges: links.map(([a, b]) => [at.get(a)!, at.get(b)!] as [number, number]), unlinked: docs.length - nodes.length }
}

/** Saves a hand edit to a note in a docs folder, unless the file changed since it was opened (`mtime` from the read). */
export function saveDoc(folders: string[], path: string, text: string, mtime: number) {
  if (!existsSync(path)) throw new FileError(404, 'that note is gone')
  const real = realpathSync(path)
  allowed(real)
  const inside = folders.some(f => { try { return real.startsWith(realpathSync(f) + '/') } catch { return false } })
  if (!inside || !/\.md$/i.test(real)) throw new FileError(403, 'only notes in your Docs folders can be edited here')
  if (Math.abs(statSync(real).mtimeMs - mtime) > 1) throw new FileError(409, 'This note changed since you opened it, probably by an agent. Copy your text, reload, and edit again.')
  writeFileSync(real, text)
  return { mtime: statSync(real).mtimeMs }
}
