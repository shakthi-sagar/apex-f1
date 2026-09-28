import { dataUrl, fetchBuffer } from '../data/fetch'
import { parseSimBin, type SimBin } from '../data/simbin'
import type { RaceJson } from '../data/types'

export const FLAG_VISIBLE = 1
export const FLAG_PIT = 2
export const FLAG_STOPPED = 4

/** Interpolated car state at an arbitrary replay time. Reused objects — no per-frame allocation. */
export interface CarSample {
  valid: boolean
  visible: boolean
  s: number // cumulative arc length (m)
  v: number // m/s (fused)
  a: number // m/s² longitudinal
  d: number // lateral offset (m)
  dd: number // lateral velocity (m/s)
  speed: number // km/h raw
  rpm: number
  gear: number
  throttle: number
  brake: number
  drs: number
  inPit: boolean
  stopped: boolean
}

export const newSample = (): CarSample => ({
  valid: false, visible: false, s: 0, v: 0, a: 0, d: 0, dd: 0, speed: 0, rpm: 0, gear: 0, throttle: 0, brake: 0,
  drs: 0, inPit: false, stopped: false,
})

interface DriverChunk {
  s: Float32Array; v: Uint16Array; d: Int16Array; speed: Uint16Array; rpm: Uint16Array
  gear: Uint8Array; throttle: Uint8Array; brake: Uint8Array; drs: Uint8Array; flags: Uint8Array
}

interface Chunk { t0: number; n: number; drivers: Map<string, DriverChunk> }

/**
 * Streams motion chunks (15 min each) and reconstructs smooth motion:
 *  - s(t): cubic Hermite using the fused speed as derivative (C1, never jumps)
 *  - d(t): Catmull-Rom
 *  - telemetry: linear (continuous) / sample-and-hold (gear, DRS)
 */
export class MotionStore {
  readonly hz: number
  readonly dt: number
  readonly t0: number
  readonly tEnd: number
  private chunks: (Chunk | null)[]
  private loading = new Map<number, Promise<void>>()
  private readonly meta: RaceJson['motion']
  private readonly base: string
  onChunkLoaded?: (index: number) => void

  constructor(race: RaceJson, bundleBase: string) {
    this.meta = race.motion
    this.hz = race.motion.hz
    this.dt = 1 / this.hz
    this.t0 = race.motion.t0
    this.tEnd = race.motion.t0 + (race.motion.n - 1) * this.dt
    this.chunks = race.motion.chunks.map(() => null)
    this.base = bundleBase
  }

  get chunkCount() { return this.chunks.length }
  isLoaded(i: number) { return !!this.chunks[i] }
  loadedCount() { return this.chunks.filter(Boolean).length }

  chunkIndexAt(t: number) {
    const c = this.meta.chunks
    for (let i = c.length - 1; i >= 0; i--) if (t >= c[i].t0) return i
    return 0
  }

  async ensure(i: number, onProgress?: (l: number, tot: number) => void): Promise<void> {
    if (i < 0 || i >= this.chunks.length || this.chunks[i]) return
    let p = this.loading.get(i)
    if (!p) {
      const info = this.meta.chunks[i]
      p = fetchBuffer(dataUrl(this.base + info.file), onProgress).then((buf) => {
        const bin = parseSimBin<{ t0: number; n: number }>(buf)
        this.chunks[i] = { t0: bin.meta.t0, n: bin.meta.n, drivers: splitDrivers(bin) }
        this.onChunkLoaded?.(i)
      })
      this.loading.set(i, p)
    }
    return p
  }

  /** Load the chunk at t first, then everything else in the background (nearest first). */
  async prefetchAround(t: number) {
    const c = this.chunkIndexAt(t)
    await this.ensure(c)
    const order = [...this.chunks.keys()].sort((a, b) => Math.abs(a - c) - Math.abs(b - c))
    for (const i of order) await this.ensure(i)
  }

