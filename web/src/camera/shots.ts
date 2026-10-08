import * as THREE from 'three'
import type { CircuitModel } from '../data/circuit'
import type { CarPose, RaceRuntime } from '../replay/runtime'
import type { CameraMode } from '../state/ui'

/** Desired camera state for a frame. */
export interface Shot {
  pos: THREE.Vector3
  look: THREE.Vector3
  fov: number
  up?: THREE.Vector3
  /** 0..1: how tightly the rig should follow (1 = locked, e.g. onboard) */
  stiffness: number
  dof?: number // focus distance for depth-of-field (optional)
  shake?: number
}

export interface TracksideCam {
  s: number
  pos: THREE.Vector3
  kind: 'corner' | 'straight' | 'pit' | 'start'
  label: string
}

/** Automatically generated broadcast-style camera positions around the lap. */
export function tracksideCameras(c: CircuitModel, heightAt: (x: number, z: number) => number, buildingHeightAt?: (x: number, z: number) => number): TracksideCam[] {
  const cams: TracksideCam[] = []
  // street circuits: cameras sit on buildings/gantries — higher and closer to the wall
  const street = !!(c.meta as { street?: boolean }).street
  const H = street ? 1.65 : 1, OFF = street ? 0.45 : 1
  const f = { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 0, grade: 0, curvature: 0 }
  const place = (s: number, side: number, extra: number, h: number, kind: TracksideCam['kind'], label: string) => {
    const i = Math.floor(c.wrap(s) / c.ds) % c.n
    const d = side > 0 ? c.barrierLeft[i] + extra : c.barrierRight[i] - extra
    c.frame(s, d, f)
    const gy = Math.max(heightAt(f.x, f.z), f.y)
    // ensure camera is above any nearby building
    const bh = buildingHeightAt ? buildingHeightAt(f.x, f.z) : 0
    const camH = Math.max(h, bh - gy + 5)
    cams.push({ s: c.wrap(s), pos: new THREE.Vector3(f.x, gy + camH, f.z), kind, label })
  }
  for (const k of c.meta.corners) {
    const i = Math.floor(k.s / c.ds) % c.n
    const outside = c.curvature[i] > 0 ? -1 : 1
    place(k.s + 25, outside, 22 * OFF, 20 * H, 'corner', `T${k.label}`)
  }
  // straights: every ~350 m where no corner camera is close
  for (let s = 0; s < c.length; s += 350) {
    if (cams.some((x) => Math.abs(x.s - s) < 160)) continue
    place(s, ((s / 350) | 0) % 2 ? 1 : -1, 15 * OFF, 18 * H, 'straight', 'Straight')
  }
  place(40, c.meta.pit.side === 'left' ? -1 : 1, 15, 18, 'start', 'Start/Finish')
  return cams.sort((a, b) => a.s - b.s)
}

const V = () => new THREE.Vector3()

function carPoint(p: CarPose, x: number, y: number, z: number, out: THREE.Vector3) {
  // car frame: +X forward, +Y up, +Z right; yaw about Y
  const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw)
  // world = R_y(yaw) * (x, y, z): x' = x cos + z sin ; z' = -x sin + z cos
  out.set(p.position.x + x * cy + z * sy, p.position.y + y + x * Math.sin(p.pitch), p.position.z - x * sy + z * cy)
  return out
}

export interface ShotContext {
  rt: RaceRuntime
  target: CarPose
  secondary?: CarPose | null
  cams: TracksideCam[]
  camera: THREE.PerspectiveCamera
  time: number
  shotTime: number // seconds since this shot started
  seed: number
  heightAt: (x: number, z: number) => number
}

