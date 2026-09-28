import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { loadGltf } from '../assets'
import * as THREE from 'three'
import { newFrame } from '../../data/circuit'
import type { RaceRuntime } from '../../replay/runtime'
import { useUI } from '../../state/ui'
import { loft, merge, mirrorZ } from './geometry'

/**
 * Safety car (visual reconstruction). FastF1 carries no position for it, so during safety-car
 * periods it is placed ahead of the race leader, easing in after deployment and peeling off
 * before the restart. Generic GT coupe — no manufacturer design.
 */
function gtGeometry() {
  const body = loft([
    { x: 2.3, w: 1.5, top: 0.62, bot: 0.25, n: 3.2, nb: 4 },
    { x: 2.0, w: 1.86, top: 0.78, bot: 0.2, n: 3.6, nb: 5 },
    { x: 1.2, w: 1.94, top: 0.9, bot: 0.18, n: 4.0, nb: 6 },
    { x: 0.4, w: 1.96, top: 1.02, bot: 0.18, n: 4.0, nb: 6 },
    { x: -0.4, w: 1.96, top: 1.02, bot: 0.18, n: 4.0, nb: 6 },
    { x: -1.4, w: 1.98, top: 0.98, bot: 0.2, n: 4.0, nb: 6 },
    { x: -2.05, w: 1.9, top: 0.9, bot: 0.25, n: 3.6, nb: 5 },
    { x: -2.25, w: 1.7, top: 0.82, bot: 0.3, n: 3.2, nb: 4 },
  ], 40, 5)
  const cabin = loft([
    { x: 0.95, w: 1.35, top: 0.93, bot: 0.8, n: 3.0 },
    { x: 0.35, w: 1.45, top: 1.26, bot: 0.85, n: 3.4 },
    { x: -0.6, w: 1.45, top: 1.28, bot: 0.85, n: 3.4 },
    { x: -1.55, w: 1.3, top: 1.0, bot: 0.85, n: 3.0 },
  ], 32, 5)
  const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 28)
  wheel.rotateX(Math.PI / 2)
  const wheels: THREE.BufferGeometry[] = []
  for (const [x, z] of [[1.4, 0.82], [-1.35, 0.84]]) {
    const w = wheel.clone(); w.translate(x, 0.34, z); wheels.push(w, mirrorZ(w))
  }
  const bar = new THREE.BoxGeometry(0.28, 0.09, 1.2)
  bar.translate(-0.15, 1.33, 0)
  const rimG: THREE.BufferGeometry[] = []
  const rim = new THREE.CircleGeometry(0.24, 24)
  for (const [x, z] of [[1.4, 0.955], [-1.35, 0.975]]) {
    const r = rim.clone(); r.translate(x, 0.34, z); rimG.push(r)
    const l = rim.clone(); l.rotateY(Math.PI); l.translate(x, 0.34, -z); rimG.push(l)
  }
  const lamps = (x: number, zs: number[], w: number, h: number) => merge(zs.map((z) => new THREE.BoxGeometry(0.06, h, w).translate(x, 0.62, z)))
  return { body, cabin, wheels: merge(wheels), bar, rims: merge(rimG), head: lamps(2.28, [0.55, -0.55], 0.4, 0.08), tail: lamps(-2.26, [0.6, -0.6], 0.36, 0.07) }
}

