// Pixel-diff two shotset.mjs directories.
//   node scripts/pixdiff.mjs <dirA> <dirB> [tol]
//
// Reports, per view, the percentage of pixels that changed by more than `tol`
// (default 2/255, which absorbs GPU dithering/AA jitter) plus the largest
// single-channel delta. Used to prove a material change is actually live
// before anyone has to look at it -- and to prove a change is a no-op.
//
// Exit code 1 if the mean delta exceeds MAXMEAN, so it can gate a commit.
import sharp from 'sharp'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const [,, dirA, dirB, tolArg] = process.argv
if (!dirA || !dirB) {
  console.error('usage: node scripts/pixdiff.mjs <dirA> <dirB> [tol]')
  process.exit(2)
}
const tol = Number(tolArg ?? 2)
const maxMean = Number(process.env.MAXMEAN ?? 0)

const files = (await readdir(dirA)).filter((f) => f.endsWith('.png'))
if (!files.length) {
  console.error(`no PNGs in ${dirA}`)
  process.exit(2)
}

const rows = []
for (const f of files) {
  const a = await sharp(path.join(dirA, f)).raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(path.join(dirB, f)).raw().toBuffer({ resolveWithObject: true })
  if (a.data.length !== b.data.length || a.info.channels !== b.info.channels) {
    rows.push({ f, pct: 100, maxd: 255, note: 'size/channel mismatch' })
    continue
  }
  const ch = a.info.channels
  const total = a.data.length / ch
  let changed = 0
  let maxd = 0
  for (let i = 0; i < a.data.length; i += ch) {
    let d = 0
    for (let c = 0; c < ch; c++) {
      const v = Math.abs(a.data[i + c] - b.data[i + c])
      if (v > d) d = v
    }
    if (d > maxd) maxd = d
    if (d > tol) changed++
  }
  rows.push({ f, pct: (100 * changed) / total, maxd })
}

rows.sort((x, y) => y.pct - x.pct)
console.log(`tolerance ${tol}/255   ${dirA}  vs  ${dirB}`)
console.log('view'.padEnd(22) + 'changed'.padStart(10) + '  maxdelta')
for (const r of rows) {
  console.log(r.f.replace('.png', '').padEnd(22) + `${r.pct.toFixed(3)}%`.padStart(10) + `  ${String(r.maxd).padStart(3)}${r.note ? '  ' + r.note : ''}`)
}
const mean = rows.reduce((s, r) => s + r.pct, 0) / rows.length
console.log(`\nmean changed: ${mean.toFixed(3)}%`)
if (mean > maxMean) {
  console.log(`FAIL: mean ${mean.toFixed(3)}% > MAXMEAN ${maxMean}`)
  process.exit(1)
}
console.log(`PASS: mean ${mean.toFixed(3)}% <= MAXMEAN ${maxMean}`)