// Identify what is occluding a given camera mode, with full ancestor chain.
//   node scripts/occlwho.mjs <mode> [time] [driver]
import { chromium } from 'playwright'

const [,, mode = 'cinematic', time = '30', drv = '1'] = process.argv
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__f1, null, { timeout: 60000 })
await page.evaluate(() => { window.__f1t = 12.5 })
await page.waitForTimeout(4000)
await page.evaluate(([t, d, m]) => {
  const { rt, ui } = window.__f1
  rt.clock.seek(Number(t)); rt.clock.setPlaying(false)
  ui.getState().setDirector(false); ui.getState().select(d); ui.getState().setCamera(m)
}, [time, drv, mode])
await page.waitForTimeout(2000)

console.log(JSON.stringify(await page.evaluate((mode) => {
  const T = window.__f1three
  const rt = window.__f1.rt
  const cam = window.__f1cam
  const scene = window.__f1scene
  const pose = rt.byNum.get(window.__f1.ui.getState().selected) || rt.poses[0]
  const isCar = (o) => { while (o) { if (typeof o.name === 'string' && o.name.startsWith('car-')) return true; o = o.parent } return false }
  const chain = (o) => { const c = []; while (o && c.length < 6) { c.push(o.name || `(${o.type})`); o = o.parent } return c }

  const origin = cam.position.clone()
  const toCar = pose.position.clone().sub(origin)
  const dist = toCar.length()
  const hits = new T.Raycaster(origin, toCar.normalize(), 0.001, dist - 0.4).intersectObjects(scene.children, true)
  const listed = hits.filter((h) => !isCar(h.object)).slice(0, 6).map((h) => ({
    at: +h.distance.toFixed(2),
    // walk up: a mesh can be hidden by any ancestor's visible flag
    hidden: (() => { let o = h.object; while (o) { if (o.visible === false) return true; o = o.parent } return false })(),
    opacity: h.object.material?.opacity,
    transparent: h.object.material?.transparent,
    mat: h.object.material?.type,
    color: h.object.material?.color?.getHexString?.(),
    chain: chain(h.object),
  }))
  return {
    mode,
    camY: +cam.position.y.toFixed(2),
    carY: +pose.position.y.toFixed(2),
    distToCar: +dist.toFixed(1),
    renderedOccluders: listed.filter((l) => !l.hidden),
    allHits: listed,
  }
}, mode), null, 2))

await browser.close()