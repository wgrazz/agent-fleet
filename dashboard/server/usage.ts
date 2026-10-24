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
