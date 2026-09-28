import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { Duel } from '../../replay/duel'
import type { RaceRuntime } from '../../replay/runtime'
import { useUI } from '../../state/ui'
import { Car } from '../cars/Car'
import { ribbon } from '../track/trackGeometry'

const TRAIL = 140 // trail samples (~ metres at 1 m spacing)

/** Ghost cars, light trails, mini-sector dominance and braking points for a lap duel. */
export function DuelScene({ rt }: { rt: RaceRuntime }) {
  const duel = useUI((s) => s.duel)
  if (!duel) return null
  return <DuelContent rt={rt} duel={duel} key={`${duel.a.driver.num}-${duel.a.lap}-${duel.b.driver.num}-${duel.b.lap}`} />
}

function trailFor(color: string) {
  const g = new THREE.BufferGeometry()
  const pos = new Float32Array(TRAIL * 2 * 3)
  const alpha = new Float32Array(TRAIL * 2)
  for (let i = 0; i < TRAIL; i++) { alpha[i * 2] = alpha[i * 2 + 1] = 1 - i / TRAIL }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aA', new THREE.BufferAttribute(alpha, 1))
  const idx: number[] = []
  for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
  g.setIndex(idx)
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(2.2) } },
    vertexShader: 'attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * vA * 0.7); }',
  })
  const mesh = new THREE.Mesh(g, m)
  mesh.frustumCulled = false
  return mesh
}

function DuelContent({ rt, duel }: { rt: RaceRuntime; duel: Duel }) {
  const c = rt.circuit
  const objs = useMemo(() => {
    const cars = duel.poses.map((p) => new Car(p.driver))
    const colA = duel.a.driver.color, colB = duel.b.driver.color === duel.a.driver.color ? '#ffffff' : duel.b.driver.color
    const trails = [trailFor(colA), trailFor(colB)]
    // mini-sector dominance: 50 m segments coloured by who gained time there
    const seg = 50
    const dom = new THREE.Group()
    const mats = [new THREE.MeshBasicMaterial({ color: colA, transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false }),
      new THREE.MeshBasicMaterial({ color: colB, transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false })]
    for (let d0 = 0; d0 < c.length - 1; d0 += seg) {
      const d1 = Math.min(c.length - 1, d0 + seg)
      const gain = duel.delta[Math.floor(d1)] - duel.delta[Math.floor(d0)] // >0: B lost time => A faster
      const w = Math.min(1, Math.abs(gain) / 0.05)
      const s0 = duel.a.sStart + d0, s1 = duel.a.sStart + d1
      const g = ribbon(c, {
        s0, s1, step: 2, across: 1,
        inner: (_s, i) => c.right[i] + 0.3, outer: (_s, i) => c.right[i] + 0.3 + 0.9 + 1.4 * w, height: () => 0.07,
      })
      dom.add(new THREE.Mesh(g, gain >= 0 ? mats[0] : mats[1]))
    }
    // braking points: posts + a line across the track
    const brakes = new THREE.Group()
    const post = new THREE.CylinderGeometry(0.12, 0.12, 2.4, 8)
    const addBrake = (d: number, col: string, side: number) => {
      const f = c.frame(duel.a.sStart + d, 0, { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 0, grade: 0, curvature: 0 })
      const i = Math.floor(c.wrap(duel.a.sStart + d) / c.ds) % c.n
      const off = side > 0 ? c.left[i] + 1.2 : c.right[i] - 1.2
      const m = new THREE.Mesh(post, new THREE.MeshBasicMaterial({ color: col, toneMapped: false }))
      m.position.set(f.x + f.nx * off, f.y + 1.2, f.z + f.nz * off)
      brakes.add(m)
      const bar = ribbon(c, {
        s0: duel.a.sStart + d - 0.25, s1: duel.a.sStart + d + 0.25, step: 0.5, across: 1,
        inner: (_s, j) => side > 0 ? 0 : c.right[j], outer: (_s, j) => side > 0 ? c.left[j] : 0, height: () => 0.08,
      })
      brakes.add(new THREE.Mesh(bar, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false })))
    }
    duel.a.brakePoints.forEach((d) => addBrake(d, colA, 1))
    duel.b.brakePoints.forEach((d) => addBrake(d, colB, -1))
    const group = new THREE.Group()
    cars.forEach((x) => group.add(x.root))
    trails.forEach((x) => group.add(x))
    group.add(dom, brakes)
    return { group, cars, trails }
  }, [c, duel])

  useEffect(() => () => {
    objs.cars.forEach((x) => x.dispose())
    objs.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose() })
  }, [objs])

  const hist = useMemo(() => [[] as THREE.Vector3[], [] as THREE.Vector3[]], [duel])
  useFrame((state) => {
    duel.poses.forEach((p, i) => {
      objs.cars[i].update(p, state.clock.elapsedTime)
      // trail from recent positions (world space), lifted slightly
      const h = hist[i]
      const last = h[0]
      if (!last || last.distanceToSquared(p.position) > 0.8) {
        h.unshift(p.position.clone())
        if (h.length > TRAIL) h.pop()
      }
      const attr = objs.trails[i].geometry.getAttribute('position') as THREE.BufferAttribute
      for (let k = 0; k < TRAIL; k++) {
        const q = h[Math.min(k, h.length - 1)] ?? p.position
        const q2 = h[Math.min(k + 1, h.length - 1)] ?? q
        const dx = q.x - q2.x, dz = q.z - q2.z
        const l = Math.hypot(dx, dz) || 1
        const w = 0.13 * (1 - k / TRAIL) + 0.02
        attr.setXYZ(k * 2, q.x - (dz / l) * w, q.y + 0.35, q.z + (dx / l) * w)
        attr.setXYZ(k * 2 + 1, q.x + (dz / l) * w, q.y + 0.35, q.z - (dx / l) * w)
      }
      attr.needsUpdate = true
    })
  }, -15)
  return <primitive object={objs.group} />
}
