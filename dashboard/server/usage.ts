// Subscription limits per provider. Only real numbers: a provider that can't be read shows as unknown.
//   Claude: ~/.fleet/claude-usage.json, written by the statusline script from Claude Code's own rate_limits.
//   Codex:  the newest rollout log's token_count event (rate_limits.primary = 5 h, secondary = weekly).
//   Copilot: the "Plan: 3/200 (1% used)" counter Copilot prints, remembered from the last screen that showed it.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FLEET_DIR } from './store.ts'

export type Window = { label: string; pct: number; resets_at: number | null }
export type Usage = { tool: string; windows: Window[]; updated: number | null; note?: string }

const json = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// a window whose reset time has passed is back to zero, even if nothing has refreshed the number yet
const win = (label: string, pct: unknown, resets: unknown): Window | null => {
  if (typeof pct !== 'number') return null
  const r = typeof resets === 'number' ? resets : null
  return { label, pct: r && r * 1000 < Date.now() ? 0 : Math.round(pct), resets_at: r }
}

function claude(): Usage {
  const d = json(join(FLEET_DIR, 'claude-usage.json'))
  const rl = d?.rate_limits
  const windows = [win('5 hours', rl?.five_hour?.used_percentage, rl?.five_hour?.resets_at),
    win('Week', rl?.seven_day?.used_percentage, rl?.seven_day?.resets_at)].filter(Boolean) as Window[]
  return { tool: 'claude', windows, updated: d?.at ? d.at * 1000 : null, note: windows.length ? undefined : 'shows up after Claude Code runs once' }
}

let codexCache: { file: string; size: number; usage: Usage } | null = null

async function codex(): Promise<Usage> {
  let newest = '', newestM = 0
  for await (const f of glob(join(homedir(), '.codex', 'sessions', '*', '*', '*', 'rollout-*.jsonl'))) {
    const m = statSync(f).mtimeMs
    if (m > newestM) [newest, newestM] = [f, m]
  }
  if (!newest) return { tool: 'codex', windows: [], updated: null, note: 'no Codex sessions yet' }
  const size = statSync(newest).size
  if (codexCache?.file === newest && codexCache.size === size) return codexCache.usage
  let rl: any = null
  for (const line of readFileSync(newest, 'utf8').split('\n').reverse()) {
    if (!line.includes('"rate_limits"')) continue
    try {
      rl = JSON.parse(line).payload?.rate_limits
      if (rl) break
    } catch {}
  }
  const usage: Usage = {
    tool: 'codex', updated: newestM,
    windows: [win('5 hours', rl?.primary?.used_percent, rl?.primary?.resets_at), win('Week', rl?.secondary?.used_percent, rl?.secondary?.resets_at)]
      .filter(Boolean) as Window[],
  }
  codexCache = { file: newest, size, usage }
  return usage
}

const COPILOT_FILE = join(FLEET_DIR, 'copilot-usage.json')

/** Called with every Copilot screen the poller reads. */
export function noteCopilotScreen(screen: string) {
  const m = screen.match(/Plan: (\d+)\/(\d+) \((\d+)% used\)/)
  if (!m) return
  const prev = json(COPILOT_FILE)
  if (prev?.used === Number(m[1]) && prev?.total === Number(m[2])) return
  writeFileSync(COPILOT_FILE, JSON.stringify({ used: Number(m[1]), total: Number(m[2]), at: Date.now() }))
}

function copilot(): Usage {
  const d = json(COPILOT_FILE)
  if (!d) return { tool: 'copilot', windows: [], updated: null, note: 'shows up after a Copilot session' }
  return { tool: 'copilot', updated: d.at, windows: [{ label: `Month · ${d.used}/${d.total}`, pct: Math.round((100 * d.used) / d.total), resets_at: null }] }
}

export async function usage(): Promise<Usage[]> {
  return [claude(), await codex(), copilot(),
    { tool: 'cursor', windows: [], updated: null, note: "Cursor doesn't expose its limits" },
    { tool: 'agy', windows: [], updated: null, note: "Antigravity doesn't expose its limits" }]
}

// ---------- how much of the weekly Claude limit the dashboard's own AI uses ----------
// Claude reports the weekly window as a percentage, not dollars. So: add up what every Claude Code session
// cost this window (API-equivalent, from the transcripts' token counts), add the dashboard's one-shot calls
// (which leave no transcript), and give Jarvis its proportional share of the weekly percentage.

