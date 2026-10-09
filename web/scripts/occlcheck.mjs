// Occlusion check across the camera matrix.
//   node scripts/occlcheck.mjs [time] [driver]
//
// Two objective probes per camera mode:
//   1. line-of-sight -- raycast camera -> target car; anything closer than the
//      car is occluding the subject. (This is what caught the TV camera sitting
//      inside its own tower at 0.2 m.)
//   2. burial -- cast rays outward in a small ring; if the nearest surface is
//      within ~1 m the lens is buried in geometry, which fills the frame.
import { chromium } from 'playwright'

const [,, time = '30', drv = '1'] = process.argv
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'
const MODES = (process.env.MODES || 'chase,close,onboard,cockpit,heli,tv,trackside,top,cinematic,orbit,free').split(',')

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__f1, null, { timeout: 60000 })
await page.evaluate(() => { window.__f1t = 12.5 })
await page.waitForTimeout(4000)

const rows = []
for (const mode of MODES) {
  await page.evaluate(([t, d, m]) => {
    const { rt, ui } = window.__f1
    rt.clock.seek(Number(t))
    rt.clock.setPlaying(false)
    ui.getState().setDirector(false)
    ui.getState().select(d)
    ui.getState().setCamera(m)
  }, [time, drv, mode])
  await page.waitForTimeout(1800)

  const r = await page.evaluate(() => {
    const T = window.__f1three
    const rt = window.__f1.rt
    const cam = window.__f1cam
    const scene = window.__f1scene
    const pose = rt.byNum.get(window.__f1.ui.getState().selected) || rt.poses[0]

    // Anything belonging to a car (`car-<num>` groups) is not an occluder for this
    // test: cockpit/onboard cameras sit inside their own car by design, and on the
    // grid one car in front of the subject is physically correct, not a bug.
    const isCar = (obj) => {
      let o = obj
      while (o) { if (typeof o.name === 'string' && o.name.startsWith('car-')) return true; o = o.parent }
      return false
    }
    // most informative name available: nearest named ancestor, else the root group
    const label = (obj) => {
      let o = obj
      while (o && !(typeof o.name === 'string' && o.name)) o = o.parent
      return (o && o.name) || '(unnamed)'
    }

    const origin = cam.position.clone()
    const toCar = pose.position.clone().sub(origin)
    const distToCar = toCar.length()
    const rc = new T.Raycaster(origin, toCar.normalize(), 0.001, distToCar - 0.4)
    const hits = rc.intersectObjects(scene.children, true)
    const blocked = hits.find((h) => !isCar(h.object))

    // burial probe: nearest non-car surface in a ring of directions
    let nearest = Infinity
    let nearestName = ''
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const dir = new T.Vector3(Math.cos(a), -0.15, Math.sin(a)).normalize().applyQuaternion(cam.quaternion)
      const hs = new T.Raycaster(origin, dir, 0.001, 6).intersectObjects(scene.children, true)
      const h = hs.find((x) => !isCar(x.object))
      if (h && h.distance < nearest) { nearest = h.distance; nearestName = label(h.object) }
    }
    return {
      occluded: blocked ? { d: +blocked.distance.toFixed(2), name: label(blocked.object) } : null,
      distToCar: +distToCar.toFixed(1),
      nearest: Number.isFinite(nearest) ? +nearest.toFixed(2) : null,
      nearestName,
    }
  })
  rows.push({ mode, ...r })
}

console.log(`occlusion sweep @ t=${time}  driver=${drv}\n`)
console.log('mode'.padEnd(12) + 'distToCar'.padStart(11) + 'occluder'.padStart(26) + '  nearest')
for (const r of rows) {
  const occ = r.occluded ? `${r.occluded.name}@${r.occluded.d}m` : '-'
  console.log(r.mode.padEnd(12) + `${r.distToCar}`.padStart(11) + occ.padEnd(26) + `  ${r.nearest ?? '-'}m ${r.nearestName}`)
}
const bad = rows.filter((r) => r.nearest !== null && r.nearest < 1.5)
console.log(bad.length
  ? `\nFLAGGED (lens buried in geometry <1.5m): ${bad.map((r) => r.mode).join(', ')}`
  : '\nno camera buried in geometry')
// Foreground occlusion is a framing choice, not a defect: a 0.7m trackside dolly
// always looks across the road. Only report it, never fail on it.
const fg = rows.filter((r) => r.occluded)
if (fg.length) {
  console.log(`\nnote -- subject ray crosses geometry (foreground framing, not a defect):`)
  for (const r of fg) console.log(`  ${r.mode.padEnd(12)} ${r.occluded.name} @${r.occluded.d}m (car at ${r.distToCar}m)`)
}
await browser.close()