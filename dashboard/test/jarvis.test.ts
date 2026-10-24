import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-jarvis-'))
const { instant, findAgent, summary, remember, memory, approvalWord, threadFor, newThread, addMessage, threads, messages, propose, pendingProposals, settleProposal, summarize, wantsRanking } = await import('../server/jarvis.ts')

const agent = (name: string, extra: object = {}) => ({
  name, controllable: true, tool: 'claude', pid: 1, cwd: '', task: '', age_s: 1, session_id: '', status: 'working', status_since: 0,
  quick_replies: [], last_line: '', message: '', exit: '', ...extra,
}) as any
const agents = [
  agent('scraper-walmart', { status: 'needs_you', message: 'Start the 30 s pace run?', quick_replies: [{ key: '1', label: 'Yes, start it' }, { key: '2', label: 'No, write up first' }] }),
  agent('ui-cards'), agent('ui-header'), agent('data-auth', { status: 'crashed' }),
]

describe('instant commands', () => {
  it('status without AI', () => {
    expect(instant('what needs me?', agents)!.say).toBe('One agent needs you: scraper-walmart, asking Start the 30 s pace run. 2 working: ui-cards, ui-header. data-auth crashed.')
    expect(instant('which agents need me', agents)).not.toBeNull()
  })
  it('yes picks the matching menu option', () => {
    expect(instant('tell walmart yes', agents)!.actions[0]).toMatchObject({ type: 'key', agent: 'scraper-walmart', key: '1' })
    expect(instant('tell walmart no', agents)!.actions[0]).toMatchObject({ type: 'key', key: '2' })
    expect(instant('answer scraper-walmart 2', agents)!.actions[0]).toMatchObject({ type: 'key', key: '2' })
  })
  it('free text goes as a reply', () => {
    expect(instant('tell ui-cards use the brand green', agents)!.actions[0]).toMatchObject({ type: 'reply', agent: 'ui-cards', text: 'use the brand green' })
  })
  it('ambiguous names ask', () => {
    expect(findAgent(agents, 'ui')).toBe('ambiguous')
    expect(instant('pause ui', agents)!.say).toMatch(/More than one/)
  })
  it('pause with a time, ideas, memory', () => {
    expect(instant('pause walmart until 18:30', agents)!.actions[0]).toMatchObject({ type: 'pause', agent: 'scraper-walmart', text: '18:30' })
    expect(instant('idea: add Costco to store types', agents)!.actions[0]).toMatchObject({ type: 'idea', text: 'add Costco to store types' })
    expect(instant('remember that the scraper only runs on the home server', agents)!.actions[0].type).toBe('remember')
    remember('the scraper only runs on the home server')
    expect(memory()).toMatch(/home server/)
  })
  it('anything else goes to Claude', () => {
    expect(instant("what's the weather in Dallas", agents)).toBeNull()
    expect(instant('pause the UI agents', agents)).toBeNull()
  })
  it('summary when quiet', () => expect(summary([])).toBe('Nothing needs you right now.'))
})

describe('conversations and approvals', () => {
  it('reuses the active conversation and starts fresh on request', () => {
    const t1 = threadFor()
    addMessage(t1, 'you', 'where are we on the Target scraper?')
    expect(threadFor().id).toBe(t1.id)
    expect(threads()[0]).toMatchObject({ id: t1.id, title: 'where are we on the Target scraper?' })
    const t2 = newThread()
    expect(t2.id).not.toBe(t1.id)
    expect(threadFor(t1.id).id).toBe(t1.id)
    expect(messages(t1.id)).toHaveLength(1)
  })
  it('agent changes wait for a yes', () => {
    const t = newThread()
    const p = propose(t.id, { type: 'start', agent: '', text: 'fix Walmart pagination', key: '', tool: 'claude', model: '', effort: '', list: '', name: '' })
    expect(p.summary).toBe('Start a Claude agent: “fix Walmart pagination”')
    expect(pendingProposals(t.id)).toHaveLength(1)
    settleProposal(p.id, 'approved', 'started walmart-fix')
    expect(pendingProposals(t.id)).toHaveLength(0)
    expect(summarize({ type: 'key', agent: 'scraper', key: '1' } as any)).toBe('Press 1 in scraper')
  })
  it('understands yes and no', () => {
    for (const y of ['yes', 'Yeah.', 'do it', 'go ahead', 'sure', 'approve it', 'yes please']) expect(approvalWord(y)).toBe('yes')
    for (const n of ['no', 'Nope', 'cancel', 'never mind']) expect(approvalWord(n)).toBe('no')
    expect(approvalWord('yes and also check the logs')).toBeNull()
  })
})

describe('ranking requests', () => {
  it('recognises asking what to do next', () => {
    for (const q of ['what should I do next?', 'rank my notes', 'prioritize my ideas', 'sort my notes by what is important', "what's most important"]) expect(wantsRanking(q)).toBe(true)
    for (const q of ['what needs me?', 'idea: rank the retailers', 'tell walmart yes']) expect(wantsRanking(q)).toBe(false)
  })
})
