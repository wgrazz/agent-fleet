// Fleet's fallback runtimes share these enforced file/lookup permissions. No shell strings.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

export type Policy = { cwd: string; tools: string[]; allow?: string[]; addDirs?: string[]; writeDir?: string; fleet: string; journal: string }
const run = promisify(execFile)
const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
const secret = (path: string) => path.split(/[\\/]/).some(p => /^\.env|^\.git$|^\.ssh$|^\.aws$|^\.codex$|^\.cursor$|^\.claude$|^auth\.json$|^config\.json$|\.(pem|key)$/i.test(p))
export function safePath(p: Policy, input: string, writing = false) {
  const path = resolve(p.cwd, input)
  if (secret(path)) throw new Error('Private configuration is not available to this tool')
  let ancestor = path
  while (!existsSync(ancestor)) { const next = dirname(ancestor); if (next === ancestor) throw new Error('Invalid path'); ancestor = next }
  const real = resolve(realpathSync(ancestor), relative(ancestor, path))
  if (writing && !inside(realpathSync(p.cwd), real)) throw new Error('Write is outside the working folder')
  const roots = writing ? (p.writeDir ? [p.writeDir] : []) : [p.cwd, ...(p.addDirs ?? [])]
  if (!roots.some(root => inside(realpathSync(root), real))) throw new Error('Path is outside the permitted folders')
  if (secret(real)) throw new Error('Private configuration is not available to this tool')
  return real
}
const text = (v: string) => ({ content: [{ type: 'text', text: v }] })
export async function callTool(p: Policy, name: string, a: Record<string, any>) {
  if (!p.tools.includes(name)) throw new Error(`Tool ${name} is not enabled`)
  if (name === 'Read') {
    const path = safePath(p, String(a.path))
    if (!statSync(path).isFile() || statSync(path).size > 8 << 20) throw new Error('Read needs a file smaller than 8 MB')
    const mime: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
    if (mime[extname(path)]) return { content: [{ type: 'image', mimeType: mime[extname(path)], data: readFileSync(path).toString('base64') }] }
    return text(readFileSync(path, 'utf8').slice(Math.max(0, Number(a.offset) || 0), Math.max(0, Number(a.offset) || 0) + 40_000))
  }
  if (name === 'Glob' || name === 'Grep') {
    const root = safePath(p, a.path || '.')
    const args = ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!.env*', root]
    const { stdout } = await run('rg', args, { maxBuffer: 8 << 20, timeout: 10_000 }).catch(e => { if (e.code === 1) return { stdout: '' }; throw e })
    const files = stdout.split('\n').filter(Boolean).filter(f => { try { safePath(p, f); return true } catch { return false } })
    if (name === 'Glob') return text(files.filter(f => !a.pattern || f.includes(a.pattern)).slice(0, 400).join('\n'))
    const hits: string[] = []
    for (const f of files.slice(0, 1000)) {
      if (statSync(f).size > 1 << 20) continue
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => { if (line.includes(String(a.pattern))) hits.push(`${f}:${i + 1}: ${line.slice(0, 500)}`) })
      if (hits.length >= 150) break
    }
    return text(hits.slice(0, 150).join('\n'))
  }
  if (name === 'Write' || name === 'Edit') {
    const path = safePath(p, String(a.path), true)
    let content = String(a.content ?? '')
    if (name === 'Edit') {
      const old = readFileSync(path, 'utf8'), find = String(a.old_text ?? '')
      if (!find || old.split(find).length !== 2) throw new Error('Edit must match exactly once')
      content = old.replace(find, String(a.new_text ?? ''))
    }
    if (content.length > 200_000) throw new Error('File too large')
    // Written BEFORE the side effect: a crash or failure must never trigger blind provider replay.
    appendFileSync(p.journal, JSON.stringify({ tool: name, path }) + '\n')
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content)
    return text('Saved')
  }
  if (name === 'Bash') {
    const argv = a.argv
    if (!Array.isArray(argv) || argv.some(x => typeof x !== 'string') || argv[0] !== 'fleet') throw new Error('Use argv beginning with fleet')
    const tail = argv.slice(1)
    const ok = (tail[0] === 'peek' && tail.length === 2 && /^[\w-]+$/.test(tail[1])) ||
      (tail[0] === 'read' && ((tail[1] === 'chat' && tail.length >= 3 && tail.length <= 4 && /^[\w-]+$/.test(tail[2])) || (tail.length >= 2 && tail.length <= 3 && /^\/api\/(agents|paused|history|transcript|ideas|lists|usage|roles)([/?]|$)/.test(tail[1])))) ||
      (tail[0] === 'mac' && ((['reminders', 'apps', 'screen'].includes(tail[1]) && tail.length === 2) ||
        (tail[1] === 'music' && tail[2] === 'now' && tail.length === 3) ||
        (tail[1] === 'calendar' && /^(today|tomorrow|week|\d{4}-\d{2}-\d{2})$/.test(tail[2]) && tail.length === 3)))
    if (!ok || !p.allow?.some(x => x.startsWith('Bash(fleet '))) throw new Error('Only Fleet read lookups are permitted')
    const out = await run(p.fleet, tail, { cwd: p.cwd, timeout: 20_000, maxBuffer: 2 << 20, env: { ...process.env, FLEET_NO_WAIT: '1' } })
    return text(out.stdout)
  }
  throw new Error('Unsupported tool')
}

const schemas: Record<string, Record<string, unknown>> = {
  Read: { path: { type: 'string' }, offset: { type: 'integer' } },
  Glob: { path: { type: 'string' }, pattern: { type: 'string', description: 'Optional substring of file path' } },
  Grep: { path: { type: 'string' }, pattern: { type: 'string', description: 'Literal text to find' } },
  Write: { path: { type: 'string' }, content: { type: 'string' } },
  Edit: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
  Bash: { argv: { type: 'array', items: { type: 'string' }, description: 'Arguments, for example ["fleet","read","/api/agents"]' } },
}
if (import.meta.main) {
  const policy: Policy = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const lines = createInterface({ input: process.stdin })
  // Sequential dispatch also preserves the write journal order.
  for await (const line of lines) {
    let q: any
    try {
      q = JSON.parse(line)
      if (q.id === undefined) continue
      let result: unknown
      if (q.method === 'initialize') result = { protocolVersion: q.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fleet-tools', version: '1.0.0' } }
      else if (q.method === 'ping') result = {}
      else if (q.method === 'tools/list') result = { tools: policy.tools.filter(n => schemas[n]).map(name => ({ name, annotations: { readOnlyHint: !['Write', 'Edit'].includes(name), destructiveHint: ['Write', 'Edit'].includes(name), openWorldHint: false }, description: `Fleet ${name}; paths are relative to ${policy.cwd}. Permissions are enforced.`, inputSchema: { type: 'object', properties: schemas[name] } })) }
      else if (q.method === 'tools/call') {
        try { result = await callTool(policy, q.params.name, q.params.arguments ?? {}) }
        catch (e) { result = { ...text((e as Error).message), isError: true } }
      } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\n')
    } catch { if (q?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, error: { code: -32603, message: 'Tool request failed' } }) + '\n') }
  }
}
