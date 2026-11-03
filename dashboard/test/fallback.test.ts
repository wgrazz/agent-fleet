// Settings → AI order: Claude first by default; Codex then Cursor answer when it's out. The CLIs are faked.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

process.env.FLEET_DIR = mkdtempSync(join(tmpdir(), 'fleet-fallback-'))
const calls: { bin: string; args: string[] }[] = []
let outputs: any[] = []
vi.mock('node:child_process', () => ({ execFile: (bin: string, args: string[], _opts: any, cb: any) => {
  calls.push({ bin, args })
  const next = outputs.shift()
  if (!next) throw new Error(`unexpected ${bin} call`)
  if (next.codex) writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(next.codex))
  cb(next.error ?? null, next.raw ?? JSON.stringify(next.body ?? {}), next.stderr ?? '')
  return { stdin: { end() {} } }
} }))

const schema = { type: 'object', required: ['reply'], additionalProperties: false, properties: { reply: { type: 'string' } } }
const ok = { body: { structured_output: { reply: 'ok' }, usage: { output_tokens: 10 }, total_cost_usd: 0.01 } }
const limited = { body: { is_error: true, result: "You've hit your session limit · resets 10pm (America/New_York)", usage: { output_tokens: 0 }, num_turns: 1 } }
const codexOut = { raw: '{"type":"error","message":"You’ve hit your usage limit. Try again at 8:56 PM."}', error: { code: 1 } }
let ai: typeof import('../server/ai.ts'), config: typeof import('../server/store.ts').config

beforeEach(async () => {
  vi.resetModules() // forget who is out between tests
  ai = await import('../server/ai.ts')
  config = (await import('../server/store.ts')).config
  delete config.ai_order
  calls.length = 0
  outputs = []
})

it('by default only Claude runs, exactly as before', async () => {
  outputs = [ok]
  expect(await ai.askFull('hi', 'sys', schema, { tools: ['Read'], deny: ['Read(**/.env*)'] })).toMatchObject({ provider: 'claude', value: { reply: 'ok' } })
  expect(calls.map(c => c.bin)).toEqual(['claude'])
  expect(calls[0].args).toEqual(expect.arrayContaining(['--strict-mcp-config', 'Read(**/.env*)']))
})

it('Claude out, Codex out, Cursor answers; the next call skips the two until they reset', async () => {
  outputs = [limited, codexOut, { body: { result: 'Reading it now. {"reply":"from cursor"}' } }]
  expect(await ai.askFull('hi', 'sys', schema)).toMatchObject({ provider: 'cursor', value: { reply: 'from cursor' } })
  expect(calls.map(c => c.bin)).toEqual(['claude', 'codex', 'cursor-agent'])
  expect(calls[1].args).toContain('features.shell_tool=false') // no shell for Codex
  expect(calls[2].args).not.toContain('--force')
  expect(Object.keys(ai.aiStatus())).toEqual(['claude', 'codex'])
  outputs = [{ body: { result: '{"reply":"again"}' } }]
  await ai.askFull('again', 'sys', schema)
  expect(calls.at(-1)!.bin).toBe('cursor-agent')
  expect(calls).toHaveLength(4)
})

it('the order comes from Settings, and history reaches the fallback', async () => {
  config.ai_order = ['codex', 'claude']
  outputs = [{ raw: '{"type":"turn.completed"}', codex: { reply: 'codex first' } }]
  expect(await ai.askFull('and now?', 'sys', schema, { history: 'you: my project is Fleet' })).toMatchObject({ provider: 'codex' })
  expect(calls.at(-1)!.args.at(-1)).toContain('my project is Fleet')
})

it('everyone out: the error keeps the limit message, so Team and shares can retry at the reset', async () => {
  const { limitReset } = await import('../server/detect.ts')
  config.ai_order = ['claude']
  outputs = [limited]
  const err = await ai.askFull('hi', 'sys', schema).catch(e => e as Error)
  expect(limitReset((err as Error).message)).toBeGreaterThan(Date.now())
  await expect(ai.askFull('hi', 'sys', schema)).rejects.toThrow('hit your session limit') // still out: no second call
  expect(calls).toHaveLength(1)
})

it("a role that may have written files isn't handed to another AI, and real errors aren't either", async () => {
  outputs = [{ body: { ...limited.body, usage: { output_tokens: 300 }, num_turns: 4 } }]
  await expect(ai.askFull('write', 'sys', schema, { tools: ['Write'] })).rejects.toThrow('hit your session limit')
  outputs = [{ body: { is_error: true, result: 'Prompt is too long' } }]
  await expect(ai.askFull('hi', 'sys', schema)).rejects.toThrow('Prompt is too long')
  expect(calls.map(c => c.bin)).toEqual(['claude', 'claude'])
})
