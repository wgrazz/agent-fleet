// Reads an agent's screen and guesses what it is doing. Patterns come from real captures in test/fixtures/;
// when a guess is wrong in practice, save that screen as a new fixture and adjust the table here.

export type Status = 'working' | 'needs_you' | 'done' | 'crashed' | 'unknown'
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

const tail = (screen: string, n = 15) => screen.split('\n').filter(l => l.trim()).slice(-n).join('\n')

export function detect(tool: string, screen: string, msSinceChange: number): Exclude<Status, 'crashed' | 'unknown'> {
  const bottom = tail(screen)
  if (NEEDS.some(r => r.test(bottom))) return 'needs_you'
  if ((WORKING[tool] ?? []).some(r => r.test(bottom))) return 'working'
  // ponytail: no busy marker and a quiet screen means done; tools with idle animations would need an idle pattern
  return msSinceChange < 5000 ? 'working' : 'done'
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