  sample(driver: string, t: number, out: CarSample): CarSample {
    out.valid = false
    out.visible = false
    const ci = this.chunkIndexAt(t)
    const ch = this.chunks[ci]
    if (!ch) { void this.ensure(ci); return out }
    const dc = ch.drivers.get(driver)
    if (!dc) return out
    const f = (t - ch.t0) * this.hz
    let k = Math.floor(f)
    if (k < 0 || k >= ch.n) return out
    if (k >= ch.n - 1) k = ch.n - 2
    const u = Math.min(1, Math.max(0, f - k))
    const fl0 = dc.flags[k], fl1 = dc.flags[k + 1]
    const vis = (u < 0.5 ? fl0 : fl1) & FLAG_VISIBLE
    out.valid = true
    out.visible = !!vis
    if (!vis) return out
    const h = this.dt
    // Hermite on s with fused speed as tangent
    const s0 = dc.s[k], s1 = dc.s[k + 1]
    const v0 = dc.v[k] / 100, v1 = dc.v[k + 1] / 100
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) { out.visible = false; return out }
    const u2 = u * u, u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2
    out.s = h00 * s0 + h10 * h * v0 + h01 * s1 + h11 * h * v1
    const dh00 = 6 * u2 - 6 * u, dh10 = 3 * u2 - 4 * u + 1, dh01 = -6 * u2 + 6 * u, dh11 = 3 * u2 - 2 * u
    out.v = Math.max(0, (dh00 * s0 + dh10 * h * v0 + dh01 * s1 + dh11 * h * v1) / h)
    out.a = (v1 - v0) / h
    // Catmull-Rom on d
    const km = Math.max(0, k - 1), kp = Math.min(ch.n - 1, k + 2)
    const p0 = dc.d[km] / 100, p1 = dc.d[k] / 100, p2 = dc.d[k + 1] / 100, p3 = dc.d[kp] / 100
    out.d = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
    out.dd = 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * u + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * u2) / h
    const lin = (a: ArrayLike<number>) => a[k] + (a[k + 1] - a[k]) * u
    out.speed = lin(dc.speed)
    out.rpm = lin(dc.rpm)
    out.throttle = lin(dc.throttle)
    out.brake = lin(dc.brake)
    out.gear = u < 0.5 ? dc.gear[k] : dc.gear[k + 1]
    out.drs = u < 0.5 ? dc.drs[k] : dc.drs[k + 1]
    const fl = u < 0.5 ? fl0 : fl1
    out.inPit = !!(fl & FLAG_PIT)
    out.stopped = !!(fl & FLAG_STOPPED)
    return out
  }

  /** Raw sample-rate access for charts (telemetry traces, comparison). Returns null if chunk missing. */
  channelWindow(driver: string, t0: number, t1: number, channel: keyof DriverChunk): { t: number[]; y: number[] } | null {
    const t: number[] = [], y: number[] = []
    for (let ci = this.chunkIndexAt(t0); ci <= this.chunkIndexAt(t1); ci++) {
      const ch = this.chunks[ci]
      if (!ch) { void this.ensure(ci); return null }
      const dc = ch.drivers.get(driver)
      if (!dc) continue
      const a = Math.max(0, Math.floor((t0 - ch.t0) * this.hz)), b = Math.min(ch.n - 1, Math.ceil((t1 - ch.t0) * this.hz))
      for (let k = a; k <= b; k++) {
        const tk = ch.t0 + k / this.hz
        if (t.length && tk <= t[t.length - 1]) continue
        t.push(tk)
        y.push(dc[channel][k])
      }
    }
    return { t, y }
  }
}

function splitDrivers(bin: SimBin): Map<string, DriverChunk> {
  const m = new Map<string, DriverChunk>()
  for (const name of Object.keys(bin.arrays)) {
    const [drv] = name.split('/')
    if (m.has(drv)) continue
    const g = <T,>(c: string) => bin.arrays[`${drv}/${c}`] as unknown as T
    m.set(drv, {
      s: g('s'), v: g('v'), d: g('d'), speed: g('speed'), rpm: g('rpm'), gear: g('gear'),
      throttle: g('throttle'), brake: g('brake'), drs: g('drs'), flags: g('flags'),
    })
  }
  return m
}
