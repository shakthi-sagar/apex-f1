import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { DriverInfo } from '../../data/types'
import type { CarPose } from '../../replay/runtime'
import { loadCarParts } from './carAssets'
import { DIM, carGeometries, compoundColor, liveryMaterial, numberTexture, sharedMaterials } from './carModel'

/**
 * One race car, built for few draw calls: bodywork is one mesh per material (procedural, or the
 * Blender model flattened per material role), each wheel is a single vertex-coloured mesh with the
 * compound band recoloured in-shader, and the three number decals share one mesh.
 */

// ------------------------------------------------------------------ shared wheel geometry
const wheelCache = new Map<string, THREE.BufferGeometry>()

function colored(g: THREE.BufferGeometry, hex: string, band = 0) {
  let x = g.index ? g.toNonIndexed() : g.clone()
  for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'uv'].includes(k)) x.deleteAttribute(k)
  if (!x.attributes.uv) x.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(x.attributes.position.count * 2), 2))
  if (!x.attributes.normal) x.computeVertexNormals()
  const c = new THREE.Color(hex)
  const n = x.attributes.position.count
  const col = new Float32Array(n * 3), b = new Float32Array(n)
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; b[i] = band }
  x.setAttribute('color', new THREE.BufferAttribute(col, 3))
  x.setAttribute('aBand', new THREE.BufferAttribute(b, 1))
  x = x.index ? x.toNonIndexed() : x
  return x
}

function wheelGeometry(front: boolean, side: 1 | -1) {
  const key = `${front}${side}`
  let g = wheelCache.get(key)
  if (g) return g
  const G = carGeometries()
  const w = (front ? DIM.tyreWF : DIM.tyreWR) / 2
  const rim = G.rim.clone().scale(1, 1, (front ? DIM.tyreWF : DIM.tyreWR) / 0.3 * 0.95)
  const cover = G.cover.clone()
  const band = G.band.clone()
  const stripe = new THREE.PlaneGeometry(0.03, 0.06)
  const s1 = stripe.clone().translate(0, 0.3, 0), s2 = stripe.clone().translate(0, -0.3, 0)
  const outer = (x: THREE.BufferGeometry, z: number) => {
    if (side < 0) x.rotateY(Math.PI)
    return x.translate(0, 0, side * z)
  }
  g = mergeGeometries([
    colored(front ? G.tyreF : G.tyreR, '#151517'),
    colored(rim, '#2a2b2e'),
    colored(outer(cover, w - 0.02), '#141416'),
    colored(outer(band, w + 0.001), '#ffffff', 1),
    colored(outer(s1, w + 0.002), '#9a9a9a'),
    colored(outer(s2, w + 0.002), '#9a9a9a'),
  ], false)!
  g.computeBoundingSphere()
  wheelCache.set(key, g)
  return g
}

function wheelMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.15 })
  const u = { uBand: { value: new THREE.Color('#888') } }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBand = u.uBand
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBand; varying float vBand;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBand = aBand;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uBand; varying float vBand;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uBand, vBand);')
  }
  m.customProgramCacheKey = () => 'wheel-v1'
  ;(m.userData as { u: typeof u }).u = u
  return m
}

let numberGeo: THREE.BufferGeometry | null = null
function numberGeometry() {
  if (numberGeo) return numberGeo
  const G = carGeometries()
  const place = (pos: [number, number, number], rot: [number, number, number], sc: number) =>
    G.numberPlate.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(sc, sc, sc)))
  numberGeo = mergeGeometries([
    place([1.95, 0.32, 0.175], [0, 0.06, 0], 0.8),
    place([1.95, 0.32, -0.175], [0, Math.PI - 0.06, 0], 0.8),
    place([2.2, 0.395, 0], [-Math.PI / 2 + 0.25, 0, -Math.PI / 2], 0.62),
  ], false)!
  return numberGeo
}

export class Car {
  readonly root = new THREE.Group()
  readonly driver: DriverInfo
  private body = new THREE.Group() // pitch/roll frame
  private shell = new THREE.Group() // bodywork meshes (procedural or asset)
  private flap = new THREE.Group()
  private steerL = new THREE.Group()
  private steerR = new THREE.Group()
  private spins: THREE.Mesh[] = []
  private rainMat: THREE.MeshStandardMaterial
  private liveryMat: THREE.MeshPhysicalMaterial
  private helmetMat: THREE.MeshPhysicalMaterial
  private wheelMat = wheelMaterial()
  private compound = -1
  private highlight: THREE.Mesh
  private highlightMat: THREE.MeshBasicMaterial
  private flapOpen = 0.55

