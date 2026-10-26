import { describe, expect, it } from 'vitest'
import { answered, asked } from '../server/history.ts'

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
