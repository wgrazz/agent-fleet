// Shared: anything sent to Fleet with a link in it (mostly reels from the "Save to Fleet" share sheet) is filed in the
// Shared list and gets its own agent that watches it: yt-dlp keeps the video and caption, ffmpeg pulls frames, whisper.cpp
// writes down what's said, and a Claude session looks at all of it and gives its take (what it is, whether it's worth
// doing, an answer to whatever you typed with it). That session stays open, so its page in Team → Shared is a
// conversation about that one post, with the video at the top.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { askFull } from './ai.ts'
import * as ideas from './ideas.ts'
import { pushAll } from './push.ts'
import { db, FLEET_DIR } from './store.ts'

export const LIST = 'Shared'
export const link = (text: string) => text.match(/https?:\/\/[^\s]+/)?.[0]

db.exec(`CREATE TABLE IF NOT EXISTS shares (id INTEGER PRIMARY KEY, url TEXT NOT NULL, sent TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS share_messages (id INTEGER PRIMARY KEY, share_id INTEGER NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`)

// a run cut short by a restart: a watch starts over from the page, a chat keeps its conversation
db.exec(`UPDATE shares SET status = 'error', error = 'Fleet restarted while it was watching' WHERE status = 'watching';
UPDATE shares SET status = 'ready' WHERE status = 'thinking'`)

export type Share = { id: number; url: string; sent: string; status: 'watching' | 'thinking' | 'ready' | 'error'; error: string; session_id: string; title: string; verdict: string; created_at: number; updated_at: number }
const now = () => Math.floor(Date.now() / 1000)
const run = promisify(execFile)
const WHISPER = join(homedir(), '.cache', 'whisper-cpp', 'ggml-small.bin')
const MODEL = 'sonnet'
export const dir = (id: number) => join(FLEET_DIR, 'shares', String(id))
export const video = (id: number) => join(dir(id), 'video.mp4')

export const share = (id: number) => db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as Share | undefined
/** Shares whose note still exists, newest first. */
export const shares = () => db.prepare('SELECT s.* FROM shares s JOIN ideas i ON i.id = s.id ORDER BY s.created_at DESC LIMIT 200').all() as Share[]
export const page = (id: number) => {
  const s = share(id)
  return s && { share: { ...s, video: existsSync(video(id)), note: ideas.idea(id) ?? null }, messages: db.prepare('SELECT * FROM share_messages WHERE share_id = ? ORDER BY id').all(id) }
}
const set = (id: number, p: Partial<Share>) => {
  for (const [k, v] of Object.entries({ ...p, updated_at: now() })) db.prepare(`UPDATE shares SET ${k} = ? WHERE id = ?`).run(v as string, id)
}
const say = (id: number, who: 'you' | 'bot', text: string) =>
  db.prepare('INSERT INTO share_messages (share_id, who, text, at) VALUES (?, ?, ?, ?)').run(id, who, text, now())

/** Download the post into its folder: video, frames, transcript. Pages and photo posts just come back with less; never throws. */
async function watch(id: number, url: string) {
  const d = dir(id)
  rmSync(d, { recursive: true, force: true })
  mkdirSync(join(d, 'frames'), { recursive: true })
  const post = { by: '', title: '', caption: '', said: '', frames: 0, every: 0 }
  try {
    const { stdout } = await run('yt-dlp', ['-j', '--no-simulate', '--no-playlist', '-q', '-f', 'b[ext=mp4]/b', '-o', video(id), '--socket-timeout', '20', url], { timeout: 300_000, maxBuffer: 64 << 20 })
    const m = JSON.parse(stdout.trim().split('\n').pop()!)
    Object.assign(post, { by: m.uploader ?? '', title: m.title ?? '', caption: m.description ?? '' })
    // about 12 frames spread over the video, at most one a second
    const secs = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video(id)])).stdout) || 30
    post.every = Math.max(1, Math.round(secs / 12))
    await run('ffmpeg', ['-loglevel', 'error', '-i', video(id), '-vf', `fps=1/${post.every},scale=512:-2`, '-frames:v', '16', join(d, 'frames', '%02d.jpg')], { timeout: 120_000 })
    post.frames = readdirSync(join(d, 'frames')).length
    if (existsSync(WHISPER)) {
      await run('ffmpeg', ['-loglevel', 'error', '-y', '-i', video(id), '-ar', '16000', '-ac', '1', join(d, 'audio.wav')], { timeout: 120_000 })
      post.said = (await run('whisper-cli', ['-m', WHISPER, '-f', join(d, 'audio.wav'), '-nt', '-np'], { timeout: 600_000, maxBuffer: 16 << 20 })).stdout.trim()
      rmSync(join(d, 'audio.wav'), { force: true })
    }
  } catch {} // whatever we got is enough; with nothing, the agent reads the link itself
  return post
}

type Take = { title: string; verdict: 'worth doing' | 'maybe' | 'skip' | 'just a note'; why: string; take: string }
const str = { type: 'string' }
const TAKE = {
  type: 'object', additionalProperties: false, required: ['title', 'verdict', 'why', 'take'],
  properties: { title: str, verdict: { type: 'string', enum: ['worth doing', 'maybe', 'skip', 'just a note'] }, why: str, take: str },
}
const REPLY = { type: 'object', additionalProperties: false, required: ['reply'], properties: { reply: str } }
const LABEL: Record<Take['verdict'], string> = { 'worth doing': '✅', maybe: '🤔', skip: '⛔', 'just a note': '📝' }

