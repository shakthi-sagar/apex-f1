import * as THREE from 'three'
import type { CircuitModel } from '../data/circuit'
import { newFrame } from '../data/circuit'
import type { LoadedRace } from '../data/loadRace'
import type { DriverInfo, RaceEvent, WeatherSample } from '../data/types'
import { ReplayClock } from './clock'
import { newSample, type CarSample } from './motion'

export const WHEELBASE = 3.6
export const WHEEL_R = 0.36

/** Everything the renderer needs about one car at the current frame (derived, visual). */
export interface CarPose {
  driver: DriverInfo
  index: number
  sample: CarSample
  visible: boolean
  position: THREE.Vector3
  forward: THREE.Vector3 // unit, horizontal-ish (includes grade)
  left: THREE.Vector3
  yaw: number
  pitch: number
  roll: number
  steer: number // front wheel angle (rad), derived from path curvature + lateral motion
  wheelSpin: number // accumulated wheel angle (rad)
  brakeGlow: number
  drsOpen: boolean
  rainLight: boolean
  lapDistance: number
  racePosition: number
}

/**
 * Per-frame race state. Owns the clock; `update()` is called once per rendered frame
 * (first in the frame loop) and every consumer reads the same poses.
 */
export class RaceRuntime {
  readonly clock: ReplayClock
  readonly data: LoadedRace
  readonly circuit: CircuitModel
  readonly poses: CarPose[]
  readonly byNum = new Map<string, CarPose>()
  readonly events: RaceEvent[]
  weather: WeatherSample
  wetness = 0
  private frame = newFrame()
  private frame2 = newFrame()
  private lastPositions = 0

  constructor(data: LoadedRace) {
    this.data = data
    this.circuit = data.circuit
    const r = data.race
    const [t0, t1] = r.race.window
    this.clock = new ReplayClock(Math.max(t0, data.motion.t0), Math.min(t1, data.motion.tEnd), r.race.raceStart - 25)
    this.clock.playing = true
    this.events = r.events
    this.poses = r.drivers.filter((d) => d.hasMotion).map((driver, index) => {
      const p: CarPose = {
        driver, index, sample: newSample(), visible: false,
        position: new THREE.Vector3(), forward: new THREE.Vector3(1, 0, 0), left: new THREE.Vector3(0, 0, -1),
        yaw: 0, pitch: 0, roll: 0, steer: 0, wheelSpin: 0, brakeGlow: 0, drsOpen: false, rainLight: false,
        lapDistance: 0, racePosition: 0,
      }
      this.byNum.set(driver.num, p)
      return p
    })
    this.weather = r.environment.weather[0]
  }

  get time() { return this.clock.time }

  update(dtReal: number) {
    this.clock.tick(dtReal)
    const t = this.clock.time
    const { motion, timing } = this.data
    const c = this.circuit
    this.updateWeather(t)
    if (performance.now() - this.lastPositions > 250) {
      this.lastPositions = performance.now()
      for (const row of timing.at(t)) {
        const p = this.byNum.get(row.driver)
        if (p) p.racePosition = row.position
      }
    }
    for (const p of this.poses) {
      const s = motion.sample(p.driver.num, t, p.sample)
      p.visible = s.valid && s.visible
      if (!p.visible) continue
      const f = c.frame(s.s, s.d, this.frame)
      // heading = path tangent rotated by the lateral slip angle atan2(dd, v)
      const slip = s.v > 2 ? Math.atan2(s.dd, s.v) : 0
      const cs = Math.cos(slip), sn = Math.sin(slip)
      // rotate tangent toward left normal by slip
      const fx = f.tx * cs + f.nx * sn
      const fz = f.tz * cs + f.nz * sn
      // grade from a short look-ahead of the reference line
      const ahead = c.frame(s.s + 2.5, s.d, this.frame2)
      const grade = (ahead.y - f.y) / 2.5
      p.position.set(f.x, f.y, f.z)
      p.yaw = Math.atan2(-fz, fx)
      p.pitch = Math.atan(grade)
      // body roll from lateral acceleration v²κ (visual only, a few tenths of a degree)
      const latAcc = s.v * s.v * f.curvature
      p.roll = THREE.MathUtils.clamp(-latAcc * 0.0012, -0.02, 0.02)
      p.forward.set(fx, grade, fz).normalize()
      p.left.set(f.nx, 0, f.nz)
      // steering: Ackermann angle for the path curvature + lateral correction, exaggerated slightly for readability
      const k = f.curvature + (s.v > 3 ? (s.dd / Math.max(s.v, 3)) * 0.02 : 0)
      const target = THREE.MathUtils.clamp(Math.atan(WHEELBASE * k) * 1.6, -0.38, 0.38)
      p.steer += (target - p.steer) * Math.min(1, dtReal * 10)
      p.wheelSpin = (s.s / WHEEL_R) % (Math.PI * 2)
      p.brakeGlow = s.brake > 50 ? Math.min(1, p.brakeGlow + dtReal * 6) : Math.max(0, p.brakeGlow - dtReal * 3)
      p.drsOpen = s.drs >= 10
      p.rainLight = this.wetness > 0.3 || s.inPit
      p.lapDistance = c.wrap(s.s)
    }
  }

  private updateWeather(t: number) {
    const w = this.data.race.environment.weather
    let i = 0
    while (i + 1 < w.length && w[i + 1].t <= t) i++
    const a = w[i], b = w[Math.min(i + 1, w.length - 1)]
    const u = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0
    this.weather = u < 0.5 ? a : b
    this.wetness = a.wetness + (b.wetness - a.wetness) * u
  }

  isRaining() { return this.weather?.rain ?? false }

  /** Current flag state from track status. */
  trackStatusAt(t: number) {
    const ts = this.data.race.trackStatus
    let s = 'green'
    for (const x of ts) { if (x.t <= t) s = x.status; else break }
    return s
  }

  lapAt(t: number) { return this.data.timing.leaderLap(t) }
}
