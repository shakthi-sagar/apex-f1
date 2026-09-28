// Capture several camera/time combinations: node scripts/views.mjs <outdir> [time] [driver]
import { chromium } from 'playwright'
const [,, outDir, time = '', drv = '1', only = ''] = process.argv
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'] })
const page = await browser.newPage({ viewport: { width: Number(process.env.W || 1600), height: Number(process.env.H || 900) } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(url)
await page.waitForFunction(() => window.__f1, null, { timeout: 60000 })
await page.waitForTimeout(3000)
const views = (only ? only.split(',') : ['chase', 'heli', 'tv', 'onboard', 'top', 'cinematic', 'close'])
for (const v of views) {
  await page.evaluate(([t, d, v]) => {
    const { rt, ui } = window.__f1
    if (t) rt.clock.seek(Number(t))
    ui.getState().setDirector(false)
    ui.getState().select(d)
    ui.getState().setCamera(v)
    rt.clock.setPlaying(true)
  }, [time, drv, v])
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${outDir}/v-${v}.png` })
}
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / 2) }; requestAnimationFrame(f) }))
console.log('fps', fps)
console.log([...new Set(logs)].slice(0, 20).join('\n'))
await browser.close()