// $ per million tokens: input, output, cache read (cache writes are 1.25x input)
const PRICES: [RegExp, number, number, number][] = [
  [/fable|mythos/, 10, 50, 0.25], [/opus-5-5/, 4, 20, 0.2], [/opus/, 5, 25, 0.5],
  [/sonnet/, 2, 10, 0.2], [/haiku-5-5/, 0.1, 0.5, 0.01], [/haiku/, 1, 5, 0.1],
]

function messageCost(model: string, u: any) {
  const [, input, output, read] = PRICES.find(([re]) => re.test(model)) ?? PRICES[3]
  return ((u.input_tokens ?? 0) * input + (u.output_tokens ?? 0) * output + (u.cache_read_input_tokens ?? 0) * read
    + (u.cache_creation_input_tokens ?? 0) * input * 1.25) / 1e6
}

type FileCost = { offset: number; msgs: Map<string, { at: number; cost: number }> }
const fileCosts = new Map<string, FileCost>()

// one scan at a time: scans share each file's read position
let scanning: Promise<unknown> = Promise.resolve()
const transcriptCost = (sinceS: number) => { const r = scanning.then(() => scanTranscripts(sinceS)); scanning = r.catch(() => 0); return r }

async function scanTranscripts(sinceS: number) {
  const { open } = await import('node:fs/promises')
  let total = 0
  const files: string[] = []
  for (const pattern of ['*/*.jsonl', '*/*/subagents/*.jsonl'])
    for await (const f of glob(join(homedir(), '.claude', 'projects', pattern))) files.push(f)
  for (const f of files) {
    let st
    try { st = statSync(f) } catch { continue }
    if (st.mtimeMs / 1000 < sinceS) continue
    const fc = fileCosts.get(f) ?? { offset: 0, msgs: new Map() }
    if (st.size > fc.offset) {
      // read only what was appended since last time, in 64 MB pieces (one read can't pass 2 GB, and some logs are bigger)
      const fh = await open(f, 'r')
      const buf = Buffer.alloc(Math.min(st.size - fc.offset, 64 << 20))
      while (fc.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - fc.offset), fc.offset)
        const end = buf.subarray(0, bytesRead).lastIndexOf(10) + 1
        // ponytail: a single line longer than 64 MB is skipped; it's never a usage line in practice
        if (!end) { if (bytesRead < buf.length) break; fc.offset += bytesRead; continue }
        for (const line of buf.toString('utf8', 0, end).split('\n')) {
          if (!line.includes('"usage"')) continue
          try {
            const d = JSON.parse(line)
            const m = d.message
            if (d.type !== 'assistant' || !m?.usage) continue
            // one reply is logged once per content block with the same usage: count it once
            fc.msgs.set(m.id ?? d.uuid, { at: Date.parse(d.timestamp) / 1000, cost: messageCost(String(m.model ?? ''), m.usage) })
          } catch {}
        }
        fc.offset += end
      }
      await fh.close()
      fileCosts.set(f, fc)
    }
    for (const { at, cost } of fc.msgs.values()) if (at >= sinceS) total += cost
  }
  return total
}

export type AiBudget = { weekly_pct: number | null; jarvis_pct: number; ai_pct: number; jarvis_usd: number; ai_usd: number; claude_usd: number; warn_pct: number; max_pct: number; since: number }

export async function aiBudget(warnPct = 5, maxPct = 10): Promise<AiBudget> {
  const claudeUsage = json(join(FLEET_DIR, 'claude-usage.json'))?.rate_limits?.seven_day
  const resets = typeof claudeUsage?.resets_at === 'number' ? claudeUsage.resets_at : null
  const since = resets && resets * 1000 > Date.now() ? resets - 7 * 86400 : Math.floor(Date.now() / 1000) - 7 * 86400
  const { db } = await import('./store.ts')
  const sum = (where: string) => (db.prepare(`SELECT coalesce(sum(cost_usd), 0) AS c FROM ai_usage WHERE at >= ? ${where}`).get(since) as { c: number }).c
  const jarvis = sum("AND feature = 'jarvis'")
  const ai = sum('')
  const oneShot = sum('AND persisted = 0') // these leave no transcript, so add them to the total
  const claude = (await transcriptCost(since)) + oneShot
  const weekly = typeof claudeUsage?.used_percentage === 'number' ? claudeUsage.used_percentage : null
  const share = (x: number) => (weekly !== null && claude > 0 ? (weekly * x) / claude : 0)
  return { weekly_pct: weekly, jarvis_pct: share(jarvis), ai_pct: share(ai), jarvis_usd: jarvis, ai_usd: ai, claude_usd: claude, warn_pct: warnPct, max_pct: maxPct, since }
}
