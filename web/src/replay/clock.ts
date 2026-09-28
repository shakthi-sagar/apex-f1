/**
 * Replay clock — owns race time, independent of React. The render loop calls `tick(dt)`
 * once per frame; React UI subscribes at a throttled rate (`subscribe`).
 */
export class ReplayClock {
  time: number
  rate = 1
  playing = false
  readonly start: number
  readonly end: number
  private listeners = new Set<() => void>()
  private lastEmit = 0
  private version = 0
  /** Smoothly animated seeks (for event navigation) */
  private seekAnim: { from: number; to: number; t: number; dur: number } | null = null

  constructor(start: number, end: number, initial: number) {
    this.start = start
    this.end = end
    this.time = initial
  }

  tick(dtReal: number) {
    if (this.seekAnim) {
      const a = this.seekAnim
      a.t += dtReal
      const u = Math.min(1, a.t / a.dur)
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2
      this.time = a.from + (a.to - a.from) * e
      if (u >= 1) this.seekAnim = null
      this.emit(true)
      return
    }
    if (this.playing) {
      this.time = Math.min(this.end, this.time + dtReal * this.rate)
      if (this.time >= this.end) this.playing = false
    }
    this.emit(false)
  }

  seek(t: number, animate = false) {
    t = Math.max(this.start, Math.min(this.end, t))
    if (animate && Math.abs(t - this.time) < 900) this.seekAnim = { from: this.time, to: t, t: 0, dur: 0.6 }
    else { this.seekAnim = null; this.time = t }
    this.emit(true)
  }

  setPlaying(p: boolean) { this.playing = p; this.emit(true) }
  toggle() { this.setPlaying(!this.playing) }
  setRate(r: number) { this.rate = r; this.emit(true) }

  get snapshotVersion() { return this.version }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private emit(force: boolean) {
    const now = performance.now()
    if (!force && now - this.lastEmit < 66) return // ~15 Hz UI updates
    this.lastEmit = now
    this.version++
    for (const l of this.listeners) l()
  }
}
