import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-ask-'))
const { answerAsk, ingestHook, openAsk, pollAsk } = await import('../server/state.ts')

const questions = [{ question: 'Lunch?', options: [{ label: 'Pizza' }] }, { question: 'Sides?', multiSelect: true, options: [{ label: 'Fries' }] }]

describe('asks', () => {
  it('answers a question once, then is gone', () => {
    const { id } = openAsk({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions } })
    expect(pollAsk(id)).toEqual({})
    expect(answerAsk(id, { answers: { 'Lunch?': 'Pizza' } })).toBe('answer "Sides?"')
    expect(answerAsk(id, { answers: { 'Lunch?': 'Pizza', 'Sides?': 'Fries, salad' } })).toBe('')
    expect(pollAsk(id)).toEqual({ decision: { behavior: 'allow', updatedInput: { questions, answers: { 'Lunch?': 'Pizza', 'Sides?': 'Fries, salad' } } } })
    expect(pollAsk(id)).toEqual({ gone: true })
  })

  it('plans approve or keep planning with feedback', () => {
    const a = openAsk({ session_id: 's2', tool_name: 'ExitPlanMode', tool_input: { plan: 'Do it' } })
    answerAsk(a.id, { approve: 'auto' })
    expect(pollAsk(a.id)).toEqual({ decision: { behavior: 'allow', updatedInput: { plan: 'Do it' }, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }] } })
    const b = openAsk({ session_id: 's2', tool_name: 'ExitPlanMode', tool_input: { plan: 'Do it' } })
    answerAsk(b.id, { approve: false, feedback: 'smaller' })
    expect(pollAsk(b.id)).toEqual({ decision: { behavior: 'deny', message: 'smaller' } })
  })

  it('drops when the session moves on (answered in the terminal), not on its own tool call', () => {
    const { id } = openAsk({ session_id: 's3', tool_name: 'AskUserQuestion', tool_input: { questions } })
    ingestHook({ session_id: 's3', event: 'working', tool_name: 'AskUserQuestion' })
    ingestHook({ session_id: 's3', event: 'notify', notification_type: 'permission_prompt' })
    expect(pollAsk(id)).toEqual({})
    ingestHook({ session_id: 's3', event: 'working', tool_name: 'Bash' })
    expect(pollAsk(id)).toEqual({ gone: true })
  })
})
