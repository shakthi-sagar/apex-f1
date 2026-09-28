import * as THREE from 'three'
import type { SimBin } from './simbin'
import type { CircuitMeta } from './types'

/**
 * Circuit geometry in the local ENU frame, exposed in three.js world space:
 *   three.x = east, three.y = up (metres above datum), three.z = -north
 * The reference line is a closed polyline at `ds` metres; everything is addressed by
 * arc length s (m, wraps at `length`) and lateral offset d (m, + = left of travel).
 */
export class CircuitModel {
  readonly meta: CircuitMeta
  readonly n: number
  readonly ds: number
  readonly length: number
  readonly px: Float32Array // three-space positions (n*3)
  readonly left: Float32Array
  readonly right: Float32Array
  readonly racing: Float32Array
  readonly curvature: Float32Array
  readonly barrierLeft: Float32Array
  readonly barrierRight: Float32Array
  readonly tx: Float32Array // three-space tangent xz (n*2)
  readonly pit?: { pts: Float32Array; s: Float32Array; d: Float32Array }

  constructor(bin: SimBin<CircuitMeta>) {
    this.meta = bin.meta
    const path = bin.get('path')
    this.n = path.length / 3
    this.ds = bin.meta.ds
    this.length = bin.meta.length
    this.px = new Float32Array(this.n * 3)
    for (let i = 0; i < this.n; i++) {
      this.px[i * 3] = path[i * 3]
      this.px[i * 3 + 1] = path[i * 3 + 2]
      this.px[i * 3 + 2] = -path[i * 3 + 1]
    }
    this.left = bin.get('left')
    this.right = bin.get('right')
    this.racing = bin.get('racing')
    this.curvature = bin.get('curvature')
    this.barrierLeft = bin.arrays['barrier_left'] as Float32Array ?? this.left.map((v) => v + 6)
    this.barrierRight = bin.arrays['barrier_right'] as Float32Array ?? this.right.map((v) => v - 6)
    this.tx = new Float32Array(this.n * 2)
    for (let i = 0; i < this.n; i++) {
      const a = (i - 1 + this.n) % this.n, b = (i + 1) % this.n
      let x = this.px[b * 3] - this.px[a * 3], z = this.px[b * 3 + 2] - this.px[a * 3 + 2]
      const l = Math.hypot(x, z) || 1
      x /= l; z /= l
      this.tx[i * 2] = x; this.tx[i * 2 + 1] = z
    }
    if (bin.arrays['pit_path']) {
      const pp = bin.get('pit_path')
      const pts = new Float32Array(pp.length)
      for (let i = 0; i < pp.length / 3; i++) {
        pts[i * 3] = pp[i * 3]; pts[i * 3 + 1] = pp[i * 3 + 2]; pts[i * 3 + 2] = -pp[i * 3 + 1]
      }
      this.pit = { pts, s: bin.get('pit_s'), d: bin.get('pit_d') }
    }
  }

  wrap(s: number) {
    const L = this.length
    return ((s % L) + L) % L
  }

  /** Interpolated sample of a per-vertex scalar array at arc length s. */
  scalarAt(arr: Float32Array, s: number) {
    const f = this.wrap(s) / this.ds
    const i = Math.floor(f) % this.n
    const j = (i + 1) % this.n
    const u = f - Math.floor(f)
    return arr[i] * (1 - u) + arr[j] * u
  }

  /**
   * Position at (s, d) in three-space, plus unit tangent (xz) and left normal.
   * Tangent in three-space: forward; left normal = (tz, -tx) rotated... computed explicitly.
   */
  frame(s: number, d: number, out: FrameOut) {
    const f = this.wrap(s) / this.ds
    const i = Math.floor(f) % this.n
    const j = (i + 1) % this.n
    const u = f - Math.floor(f)
    const p = this.px, t = this.tx
    const x = p[i * 3] + (p[j * 3] - p[i * 3]) * u
    const y = p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * u
    const z = p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * u
    let tx = t[i * 2] + (t[j * 2] - t[i * 2]) * u
    let tz = t[i * 2 + 1] + (t[j * 2 + 1] - t[i * 2 + 1]) * u
    const l = Math.hypot(tx, tz) || 1
    tx /= l; tz /= l
    // ENU left normal (-ty_enu, tx_enu) -> three: tangent (tx, -ty) ; left = (tz, -tx)?  derive:
    // enu t=(a,b) -> three (a, -b). enu left=(-b, a) -> three (-b, -a) = (tz, -tx)
    const nx = tz, nz = -tx
    out.x = x + nx * d
    out.y = y
    out.z = z + nz * d
    out.tx = tx; out.tz = tz
    out.nx = nx; out.nz = nz
    // grade (dy/ds)
    out.grade = (p[j * 3 + 1] - p[i * 3 + 1]) / this.ds
    out.curvature = this.curvature[i] * (1 - u) + this.curvature[j] * u
    return out
  }

  point(s: number, d: number, target = new THREE.Vector3()) {
    const f = this.frame(s, d, TMP)
    return target.set(f.x, f.y, f.z)
  }
}

export interface FrameOut {
  x: number; y: number; z: number
  tx: number; tz: number
  nx: number; nz: number
  grade: number
  curvature: number
}

export const newFrame = (): FrameOut => ({ x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: -1, grade: 0, curvature: 0 })
const TMP = newFrame()
