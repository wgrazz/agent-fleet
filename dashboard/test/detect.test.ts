import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect, quickReplies } from '../server/detect.ts'

// fixtures/<tool>/<expected state>-<label>.txt, captured with `tmux capture-pane -p` from real sessions
const root = join(import.meta.dirname, 'fixtures')

describe('detect', () => {
  for (const tool of readdirSync(root)) {
    for (const file of readdirSync(join(root, tool))) {
      const expected = file.split('-')[0]
      // a quiet screen, so 'working' has to come from the tool's busy marker, not from recent change
      it(`${tool}/${file} → ${expected}`, () => {
        expect(detect(tool, readFileSync(join(root, tool, file), 'utf8'), 10_000)).toBe(expected)
      })
    }
  }

  it('a changing screen with no marker counts as working', () => {
    expect(detect('claude', 'some output\n', 1000)).toBe('working')
  })
})

describe('quickReplies', () => {
  const fx = (p: string) => readFileSync(join(root, p), 'utf8')

  it('numbered menus', () => {
    expect(quickReplies(fx('copilot/needs_you-permission.txt')).map(q => q.key)).toEqual(['1', '2', '3'])
    expect(quickReplies(fx('codex/needs_you-trust.txt'))).toEqual([
      { key: '1', label: 'Trust and continue' },
      { key: '2', label: 'Back to Agent Command Center' },
    ])
  })

  it('letter keys', () => {
    expect(quickReplies(fx('cursor/needs_you-trust.txt')).map(q => q.key)).toEqual(['a', 'q'])
  })

  it('nothing when the agent is not asking', () => {
    expect(quickReplies(fx('claude/done-1.txt'))).toEqual([])
    expect(quickReplies(fx('codex/working-1.txt'))).toEqual([])
  })
})
