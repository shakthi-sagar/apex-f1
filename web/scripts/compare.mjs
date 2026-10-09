// Build labelled side-by-side comparison sheets so a human can judge a change by
// opening one file instead of diffing directories by eye.
//   node scripts/compare.mjs <dirA> <dirB> <out.png> [labelA] [labelB] [views]
import sharp from 'sharp'
import path from 'node:path'

const [,, dirA, dirB, out, labelA = 'A', labelB = 'B', viewArg] = process.argv
if (!dirA || !dirB || !out) {
  console.error('usage: node scripts/compare.mjs <dirA> <dirB> <out.png> [labelA] [labelB] [views]')
  process.exit(2)
}

const VIEWS = (viewArg || 'chase,close,tv,top').split(',')
const TW = 620
const TH = Math.round((TW * 9) / 16)
const PAD = 20
const HEAD = 74
const GAP = 38
const W = PAD * 2 + TW * 2 + PAD
const H = HEAD + VIEWS.length * (TH + GAP) + PAD - GAP

const tile = (dir, v) => sharp(path.join(dir, `${v}.png`)).resize(TW, TH, { fit: 'fill' }).png().toBuffer()
const layers = []

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const label = (text, x, y, size = 19, fill = '#eef1f6') =>
  `<text x="${x}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${size}" font-weight="700" fill="${fill}">${esc(text)}</text>`

layers.push({
  input: Buffer.from(`<svg width="${W}" height="${HEAD}">
    ${label(labelA, PAD, 30, 21, '#39ff88')}
    ${label(labelB, PAD + TW + PAD, 30, 21, '#ffb800')}
    ${label('(left = ' + esc(dirA) + '   right = ' + esc(dirB) + ')', PAD, 58, 13, '#8c94a3')}
  </svg>`),
  top: 0, left: 0,
})

for (let i = 0; i < VIEWS.length; i++) {
  const v = VIEWS[i]
  const top = HEAD + i * (TH + GAP)
  layers.push({ input: await tile(dirA, v), top, left: PAD })
  layers.push({ input: await tile(dirB, v), top, left: PAD + TW + PAD })
  layers.push({
    input: Buffer.from(`<svg width="${W}" height="${GAP}">${label(v, PAD, 24, 15, '#cfd5de')}</svg>`),
    top: top + TH, left: 0,
  })
}

await sharp({ create: { width: W, height: H, channels: 3, background: '#0b0d12' } })
  .composite(layers)
  .png()
  .toFile(out)

console.log(`wrote ${out}  (${W}x${H}, ${VIEWS.length} views)`)