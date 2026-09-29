// Uncapped perf benchmark with ablations: node scripts/bench.mjs [url]
import { chromium } from 'playwright'
const url = process.argv[2] || 'http://127.0.0.1:5174/race/2024/21'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(url)
await page.waitForFunction(() => window.__f1 && window.__f1scene, null, { timeout: 90000 })
await page.evaluate(() => { const { rt, ui } = window.__f1; rt.clock.seek(5400); rt.clock.setPlaying(true); ui.getState().setDirector(false); ui.getState().select('1'); ui.getState().setCamera('chase') })
await page.waitForTimeout(4000)
const measure = () => page.evaluate(() => new Promise((res) => {
  const times = []; let last = performance.now(); let n = 0
  const f = () => { const now = performance.now(); times.push(now - last); last = now; if (++n < 240) requestAnimationFrame(f); else {
    times.sort((a, b) => a - b); res({ fps: +(1000 / (times.reduce((a, b) => a + b) / times.length)).toFixed(1), p95ms: +times[Math.floor(times.length * 0.95)].toFixed(1) }) } }
  requestAnimationFrame(f)
}))
const hide = (names) => page.evaluate((names) => { window.__f1scene.traverse((o) => { if (names.includes(o.name)) o.visible = false }) }, names)
const show = (names) => page.evaluate((names) => { window.__f1scene.traverse((o) => { if (names.includes(o.name)) o.visible = true }) }, names)
const info = await page.evaluate(() => { const r = window.__f1gl?.info?.render; return r ? { calls: r.calls, tris: r.triangles } : null })
console.log('baseline', await measure(), info)
for (const g of [['trees'], ['buildings'], ['track'], ['terrain'], ['cars']]) { await hide(g); console.log('without', g.join(','), await measure()); await show(g) }
await page.evaluate(() => window.__f1.ui.setState({ hudHidden: true })); await page.waitForTimeout(500)
console.log('hud hidden', await measure())
await page.evaluate(() => window.__f1.ui.setState({ hudHidden: false }))
await page.evaluate(() => window.__f1.ui.getState().setQuality('balanced')); await page.waitForTimeout(1500)
console.log('quality balanced', await measure())
await browser.close()
