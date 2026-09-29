import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { instanced, loadInstanceParts } from '../assets'
import { freeze } from '../static'
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
        pts.push({ x: f.x, y: f.y, z: f.z, yaw: Math.atan2(-side * f.nz, side * f.nx) }) // +X away from the track (lamp arm is -X)
      }
    }
    const mats = pts.map((p) => new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(1, 1, 1)))
    const headMat = new THREE.MeshStandardMaterial({ color: '#111', emissive: new THREE.Color('#fff4e0'), emissiveIntensity: 9 })
    const group = new THREE.Group()
    // Blender pylon (assets/environment/floodlight.glb); lamp faces get the animated emissive material
    loadInstanceParts('assets/environment/floodlight.glb').then((parts) => {
      group.add(instanced(parts, mats, (part) => (part.name === 'ts_lamp' ? headMat : undefined)))
      freeze(group)
    }).catch(() => {})
    return { group, headMat }
  }, [c, night])
  useFrame(() => {
    if (objs) objs.headMat.emissiveIntensity = look.night ? 9 : 0.5
  })
  return objs ? <primitive object={objs.group} /> : null
}
