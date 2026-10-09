// Soak a camera mode across many random seeds to measure how often it ends up
// occluded. cinematic/trackside pick positions from Math.random() per shot, so a
// single run tells you nothing -- this resamples the seed cheaply in one session.
//   node scripts/occlsoak.mjs <mode> [time] [driver] [samples]
import { chromium } from 'playwright'

const [,, mode = 'cinematic', time = '30', drv = '1', n = '12'] = process.argv
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'
const N = Number(n)

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__f1, null, { timeout: 60000 })
await page.evaluate(() => { window.__f1t = 12.5 })
await page.waitForTimeout(4000)

// reset the shot seed by bouncing through another mode before each sample
const probe = async () => page.evaluate((mode) => {
  const T = window.__f1three
  const rt = window.__f1.rt
  const cam = window.__f1cam
  const scene = window.__f1scene
  const pose = rt.byNum.get(window.__f1.ui.getState().selected) || rt.poses[0]
  const isCar = (o) => { while (o) { if (typeof o.name === 'string' && o.name.startsWith('car-')) return true; o = o.parent } return false }
  const hidden = (o) => { while (o) { if (o.visible === false) return true; o = o.parent } return false }
  const chain = (o) => { const c = []; while (o && c.length < 4) { c.push(o.name || `(${o.type})`); o = o.parent } return c.join(' < ') }
  const origin = cam.position.clone()
  const toCar = pose.position.clone().sub(origin)
  const dist = toCar.length()
  const hits = new T.Raycaster(origin, toCar.normalize(), 0.001, dist - 0.4).intersectObjects(scene.children, true)
  const b = hits.find((h) => !isCar(h.object) && !hidden(h.object))
  return b ? { hit: true, at: +b.distance.toFixed(1), gap: +(dist - b.distance).toFixed(1), what: chain(b.object) } : { hit: false }
}, mode)

await page.evaluate(([t, d]) => {
  const { rt, ui } = window.__f1
  rt.clock.seek(Number(t)); rt.clock.setPlaying(false)
  ui.getState().setDirector(false); ui.getState().select(d)
}, [time, drv])

const samples = []
for (let i = 0; i < N; i++) {
  await page.evaluate((m) => window.__f1.ui.getState().setCamera(m), 'chase')
  await page.waitForTimeout(120)
  await page.evaluate((m) => window.__f1.ui.getState().setCamera(m), mode)
  await page.waitForTimeout(700)
  samples.push(await probe())
}

const bad = samples.filter((s) => s.hit)
console.log(`${mode} occlusion soak @ t=${time}  ${N} seeds`)
console.log(`occluded: ${bad.length}/${N}  (${((100 * bad.length) / N).toFixed(0)}%)`)
const groups = {}
for (const s of bad) groups[s.what] = (groups[s.what] || 0) + 1
for (const [what, c] of Object.entries(groups).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(2)}x ${what}`)
if (!bad.length) console.log('  no occlusions')
await browser.close()