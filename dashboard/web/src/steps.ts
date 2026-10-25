// An agent's reply as checklist steps: each top-level list item is a step, and whatever sits under it
// (sub-bullets, indented text, code blocks) becomes that step's notes. The first heading names the plan.
export type Step = { text: string; notes: string }

const ITEM = /^(\s*)(?:[-*•+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/
const HEADING = /^\s*(?:#{1,6}\s+(.+?)\s*#*|\*\*([^*]+)\*\*:?)\s*$/
const FENCE = /^\s*```/

export function planSteps(text: string): { title: string; steps: Step[] } {
  const steps: { text: string; notes: string[] }[] = []
  let title = '', base = -1, fence = false, blank = false
  let cur: (typeof steps)[number] | null = null
  const strip = (l: string) => l.replace(new RegExp(`^ {0,${base + 3}}`), '')
  for (const line of text.split('\n')) {
    if (fence || FENCE.test(line)) {
      if (FENCE.test(line)) fence = !fence
      cur?.notes.push(strip(line))
      continue
    }
    if (!line.trim()) { blank = true; cur?.notes.push(''); continue }
    const h = line.match(HEADING)
    const m = !h && line.match(ITEM)
    if (h) { title ||= (h[1] ?? h[2]).replace(/[:.]$/, ''); cur = null }
    else if (m && (base < 0 || m[1].length <= base + 1)) {
      if (base < 0) base = m[1].length
      cur = { text: m[2].replace(/\*\*|__/g, '').trim(), notes: [] }
      steps.push(cur)
    } else if (cur && (!blank || /^\s/.test(line))) cur.notes.push(strip(line))
    else cur = null
    blank = false
  }
  return { title, steps: steps.map(s => ({ text: s.text, notes: s.notes.join('\n').replace(/\n{3,}/g, '\n\n').trim() })) }
}
