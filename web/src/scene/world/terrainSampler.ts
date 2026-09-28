import type { SimBin } from '../../data/simbin'
import type { WorldMeta } from '../../data/loadRace'

/** Bilinear terrain height lookup in three-space (x = east, z = -north). */
export class TerrainSampler {
  readonly N: number
  readonly x0: number
  readonly y0: number
  readonly size: number
  readonly h: Float32Array

  constructor(world: SimBin<WorldMeta>) {
    const [x0, y0, size] = world.meta.extent
    this.N = world.meta.terrainN
    this.x0 = x0; this.y0 = y0; this.size = size
    const raw = world.get<Int16Array>('terrain')
    this.h = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) this.h[i] = raw[i] * world.meta.terrainScale
  }

  /** Height at three-space (x, z). */
  height(x: number, z: number) {
    const north = -z
    const N = this.N
    const fx = ((x - this.x0) / this.size) * (N - 1)
    const fy = ((north - this.y0) / this.size) * (N - 1)
    const ix = Math.max(0, Math.min(N - 2, Math.floor(fx)))
    const iy = Math.max(0, Math.min(N - 2, Math.floor(fy)))
    const u = Math.max(0, Math.min(1, fx - ix)), v = Math.max(0, Math.min(1, fy - iy))
    const h = this.h
    const a = h[iy * N + ix], b = h[iy * N + ix + 1], c = h[(iy + 1) * N + ix], d = h[(iy + 1) * N + ix + 1]
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
  }

  inside(x: number, z: number, margin = 0) {
    const north = -z
    return x > this.x0 + margin && x < this.x0 + this.size - margin && north > this.y0 + margin && north < this.y0 + this.size - margin
  }
}
