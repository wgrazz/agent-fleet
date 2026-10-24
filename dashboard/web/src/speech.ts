// Text helpers for Jarvis's voice: pure, so they're tested in test/jarvis.test.ts.

/** One transcript from a recognition's results. iOS sometimes repeats the whole phrase in each result instead of
 * adding to it, so a result that already contains what came before replaces it. */
export function joinResults(parts: string[]): string {
  return parts.reduce((acc, p) => (p.trim().startsWith(acc.trim()) ? p.trim() : `${acc} ${p.trim()}`), '').trim()
}

/** Sentences grouped into chunks of about 160 characters: the first one is made and playing while the rest are made. */
export function speechChunks(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text]
  const out: string[] = []
  for (const s of sentences) {
    if (out.length && out[out.length - 1].length + s.length <= 160 && out.length > 1) out[out.length - 1] += s
    else out.push(s)
  }
  return out.map(c => c.trim()).filter(Boolean)
}
