// Jarvis's voice, made on the Mac and played on whatever device asked:
//   kokoro: natural open-weight voices (`fleet tts install`), kept loaded in one Python process
//   mac:    macOS `say` (Premium/Enhanced voices sound good once downloaded in System Settings → Spoken Content)
// Audio is converted to AAC (small over Tailscale) and cached by text+voice+speed.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { FLEET_DIR } from './store.ts'
import { run } from './tmux.ts'

const TTS_DIR = join(FLEET_DIR, 'tts')
const CACHE = join(TTS_DIR, 'cache')
const PY = join(TTS_DIR, 'venv', 'bin', 'python')
const SCRIPT = join(import.meta.dirname, '..', 'tts', 'kokoro_server.py')

export const kokoroInstalled = () => existsSync(PY) && existsSync(join(TTS_DIR, 'kokoro-v1.0.onnx')) && existsSync(join(TTS_DIR, 'voices-v1.0.bin'))

let proc: ChildProcessWithoutNullStreams | null = null
let ready: Promise<string[]> | null = null
const waiting: ((r: { ok?: boolean; error?: string }) => void)[] = []

function kokoro(): Promise<string[]> {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    proc = spawn(PY, [SCRIPT], { env: { ...process.env, FLEET_TTS_DIR: TTS_DIR } })
    const lines = createInterface({ input: proc.stdout })
    let first = true
    lines.on('line', line => {
      let msg: any
      try { msg = JSON.parse(line) } catch { return }
      if (first) { first = false; return resolve(msg.voices ?? []) }
      waiting.shift()?.(msg)
    })
    proc.stderr.on('data', () => {}) // onnxruntime chatter
    proc.on('exit', () => { proc = null; ready = null; while (waiting.length) waiting.shift()!({ error: 'voice process stopped' }) })
    setTimeout(() => reject(new Error('voice model took too long to load')), 30_000)
  })
  ready.catch(() => { ready = null })
  return ready
}

let queue = Promise.resolve()
const serial = <T,>(f: () => Promise<T>) => { const p = queue.then(f, f); queue = p.then(() => {}, () => {}); return p }

export type VoiceList = { kokoro: string[] | null; mac: string[] }

export async function voices(): Promise<VoiceList> {
  const mac = (await run('say', ['-v', '?']).catch(() => '')).split('\n')
    .map(l => l.match(/^(.+?)\s{2,}(en_[A-Z]{2})\s/)).filter(Boolean)
    .map(m => m![1].trim())
    .filter(n => !/^(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Zarvox|Junior|Ralph|Fred|Albert|Kathy)$/.test(n))
  return { kokoro: kokoroInstalled() ? await kokoro().catch(() => null) : null, mac }
}

function prune() {
  const files = readdirSync(CACHE).map(f => ({ f, t: statSync(join(CACHE, f)).mtimeMs })).sort((a, b) => b.t - a.t)
  for (const { f } of files.slice(80)) rmSync(join(CACHE, f), { force: true })
}

/** Path to an .m4a of `text` spoken in the chosen voice. */
export async function speech(text: string, engine: string, voice: string, speed: number): Promise<string> {
  mkdirSync(CACHE, { recursive: true })
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200)
  const key = createHash('sha1').update(`${engine}|${voice}|${speed}|${clean}`).digest('hex').slice(0, 20)
  const out = join(CACHE, `${key}.m4a`)
  if (existsSync(out)) return out
  const raw = join(CACHE, `${key}.${engine === 'mac' ? 'aiff' : 'wav'}`)
  if (engine === 'mac') {
    await run('say', [...(voice ? ['-v', voice] : []), '-r', String(Math.round(185 * speed)), '-o', raw, '--', clean])
  } else {
    await kokoro()
    const r = await serial(() => new Promise<{ ok?: boolean; error?: string }>(resolve => {
      waiting.push(resolve)
      proc!.stdin.write(JSON.stringify({ text: clean, voice, speed, out: raw }) + '\n')
    }))
    if (!r.ok) throw new Error(r.error ?? 'speech failed')
  }
  await run('afconvert', ['-f', 'mp4f', '-d', 'aac', '-b', '64000', raw, out])
  rmSync(raw, { force: true })
  prune()
  return out
}
