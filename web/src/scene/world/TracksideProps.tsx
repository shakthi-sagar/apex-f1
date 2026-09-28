import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { tracksideCameras } from '../../camera/shots'
import type { RaceRuntime } from '../../replay/runtime'
import { instanced, loadInstanceParts } from '../assets'
import type { TerrainSampler } from './terrainSampler'

/**
 * Blender-authored trackside kit: TV camera towers exactly where the trackside cameras film
 * from (so the broadcast shots come from visible towers) and marshal posts along the barriers.
 */
export function TracksideProps({ rt, terrain }: { rt: RaceRuntime; terrain: TerrainSampler }) {
  const c = rt.circuit
  const group = useMemo(() => new THREE.Group(), [])
  useEffect(() => {
    let alive = true
    const up = new THREE.Vector3(0, 1, 0)
    const f = { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 0, grade: 0, curvature: 0 }
    const facing = (x: number, z: number, s: number) => {
      c.frame(s, 0, f)
      return Math.atan2(-(f.z - z), f.x - x) // model +X towards the track
    }
    // towers: camera sits 1.2 m above the platform, so the tower base is below the shot position
    const towers = tracksideCameras(c, (x, z) => terrain.height(x, z)).map((cam) => {
      const ground = terrain.inside(cam.pos.x, cam.pos.z) ? terrain.height(cam.pos.x, cam.pos.z) : cam.pos.y - 9
      const scaleY = Math.max(0.4, (cam.pos.y - 1.2 - ground) / 8)
      return new THREE.Matrix4().compose(new THREE.Vector3(cam.pos.x, ground, cam.pos.z),
        new THREE.Quaternion().setFromAxisAngle(up, facing(cam.pos.x, cam.pos.z, cam.s)), new THREE.Vector3(1, scaleY, 1))
    })
    // marshal posts every ~280 m, alternating sides, just behind the barrier
    const posts: THREE.Matrix4[] = []
    for (let s = 120; s < c.length; s += 280) {
      const side = ((s / 280) | 0) % 2 ? 1 : -1
      const i = Math.floor(s / c.ds) % c.n
      const d = side > 0 ? c.barrierLeft[i] + 2.2 : c.barrierRight[i] - 2.2
      c.frame(s, d, f)
      const gy = terrain.inside(f.x, f.z) ? Math.max(f.y - 0.3, terrain.height(f.x, f.z)) : f.y
      posts.push(new THREE.Matrix4().compose(new THREE.Vector3(f.x, gy, f.z),
        new THREE.Quaternion().setFromAxisAngle(up, facing(f.x, f.z, s)), new THREE.Vector3(1, 1, 1)))
    }
    Promise.all([loadInstanceParts('assets/environment/camera-tower.glb'), loadInstanceParts('assets/environment/marshal-post.glb')])
      .then(([tp, mp]) => {
        if (!alive) return
        group.add(instanced(tp, towers), instanced(mp, posts))
      }).catch(() => {})
    return () => { alive = false; group.clear() }
  }, [c, terrain, group])
  return <primitive object={group} />
}
