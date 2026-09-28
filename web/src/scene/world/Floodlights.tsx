import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { look } from '../atmosphere/Atmosphere'

/**
 * Night circuits: floodlight pylons along both sides of the track (instanced), with emissive
 * lamp heads that bloom. The actual illumination is an overhead flood light set up by the
 * Atmosphere for night races (one shadowed key light approximates the lighting truss).
 */
export function Floodlights({ rt }: { rt: RaceRuntime }) {
  const night = rt.data.race.environment.night || rt.circuit.meta.theme.night
  const c = rt.circuit
  const objs = useMemo(() => {
    if (!night) return null
    const pts: { x: number; y: number; z: number; yaw: number }[] = []
    const f = { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 0, grade: 0, curvature: 0 }
    for (let s = 0; s < c.length; s += 32) {
      for (const side of [1, -1]) {
        if (((s / 32) | 0) % 2 === (side > 0 ? 0 : 1)) continue // staggered sides
        const i = Math.floor(s / c.ds) % c.n
        const d = side > 0 ? c.barrierLeft[i] + 2.2 : c.barrierRight[i] - 2.2
        c.frame(s, d, f)
        pts.push({ x: f.x, y: f.y, z: f.z, yaw: Math.atan2(side * f.nz, side * f.nx) })
      }
    }
    const pole = new THREE.CylinderGeometry(0.16, 0.24, 14, 6)
    pole.translate(0, 7, 0)
    const arm = new THREE.BoxGeometry(3.4, 0.25, 0.25)
    arm.translate(-1.5, 13.6, 0)
    const head = new THREE.BoxGeometry(1.8, 0.35, 0.9)
    head.translate(-2.6, 13.3, 0)
    const poleMat = new THREE.MeshStandardMaterial({ color: '#5a5f66', roughness: 0.5, metalness: 0.7 })
    const headMat = new THREE.MeshStandardMaterial({ color: '#111', emissive: new THREE.Color('#fff4e0'), emissiveIntensity: 9, toneMapped: true })
    const n = pts.length
    const mk = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const im = new THREE.InstancedMesh(g, m, n)
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1)
      pts.forEach((p, k) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw)
        m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, one)
        im.setMatrixAt(k, m4)
      })
      im.instanceMatrix.needsUpdate = true
      im.frustumCulled = false
      return im
    }
    const group = new THREE.Group()
    group.add(mk(pole, poleMat), mk(arm, poleMat), mk(head, headMat))
    return { group, headMat }
  }, [c, night])
  useFrame(() => {
    if (objs) objs.headMat.emissiveIntensity = look.night ? 9 : 0.5
  })
  return objs ? <primitive object={objs.group} /> : null
}