  constructor(driver: DriverInfo, season?: number) {
    this.driver = driver
    const G = carGeometries()
    const M = sharedMaterials()
    this.root.name = `car-${driver.num}`
    this.root.add(this.body)
    this.body.add(this.shell)
    this.liveryMat = liveryMaterial(driver.livery)
    this.helmetMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(driver.livery.accent).lerp(new THREE.Color('#ffffff'), 0.25), roughness: 0.25, clearcoat: 1 })
    this.rainMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color('#ff1a1a'), emissiveIntensity: 0 })

    // procedural bodywork (replaced by the Blender model once loaded)
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, cast: boolean) => {
      const mesh = new THREE.Mesh(g, m)
      mesh.castShadow = cast
      mesh.receiveShadow = cast
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      parent.add(mesh)
      return mesh
    }
    add(this.shell, G.body, this.liveryMat, true)
    add(this.shell, G.carbon, M.carbon, true)
    add(this.shell, G.dark, M.dark, false)
    add(this.shell, G.halo, M.halo, false)
    add(this.shell, G.helmet, this.helmetMat, false)
    add(this.shell, G.visor, M.visor, false)
    add(this.shell, G.rainLight, this.rainMat, false)
    this.flap.position.copy(G.flapPivot)
    add(this.flap, G.flap, this.liveryMat, false)
    this.body.add(this.flap)

    const numMat = new THREE.MeshBasicMaterial({ map: numberTexture(driver.num, driver.livery.number), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: false })
    add(this.body, numberGeometry(), numMat, false)

    // wheels: steer pivot (front) -> spinning mesh
    const zF = DIM.trackF / 2, zR = DIM.trackR / 2
    const wheel = (front: boolean, side: 1 | -1) => {
      const m = new THREE.Mesh(wheelGeometry(front, side), this.wheelMat)
      m.castShadow = true
      this.spins.push(m)
      return m
    }
    this.steerR.position.set(DIM.wheelbase / 2, DIM.wheelR, zF)
    this.steerR.add(wheel(true, 1))
    this.steerL.position.set(DIM.wheelbase / 2, DIM.wheelR, -zF)
    this.steerL.add(wheel(true, -1))
    const rr = wheel(false, 1); rr.position.set(-DIM.wheelbase / 2, DIM.wheelR, zR)
    const rl = wheel(false, -1); rl.position.set(-DIM.wheelbase / 2, DIM.wheelR, -zR)
    this.root.add(this.steerL, this.steerR, rr, rl)

    const blob = new THREE.Mesh(G.shadow, M.shadow)
    blob.renderOrder = -1
    blob.matrixAutoUpdate = false
    this.root.add(blob)
    this.highlightMat = new THREE.MeshBasicMaterial({ color: driver.color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(3.3, 3.55, 64).rotateX(-Math.PI / 2), this.highlightMat)
    this.highlight.position.y = 0.04
    this.highlight.scale.set(1, 1, 0.55)
    this.highlight.visible = false
    this.root.add(this.highlight)
    if (season) void this.tryAsset(season)
  }

  /** Swap the procedural bodywork for the published model (flattened per material role). */
  private async tryAsset(season: number) {
    const parts = await loadCarParts(season, this.driver.teamId)
    if (!parts || parts.entry.hideProceduralBody === false) return
    const M = sharedMaterials()
    const roles: Record<string, THREE.Material> = {
      livery: this.liveryMat, carbon: M.carbon, dark: M.dark, halo: M.halo, helmet: this.helmetMat, rainlight: this.rainMat, visor: M.visor,
    }
    const cast = new Set(['livery', 'carbon'])
    this.shell.clear()
    for (const { role, geometry } of parts.roles) {
      const mesh = new THREE.Mesh(geometry, roles[role] ?? M.carbon)
      mesh.castShadow = cast.has(role)
      mesh.receiveShadow = cast.has(role)
      mesh.matrixAutoUpdate = false
      this.shell.add(mesh)
    }
    this.flap.clear()
    if (parts.flap) {
      this.flap.position.copy(parts.flap.position)
      this.flap.quaternion.copy(parts.flap.quaternion)
      const fm = new THREE.Mesh(parts.flap.geometry, this.liveryMat)
      fm.matrixAutoUpdate = false
      this.flap.add(fm)
      this.flapOpen = -0.45
    }
    if (parts.entry.hideProceduralWheels) [this.steerL, this.steerR, ...this.spins].forEach((w) => (w.visible = false))
  }

  setCompound(c: number) {
    if (c === this.compound) return
    this.compound = c
    ;(this.wheelMat.userData as { u: { uBand: { value: THREE.Color } } }).u.uBand.value.set(compoundColor(c))
  }

  /** Ground ring marks the followed car — only useful from high/wide cameras. */
  setSelected(sel: boolean, t: number, wide: boolean) {
    const on = sel && wide
    this.highlight.visible = on
    if (on) this.highlightMat.opacity = 0.5 + 0.2 * Math.sin(t * 4)
  }

  update(p: CarPose, t: number) {
    this.root.visible = p.visible
    if (!p.visible) return
    this.root.position.copy(p.position)
    this.root.rotation.set(0, p.yaw, 0, 'YXZ')
    this.body.rotation.set(p.roll, 0, p.pitch, 'YXZ')
    this.steerL.rotation.y = p.steer
    this.steerR.rotation.y = p.steer
    for (const w of this.spins) w.rotation.z = -p.wheelSpin
    this.flap.rotation.z = p.drsOpen ? this.flapOpen : 0
    // FIA rain light blinks in wet conditions; pulses brighter under braking for readability
    const blink = p.rainLight ? (Math.floor(t * 4) % 2 === 0 ? 1 : 0.15) : 0
    this.rainMat.emissiveIntensity = Math.max(blink * 6, p.brakeGlow * 2)
  }

  dispose() {
    this.liveryMat.dispose(); this.helmetMat.dispose(); this.rainMat.dispose(); this.wheelMat.dispose(); this.highlightMat.dispose()
  }
}
