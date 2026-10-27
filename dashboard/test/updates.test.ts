// How a tool was installed, read from where its program really lives, and when a version counts as newer.
import { expect, it } from 'vitest'
import { behind, source } from '../server/updates.ts'

it('tells a Homebrew cask from a global npm package, and leaves anything else alone', () => {
  expect(source('/opt/homebrew/Caskroom/claude-code@latest/2.1.306/claude')).toEqual({ via: 'brew', name: 'claude-code@latest' })
  expect(source('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toEqual({ via: 'npm', name: '@openai/codex' })
  expect(source('/Users/me/.local/share/claude/versions/2.1.306')).toBeNull()
})

it('compares versions as numbers', () => {
  const u = (current: string, latest: string) => ({ tool: 'x', current, latest, via: 'npm' as const, name: 'x' })
  expect(behind(u('2.1.9', '2.1.10'))).toBe(true)
  expect(behind(u('2.1.311', '2.1.311'))).toBe(false)
  expect(behind(u('0.165.0', '0.164.0'))).toBe(false) // a stale answer never says to "update" backwards
})
