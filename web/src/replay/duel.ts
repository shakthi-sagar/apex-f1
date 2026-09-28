import * as THREE from 'three'
import { newFrame } from '../data/circuit'
import type { DriverInfo } from '../data/types'
import { ReplayClock } from './clock'
import { newSample } from './motion'
import { LAP } from './raceQueries'
import { WHEEL_R, WHEELBASE, type CarPose, type RaceRuntime } from './runtime'

/** One lap resampled on a 1 m distance grid (from measured, fused motion + raw telemetry). */
export interface LapTrace {
  driver: DriverInfo
  lap: number
  lapTime: number
  sStart: number // cumulative s at the line
  length: number
  t: Float32Array // time since lap start at each metre
  speed: Float32Array
  throttle: Float32Array
  brake: Float32Array
  gear: Uint8Array
  d: Float32Array // lateral offset
  brakePoints: number[] // distances where braking starts
}

export interface DuelSide { driver: string; lap: number }

/** Build a distance-indexed trace for a driver's lap. Returns null if data isn't loaded yet. */
export async function buildLapTrace(rt: RaceRuntime, driver: string, lap: number): Promise<LapTrace | null> {
  const rows = rt.data.race.laps.byDriver[driver]
  const row = rows?.find((r) => r[LAP.lap] === lap)
  if (!row || row[LAP.start] == null || row[LAP.end] == null) return null
  const t0 = row[LAP.start] as number, t1 = row[LAP.end] as number
  const m = rt.data.motion
  for (let c = m.chunkIndexAt(t0); c <= m.chunkIndexAt(t1); c++) await m.ensure(c)
  const L = rt.circuit.length
  const n = Math.ceil(L)
  const tt: number[] = [], ss: number[] = [], sp: number[] = [], th: number[] = [], br: number[] = [], gr: number[] = [], dd: number[] = []
  const smp = newSample()
  for (let t = t0; t <= t1 + 1e-6; t += 0.05) {
    m.sample(driver, t, smp)
    if (!smp.visible) continue
    tt.push(t - t0); ss.push(smp.s); sp.push(smp.speed); th.push(smp.throttle); br.push(smp.brake); gr.push(smp.gear); dd.push(smp.d)
  }
  if (ss.length < 20) return null
  const s0 = ss[0] - 0 // start of lap in cumulative metres (line crossing)
  // snap lap start to the timing line: nearest multiple of L to s0
  const sLine = Math.round(s0 / L) * L
  const dist = ss.map((s) => s - sLine)
  const out = {
    t: new Float32Array(n), speed: new Float32Array(n), throttle: new Float32Array(n), brake: new Float32Array(n),
    gear: new Uint8Array(n), d: new Float32Array(n),
  }
  let j = 0
  for (let k = 0; k < n; k++) {
    while (j + 1 < dist.length && dist[j + 1] < k) j++
    const j2 = Math.min(dist.length - 1, j + 1)
    const span = dist[j2] - dist[j]
    const u = span > 1e-6 ? THREE.MathUtils.clamp((k - dist[j]) / span, 0, 1) : 0
    const lerp = (a: number[]) => a[j] + (a[j2] - a[j]) * u
    out.t[k] = k < dist[0] ? 0 : lerp(tt)
    out.speed[k] = lerp(sp); out.throttle[k] = lerp(th); out.brake[k] = lerp(br); out.d[k] = lerp(dd)
    out.gear[k] = u < 0.5 ? gr[j] : gr[j2]
  }
  const brakePoints: number[] = []
  for (let k = 1; k < n; k++) if (out.brake[k] > 50 && out.brake[k - 1] <= 50 && (brakePoints.length === 0 || k - brakePoints[brakePoints.length - 1] > 60)) brakePoints.push(k)
  return {
    driver: rt.byNum.get(driver)!.driver, lap, lapTime: t1 - t0, sStart: sLine, length: L, ...out, brakePoints,
  }
}

/** Time delta (B - A) at each metre: positive = B slower. */
export function deltaTrace(a: LapTrace, b: LapTrace) {
  const n = Math.min(a.t.length, b.t.length)
  const d = new Float32Array(n)
  for (let k = 0; k < n; k++) d[k] = b.t[k] - a.t[k]
  return d
}

