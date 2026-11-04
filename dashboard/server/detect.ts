// Reads an agent's screen and guesses what it is doing. Patterns come from real captures in test/fixtures/;
// when a guess is wrong in practice, save that screen as a new fixture and adjust the table here.

export type Status = 'working' | 'needs_you' | 'waiting' | 'ready' | 'done' | 'crashed' | 'unknown'
export type QuickReply = { key: string; label: string }

// Selection menus and confirm prompts, shared by every tool.
const NEEDS = [
  /↑\/↓/,
  /enter to (select|confirm)|enter continue|enter confirm/i,
  /use arrow keys/i,
  /\(y\/n\)|\[y\/n\]/i,
  /do you want to (proceed|make this edit|create|run)/i,
]

// What each tool shows while it is busy.
const WORKING: Record<string, RegExp[]> = {
  claude: [/^\s*[^\w\s]\s+[A-Z][\w-]*…/m, /esc to interrupt/],  // "✶ Catapulting… (4s · ↓ 24 tokens)"
  codex: [/esc to interrupt/],                                  // "• Working (12s • esc to interrupt)"
  cursor: [/ctrl\+c to stop/],
  copilot: [/esc interrupt/],                                   // "◉ Working · 194 B esc interrupt"
  agy: [/^\s*[⠀-⣿]+\s+\S/m, /esc to cancel/],                   // braille spinner "⡿  Running command..."
}

// Finished its turn but still has a background job running that will wake it again, e.g. Claude's footer
// "⏵⏵ auto mode on · 1 shell" while an `until …; do sleep 300; done` poll runs.
const BACKGROUND = /·\s*\d+\s+(shells?|background tasks?|monitors?)\b/i

/** How many background jobs the footer counts ("· 2 shells · 1 monitor" -> 3). */
export const backgroundCount = (screen: string) =>
  [...tail(screen, 4).matchAll(new RegExp(BACKGROUND, 'gi'))].reduce((n, m) => n + Number(m[0].match(/\d+/)![0]), 0)

const tail = (screen: string, n = 15) => screen.split('\n').filter(l => l.trim()).slice(-n).join('\n')

/** The tool's own busy marker is on screen (a spinner, "esc to interrupt"): real work, not just a redraw. */
export const busy = (tool: string, screen: string) => (WORKING[tool] ?? []).some(r => r.test(tail(screen)))

export function detect(tool: string, screen: string, msSinceChange: number): Exclude<Status, 'crashed' | 'unknown' | 'ready'> {
  const bottom = tail(screen)
  if (NEEDS.some(r => r.test(bottom))) return 'needs_you'
  if (busy(tool, screen)) return 'working'
  if (msSinceChange < 5000) return 'working'
  // ponytail: no busy marker and a quiet screen means done; tools with idle animations would need an idle pattern
  return BACKGROUND.test(tail(screen, 4)) ? 'waiting' : 'done'
}

export function quickReplies(screen: string): QuickReply[] {
  const bottom = tail(screen)
  if (!NEEDS.some(r => r.test(bottom))) return []
  const found: QuickReply[] = []
  for (const line of bottom.split('\n')) {
    const m = line.match(/^[\s│]*(?:[❯›>▶]\s*)?(?:([1-9])\.|\[([a-z])\])\s+(.+?)[\s│]*$/)
    if (m) found.push({ key: m[1] ?? m[2], label: m[3] })
  }
  return found
}

// The line a waiting agent is asking about: the last line with a question mark above its menu, else the line
// just above the menu.
export function question(screen: string): string {
  const lines = tail(screen, 25).split('\n').map(l => l.replace(/^[\s│╭╰─]+|[\s│╮╯─]+$/g, ''))
  const menu = lines.findIndex(l => /^(?:[❯›>▶]\s*)?(?:[1-9]\.|\[[a-z]\])\s/.test(l))
  const above = menu >= 0 ? lines.slice(0, menu) : lines
  return above.filter(l => l.includes('?')).at(-1) ?? above.filter(Boolean).at(-1) ?? ''
}

