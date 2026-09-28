import type { SimBin } from '../data/simbin'

export interface TimingRow {
  driver: string
  position: number
  gap: number | null // s to leader
  interval: number | null // s to car ahead
  lapsDown: number
  lap: number
}

/** 2 Hz race order / gaps from the pipeline (time-at-distance gaps). */
export class TimingStore {
  readonly t0: number
  readonly step: number
  readonly n: number
  readonly drivers: string[]
  private pos: Uint8Array
  private gap: Int32Array
  private iv: Int32Array
  private down: Uint8Array
  private lap: Uint8Array
  readonly profile: { speed: Float32Array; throttle: Float32Array; brake: Float32Array }
  private rows: TimingRow[]

  constructor(bin: SimBin<{ t0: number; step: number; n: number; drivers: string[] }>) {
    this.t0 = bin.meta.t0
    this.step = bin.meta.step
    this.n = bin.meta.n
    this.drivers = bin.meta.drivers
    this.pos = bin.get<Uint8Array>('position')
    this.gap = bin.get<Int32Array>('gap')
    this.iv = bin.get<Int32Array>('interval')
    this.down = bin.get<Uint8Array>('laps_down')
    this.lap = bin.get<Uint8Array>('lap')
    this.profile = { speed: bin.get('profile_speed'), throttle: bin.get('profile_throttle'), brake: bin.get('profile_brake') }
    this.rows = this.drivers.map((d) => ({ driver: d, position: 0, gap: null, interval: null, lapsDown: 0, lap: 0 }))
  }

  index(t: number) {
    return Math.max(0, Math.min(this.n - 1, Math.round((t - this.t0) / this.step)))
  }

  /** Rows sorted by position at time t (shared array; do not keep references across frames). */
  at(t: number): TimingRow[] {
    const f = Math.max(0, Math.min(this.n - 1, (t - this.t0) / this.step))
    const i = Math.floor(f)
    const j = Math.min(this.n - 1, i + 1)
    const u = f - i
    const k = u < 0.5 ? i : j
    for (let r = 0; r < this.drivers.length; r++) {
      const row = this.rows[r]
      const o = r * this.n
      row.position = this.pos[o + k]
      const g0 = this.gap[o + i], g1 = this.gap[o + j]
      row.gap = g0 < 0 || g1 < 0 ? (g0 >= 0 ? g0 / 1000 : null) : (g0 + (g1 - g0) * u) / 1000
      const i0 = this.iv[o + i], i1 = this.iv[o + j]
      row.interval = i0 < 0 || i1 < 0 ? (i0 >= 0 ? i0 / 1000 : null) : (i0 + (i1 - i0) * u) / 1000
      row.lapsDown = this.down[o + k]
      row.lap = this.lap[o + k]
    }
    return [...this.rows].sort((a, b) => (a.position || 99) - (b.position || 99))
  }

  positionOf(driver: string, t: number) {
    const r = this.drivers.indexOf(driver)
    return r < 0 ? 0 : this.pos[r * this.n + this.index(t)]
  }

  intervalOf(driver: string, t: number) {
    const r = this.drivers.indexOf(driver)
    if (r < 0) return null
    const v = this.iv[r * this.n + this.index(t)]
    return v < 0 ? null : v / 1000
  }

  leaderLap(t: number) {
    const k = this.index(t)
    let best = 0
    for (let r = 0; r < this.drivers.length; r++) if (this.pos[r * this.n + k] === 1) best = this.lap[r * this.n + k]
    return best
  }
}
