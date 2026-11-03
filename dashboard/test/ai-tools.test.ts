import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { safePath, callTool, type Policy } from '../server/ai-tools.ts'
const cwd = mkdtempSync(join(tmpdir(), 'fleet-tools-'))
const outside = mkdtempSync(join(tmpdir(), 'fleet-outside-'))
mkdirSync(join(cwd, 'drafts'))
writeFileSync(join(cwd, 'readme.md'), 'hello')
writeFileSync(join(cwd, '.env.local'), 'private')
symlinkSync(outside, join(cwd, 'escape'))
const p: Policy = { cwd, tools: ['Read', 'Write', 'Edit', 'Bash'], writeDir: join(cwd, 'drafts'), fleet: 'unused', journal: join(cwd, 'journal') }
it('enforces file roots, secret exclusions and symlink boundaries', () => {
  expect(safePath(p, 'readme.md')).toBe(realpathSync(join(cwd, 'readme.md')))
  expect(() => safePath(p, '.env.local')).toThrow('Private')
  expect(() => safePath(p, '../other')).toThrow('outside')
  expect(() => safePath(p, 'escape/new.md', true)).toThrow('outside')
  expect(() => safePath(p, 'readme.md', true)).toThrow('outside')
})
it('journals allowed writes, denies undeclared tools and arbitrary shell commands', async () => {
  await callTool(p, 'Write', { path: 'drafts/a.md', content: 'draft' })
  expect(readFileSync(join(cwd, 'drafts/a.md'), 'utf8')).toBe('draft')
  expect(readFileSync(p.journal, 'utf8')).toContain('Write')
  await expect(callTool(p, 'Bash', { argv: ['fleet', 'kill', 'all'] })).rejects.toThrow('Only Fleet read')
  await expect(callTool(p, 'Bash', { argv: ['sh', '-c', 'echo oops'] })).rejects.toThrow('beginning with fleet')
  await expect(callTool(p, 'WebFetch', {})).rejects.toThrow('not enabled')
})
