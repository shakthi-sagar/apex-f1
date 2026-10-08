import * as THREE from 'three'
import type { Livery } from '../../data/types'
import { airfoil, loft, merge, mirrorZ, plate, rod, sweepWing, tube, tyre, type Section } from './geometry'

/**
 * Procedural 2022+-regulation Formula 1 car ("ground-effect era" proportions).
 * Original geometry — no third-party model is used. Per-season/team glTF assets can
 * replace it through the CarAssetProvider (see carAssets.ts).
 *
 * Frame: +X forward, +Y up, +Z right, origin = ground, mid-wheelbase.
 */

export const DIM = {
  wheelbase: 3.6,
  trackF: 1.62,
  trackR: 1.56,
  wheelR: 0.36,
  tyreWF: 0.305,
  tyreWR: 0.405,
  rimR: 0.235,
}
const FX = DIM.wheelbase / 2
const RX = -DIM.wheelbase / 2

export interface CarGeometries {
  body: THREE.BufferGeometry // livery-painted surfaces
  carbon: THREE.BufferGeometry // unpainted carbon: floor, wings, suspension
  dark: THREE.BufferGeometry // inlets, cockpit interior
  halo: THREE.BufferGeometry
  helmet: THREE.BufferGeometry
  visor: THREE.BufferGeometry
  tyreF: THREE.BufferGeometry
  tyreR: THREE.BufferGeometry
  rim: THREE.BufferGeometry
  cover: THREE.BufferGeometry
  band: THREE.BufferGeometry
  flap: THREE.BufferGeometry // DRS flap (pivot at origin)
  flapPivot: THREE.Vector3
  rainLight: THREE.BufferGeometry
  shadow: THREE.BufferGeometry
  numberPlate: THREE.BufferGeometry
}

let cached: CarGeometries | null = null

