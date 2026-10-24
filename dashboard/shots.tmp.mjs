// screenshots through the DevTools protocol, in real time, with true phone emulation
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'
const [, , outDir, ...specs] = process.argv
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=9340', `--user-data-dir=${outDir}/chrome-prof`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
await sleep(1500)
const ws = new WebSocket((await (await fetch('http://127.0.0.1:9340/json')).json()).find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.on('open', r))
let id = 0; const pending = new Map(); const errors = []
ws.on('message', m => { const d = JSON.parse(m); if (d.id) pending.get(d.id)?.(d); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] ?? d.params.exceptionDetails.text); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)) })
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await cmd('Runtime.enable'); await cmd('Page.enable')
await cmd('Page.navigate', { url: `http://127.0.0.1:7899/?key=${process.env.K}` }); await sleep(2500)
for (const spec of specs) {
  const [name, size, hash, js = ''] = spec.split('|')
  const [w, h] = size.split('x').map(Number)
  const mobile = w < 700
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile })
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: mobile })
  await cmd('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(hash)}` }); await sleep(1800)
  if (js) { await cmd('Runtime.evaluate', { expression: js, awaitPromise: true }); await sleep(1200) }
  const shot = await cmd('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(shot.result.data, 'base64'))
  await cmd('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))` }); await sleep(300)
}
console.log('errors:', errors.length ? [...new Set(errors)] : 'none')
ws.close(); chrome.kill()
