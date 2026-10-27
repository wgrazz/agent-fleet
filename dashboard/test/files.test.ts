// Reading and finding files an agent mentions: found from its folder or one above, never secrets or outside home.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-files-')))
process.env.HOME = home
const { findFiles, readText } = await import('../server/files.ts')
const put = (p: string, text = 'hi') => { mkdirSync(join(home, p, '..'), { recursive: true }); writeFileSync(join(home, p), text) }
put('repo/docs/specs/search-design.md', '# Search')
put('repo/app/src/index.ts')
put('repo/.env', 'KEY=1')
put('.ssh/config')
put('repo/node_modules/x/search-design.md')
const app = join(home, 'repo/app')

it('reads a file relative to the agent folder or a folder above it, ignoring :line', () => {
  expect(readText(app, 'src/index.ts:3').text).toBe('hi')
  expect(readText(app, 'docs/specs/search-design.md').text).toBe('# Search')
  expect(readText(app, '~/repo/docs/specs/search-design.md').rel).toBe('../docs/specs/search-design.md')
})

it('refuses secrets, missing files and anything outside home', () => {
  expect(() => readText(app, '../.env')).toThrow(/secret/)
  expect(() => readText(home, '.ssh/config')).toThrow(/secret/)
  expect(() => readText(app, 'nope.md')).toThrow(/no such file/)
  expect(() => readText(app, '/etc/hosts')).toThrow(/home folder/)
})

it('finds file names by every word, skipping node_modules and secrets', async () => {
  expect(await findFiles(join(home, 'repo'), 'search design')).toEqual(['docs/specs/search-design.md'])
  expect(await findFiles(join(home, 'repo'), 'env')).toEqual([])
})
