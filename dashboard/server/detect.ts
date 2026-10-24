// Reads an agent's screen and guesses what it is doing. Patterns come from real captures in test/fixtures/;
// when a guess is wrong in practice, save that screen as a new fixture and adjust the table here.

export type Status = 'working' | 'needs_you' | 'waiting' | 'done' | 'crashed' | 'unknown'
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

const tail = (screen: string, n = 15) => screen.split('\n').filter(l => l.trim()).slice(-n).join('\n')

export function detect(tool: string, screen: string, msSinceChange: number): Exclude<Status, 'crashed' | 'unknown'> {
  const bottom = tail(screen)
  if (NEEDS.some(r => r.test(bottom))) return 'needs_you'
  if ((WORKING[tool] ?? []).some(r => r.test(bottom))) return 'working'
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
