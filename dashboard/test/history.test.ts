import { describe, expect, it } from 'vitest'
import { asked } from '../server/history.ts'

describe('asked', () => {
  it('shows a question with numbered options and a plan in full', () => {
    const q = asked('AskUserQuestion', { questions: [{ question: 'Which list?', options: [{ label: 'Build', description: 'code work' }, { label: 'Do' }] }] })
    expect(q).toEqual({ role: 'assistant', text: '**Which list?**\n\n- **1.** Build — code work\n- **2.** Do' })
    expect(asked('ExitPlanMode', { plan: '1. Fix it' })?.text).toContain('1. Fix it')
    expect(asked('Bash', { command: 'ls' })).toBeNull()
  })
})
