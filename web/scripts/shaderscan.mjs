// Static scan for dead shader code: writes to a value inside a single
// onBeforeCompile replacement that are unconditionally overwritten later in the
// same block. The asphalt curb bug was exactly this shape -- it wrote
// diffuseColor.rgb and then `diffuseColor.rgb = mix(base, paint, paintMask)`
// threw it away, so it never rendered.
//
//   node web/scripts/shaderscan.mjs
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOTS = ['src/scene', 'src/camera']

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.tsx?$/.test(e.name)) yield p
  }
}

/** Pull out the body of each `#include <x>` -> `...` replacement. */
function replacements(src) {
  const out = []
  const re = /\.replace\(\s*['"`]#include <([a-z_]+)>['"`]\s*,\s*([\s\S]*?)\)\n/g
  let m
  while ((m = re.exec(src))) out.push({ chunk: m[1], body: m[2] })
  return out
}

/**
 * Walks a replacement body and reports which writes to `varName` are dead --
 * overwritten by a later assignment WITHOUT their value ever being read first.
 * A read-modify-write (`x = mix(x, ...)`) consumes the previous value, so the
 * write before it is live; naive "two writes" counting produces false positives.
 */
function deadWrites(body, varName) {
  const lines = body.split('\n')
  const out = []
  let depth = 0
  let pending = null // a write whose value has not yet been read
  for (let i = 0; i < lines.length; i++) {
    const before = depth
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    const guarded = before > 0
    const isAssign = new RegExp(`(^|[^.\\w])${varName}(\\.\\w+)*\\s*=[^=]`).test(lines[i])
    if (isAssign) {
      // does the right-hand side read the variable back?
      const rhs = lines[i].slice(lines[i].search(new RegExp(`${varName}(\\.\\w+)*\\s*=[^=]`)) + 1)
      const readsRHS = new RegExp(`(^|[^.\\w])${varName}(\\.\\w+)*`).test(rhs)
      if (pending && !guarded && !readsRHS) out.push(pending)
      pending = { line: i + 1, text: lines[i].trim(), guarded }
    } else if (pending && new RegExp(`(^|[^.\\w])${varName}(\\.\\w+)*`).test(lines[i])) {
      pending = null // consumed by a read
    }
  }
  return out
}

const findings = []
for (const root of ROOTS) {
  for await (const file of walk(path.join(process.cwd(), root))) {
    const src = await readFile(file, 'utf8')
    for (const { chunk, body } of replacements(src)) {
      for (const v of ['diffuseColor.rgb', 'roughnessFactor', 'metalnessFactor', 'totalEmissiveRadiance']) {
        const dead = deadWrites(body, v)
        if (!dead.length) continue
        findings.push({ file: path.relative(process.cwd(), file), chunk, var: v, dead: dead.map((d) => d.text) })
      }
    }
  }
}

if (!findings.length) {
  console.log('shaderscan: no overwritten shader writes found')
} else {
  console.log(`shaderscan: ${findings.length} suspect overwrite(s)\n`)
  for (const f of findings) {
    console.log(`${f.file}  [${f.chunk}]  -> ${f.var}`)
    for (const d of f.dead) console.log(`    DEAD (overwritten, never read): ${d}`)
    console.log()
  }
}