// The permission/edit mode the agent shows in its footer, e.g. Claude's "⏵⏵ auto mode on" or Copilot's
// "Interactive · Manual Approval". Shift+Tab cycles it in Claude, Copilot and Antigravity.
export function mode(screen: string): string {
  const bottom = tail(screen, 6)
  const m = bottom.match(/(auto mode|plan mode|accept edits|auto-accept edits|bypass permissions)\s+on/i)
    ?? bottom.match(/Interactive · ([A-Za-z ]+?)(?:\s{2,}|·|$)/m)
  return m ? m[1].trim() : ''
}

// What a busy agent is doing right now, from its spinner line ("Catapulting… (4s · ↓ 24 tokens)").
export function workingLine(tool: string, screen: string): string {
  const patterns = (WORKING[tool] ?? []).filter(r => !/esc to cancel/.test(r.source))
  const line = tail(screen).split('\n').reverse().find(l => patterns.some(r => r.test(l)))
  return line
    ? line.replace(/^[\s\W⠀-⣿]+/, '').replace(/\s*[•·]?\s*(esc to interrupt|esc interrupt|ctrl\+c to stop)\)?/i, ')').replace(/\(\)$/, '').replace(/\s+\)$/, ')').trim().slice(0, 90)
    : ''
}

// A subscription limit, as the tools print it: Claude "You've hit your session limit · resets 10pm (America/New_York)",
// Codex "You've hit your usage limit. Upgrade to Pro (…) or try again at 8:56 PM." (wrapped over several lines).
const LIMIT = /hit your [\w -]*limit(?: · resets|\..*try again at)/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// What picks up again after a limit resets, most important first, in minutes after the reset: agents, then Team, then shares.
export const AFTER_RESET = { agents: 2, roles: 5, shares: 8 }

/** When the limit in TEXT resets (epoch ms), or null if TEXT isn't a limit message. A time it can't read: 30 min after `from`.
 * ponytail: the Mac's own time zone, not the one in brackets; a weekday ("Mon 9am") reads as the next 9am, and the
 * retry every 30 min after a failed resume covers that. */
export function limitReset(text: string, from = Date.now()): number | null {
  const flat = text.replace(/\s+/g, ' ')
  if (!LIMIT.test(flat)) return null
  const when = flat.match(/(?:resets|try again at)\s+(.+)/i)?.[1] ?? ''
  const t = when.match(/\b(\d{1,2})(?::(\d\d))?\s*([ap])\.?m\b/i)
  if (!t) return from + 30 * 60_000
  const d = new Date(from)
  const md = when.match(/\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i) // "Nov 5", "Nov 3rd, 2026"
  const month = md ? MONTHS.indexOf(md[1].toLowerCase()) : -1
  if (month >= 0) d.setMonth(month, Number(md![2]))
  d.setHours(Number(t[1]) % 12 + (t[3].toLowerCase() === 'p' ? 12 : 0), Number(t[2] ?? 0), 0, 0)
  if (month < 0 && d.getTime() <= from) d.setDate(d.getDate() + 1) // "resets 1am" said at 11pm
  return d.getTime()
}

// The part of the screen above the agent's input box: what it's printing right now, for the chat's live view.
export function liveTail(screen: string, n = 20): string[] {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''))
  const border = (l: string) => /^[\s─━═╭╮╰╯│┃▄▀╻╹]+$/.test(l) && /[─━═▄▀]/.test(l)
  // drop everything from the input box down (Claude, Codex, Copilot and Antigravity all draw one at the bottom)
  let end = lines.length
  for (let i = lines.length - 1, seen = 0; i >= 0 && i > lines.length - 14; i--) if (border(lines[i]) && ++seen === 2) { end = i; break }
  // right-aligned lines are UI hints ("● high · /effort"), not output
  return lines.slice(0, end).filter(l => l.trim() && !border(l) && !/^\s{24,}\S/.test(l)).slice(-n)
}