/** Shot generators. Each returns the ideal camera for the current frame. */
export const SHOTS: Partial<Record<CameraMode, (ctx: ShotContext, out: Shot) => Shot>> = {
  chase(ctx, out) {
    const p = ctx.target
    const speed = p.sample.v
    const back = 8.5 + speed * 0.012
    carPoint(p, -back, 2.4 + speed * 0.002, 0, out.pos)
    carPoint(p, 6, 0.9, 0, out.look)
    out.fov = 52 + Math.min(10, speed * 0.08)
    out.stiffness = 0.12
    out.shake = 0.02 + speed * 0.0003
    return out
  },
  close(ctx, out) {
    const p = ctx.target
    carPoint(p, -5.2, 1.25, 0.0, out.pos)
    carPoint(p, 4, 0.7, 0, out.look)
    out.fov = 58
    out.stiffness = 0.25
    out.shake = 0.03 + p.sample.v * 0.0004
    return out
  },
  onboard(ctx, out) {
    // T-camera above the airbox
    const p = ctx.target
    carPoint(p, -0.3, 1.2, 0, out.pos)
    carPoint(p, 20, 0.6, 0, out.look)
    out.fov = 72
    out.stiffness = 1
    out.shake = 0.004 + p.sample.v * 0.00005
    return out
  },
  cockpit(ctx, out) {
    const p = ctx.target
    carPoint(p, 0.02, 0.9, 0, out.pos)
    carPoint(p, 20, 0.55, 0, out.look)
    out.fov = 78
    out.stiffness = 1
    out.shake = 0.006 + p.sample.v * 0.00008
    return out
  },
  heli(ctx, out) {
    const p = ctx.target
    const a = ctx.seed * Math.PI * 2 + ctx.shotTime * 0.03
    const r = 95
    out.pos.set(p.position.x + Math.cos(a) * r, p.position.y + 85, p.position.z + Math.sin(a) * r)
    // lead the car slightly
    carPoint(p, 25 + p.sample.v * 0.3, 0, 0, out.look)
    out.fov = 34
    out.stiffness = 0.05
    return out
  },
  top(ctx, out) {
    const p = ctx.target
    out.pos.set(p.position.x, p.position.y + 420, p.position.z + 0.01)
    out.look.copy(p.position)
    out.fov = 40
    out.stiffness = 0.08
    out.up = new THREE.Vector3(0, 0, -1)
    return out
  },
  tv(ctx, out) {
    // nearest trackside camera ahead of/at the car: long lens pan
    const p = ctx.target
    const cam = pickTrackside(ctx)
    out.pos.copy(cam.pos)
    carPoint(p, 3 + p.sample.v * 0.08, 0.6, 0, out.look)
    const dist = cam.pos.distanceTo(p.position)
    out.fov = THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(9 / dist)), 6, 55)
    out.stiffness = 0.35
    out.dof = dist
    return out
  },
  trackside(ctx, out) {
    return SHOTS.tv!(ctx, out)
  },
  cinematic(ctx, out) {
    // low dolly: camera sits by the track ahead and sweeps as the car passes
    const p = ctx.target
    const c = ctx.rt.circuit
    const anchorS = (ctx.target.sample.s - (ctx.shotTime * p.sample.v) + 90)
    const i = Math.floor(c.wrap(anchorS) / c.ds) % c.n
    const side = ctx.seed > 0.5 ? 1 : -1
    const d = side > 0 ? c.left[i] + 3.5 : c.right[i] - 3.5
    const f = c.frame(anchorS, d, { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 0, grade: 0, curvature: 0 })
    out.pos.set(f.x, f.y + 0.7, f.z)
    carPoint(p, 1.5, 0.5, 0, out.look)
    const dist = out.pos.distanceTo(p.position)
    out.fov = THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(4.5 / dist)), 8, 60)
    out.stiffness = 0.5
    out.dof = dist
    return out
  },
}

function pickTrackside(ctx: ShotContext): TracksideCam {
  const p = ctx.target
  const c = ctx.rt.circuit
  const s = p.lapDistance
  // prefer the camera 20..220 m ahead; fall back to nearest
  let best = ctx.cams[0], bestScore = Infinity
  for (const cam of ctx.cams) {
    let ds = cam.s - s
    if (ds < -c.length / 2) ds += c.length
    if (ds > c.length / 2) ds -= c.length
    const score = ds > -40 && ds < 240 ? Math.abs(ds - 60) : 1000 + Math.abs(ds)
    if (score < bestScore) { bestScore = score; best = cam }
  }
  return best
}

export function newShot(): Shot {
  return { pos: V(), look: V(), fov: 50, stiffness: 0.2 }
}
