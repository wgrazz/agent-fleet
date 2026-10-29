// Shared: anything sent to Fleet with a link in it (mostly reels from the "Save to Fleet" share sheet) is filed in the
// Shared list and broken down in the background: what it is, whether it's worth doing, and notes, written into the note.
// A video's caption comes from yt-dlp and what's said in it from whisper.cpp; a page or claim is read and checked on the web.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { askFull } from './ai.ts'
import * as ideas from './ideas.ts'
import { pushAll } from './push.ts'
import { db } from './store.ts'

export const LIST = 'Shared'
export const link = (text: string) => text.match(/https?:\/\/[^\s]+/)?.[0]

const run = promisify(execFile)
const WHISPER = join(homedir(), '.cache', 'whisper-cpp', 'ggml-small.bin')

/** The post's title, caption and spoken words. Pages and photo posts just come back with less; never throws. */
async function read(url: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-share-'))
  try {
    const { stdout } = await run('yt-dlp', ['-j', '--no-simulate', '--no-playlist', '-q', '-f', 'bestaudio/best', '-o', join(dir, 'a.media'), '--socket-timeout', '20', url], { timeout: 180_000, maxBuffer: 64 << 20 })
    const m = JSON.parse(stdout.trim().split('\n').pop()!)
    let said = ''
    if (existsSync(WHISPER)) {
      await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 'a.media'), '-ar', '16000', '-ac', '1', join(dir, 'a.wav')], { timeout: 120_000 })
      said = (await run('whisper-cli', ['-m', WHISPER, '-f', join(dir, 'a.wav'), '-nt', '-np'], { timeout: 600_000, maxBuffer: 16 << 20 })).stdout.trim()
    }
    return { by: m.uploader ?? '', title: m.title ?? '', caption: m.description ?? '', said }
  } catch {
    return { by: '', title: '', caption: '', said: '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Breakdown = { title: string; verdict: 'worth doing' | 'maybe' | 'skip' | 'just a note'; why: string; summary: string; answer: string; notes: string[] }
const str = { type: 'string' }
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'verdict', 'why', 'summary', 'answer', 'notes'],
  properties: { title: str, verdict: { type: 'string', enum: ['worth doing', 'maybe', 'skip', 'just a note'] }, why: str, summary: str, answer: str, notes: { type: 'array', items: str } },
}
const SYSTEM = `The owner shared something to their inbox (usually an Instagram reel, sometimes a TikTok, video or page) and wants
it broken down so they don't have to rewatch it. You get what they typed with it, the post's caption and transcript when
there is one, and their open notes so you know what they're working on. If there's no transcript, read the link yourself.
Check claims that matter (a tool's real name, price, GitHub stars, whether it does what it says) on the web; be brief.
Answer with:
- title: what this is, in under 60 characters, e.g. "Voicebox: free local ElevenLabs alternative".
- verdict: "worth doing" (act on it), "maybe", "skip" (hype, wrong, or not for them), or "just a note" (good to know, nothing to do).
- why: one sentence, tied to what they're working on when it fits.
- summary: what the post actually says or shows, in 2 to 4 plain sentences. Name the tool, product or person.
- answer: if they asked something ("is this true?", "UX improvements?"), answer it directly; else "".
- notes: 0 to 5 short lines: takeaways, caveats you found, and concrete next steps if it's worth doing.
Plain words, no hype, no markdown.`

const LABEL: Record<Breakdown['verdict'], string> = { 'worth doing': '✅', maybe: '🤔', skip: '⛔', 'just a note': '📝' }

/** Break down one shared note and write the result into it. Failures go in its notes too, so the note says why. */
export async function breakDown(id: number) {
  const it = ideas.idea(id)
  const url = it && link(it.text)
  if (!it || !url) return
  const post = await read(url)
  const open = (db.prepare(`SELECT list, text FROM ideas WHERE done = 0 AND list != ? AND text NOT LIKE '## %' ORDER BY priority DESC, id DESC LIMIT 60`).all(LIST) as { list: string; text: string }[])
    .map(n => `- [${n.list}] ${n.text.slice(0, 160).replace(/\n/g, ' ')}`).join('\n')
  const task = [`They sent: ${it.text}`, `Link: ${url}`, post.by && `Posted by: ${post.by}`, post.title && `Title: ${post.title}`,
    post.caption && `Caption: ${post.caption.slice(0, 3000)}`, post.said ? `Transcript: ${post.said.slice(0, 12_000)}` : '(no transcript)',
    `Their open notes:\n${open || '(none)'}`].filter(Boolean).join('\n\n')
  try {
    const { value: b } = await askFull<Breakdown>(task, SYSTEM, SCHEMA, { tools: ['WebSearch', 'WebFetch'], model: 'sonnet', budgetUsd: 1, timeoutMs: 5 * 60_000, feature: 'share' })
    ideas.updateIdea(id, {
      text: `${LABEL[b.verdict]} ${b.title}`,
      notes: [`${b.verdict[0].toUpperCase()}${b.verdict.slice(1)}: ${b.why}`, b.summary, b.answer && `You asked: ${b.answer}`,
        b.notes.map(n => `- ${n}`).join('\n'), `Sent: ${it.text}`, it.notes].filter(Boolean).join('\n\n'),
    })
    await pushAll({ title: `${LABEL[b.verdict]} ${b.title}`, body: b.why, url: `/#/idea/${id}`, tag: `share-${id}` }).catch(() => {})
  } catch (e) {
    ideas.updateIdea(id, { notes: [it.notes, `Couldn't break this down: ${(e as Error).message.slice(0, 300)}`].filter(Boolean).join('\n\n') })
  }
}