const SYSTEM = `You are the owner's agent for one thing they shared to their inbox, usually an Instagram reel, sometimes a TikTok,
video or web page. You've watched it so they don't have to rewatch it, and afterwards they come back to talk with you about it.
You get what they typed when they shared it, the caption, a transcript of what's said, and frames from the video saved in
./frames (look at them with Read: on-screen text, the app or product shown, the setting). If there's no video, read the link.
Check claims that matter (a tool's real name, price, GitHub stars, whether it does what it says) on the web; be brief.
You also get their open notes, so you know what they're working on.
Plain words, no hype. Markdown is fine: short paragraphs and lists, no headings.`

const FIRST = `First Read every frame in ./frames (several Read calls at once is fine), so you know what it looks like, not just what's said.
Then give your take:
- title: what this is, under 60 characters, e.g. "Voicebox: free local ElevenLabs alternative".
- verdict: "worth doing" (act on it), "maybe", "skip" (hype, wrong, or not for them), or "just a note" (good to know).
- why: one sentence, tied to what they're working on when it fits.
- take: your message to them, about 120 to 250 words. Start with what the post actually says and shows (name the tool,
  product or person; what's on screen when it matters), so they get the feel of it without rewatching. Then, if they
  asked or said something when they shared it, answer that directly. Then caveats you found and, if it's worth doing,
  concrete next steps.`

const openNotes = () => (db.prepare(`SELECT list, text FROM ideas WHERE done = 0 AND list != ? AND text NOT LIKE '## %' ORDER BY priority DESC, id DESC LIMIT 60`).all(LIST) as { list: string; text: string }[])
  .map(n => `- [${n.list}] ${n.text.slice(0, 160).replace(/\n/g, ' ')}`).join('\n')
const ask = <T,>(id: number, task: string, schema: Record<string, unknown>, resume = '') =>
  askFull<T>(task, SYSTEM, schema, { tools: ['Read', 'WebSearch', 'WebFetch'], deny: ['Read(**/.env*)'], cwd: dir(id), model: MODEL, budgetUsd: 1, timeoutMs: 5 * 60_000, feature: 'share', persist: true, resume: resume || undefined })

/** Watch a shared note's link and give a first take. Running it again starts the conversation over. */
export async function breakDown(id: number) {
  // the first take renames the note, so a second watch goes by what was first sent
  const it = ideas.idea(id), old = share(id)
  const sent = old?.sent || it?.text || '', url = old?.url || link(sent)
  if (!it || !url || old?.status === 'watching' || old?.status === 'thinking') return
  db.prepare("INSERT INTO shares (id, url, sent, status, created_at, updated_at) VALUES (?, ?, ?, 'watching', ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'watching', error = '', session_id = ''").run(id, url, sent, now(), now())
  db.prepare('DELETE FROM share_messages WHERE share_id = ?').run(id)
  try {
    const post = await watch(id, url)
    const task = [`They shared: ${sent}`, `Link: ${url}`, post.by && `Posted by: ${post.by}`, post.title && `Title: ${post.title}`,
      post.caption && `Caption: ${post.caption.slice(0, 3000)}`, post.said ? `Transcript: ${post.said.slice(0, 12_000)}` : '(no transcript)',
      post.frames ? `Frames: ${post.frames} in ./frames, one every ${post.every} s (01.jpg first).` : '(no video frames)',
      `Their open notes:\n${openNotes() || '(none)'}`, FIRST].filter(Boolean).join('\n\n')
    const a = await ask<Take>(id, task, TAKE)
    const t = a.value
    say(id, 'bot', `**${LABEL[t.verdict]} ${t.verdict[0].toUpperCase()}${t.verdict.slice(1)}:** ${t.why}\n\n${t.take}`)
    set(id, { status: 'ready', session_id: a.session_id, title: t.title, verdict: t.verdict })
    // the note says it too, so it reads well in the Shared list and the chief of staff sees it
    ideas.updateIdea(id, { text: `${LABEL[t.verdict]} ${t.title}`, notes: [`${t.verdict[0].toUpperCase()}${t.verdict.slice(1)}: ${t.why}`, t.take, `Sent: ${sent}`].join('\n\n') })
    await pushAll({ title: `${LABEL[t.verdict]} ${t.title}`, body: t.why, url: `/#/team/shared/${id}`, tag: `share-${id}` }).catch(() => {})
  } catch (e) {
    set(id, { status: 'error', error: (e as Error).message.slice(0, 500) })
  }
}

/** Ask a share's agent something. It answers in the same session, with the post still in mind. */
export async function chat(id: number, text: string) {
  const s = share(id)
  if (!s) throw new Error('no such share')
  if (s.status === 'watching' || s.status === 'thinking') throw new Error('it’s still working on the last one')
  say(id, 'you', text)
  set(id, { status: 'thinking', error: '' })
  try {
    const a = await ask<{ reply: string }>(id, `${text}\n\n(Reply in "reply". Look at ./frames or the web again if it helps.)`, REPLY, s.session_id)
    say(id, 'bot', a.value.reply)
    set(id, { status: 'ready', session_id: a.session_id || s.session_id })
  } catch (e) {
    set(id, { status: s.session_id ? 'ready' : 'error', error: (e as Error).message.slice(0, 500) })
  }
}
