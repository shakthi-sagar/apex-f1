// Close-up of a car from several angles: node scripts/car.mjs <outdir> <time> <driver>
import { chromium } from 'playwright'
const [,, outDir, time = '4300', drv = '4'] = process.argv
const url = process.env.URL || 'http://127.0.0.1:5174/race/2024/21'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url)
await page.waitForFunction(() => window.__f1 && window.__f1cam, null, { timeout: 60000 })
await page.evaluate(([t, d]) => {
  const { rt, ui } = window.__f1
  rt.clock.seek(Number(t)); rt.clock.setPlaying(false)
  ui.getState().setDirector(false); ui.getState().select(d); ui.getState().setCamera('free')
  ui.setState({ hudHidden: true }); window.__f1freeze = true
}, [time, drv])
await page.waitForTimeout(2500)
const angles = [[-6, 2.2, 4.5, 'rear34'], [6.5, 1.6, 4, 'front34'], [0.3, 1.2, 7.5, 'side'], [-3, 7, 0.5, 'top'], [4.2, 0.6, 1.6, 'low']]
for (const [x, y, z, name] of angles) {
  await page.evaluate(([x, y, z, d]) => {
    const { rt } = window.__f1
    const cam = window.__f1cam
    const p = rt.byNum.get(d)
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw)
    const wx = p.position.x + x * cy + z * sy, wz = p.position.z - x * sy + z * cy
    cam.position.set(wx, p.position.y + y, wz)
    cam.fov = 40; cam.near = 0.05; cam.updateProjectionMatrix()
    cam.lookAt(p.position.x, p.position.y + 0.5, p.position.z)
  }, [x, y, z, drv])
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${outDir}/car-${name}.png` })
}
await browser.close()