function distanceAtTime(tr: LapTrace, tau: number) {
  // binary search the monotonic time-at-distance array
  const t = tr.t
  if (tau <= 0) return 0
  if (tau >= tr.lapTime) return tr.length
  let lo = 0, hi = t.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= tau) lo = m; else hi = m }
  const u = t[hi] > t[lo] ? (tau - t[lo]) / (t[hi] - t[lo]) : 0
  return lo + u
}

/**
 * Lap duel: two ghost cars replaying chosen laps on a shared lap clock from the same line.
 * Owns its own clock; the race clock is paused while a duel runs.
 */
export class Duel {
  readonly a: LapTrace
  readonly b: LapTrace
  readonly clock: ReplayClock
  readonly delta: Float32Array
  readonly poses: [CarPose, CarPose]
  private f = newFrame()

  constructor(private rt: RaceRuntime, a: LapTrace, b: LapTrace) {
    this.a = a
    this.b = b
    this.clock = new ReplayClock(-2, Math.max(a.lapTime, b.lapTime) + 2, -2)
    this.clock.setRate(1)
    this.delta = deltaTrace(a, b)
    const mk = (tr: LapTrace, index: number): CarPose => ({
      driver: tr.driver, index, sample: newSample(), visible: true, position: new THREE.Vector3(), forward: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(0, 0, -1), yaw: 0, pitch: 0, roll: 0, steer: 0, wheelSpin: 0, brakeGlow: 0, drsOpen: false,
      rainLight: false, lapDistance: 0, racePosition: index + 1,
    })
    this.poses = [mk(a, 0), mk(b, 1)]
  }

  update(dt: number) {
    this.clock.tick(dt)
    const tau = this.clock.time
    this.place(this.a, this.poses[0], tau, dt)
    this.place(this.b, this.poses[1], tau, dt)
  }

  private place(tr: LapTrace, p: CarPose, tau: number, dt: number) {
    const c = this.rt.circuit
    const dist = distanceAtTime(tr, tau)
    const k = Math.min(tr.length - 1, Math.floor(dist))
    const s = tr.sStart + dist
    const lat = tr.d[k] ?? 0
    const f = c.frame(s, lat, this.f)
    p.position.set(f.x, f.y, f.z)
    const k2 = Math.min(tr.length - 1, k + 3)
    const ahead = c.frame(s + 3, tr.d[k2] ?? lat, newFrame())
    const dx = ahead.x - f.x, dz = ahead.z - f.z
    p.yaw = Math.atan2(-dz, dx)
    p.pitch = Math.atan((ahead.y - f.y) / 3)
    p.roll = 0
    p.forward.set(dx, 0, dz).normalize()
    p.left.set(f.nx, 0, f.nz)
    const sp = tr.speed[k] ?? 0
    p.sample.v = sp / 3.6
    p.sample.speed = sp
    p.sample.s = s
    p.sample.throttle = tr.throttle[k] ?? 0
    p.sample.brake = tr.brake[k] ?? 0
    p.sample.gear = tr.gear[k] ?? 0
    p.sample.visible = p.sample.valid = true
    p.visible = tau >= -2
    const target = THREE.MathUtils.clamp(Math.atan(WHEELBASE * f.curvature) * 1.6, -0.38, 0.38)
    p.steer += (target - p.steer) * Math.min(1, dt * 10)
    p.wheelSpin = (s / WHEEL_R) % (Math.PI * 2)
    p.brakeGlow = p.sample.brake > 50 ? 1 : 0
    p.lapDistance = c.wrap(s)
  }

  /** Current distance of each ghost and live delta (B relative to A at A's position). */
  status() {
    const tau = this.clock.time
    const dA = distanceAtTime(this.a, tau), dB = distanceAtTime(this.b, tau)
    const k = Math.max(0, Math.min(this.delta.length - 1, Math.floor(Math.min(dA, dB))))
    return { tau, dA, dB, delta: this.delta[k], gapMeters: dA - dB }
  }
}
