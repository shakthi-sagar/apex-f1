// CPU profile of the running replay: top self-time functions
import { chromium } from 'playwright'
const url = process.argv[2] || 'http://127.0.0.1:5174/race/2024/21'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(url)
await page.waitForFunction(() => window.__f1 && window.__f1scene, null, { timeout: 90000 })
await page.evaluate(() => { const { rt, ui } = window.__f1; rt.clock.seek(5400); rt.clock.setPlaying(true) })
await page.waitForTimeout(3000)
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start')
await page.waitForTimeout(5000)
const { profile } = await cdp.send('Profiler.stop')
const self = new Map(); const total = profile.samples.length
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
for (const id of profile.samples) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + 1) }
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28).map(([k, v]) => `${(v / total * 100).toFixed(1)}%  ${k}`).join('\n'))
await browser.close()
