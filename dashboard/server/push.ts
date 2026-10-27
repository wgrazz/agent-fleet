// Web push to the phone (and any browser that subscribed). Keys live in ~/.fleet/vapid.json, never in the repo.
import webpush from 'web-push'
import type { Agent } from './state.ts'
import { db, readSecret } from './store.ts'

const vapid = readSecret('vapid.json', () => webpush.generateVAPIDKeys())
// Safari rejects an https://localhost subject, so point at the project instead
webpush.setVapidDetails('https://github.com/wgrazz/agent-fleet', vapid.publicKey, vapid.privateKey)

export const publicKey = vapid.publicKey

export function subscribe(sub: { endpoint?: unknown }) {
  if (typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) throw new Error('not a push subscription')
  db.prepare('INSERT INTO push_subs (endpoint, sub) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub')
    .run(sub.endpoint, JSON.stringify(sub))
}

const TITLE = { needs_you: 'needs you', done: 'is done', crashed: 'crashed' } as Record<string, string>

export async function notify(a: Agent) {
  const body = (a.message || a.exit || a.last_line || a.task).slice(0, 120)
  return pushAll({ title: `${a.name} ${TITLE[a.status] ?? a.status}`, body, url: `/#/agent/${a.name}`, tag: a.name })
}

/** A notification on every subscribed device. */
export async function pushAll(p: { title: string; body: string; url: string; tag: string }) {
  const payload = JSON.stringify(p)
  const subs = db.prepare('SELECT endpoint, sub FROM push_subs').all() as { endpoint: string; sub: string }[]
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(JSON.parse(s.sub), payload)
    } catch (e: any) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint)
      else console.error('push failed:', e.statusCode ?? '', e.body ?? e.message)
    }
  }))
}
