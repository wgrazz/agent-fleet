// The Docs tab: which notes show, which are plans, search, links between notes, and saving an edit without clobbering an agent's.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-docs-')))
process.env.HOME = home
const { graph, listDocs, note, saveDoc, searchDocs } = await import('../server/docs.ts')
const root = join(home, 'repo')
const put = (p: string, text = 'hi') => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text) }
put('plans/pending/ship-it.md', '# Ship it\n\nSee [the spec](../../docs/spec.md).')
put('.plans/pending/older.md', '# Older plan')
put('plans/README.md', '# How plans work')
put('.agents/docs/HANDOFF.md', '# Handoff\n\nNext: plans/pending/ship-it.md and docs/README.md')
put('docs/spec.md', '# Search spec\n\nfirst line\nthe ranking rule is here')
put('docs/README.md', 'docs readme, mentions spec.md')
put('README.md', 'top readme, mentions README.md')
put('on-hold/old.md', '# Old')
put('node_modules/x/README.md')
put('.claude/skills/x.md')
put('.agents/skills/y/SKILL.md')
put('.env.md', 'KEY=1')
const skip = ['on-hold']
const P = (rel: string) => join(root, rel)
const mtime = (p: string) => statSync(p).mtimeMs

it('lists notes, hidden folders included, minus skipped folders, tool config and secrets; marks plans', async () => {
  const docs = await listDocs([root], skip)
  expect(docs.map(d => d.rel).sort()).toEqual(['.agents/docs/HANDOFF.md', '.plans/pending/older.md', 'README.md', 'docs/README.md', 'docs/spec.md', 'plans/README.md', 'plans/pending/ship-it.md'])
  expect(docs.filter(d => d.plan).map(d => d.title).sort()).toEqual(['Older plan', 'Ship it'])
  expect(docs.find(d => d.rel === 'docs/README.md')!.title).toBe('README')
  expect(await listDocs([join(home, 'gone')])).toEqual([]) // a missing folder doesn't break the rest
})

it('searches text and paths for every word, with the first matching line', async () => {
  const hits = await searchDocs([root], skip, 'ranking spec')
  expect(hits.map(h => h.rel)).toEqual(['docs/spec.md'])
  expect(hits[0].snippet).toBe('# Search spec')
  expect(await searchDocs([root], skip, 'old')).toEqual([expect.objectContaining({ rel: '.plans/pending/older.md' })])
})

it('opens a note with the notes linking to it: by relative path, root path and unique name, but not by a shared name', async () => {
  const from = async (rel: string) => (await note([root], skip, P(rel))).linkedFrom.map(d => d.rel).sort()
  expect(await from('docs/spec.md')).toEqual(['docs/README.md', 'plans/pending/ship-it.md']) // ../../docs/spec.md and bare spec.md
  expect(await from('plans/pending/ship-it.md')).toEqual(['.agents/docs/HANDOFF.md'])
  expect(await from('docs/README.md')).toEqual(['.agents/docs/HANDOFF.md']) // by its path; the bare README.md is ambiguous
  expect(await from('README.md')).toEqual([]) // only itself says README.md
  const g = await graph([root], skip)
  expect(g.nodes.length).toBe(4)
  expect(g.edges.length).toBe(4)
})

it('saves an edit, but not over a change made since it was opened, nor outside the docs folders', () => {
  const path = P('docs/spec.md')
  const saved = saveDoc([root], path, '# Edited', mtime(path))
  expect(readFileSync(path, 'utf8')).toBe('# Edited')
  utimesSync(path, new Date(), new Date(Date.now() + 5000)) // an agent wrote it meanwhile
  expect(() => saveDoc([root], path, '# Mine', saved.mtime)).toThrow(/changed since you opened it/)
  mkdirSync(join(home, 'other'), { recursive: true })
  writeFileSync(join(home, 'other/x.md'), 'x')
  expect(() => saveDoc([root], join(home, 'other/x.md'), 'y', mtime(join(home, 'other/x.md')))).toThrow(/Docs folders/)
})
