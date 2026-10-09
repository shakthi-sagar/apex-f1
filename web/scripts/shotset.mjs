// Deterministic screenshot matrix for A/B visual diffing.
//   node scripts/shotset.mjs <outdir> [time] [driver]
//
// Unlike views.mjs (which loops every camera for eyeballing) this is built for
// pixel comparison: the replay clock is paused and time-dependent animation is
// frozen so two runs of the *same* build are identical. Cameras whose framing
// orbits with wall-clock time (heli, cinematic) are excluded by default because
// they can never reproduce -- verify those by eye, not by diff.
//
//   VIEWS=tv,top node scripts/shotset.mjs /tmp/a
import { chromium } from 'playwright'

const [,, outDir, time = '30', drv = '1'] = process.argv
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'
const W = Number(process.env.W || 1280)
const H = Number(process.env.H || 720)
const VIEWS = (process.env.VIEWS || 'tv,trackside,top,chase,close,onboard,cockpit').split(',')

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__f1, null, { timeout: 60000 })

// Pin the clock that drives camera shake / tree sway / rain / asphalt ripples /
// cloud drift. Without this every run differs by ~1.6% of pixels purely from
// wall-clock jitter, which drowns out the material change being tested.
await page.evaluate(() => { window.__f1t = 12.5 })
await page.waitForTimeout(4000)

// Tree canopies sway off the scripted clock too; zero the wind uniform as well so
// foliage geometry is byte-identical between runs.
const frozen = await page.evaluate(() => {
  const scene = window.__f1scene
  let n = 0
  scene.traverse((o) => {
    if (!o.material) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const u = m.userData && m.userData.u
      if (u && u.uWind) { u.uWind.value = 0; n++ }
    }
  })
  return n
})
if (!frozen) console.warn('warn: no uWind uniforms found -- renders may not be reproducible')

for (const v of VIEWS) {
  await page.evaluate(([t, d, v]) => {
    const { rt, ui } = window.__f1
    rt.clock.seek(Number(t))
    rt.clock.setPlaying(false)
    ui.getState().setDirector(false)
    ui.getState().select(d)
    ui.getState().setCamera(v)
  }, [time, drv, v])
  await page.waitForTimeout(2200)
  await page.screenshot({ path: `${outDir}/${v}.png` })
}

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0
  const t0 = performance.now()
  const f = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : res(n / 2) }
  requestAnimationFrame(f)
}))
console.log(`shotset: ${VIEWS.length} views -> ${outDir}  (wind uniforms frozen: ${frozen})`)
console.log(`fps ${fps}`)
if (errs.length) console.log('page errors:\n' + [...new Set(errs)].slice(0, 10).join('\n'))
await browser.close()