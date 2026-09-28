// node scripts/scenario.mjs <out.png> <steps.json>  — steps: [{js}|{click}|{wait}|{shot}]
import { chromium } from 'playwright'
import fs from 'node:fs'
const [,, outPrefix, stepsFile] = process.argv
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'))
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()) })
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
await page.goto(url)
await page.waitForFunction(() => window.__f1 && window.__f1cam, null, { timeout: 60000 })
await page.waitForTimeout(2000)
let n = 0
for (const s of steps) {
  if (s.js) await page.evaluate(s.js)
  if (s.click) await page.click(s.click)
  if (s.select) await page.selectOption(s.select[0], s.select[1])
  if (s.wait) await page.waitForTimeout(s.wait)
  if (s.shot) await page.screenshot({ path: `${outPrefix}-${s.shot}.png` })
  n++
}
console.log([...new Set(logs)].slice(0, 10).join('\n'))
await browser.close()
