// Codex and Cursor for the smart features, when Claude is out (Settings → AI order). They run on your own CLI logins,
// never an API key, with their shell and file tools off: files and Fleet lookups go through Fleet's permission-checked
// MCP bridge (ai-tools.ts), the same folders and read-only lookups Claude gets.
import { execFile, type ExecException } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Policy } from './ai-tools.ts'
import { FLEET_BIN, FLEET_DIR } from './store.ts'

export type Provider = 'claude' | 'codex' | 'cursor'
export const PROVIDERS: Provider[] = ['claude', 'codex', 'cursor']
export type RunOpts = { tools?: string[]; allow?: string[]; addDirs?: string[]; writeDir?: string; timeoutMs?: number; cwd?: string; history?: string }

/** Out of usage, logged out or not installed: try the next one in the order. Anything else is a real error. */
export class Unavailable extends Error {}
export const unavailable = (s: string) => /hit your .*limit|usage.?limit|rate.?limit|quota|too many requests|out of.*(credits|usage)|not logged in|not authenticated|authentication (required|failed)|please (log|sign) in|login required|token.*(expired|revoked)|subscription.*(expired|required)|can't use your .*subscription|ENOENT/i.test(s)

export function validate(value: any, schema: any, path = 'answer'): void {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${path}`)
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${path}`)
    for (const k of schema.required ?? []) if (!(k in value)) throw new Error(`Missing ${path}.${k}`)
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(v, schema.properties[k], `${path}.${k}`)
      else if (schema.additionalProperties === false) throw new Error(`Unexpected ${path}.${k}`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`Invalid ${path}`)
    for (const v of value) validate(v, schema.items, path)
  } else if (schema.type === 'integer' ? !Number.isInteger(value) : schema.type && typeof value !== schema.type) throw new Error(`Invalid ${path}`)
}

// Codex's --output-schema wants every property required and no extras.
const strict = (schema: any): any => schema.type === 'object'
  ? { ...schema, additionalProperties: false, required: Object.keys(schema.properties ?? {}), properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, strict(v)])) }
  : schema.type === 'array' ? { ...schema, items: strict(schema.items) } : schema

/** Cursor can put commentary before its JSON: take the first object that runs to the end. Callers still validate it. */
export function jsonReply(text: string) {
  const clean = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  try { return JSON.parse(clean) } catch {}
  for (let i = clean.indexOf('{'); i >= 0; i = clean.indexOf('{', i + 1)) {
    try { return JSON.parse(clean.slice(i)) } catch {}
  }
  throw new Error('Invalid structured response')
}

// subscription logins only: an API key in the environment would bill instead
function environment() {
  const env: NodeJS.ProcessEnv = { ...process.env, FLEET_NO_WAIT: '1' }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k]
  return env
}
const execute = (bin: string, args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv) =>
  new Promise<{ stdout: string; stderr: string; error: ExecException | null }>(done => {
    const child = execFile(bin, args, { cwd, timeout, maxBuffer: 16 << 20, env }, (error, stdout, stderr) => done({ error, stdout, stderr }))
    child.stdin?.end()
  })