export function carGeometries(): CarGeometries {
  if (cached) return cached
  // ---------------------------------------------------------------- monocoque + nose + engine cover
  const chassis: Section[] = [
    { x: 2.62, w: 0.13, top: 0.235, bot: 0.14, n: 2.2 },
    { x: 2.45, w: 0.2, top: 0.27, bot: 0.13, n: 2.3 },
    { x: 2.15, w: 0.28, top: 0.34, bot: 0.12, n: 2.5 },
    { x: 1.8, w: 0.36, top: 0.45, bot: 0.11, n: 2.8 },
    { x: 1.35, w: 0.5, top: 0.56, bot: 0.09, n: 3.2, nb: 5 },
    { x: 0.85, w: 0.66, top: 0.63, bot: 0.07, n: 3.4, nb: 6 },
    { x: 0.45, w: 0.72, top: 0.64, bot: 0.07, n: 3.4, nb: 6 },
    { x: 0.0, w: 0.76, top: 0.64, bot: 0.07, n: 3.2, nb: 6 },
    { x: -0.3, w: 0.62, top: 0.9, bot: 0.07, n: 2.6, nb: 6 },
    { x: -0.55, w: 0.56, top: 0.93, bot: 0.07, n: 2.4, nb: 6 },
    { x: -0.95, w: 0.5, top: 0.82, bot: 0.08, n: 2.4, nb: 5 },
    { x: -1.45, w: 0.36, top: 0.6, bot: 0.1, n: 2.4, nb: 4 },
    { x: -1.9, w: 0.26, top: 0.44, bot: 0.14, n: 2.4, nb: 3 },
    { x: -2.3, w: 0.19, top: 0.36, bot: 0.18, n: 2.4 },
    { x: -2.52, w: 0.12, top: 0.3, bot: 0.2, n: 2.2 },
  ]
  const chassisG = loft(chassis, 44, 5)

  // sidepods (right side, mirrored). Undercut: bottom rises toward the front.
  const pod: Section[] = [
    { x: 0.98, w: 0.3, top: 0.58, bot: 0.4, zc: 0.52, n: 3.0, nb: 2.4 },
    { x: 0.78, w: 0.42, top: 0.61, bot: 0.3, zc: 0.54, n: 3.4, nb: 2.6 },
    { x: 0.4, w: 0.47, top: 0.6, bot: 0.2, zc: 0.53, n: 3.6, nb: 3.0 },
    { x: -0.2, w: 0.44, top: 0.55, bot: 0.13, zc: 0.49, n: 3.4, nb: 3.6 },
    { x: -0.85, w: 0.32, top: 0.45, bot: 0.1, zc: 0.41, n: 3.0, nb: 4 },
    { x: -1.4, w: 0.2, top: 0.34, bot: 0.1, zc: 0.3, n: 2.8, nb: 4 },
    { x: -1.75, w: 0.1, top: 0.24, bot: 0.12, zc: 0.2, n: 2.5 },
  ]
  const podR = loft(pod, 32, 5, false, true)
  const podL = mirrorZ(podR)
  // sidepod inlet mouth (dark)
  // slot-style inlet: short, wide mouth under the leading edge
  const inletR = plate([[0, 0], [0.28, 0], [0.28, 0.12], [0, 0.12]], 0.02, 0.004)
  inletR.rotateY(-Math.PI / 2)
  inletR.translate(0.985, 0.43, 0.38)
  const inletL = mirrorZ(inletR)
  // engine cover fin (shark fin)
  const fin = plate([[-0.62, 0.92], [-1.55, 0.83], [-1.72, 0.72], [-1.0, 0.7], [-0.62, 0.8]], 0.01, 0.002)
  // airbox intake (dark)
  const airbox = loft([
    { x: -0.18, w: 0.2, top: 0.97, bot: 0.8, n: 2.4 },
    { x: -0.3, w: 0.24, top: 0.99, bot: 0.78, n: 2.4 },
    { x: -0.55, w: 0.26, top: 0.96, bot: 0.78, n: 2.4 },
  ], 24, 3)
  // cockpit rim + opening
  const cockpitRim = tube([
    new THREE.Vector3(0.55, 0.64, 0), new THREE.Vector3(0.45, 0.645, 0.2), new THREE.Vector3(0.05, 0.65, 0.29),
    new THREE.Vector3(-0.25, 0.68, 0.24), new THREE.Vector3(-0.32, 0.7, 0), new THREE.Vector3(-0.25, 0.68, -0.24),
    new THREE.Vector3(0.05, 0.65, -0.29), new THREE.Vector3(0.45, 0.645, -0.2),
  ], 0.022, 80, true)
  const cockpitHole = new THREE.CircleGeometry(1, 48)
  cockpitHole.rotateX(-Math.PI / 2)
  cockpitHole.scale(0.42, 1, 0.27)
  cockpitHole.translate(0.12, 0.652, 0)

  // ---------------------------------------------------------------- floor & diffuser
  const floorShape: [number, number][] = [
    [1.15, -0.2], [1.0, -0.62], [0.7, -0.92], [-1.2, -0.95], [-1.45, -0.88], [-1.62, -0.56], [-2.05, -0.5],
    [-2.05, 0.5], [-1.62, 0.56], [-1.45, 0.88], [-1.2, 0.95], [0.7, 0.92], [1.0, 0.62], [1.15, 0.2],
  ]
  const floor = plate(floorShape, 0.025, 0.004)
  floor.rotateX(Math.PI / 2)
  floor.translate(0, 0.055, 0)
  // floor edge fences / edge wing
  const edgeR = plate([[0.9, 0.055], [-1.25, 0.055], [-1.25, 0.1], [0.6, 0.12]], 0.01)
  edgeR.translate(0, 0, 0.93)
  const edgeL = mirrorZ(edgeR)
  // diffuser ramp
  const diffuser = plate([[-1.65, 0.06], [-2.08, 0.26], [-2.08, 0.3], [-1.65, 0.09]], 1.0)
  const plank = plate([[1.0, 0.03], [-1.6, 0.03], [-1.6, 0.045], [1.0, 0.045]], 0.3)

  // ---------------------------------------------------------------- front wing
  const fwParts: THREE.BufferGeometry[] = []
  const fwMain = sweepWing(airfoil(0.34, 0.08, 1.9, 0.08), 0.95, 0.03, 2, 0.02, 0.1)
  fwMain.translate(2.95, 0.085, 0)
  fwParts.push(fwMain)
  const flaps = [
    { c: 0.2, x: 2.72, y: 0.12, up: 0.1, span: 1.78, aoa: -0.25 },
    { c: 0.17, x: 2.6, y: 0.16, up: 0.16, span: 1.72, aoa: -0.42 },
    { c: 0.14, x: 2.5, y: 0.2, up: 0.2, span: 1.64, aoa: -0.6 },
  ]
  const fwFlaps: THREE.BufferGeometry[] = []
  for (const f of flaps) {
    const g = sweepWing(airfoil(f.c, 0.1, f.span, 0.1), f.span / 2, f.up, 2.2, f.aoa * 0.4, f.aoa)
    g.translate(f.x, f.y, 0)
    fwFlaps.push(g)
  }
  // flaps are painted in the livery (top element), rest carbon
  const fwEndR = plate([[2.98, 0.045], [2.44, 0.05], [2.4, 0.16], [2.5, 0.29], [2.66, 0.31], [2.86, 0.2], [2.98, 0.1]], 0.01)
  fwEndR.translate(0, 0, 0.965)
  const fwEndL = mirrorZ(fwEndR)
  // nose pylons to main plane
  const noseMount = plate([[2.78, 0.14], [2.56, 0.14], [2.6, 0.2], [2.78, 0.2]], 0.1)

  // ---------------------------------------------------------------- rear wing + beam wing + pylon
  const rwMain = sweepWing(airfoil(0.36, 0.12, 1.0, 0.1), 0.5, -0.03, 2, -0.18, -0.1)
  rwMain.translate(-2.36, 0.83, 0)
  const flapPivot = new THREE.Vector3(-2.6, 0.93, 0)
  const flap = sweepWing(airfoil(0.24, 0.12, 0.98, 0.08), 0.49, -0.02, 2, -0.5, -0.45)
  const rwEndR = plate([[-2.3, 0.62], [-2.8, 0.6], [-2.84, 0.86], [-2.78, 0.99], [-2.62, 1.04], [-2.44, 1.0], [-2.32, 0.88]], 0.012)
  rwEndR.translate(0, 0, 0.51)
  const rwEndL = mirrorZ(rwEndR)
  const beam = sweepWing(airfoil(0.2, 0.12, 0.9, 0.08), 0.45, 0, 2, -0.2, -0.2)
  beam.translate(-2.38, 0.42, 0)
  const beam2 = sweepWing(airfoil(0.15, 0.12, 0.9, 0.08), 0.45, 0, 2, -0.45, -0.45)
  beam2.translate(-2.55, 0.48, 0)
  const pylon = plate([[-2.25, 0.3], [-2.5, 0.3], [-2.62, 0.86], [-2.54, 0.9]], 0.03)
  const crash = loft([
    { x: -2.45, w: 0.14, top: 0.32, bot: 0.2, n: 2.5 },
    { x: -2.7, w: 0.1, top: 0.3, bot: 0.22, n: 2.5 },
  ], 16, 2)

  // ---------------------------------------------------------------- suspension (carbon wishbones)
  const susp: THREE.BufferGeometry[] = []
  const hubF = new THREE.Vector3(FX, DIM.wheelR, DIM.trackF / 2 - 0.12)
  const hubR = new THREE.Vector3(RX, DIM.wheelR, DIM.trackR / 2 - 0.15)
  const armPairs: [THREE.Vector3, THREE.Vector3, number][] = [
    [new THREE.Vector3(FX + 0.25, 0.42, 0.18), hubF.clone().add(new THREE.Vector3(0, 0.12, 0)), 0.018],
    [new THREE.Vector3(FX - 0.35, 0.44, 0.2), hubF.clone().add(new THREE.Vector3(0, 0.12, 0)), 0.018],
    [new THREE.Vector3(FX + 0.25, 0.22, 0.14), hubF.clone().add(new THREE.Vector3(0, -0.1, 0)), 0.018],
    [new THREE.Vector3(FX - 0.35, 0.2, 0.18), hubF.clone().add(new THREE.Vector3(0, -0.1, 0)), 0.018],
    [new THREE.Vector3(FX - 0.05, 0.25, 0.16), hubF.clone().add(new THREE.Vector3(0, 0.02, 0)), 0.012],
    [new THREE.Vector3(RX + 0.3, 0.42, 0.14), hubR.clone().add(new THREE.Vector3(0, 0.13, 0)), 0.018],
    [new THREE.Vector3(RX - 0.2, 0.44, 0.12), hubR.clone().add(new THREE.Vector3(0, 0.13, 0)), 0.018],
    [new THREE.Vector3(RX + 0.3, 0.2, 0.14), hubR.clone().add(new THREE.Vector3(0, -0.1, 0)), 0.018],
    [new THREE.Vector3(RX - 0.25, 0.22, 0.12), hubR.clone().add(new THREE.Vector3(0, -0.1, 0)), 0.018],
  ]
  for (const [a, b, r] of armPairs) {
    susp.push(rod(a, b, r))
    const a2 = a.clone(), b2 = b.clone()
    a2.z *= -1; b2.z *= -1
    susp.push(rod(a2, b2, r))
  }
  // mirrors
  const mirrorR = plate([[0.62, 0.72], [0.48, 0.72], [0.48, 0.79], [0.62, 0.79]], 0.14, 0.01)
  mirrorR.translate(0, 0, 0.52)
  const mirrorL = mirrorZ(mirrorR)
  const mirrorStalkR = rod(new THREE.Vector3(0.55, 0.6, 0.36), new THREE.Vector3(0.55, 0.73, 0.5), 0.01)
  const mirrorStalkL = mirrorZ(mirrorStalkR)
  // T-camera on airbox
  const tcam = plate([[-0.1, 0.99], [-0.28, 0.99], [-0.28, 1.03], [-0.1, 1.03]], 0.14, 0.008)

  // ---------------------------------------------------------------- halo
  const halo = merge([
    tube([
      new THREE.Vector3(-0.3, 0.69, -0.3), new THREE.Vector3(-0.12, 0.83, -0.3), new THREE.Vector3(0.2, 0.87, -0.23),
      new THREE.Vector3(0.4, 0.875, 0), new THREE.Vector3(0.2, 0.87, 0.23), new THREE.Vector3(-0.12, 0.83, 0.3),
      new THREE.Vector3(-0.3, 0.69, 0.3),
    ], 0.028, 90),
    tube([new THREE.Vector3(0.4, 0.875, 0), new THREE.Vector3(0.52, 0.8, 0), new THREE.Vector3(0.63, 0.64, 0)], 0.024, 20),
  ])
  // driver helmet
  const helmet = new THREE.SphereGeometry(0.135, 32, 20)
  helmet.scale(1.1, 1, 0.95)
  helmet.translate(0.02, 0.78, 0)
  const visor = new THREE.SphereGeometry(0.137, 24, 10, -0.9, 1.8, 1.25, 0.45)
  visor.rotateY(Math.PI / 2 + Math.PI)
  visor.scale(1.1, 1, 0.95)
  visor.translate(0.02, 0.78, 0)
  visor.rotateY(0)

  // ---------------------------------------------------------------- wheels (built around origin; placed by the car)
  const tyreF = tyre(DIM.wheelR, DIM.tyreWF, DIM.rimR)
  const tyreR = tyre(DIM.wheelR, DIM.tyreWR, DIM.rimR)
  const rim = new THREE.CylinderGeometry(DIM.rimR, DIM.rimR, 0.3, 40, 1, true)
  rim.rotateX(Math.PI / 2)
  // wheel covers (flat aero discs) with a hub
  const cover = merge([new THREE.CircleGeometry(DIM.rimR * 0.99, 40), new THREE.CylinderGeometry(0.05, 0.06, 0.03, 16).rotateX(Math.PI / 2).translate(0, 0, 0.015)])
  // compound band on the outer sidewall
  const band = new THREE.RingGeometry(0.308, 0.316, 64)

  // ---------------------------------------------------------------- rain light, shadow, number plate
  const rainLight = new THREE.BoxGeometry(0.05, 0.05, 0.1)
  rainLight.translate(-2.72, 0.26, 0)
  const shadow = new THREE.PlaneGeometry(6.2, 2.6)
  shadow.rotateX(-Math.PI / 2)
  shadow.translate(-0.05, 0.02, 0)
  const numberPlate = new THREE.PlaneGeometry(0.28, 0.2)

  const bodyParts = [chassisG, podR, podL, fin, fwFlaps[2], fwEndR, fwEndL, rwEndR, rwEndL, mirrorR, mirrorL, crash]
  cached = {
    body: merge(bodyParts),
    carbon: merge([floor, edgeR, edgeL, diffuser, plank, fwMain, fwFlaps[0], fwFlaps[1], noseMount, rwMain, beam, beam2,
      pylon, ...susp, mirrorStalkR, mirrorStalkL]),
    dark: merge([inletR, inletL, airbox, cockpitHole, tcam]),
    halo: merge([halo, cockpitRim]),
    helmet: merge([helmet]),
    visor: merge([visor]),
    tyreF: merge([tyreF]),
    tyreR: merge([tyreR]),
    rim: merge([rim]),
    cover: merge([cover]),
    band: merge([band]),
    flap: (() => { const f = flap.clone(); return merge([f]) })(),
    flapPivot,
    rainLight: merge([rainLight]),
    shadow,
    numberPlate,
  }
  return cached
}

