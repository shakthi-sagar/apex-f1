import * as THREE from 'three'
import type { CircuitModel } from '../../data/circuit'
import { newFrame } from '../../data/circuit'

/**
 * Ribbon builders along the reference line. All ribbons are sampled every `step` metres
 * with lateral subdivisions; attributes carry (d, s) so shaders can paint markings.
 */

export interface RibbonOpts {
  s0?: number
  s1?: number
  step?: number
  across: number // lateral subdivisions
  inner: (s: number, i: number) => number // lateral offset of the first edge
  outer: (s: number, i: number) => number
  height?: (s: number, u: number, d: number) => number // y offset profile
  yFn?: (x: number, z: number, base: number, u: number) => number
  extra?: Record<string, (s: number, u: number, d: number, i: number) => number>
}

const F = newFrame()

export function ribbon(c: CircuitModel, o: RibbonOpts): THREE.BufferGeometry {
  const step = o.step ?? 2
  const s0 = o.s0 ?? 0
  const s1 = o.s1 ?? c.length
  // closed loops are emitted as an open strip 0..L with a duplicated seam row so that the
  // painted-marking coordinate (s) never interpolates across the wrap
  const closed = false
  const nS = Math.max(2, Math.ceil((s1 - s0) / step))
  const rows = nS + 1
  const A = o.across
  const pos = new Float32Array(rows * (A + 1) * 3)
  const uv = new Float32Array(rows * (A + 1) * 2)
  const extras: Record<string, Float32Array> = {}
  for (const k of Object.keys(o.extra ?? {})) extras[k] = new Float32Array(rows * (A + 1))
  let p = 0, q = 0, e = 0
  let lastD0 = o.inner(s0, Math.floor(c.wrap(s0) / c.ds) % c.n), lastD1 = o.outer(s0, Math.floor(c.wrap(s0) / c.ds) % c.n)
  if (!Number.isFinite(lastD0) || !Number.isFinite(lastD1)) { lastD0 = 0; lastD1 = 0 }
  for (let r = 0; r < rows; r++) {
    const s = closed ? (r / nS) * c.length : s0 + ((s1 - s0) * r) / nS
    const i = Math.floor(c.wrap(s) / c.ds) % c.n
    let d0 = o.inner(s, i), d1 = o.outer(s, i)
    if (!Number.isFinite(d0) || !Number.isFinite(d1)) { d0 = lastD0; d1 = lastD1 }
    lastD0 = d0; lastD1 = d1
    for (let a = 0; a <= A; a++) {
      const u = a / A
      const d = d0 + (d1 - d0) * u
      c.frame(s, d, F)
      let y = F.y + (o.height ? o.height(s, u, d) : 0)
      if (o.yFn) y = o.yFn(F.x, F.z, y, u)
      pos[p++] = F.x; pos[p++] = y; pos[p++] = F.z
      uv[q++] = d; uv[q++] = s
      for (const [k, fn] of Object.entries(o.extra ?? {})) extras[k][e] = fn(s, u, d, i)
      e++
    }
  }
  const idx: number[] = []
  const segs = closed ? rows : rows - 1
  // winding: lateral axis must run toward +d (left) for an upward-facing surface
  const i0s = Math.floor(c.wrap(s0) / c.ds) % c.n
  const flip = o.outer(s0, i0s) < o.inner(s0, i0s)
  for (let r = 0; r < segs; r++) {
    const r2 = (r + 1) % rows
    for (let a = 0; a < A; a++) {
      const i0 = r * (A + 1) + a, i1 = i0 + 1, i2 = r2 * (A + 1) + a, i3 = i2 + 1
      if (flip) idx.push(i0, i1, i2, i1, i3, i2)
      else idx.push(i0, i2, i1, i1, i2, i3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  for (const [k, arr] of Object.entries(extras)) g.setAttribute(k, new THREE.BufferAttribute(arr, 1))
  g.setIndex(idx)
  g.computeVertexNormals()
  // closed ribbon: make the seam smooth by averaging normals of first/last rows is unnecessary (shared rows)
  g.computeBoundingSphere()
  return g
}

/** Continuous ranges of a boolean predicate along the lap, as [s0, s1] (s1 may exceed length). */
export function ranges(c: CircuitModel, pred: (i: number) => boolean, step = 2, minLen = 8): [number, number][] {
  const out: [number, number][] = []
  const n = Math.ceil(c.length / step)
  let start = -1
  for (let k = 0; k <= n; k++) {
    const i = Math.floor((k * step) / c.ds) % c.n
    const on = k < n && pred(i)
    if (on && start < 0) start = k * step
    if (!on && start >= 0) {
      if (k * step - start >= minLen) out.push([start, k * step])
      start = -1
    }
  }
  // merge wrap-around
  if (out.length > 1 && out[0][0] === 0 && Math.abs(out[out.length - 1][1] - n * step) < step * 1.5) {
    const last = out.pop()!
    out[0] = [last[0], out[0][1] + c.length]
  }
  return out
}
