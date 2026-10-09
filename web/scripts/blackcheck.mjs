// Detect blank/black 3D frames across a rendered camera matrix.
//   node scripts/blackcheck.mjs <dir>
//
// Crops to the central viewport so the HUD panels hugging the edges (timing
// tower, telemetry, minimap, transport) don't mask or fake a dark frame, then
// reports mean luminance and the share of near-black pixels. A frame whose
// viewport is >60% near-black is almost always a camera buried in geometry.
import sharp from 'sharp'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const [,, dir] = process.argv
if (!dir) { console.error('usage: node scripts/blackcheck.mjs <dir>'); process.exit(2) }

const files = (await readdir(dir)).filter((f) => f.endsWith('.png'))
if (!files.length) { console.error(`no PNGs in ${dir}`); process.exit(2) }

const rows = []
for (const f of files) {
  const img = sharp(path.join(dir, f))
  const meta = await img.metadata()
  const cw = Math.round(meta.width * 0.6)
  const ch = Math.round(meta.height * 0.78)
  const left = Math.round((meta.width - cw) / 2)
  const top = Math.round(meta.height * 0.08)
  const { data, info } = await img
    .extract({ left, top, width: cw, height: ch })
    .raw().toBuffer({ resolveWithObject: true })
  const chn = info.channels
  let sum = 0
  let dark = 0
  let n = 0
  for (let i = 0; i < data.length; i += chn) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    sum += lum
    if (lum < 10) dark++
    n++
  }
  rows.push({ f, mean: sum / n, dark: (100 * dark) / n })
}

rows.sort((a, b) => a.mean - b.mean)
console.log(`${dir}  (central viewport crop)`)
console.log('view'.padEnd(22) + 'meanLum'.padStart(9) + 'near-black'.padStart(11))
for (const r of rows) {
  console.log(r.f.replace('.png', '').padEnd(22) + r.mean.toFixed(1).padStart(9) + `${r.dark.toFixed(1)}%`.padStart(11))
}
const flagged = rows.filter((r) => r.dark > 60)
console.log(flagged.length
  ? `\nFLAGGED (viewport >60% near-black): ${flagged.map((r) => r.f.replace('.png', '')).join(', ')}`
  : '\nno frames flagged as blank/black')