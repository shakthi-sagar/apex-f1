import * as THREE from 'three'
import type { DriverInfo } from '../../data/types'
import type { CarPose } from '../../replay/runtime'
import { loadCarModel } from './carAssets'
import { DIM, carGeometries, compoundColor, liveryMaterial, numberTexture, sharedMaterials } from './carModel'

/** One race car: shared geometry, per-car livery materials, animated wheels/DRS/lights. */
export class Car {
  readonly root = new THREE.Group()
  readonly driver: DriverInfo
  private body: THREE.Group
  private steerL: THREE.Group
  private steerR: THREE.Group
  private spins: THREE.Object3D[] = []
  private flap: THREE.Group
  private rainMat: THREE.MeshStandardMaterial
  private bandMat: THREE.MeshBasicMaterial
  private liveryMat: THREE.MeshPhysicalMaterial
  private compound = -1
  private highlight: THREE.Mesh
  private highlightMat: THREE.MeshBasicMaterial

  constructor(driver: DriverInfo, season?: number) {
    this.driver = driver
    const G = carGeometries()
    const M = sharedMaterials()
    this.root.name = `car-${driver.num}`
    this.body = new THREE.Group()
    this.root.add(this.body)
    this.liveryMat = liveryMaterial(driver.livery)
    const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = this.body, cast = true) => {
      const mesh = new THREE.Mesh(g, m)
      mesh.castShadow = cast
      mesh.receiveShadow = true
      parent.add(mesh)
      return mesh
    }
    add(G.body, this.liveryMat)
    add(G.carbon, M.carbon)
    add(G.dark, M.dark, this.body, false)
    add(G.halo, M.halo)
    const helmetMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(driver.livery.accent).lerp(new THREE.Color('#ffffff'), 0.25), roughness: 0.25, clearcoat: 1 })
    add(G.helmet, helmetMat)
    add(G.visor, M.visor, this.body, false)
    // DRS flap pivots about its leading edge
    this.flap = new THREE.Group()
    this.flap.position.copy(G.flapPivot)
    add(G.flap, this.liveryMat, this.flap)
    this.body.add(this.flap)
    // rain light / brake light
    this.rainMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: new THREE.Color('#ff1a1a'), emissiveIntensity: 0 })
    add(G.rainLight, this.rainMat, this.body, false)
    // numbers: nose sides + engine cover
    const numTex = numberTexture(driver.num, driver.livery.number)
    const numMat = new THREE.MeshBasicMaterial({ map: numTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, toneMapped: false })
    const nL = new THREE.Mesh(G.numberPlate, numMat)
    nL.position.set(1.95, 0.32, 0.175)
    nL.rotation.set(0, 0.06, 0)
    nL.scale.setScalar(0.8)
    const nR = nL.clone()
    nR.position.z = -0.175
    nR.rotation.y = Math.PI - 0.06
    const nTop = new THREE.Mesh(G.numberPlate, numMat)
    nTop.position.set(2.2, 0.395, 0)
    nTop.rotation.set(-Math.PI / 2 + 0.25, 0, -Math.PI / 2)
    nTop.scale.setScalar(0.62)
    this.body.add(nL, nR, nTop)

    // wheels
    this.bandMat = new THREE.MeshBasicMaterial({ color: '#888', toneMapped: true })
    const makeWheel = (front: boolean, side: 1 | -1) => {
      const spin = new THREE.Group()
      const t = add(front ? G.tyreF : G.tyreR, M.tyre, spin)
      t.castShadow = true
      const rim = add(G.rim, M.rim, spin, false)
      rim.scale.z = (front ? DIM.tyreWF : DIM.tyreWR) / 0.3 * 0.95
      const w = (front ? DIM.tyreWF : DIM.tyreWR) / 2
      const cover = add(G.cover, M.cover, spin, false)
      cover.position.z = side * (w - 0.02)
      if (side < 0) cover.rotation.y = Math.PI
      const band = add(G.band, this.bandMat, spin, false)
      band.position.z = side * (w + 0.001)
      if (side < 0) band.rotation.y = Math.PI
      // small sidewall markings so rotation reads at speed
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.06), new THREE.MeshBasicMaterial({ color: '#9a9a9a' }))
      stripe.position.set(0, 0.3, side * (w + 0.002))
      if (side < 0) stripe.rotation.y = Math.PI
      spin.add(stripe)
      const stripe2 = stripe.clone()
      stripe2.position.set(0, -0.3, side * (w + 0.002))
      spin.add(stripe2)
      this.spins.push(spin)
      return spin
    }
    const zF = DIM.trackF / 2, zR = DIM.trackR / 2
    this.steerR = new THREE.Group()
    this.steerR.position.set(DIM.wheelbase / 2, DIM.wheelR, zF)
    this.steerR.add(makeWheel(true, 1))
    this.steerL = new THREE.Group()
    this.steerL.position.set(DIM.wheelbase / 2, DIM.wheelR, -zF)
    this.steerL.add(makeWheel(true, -1))
    const rr = makeWheel(false, 1)
    rr.position.set(-DIM.wheelbase / 2, DIM.wheelR, zR)
    const rl = makeWheel(false, -1)
    rl.position.set(-DIM.wheelbase / 2, DIM.wheelR, -zR)
    this.root.add(this.steerL, this.steerR, rr, rl)

    // contact shadow (soft AO blob)
    const sh = new THREE.Mesh(G.shadow, M.shadow)
    sh.renderOrder = -1
    this.root.add(sh)
    // selection ring
    this.highlightMat = new THREE.MeshBasicMaterial({ color: driver.color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false })
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(3.3, 3.55, 64).rotateX(-Math.PI / 2), this.highlightMat)
    this.highlight.position.y = 0.04
    this.highlight.scale.set(1, 1, 0.55)
    this.root.add(this.highlight)
    if (season) void this.tryAsset(season)
  }

  /** Swap in a licensed glTF body if one is published for this season/team (async, optional). */
  private async tryAsset(season: number) {
    const r = await loadCarModel(season, this.driver.teamId)
    if (!r) return
    if (r.entry.hideProceduralBody !== false) this.body.children.forEach((c) => { if (c !== this.flap) c.visible = false })
    if (r.entry.hideProceduralWheels) [this.steerL, this.steerR, ...this.spins].forEach((w) => (w.visible = false))
    this.body.add(r.object)
  }

  setCompound(c: number) {
    if (c === this.compound) return
    this.compound = c
    this.bandMat.color.set(compoundColor(c))
  }

  /** Ground ring marks the followed car — only useful from high/wide cameras. */
  setSelected(sel: boolean, t: number, wide: boolean) {
    this.highlightMat.opacity = sel && wide ? 0.5 + 0.2 * Math.sin(t * 4) : 0
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
    this.flap.rotation.z = p.drsOpen ? 0.55 : 0
    // FIA rain light blinks in wet conditions; brake doesn't drive the rain light in F1 but we
    // pulse it brighter under braking for readability.
    const blink = p.rainLight ? (Math.floor(t * 4) % 2 === 0 ? 1 : 0.15) : 0
    this.rainMat.emissiveIntensity = Math.max(blink * 6, p.brakeGlow * 2)
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.material !== sharedMaterials().carbon) {
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        mats.forEach((x) => x.dispose())
      }
    })
  }
}
