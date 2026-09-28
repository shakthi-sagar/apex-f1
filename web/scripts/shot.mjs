// usage: node shot.mjs <url> <out.png> [waitMs] [js-to-eval-after-load]
import { chromium } from 'playwright'
const [,, url, out, wait = '8000', js = ''] = process.argv
const browser = await chromium.launch({ headless: true, args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--use-gl=angle'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(Number(wait))
if (js) { await page.evaluate(js); await page.waitForTimeout(3000) }
await page.screenshot({ path: out })
const info = await page.evaluate(() => { const c = document.querySelector('canvas'); if (!c) return 'no canvas'; const gl = c.getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a' })
console.log('renderer:', info)
console.log(logs.filter(l => !l.includes('[vite]')).slice(0, 30).join('\n'))
await browser.close()
