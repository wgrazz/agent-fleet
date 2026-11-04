import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backgroundCount, detect, limitReset, liveTail, mode, question, quickReplies, workingLine } from '../server/detect.ts'

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

describe('question', () => {
  const fx = (p: string) => readFileSync(join(root, p), 'utf8')
  it('finds what the agent is asking', () => {
    expect(question(fx('copilot/needs_you-trust.txt'))).toBe('Do you trust the files in this folder?')
    expect(question(fx('codex/needs_you-trust.txt'))).toBe('Trust this folder? Codex can read, edit, and run files here, subject to your')
    expect(question('Pick one:\n❯ 1. Yes\n  2. No\n')).toBe('Pick one:')
  })
})

describe('hookStatus', async () => {
  process.env.FLEET_DIR ??= (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'fleet-hook-'))
  const { hookStatus } = await import('../server/state.ts')
  it('maps Claude hook events', () => {
    expect(hookStatus({ event: 'working' })).toBe('working')
    expect(hookStatus({ event: 'done' })).toBe('done')
    expect(hookStatus({ event: 'end' })).toBe('end')
    expect(hookStatus({ event: 'notify', notification_type: 'permission_prompt' })).toBe('needs_you')
    expect(hookStatus({ event: 'notify', notification_type: 'agent_completed' })).toBe('done')
  })
  it('ignores the idle reminder Claude sends a minute after finishing', () => {
    expect(hookStatus({ event: 'notify', notification_type: 'idle_prompt' })).toBeNull()
    expect(hookStatus({ event: 'bogus' })).toBeNull()
  })
})

describe('mode and working line', () => {
  const fx = (p: string) => readFileSync(join(root, p), 'utf8')
  it('reads the footer mode', () => {
    expect(mode(fx('claude/done-1.txt'))).toBe('auto mode')
    expect(mode(fx('copilot/done-2.txt'))).toBe('Manual Approval')
    expect(mode(fx('codex/done-1.txt'))).toBe('')
  })
  it('reads what a busy agent is doing', () => {
    expect(workingLine('claude', fx('claude/working-1.txt'))).toBe('Catapulting… (4s · ↓ 24 tokens)')
    expect(workingLine('codex', fx('codex/working-1.txt'))).toBe('Working (2s)')
    expect(workingLine('claude', fx('claude/done-1.txt'))).toBe('')
  })
})

describe('liveTail', () => {
  const fx = (p: string) => readFileSync(join(root, p), 'utf8')
  it('keeps what the agent printed and drops the input box and footer', () => {
    const t = liveTail(fx('claude/working-1.txt'))
    expect(t.at(-1)).toMatch(/Catapulting/)
    expect(t.join('\n')).not.toMatch(/PONYTAIL|auto mode on/)
  })
})

describe('limitReset', () => {
  const at = (s: string) => new Date(s).getTime()
  const from = at('2026-11-01T16:10:00')

  it("Claude's limit message, read off its screen", () => {
    const screen = readFileSync(join(root, 'claude/done-limit.txt'), 'utf8')
    expect(limitReset(liveTail(screen, 3).join('\n'), from)).toBe(at('2026-11-01T22:00:00'))
  })

  it("Codex's, wrapped over lines, with minutes", () => {
    const text = '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit\nhttps://chatgpt.com/settings/usage to purchase more credits or try again at 8:56 PM.'
    expect(limitReset(text, from)).toBe(at('2026-11-01T20:56:00'))
  })

  it('a time already past today is tomorrow; a date is that date', () => {
    expect(limitReset("You've hit your 5-hour limit · resets 1am (America/New_York)", from)).toBe(at('2026-11-02T01:00:00'))
    expect(limitReset("You've hit your weekly limit · resets Nov 5, 9am (America/New_York)", from)).toBe(at('2026-11-05T09:00:00'))
    expect(limitReset('You’ve hit your usage limit. Try again at Nov 3rd, 2026 8:56 PM.', from)).toBe(at('2026-11-03T20:56:00'))
  })

  it("a time it can't read is 30 min on; anything else isn't a limit", () => {
    expect(limitReset("You've hit your session limit · resets soon", from)).toBe(from + 30 * 60_000)
    expect(limitReset('Prompt is too long', from)).toBeNull()
    expect(limitReset('the docs say you may hit your limit when scraping', from)).toBeNull()
  })
})

it('a limit message the agent has since answered past is not a limit any more', () => {
  const screen = readFileSync(join(root, 'claude/done-limit.txt'), 'utf8').replace('     /upgrade to increase your usage limit.\n', '     /upgrade to increase your usage limit.\n\n❯ continue\n\n⏺ Picked up and finished the migration.\n\n✻ Worked for 9s · done 10:05 PM\n')
  expect(limitReset(liveTail(screen, 3).join('\n'))).toBeNull()
})

describe('backgroundCount', () => {
  it('adds up every job kind in the footer', () => {
    expect(backgroundCount('> \n⏵⏵ auto mode on · 2 shells · 1 monitor')).toBe(3)
    expect(backgroundCount('> \n⏵⏵ auto mode on')).toBe(0)
  })
})
