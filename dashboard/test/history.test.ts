import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { answered, asked, statusOf } from '../server/history.ts'

describe('asked', () => {
  it('shows a question with numbered options and a plan in full', () => {
    const q = asked('AskUserQuestion', { questions: [{ question: 'Which list?', options: [{ label: 'Build', description: 'code work' }, { label: 'Do' }] }] })
    expect(q).toEqual({ role: 'assistant', text: '**Which list?**\n\n- **1.** Build — code work\n- **2.** Do' })
    expect(asked('ExitPlanMode', { plan: '1. Fix it' })?.text).toContain('1. Fix it')
    expect(asked('Bash', { command: 'ls' })).toBeNull()
  })
  it('shows your answers as your own message', () => {
    expect(answered('AskUserQuestion', { answers: { 'Lunch?': 'Sushi', 'Sides?': 'Fries, Soup' } }, '')).toBe('- Lunch? → **Sushi**\n- Sides? → **Fries, Soup**')
    expect(answered('ExitPlanMode', { plan: 'x' }, '')).toBe('Approved the plan')
    expect(answered('ExitPlanMode', 'Error: smaller', 'Use hello')).toBe('Keep planning: Use hello')
    expect(answered('ExitPlanMode', '', "The user doesn't want to proceed with this tool use.")).toBe('Keep planning')
    expect(answered('Bash', {}, '')).toBe('')
  })
})

describe('statusOf', () => {
  const log = (lines: object[]) => { const f = join(mkdtempSync(join(tmpdir(), 'st-')), 'x.jsonl'); writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n')); return f }
  it("reads Claude's model and context from its last real reply", () => {
    const u = (n: number) => ({ input_tokens: 5, cache_read_input_tokens: n, cache_creation_input_tokens: 10 })
    expect(statusOf('claude', log([
      { type: 'assistant', message: { model: 'claude-opus-5-5', usage: u(1000) } },
      { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: u(9) } },
      { type: 'assistant', message: { model: 'claude-opus-5-5', usage: u(150_000) } },
    ]))).toEqual({ model: 'claude-opus-5-5', effort: '', context: 150_015, window: 200_000 })
  })
  it("reads Codex's model, effort, context and window", () => {
    expect(statusOf('codex', log([
      { type: 'turn_context', payload: { model: 'gpt-6', effort: 'high' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 4000 }, model_context_window: 258_400 } } },
    ]))).toEqual({ model: 'gpt-6', effort: 'high', context: 4000, window: 258_400 })
    expect(statusOf('codex', log([]))).toBeNull()
  })
})