export function SafetyCar({ rt }: { rt: RaceRuntime }) {
  const obj = useMemo(() => {
    const g = gtGeometry()
    const root = new THREE.Group()
    const paint = new THREE.MeshPhysicalMaterial({ color: '#c9ccd1', metalness: 0.7, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06 })
    const glass = new THREE.MeshPhysicalMaterial({ color: '#0d1116', metalness: 0.2, roughness: 0.05, clearcoat: 1 })
    const tyre = new THREE.MeshStandardMaterial({ color: '#141416', roughness: 0.7 })
    const lightA = new THREE.MeshStandardMaterial({ color: '#221400', emissive: '#ffae00', emissiveIntensity: 0 })
    const add = (geo: THREE.BufferGeometry, m: THREE.Material) => { const x = new THREE.Mesh(geo, m); x.castShadow = true; root.add(x); return x }
    add(g.body, paint)
    add(g.cabin, glass)
    add(g.wheels, tyre)
    add(g.bar, lightA)
    add(g.rims, new THREE.MeshStandardMaterial({ color: '#b8bcc2', metalness: 0.9, roughness: 0.25 }))
    add(g.head, new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#e8f0ff', emissiveIntensity: 4 }))
    add(g.tail, new THREE.MeshStandardMaterial({ color: '#300', emissive: '#ff1010', emissiveIntensity: 3 }))
    // side decal band in the accent colour
    for (const z of [0.99, -0.99]) {
      const band = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.1), new THREE.MeshStandardMaterial({ color: '#b6ff00', emissive: '#2a3a00', side: THREE.DoubleSide }))
      band.position.set(0, 0.55, z)
      root.add(band)
    }
    root.visible = false
    root.name = 'safety-car'
    return { root, lightA }
  }, [])
  // swap in the Blender-authored safety car when available (procedural stays as fallback)
  useEffect(() => {
    let alive = true
    loadGltf('assets/cars/2024/safety-car.glb').then((scene) => {
      if (!alive) return
      const model = scene.clone(true)
      model.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.castShadow = true
        if ((m.material as THREE.Material).name === 'lightbar') m.material = obj.lightA
      })
      obj.root.children.forEach((c) => (c.visible = false))
      obj.root.add(model)
    }).catch(() => { /* keep procedural */ })
    return () => { alive = false }
  }, [obj])
  const f = useMemo(() => newFrame(), [])
  const state = useMemo(() => ({ s: 0, vis: 0 }), [])

  const periods = useMemo(() => {
    const ts = rt.data.race.trackStatus
    const out: [number, number][] = []
    ts.forEach((x, i) => { if (x.status === 'sc') out.push([x.t, ts[i + 1]?.t ?? rt.clock.end]) })
    return out
  }, [rt])

  useFrame((st, dt) => {
    const t = rt.time
    const p = periods.find(([a, b]) => t >= a - 5 && t <= b + 5)
    const leader = rt.poses.find((x) => x.visible && x.racePosition === 1)
    const target = p && leader && !useUI.getState().duel ? 1 : 0
    if (!p || !leader) { obj.root.visible = false; state.vis = 0; return }
    // ease in over ~20 s after deployment, peel off during the final ~15 s
    const [a, b] = p
    const fadeIn = THREE.MathUtils.smoothstep(t, a + 8, a + 28)
    const fadeOut = 1 - THREE.MathUtils.smoothstep(t, b - 18, b - 3)
    const gap = 110 * fadeIn + (1 - fadeIn) * 400
    const s = leader.sample.s + gap
    state.s = s
    state.vis = target * fadeIn * fadeOut
    obj.root.visible = state.vis > 0.02
    if (!obj.root.visible) return
    const lat = THREE.MathUtils.lerp(0, (rt.circuit.meta.pit.side === 'left' ? 1 : -1) * 20, 1 - fadeOut)
    rt.circuit.frame(s, lat, f)
    const ahead = rt.circuit.frame(s + 3, lat, newFrame())
    obj.root.position.set(f.x, f.y, f.z)
    obj.root.rotation.set(0, Math.atan2(-(ahead.z - f.z), ahead.x - f.x), 0)
    obj.root.scale.setScalar(Math.max(0.001, Math.min(1, state.vis * 1.5)))
    // alternating light bar
    obj.lightA.emissiveIntensity = Math.sin(st.clock.elapsedTime * 12) > 0 ? 7 : 0.4
    void dt
  }, -12)
  return <primitive object={obj.root} />
}