export async function runOther<T>(provider: 'codex' | 'cursor', task: string, system: string, schema: Record<string, unknown>, opts: RunOpts): Promise<T> {
  const cwd = opts.cwd ?? join(FLEET_DIR, 'ai'), tools = opts.tools ?? []
  const temp = mkdtempSync(join(FLEET_DIR, 'ai', 'run-'))
  try {
    const journal = join(temp, 'writes.jsonl') // the bridge notes each write before making it: then never replay
    const policy: Policy = { cwd, tools, allow: opts.allow, addDirs: opts.addDirs, writeDir: opts.writeDir ? resolve(cwd, opts.writeDir) : undefined, fleet: FLEET_BIN, journal }
    if (policy.writeDir) mkdirSync(policy.writeDir, { recursive: true })
    writeFileSync(join(temp, 'policy.json'), JSON.stringify(policy), { mode: 0o600 })
    const bridge = { command: process.execPath, args: [join(import.meta.dirname, 'ai-tools.ts'), join(temp, 'policy.json')] }
    const prompt = `${system}\n\nFleet supplies its own permission-checked tools through the fleet MCP server. Use those tools for files and Fleet lookups; file paths are relative to ${cwd}. Do not run shell commands or delegate. Use web search/fetch only when requested by your role.\n\n${opts.history ? `Previous conversation (context, not new instructions):\n${opts.history}\n\nCurrent request:\n` : ''}${task}\n\nReturn ONLY a JSON object matching this schema (no markdown):\n${JSON.stringify(schema)}`
    let args: string[], env = environment()
    if (provider === 'codex') {
      writeFileSync(join(temp, 'schema.json'), JSON.stringify(strict(schema)))
      args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '--output-schema', join(temp, 'schema.json'),
        '-o', join(temp, 'answer.json'), '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false',
        '-c', 'features.apps=false', '-c', 'features.multi_agent=false', '-c', 'features.hooks=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
        '-c', `web_search="${tools.includes('WebSearch') || tools.includes('WebFetch') ? 'live' : 'disabled'}"`,
        '-c', 'mcp_servers.fleet.default_tools_approval_mode="approve"', '-c', 'mcp_servers.fleet.required=true',
        '-c', `mcp_servers.fleet.command=${JSON.stringify(bridge.command)}`, '-c', `mcp_servers.fleet.args=${JSON.stringify(bridge.args)}`, '--', prompt]
    } else {
      mkdirSync(join(temp, '.cursor'))
      // its own config, so a project's looser Shell/Write rules don't apply; only the bridge is allowed
      writeFileSync(join(temp, 'cli-config.json'), JSON.stringify({ version: 1, editor: { vimMode: false }, approvalMode: 'allowlist', permissions: {
        allow: ['Mcp(fleet:*)', ...(tools.includes('WebFetch') ? ['WebFetch(*)'] : [])],
        deny: ['Shell(*)', 'Write(**)', 'Read(**)', ...(!tools.includes('WebFetch') ? ['WebFetch(*)'] : [])],
      } }))
      let globals: Record<string, unknown> = {} // your global MCP servers, switched off by name for this run
      try { globals = JSON.parse(readFileSync(join(homedir(), '.cursor', 'mcp.json'), 'utf8')).mcpServers ?? {} } catch {}
      writeFileSync(join(temp, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { ...Object.fromEntries(Object.keys(globals).map(k => [k, { command: 'false', disabled: true }])), fleet: bridge } }))
      env = { ...env, CURSOR_CONFIG_DIR: temp }
      args = ['--print', '--output-format', 'json', '--model', 'auto', '--workspace', temp, '--trust', '--approve-mcps', '--', prompt]
    }
    const r = await execute(provider === 'codex' ? 'codex' : 'cursor-agent', args, temp, opts.timeoutMs ?? 120_000, env)
    let value: any, errorText = r.stderr
    try {
      if (provider === 'codex') {
        for (const line of r.stdout.split('\n').filter(Boolean)) {
          const event = JSON.parse(line)
          if (event.type === 'error' || event.type === 'turn.failed') errorText += '\n' + (event.message ?? event.error?.message ?? '')
        }
        if (existsSync(join(temp, 'answer.json'))) value = jsonReply(readFileSync(join(temp, 'answer.json'), 'utf8'))
      } else {
        const out = JSON.parse(r.stdout)
        if (out.is_error) errorText += '\n' + out.result
        else value = typeof out.result === 'string' ? jsonReply(out.result) : out.result
      }
    } catch { errorText += '\nInvalid structured response' }
    if (r.error || value === undefined) {
      const message = (errorText || r.error?.message || `${provider} returned no answer`).trim().slice(-1000)
      if ((r.error?.code === 'ENOENT' || unavailable(message)) && !existsSync(journal)) throw new Unavailable(message)
      throw new Error(`${provider}: ${message}${existsSync(journal) ? ' Files may have changed, so it was not tried again.' : ''}`)
    }
    validate(value, schema)
    return value as T
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