// ------------------------------------------------------------------------------------------------ materials

const COMPOUND_COLORS: Record<number, string> = { 1: '#ff2d2d', 2: '#ffd12b', 3: '#f2f2f2', 4: '#3ad14a', 5: '#2f8cff', 0: '#888888' }
export const compoundColor = (c: number) => COMPOUND_COLORS[c] ?? '#888'

/**
 * Livery shader: team primary/secondary/accent assigned procedurally by position on the car
 * (lower-body secondary band, spine stripe, nose tip & endplate accents). No sponsor marks.
 */
export function liveryMaterial(l: Livery, envIntensity = 1): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: l.finish === 'satin' ? 0.38 : 0.2,
    metalness: 0.22,
    clearcoat: l.finish === 'satin' ? 0.3 : 1.0,
    clearcoatRoughness: l.finish === 'satin' ? 0.3 : 0.05,
    envMapIntensity: envIntensity * 1.2,
  })
  const uniforms = {
    uPrimary: { value: new THREE.Color(l.primary) },
    uSecondary: { value: new THREE.Color(l.secondary) },
    uAccent: { value: new THREE.Color(l.accent) },
    uHighlight: { value: new THREE.Color(l.highlight) },
  }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCarPos;
uniform vec3 uPrimary; uniform vec3 uSecondary; uniform vec3 uAccent; uniform vec3 uHighlight;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 p = vCarPos;
  vec3 col = uPrimary;
  // lower body / sidepod flank band in secondary colour, swooping up toward the rear
  float bandY = 0.36 + 0.06 * smoothstep(0.8, -1.6, p.x);
  float lower = smoothstep(bandY + 0.015, bandY - 0.015, p.y);
  col = mix(col, uSecondary, lower);
  // spine stripe along nose + engine cover
  float spine = smoothstep(0.045, 0.03, abs(p.z)) * step(0.5, p.y) * step(p.x, 2.7) * step(-1.6, p.x);
  col = mix(col, uAccent, spine * 0.9);
  // thin highlight pinstripe at the band edge
  float pin = smoothstep(0.012, 0.0, abs(p.y - bandY - 0.03)) * step(abs(p.z), 0.8);
  col = mix(col, uHighlight, pin * 0.85);
  // nose tip & wing endplates / top flap in accent
  float tip = step(2.42, p.x) * step(abs(p.z), 0.2);
  float endplates = step(0.9, abs(p.z)) * step(2.2, p.x);
  float rearEnd = step(0.49, abs(p.z)) * step(p.x, -2.2);
  float flapTop = step(2.4, p.x) * step(0.19, p.y) * step(abs(p.z), 0.9);
  col = mix(col, uAccent, max(max(tip, flapTop), 0.0));
  col = mix(col, uSecondary, max(endplates, rearEnd));
  diffuseColor.rgb = col;
}`)
  }
  m.customProgramCacheKey = () => 'livery-v1'
  ;(m.userData as { uniforms: typeof uniforms }).uniforms = uniforms
  return m
}

export function numberTexture(num: string, color: string, bg: string | null = null) {
  const c = document.createElement('canvas')
  c.width = 256; c.height = 192
  const g = c.getContext('2d')!
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, 256, 192) }
  g.fillStyle = color
  g.font = '900 150px "Titillium Web", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(num, 128, 104)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

let sidewallTex: THREE.Texture | null = null
/** Generic sidewall markings (no trademarks) so wheel rotation is readable. */
export function sidewallTexture() {
  if (sidewallTex) return sidewallTex
  const c = document.createElement('canvas')
  c.width = 512; c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#1a1a1c'
  g.fillRect(0, 0, 512, 64)
  g.fillStyle = '#d9d9d9'
  for (let i = 0; i < 4; i++) {
    g.fillRect(i * 128 + 20, 26, 60, 10)
    g.fillRect(i * 128 + 88, 26, 14, 10)
  }
  sidewallTex = new THREE.CanvasTexture(c)
  sidewallTex.wrapS = THREE.RepeatWrapping
  sidewallTex.colorSpace = THREE.SRGBColorSpace
  return sidewallTex
}

export const sharedMaterials = (() => {
  let m: ReturnType<typeof make> | null = null
  function make() {
    return {
      carbon: new THREE.MeshPhysicalMaterial({ color: 0x0d0e10, roughness: 0.38, metalness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.8, metalness: 0 }),
      halo: new THREE.MeshPhysicalMaterial({ color: 0x1a1b1e, roughness: 0.3, metalness: 0.6, clearcoat: 0.8 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.82, metalness: 0 }),
      rim: new THREE.MeshStandardMaterial({ color: 0x222325, roughness: 0.35, metalness: 0.9 }),
      cover: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.5, metalness: 0.5 }),
      visor: new THREE.MeshPhysicalMaterial({ color: 0x0a0a0a, roughness: 0.05, metalness: 0.9, clearcoat: 1 }),
      shadow: (() => {
        const c = document.createElement('canvas')
        c.width = 128; c.height = 64
        const g = c.getContext('2d')!
        const grd = g.createRadialGradient(64, 32, 4, 64, 32, 62)
        grd.addColorStop(0, 'rgba(0,0,0,0.75)')
        grd.addColorStop(0.55, 'rgba(0,0,0,0.45)')
        grd.addColorStop(1, 'rgba(0,0,0,0)')
        g.fillStyle = grd
        g.fillRect(0, 0, 128, 64)
        const t = new THREE.CanvasTexture(c)
        return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 })
      })(),
    }
  }
  return () => (m ??= make())
})()
