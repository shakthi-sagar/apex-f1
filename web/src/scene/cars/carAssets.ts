import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { dataUrl, fetchJson } from '../../data/fetch'

/**
 * Car asset provider. The procedural car (carModel.ts) is always available; separately supplied,
 * properly licensed glTF models can override the body per season/team without code changes:
 *
 *   assets/cars/{season}/index.json
 *   {
 *     "models": {
 *       "default":         { "url": "f1-2024.glb", "recolor": true },          // shared, recoloured per team
 *       "red-bull-racing": { "url": "red-bull-racing.glb", "scale": 1, "rotationY": 0, "offset": [0, 0, 0],
 *                            "license": "CC-BY-4.0 …", "hideProceduralBody": true }
 *     }
 *   }
 *
 * Models must use +X forward, +Y up, metres (or provide scale/rotationY to normalise). Wheels stay
 * procedural (so rotation/steering always work) unless the model supplies its own.
 */

export interface CarAssetEntry {
  url: string
  scale?: number
  rotationY?: number
  offset?: [number, number, number]
  license?: string
  hideProceduralBody?: boolean
  hideProceduralWheels?: boolean
  /** material names are roles (livery, carbon, dark, halo, helmet, rainlight) recoloured per team */
  recolor?: boolean
}

const indexCache = new Map<number, Promise<Record<string, CarAssetEntry>>>()
const modelCache = new Map<string, Promise<THREE.Object3D>>()

export function carAssetIndex(season: number) {
  let p = indexCache.get(season)
  if (!p) {
    p = fetchJson<{ models: Record<string, CarAssetEntry> }>(dataUrl(`assets/cars/${season}/index.json`))
      .then((j) => j.models ?? {})
      .catch(() => ({}))
    indexCache.set(season, p)
  }
  return p
}

export async function loadCarModel(season: number, teamId: string): Promise<{ object: THREE.Object3D; entry: CarAssetEntry } | null> {
  const idx = await carAssetIndex(season)
  // a team-specific model wins; otherwise the season's shared model is recoloured per team
  const entry = idx[teamId] ?? idx['default']
  if (!entry) return null
  const url = dataUrl(`assets/cars/${season}/${entry.url}`)
  let p = modelCache.get(url)
  if (!p) {
    p = new GLTFLoader().loadAsync(url).then((g) => {
      const root = g.scene
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true }
      })
      return root
    })
    modelCache.set(url, p)
  }
  try {
    const src = await p
    const object = src.clone(true)
    object.scale.setScalar(entry.scale ?? 1)
    object.rotation.y = entry.rotationY ?? 0
    if (entry.offset) object.position.fromArray(entry.offset)
    return { object, entry }
  } catch {
    return null
  }
}

/** A car model flattened for rendering: one merged geometry per material role (few draw calls). */
export interface CarParts {
  entry: CarAssetEntry
  roles: { role: string; geometry: THREE.BufferGeometry }[]
  flap: { geometry: THREE.BufferGeometry; position: THREE.Vector3; quaternion: THREE.Quaternion } | null
}

const partsCache = new Map<string, Promise<CarParts | null>>()

export function loadCarParts(season: number, teamId: string): Promise<CarParts | null> {
  const key = `${season}/${teamId}`
  let p = partsCache.get(key)
  if (!p) {
    p = (async () => {
      const r = await loadCarModel(season, teamId)
      if (!r) return null
      const root = r.object
      root.updateMatrixWorld(true)
      const byRole = new Map<string, THREE.BufferGeometry[]>()
      let flap: CarParts['flap'] = null
      const clean = (g: THREE.BufferGeometry) => {
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k)
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
        return g.index ? g.toNonIndexed() : g
      }
      const flapNode = root.getObjectByName('DRSFlap')
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const role = (m.material as THREE.Material).name
        // meshes under the flap node are kept in the flap's local frame (it pivots)
        let inFlap = false
        for (let q: THREE.Object3D | null = m; q; q = q.parent) if (q === flapNode) inFlap = true
        if (inFlap && flapNode) {
          const local = new THREE.Matrix4().copy(flapNode.matrixWorld).invert().multiply(m.matrixWorld)
          const g = clean(m.geometry.clone().applyMatrix4(local))
          flap = { geometry: g, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
          flapNode.matrixWorld.decompose(flap.position, flap.quaternion, new THREE.Vector3())
          return
        }
        const g = clean(m.geometry.clone().applyMatrix4(m.matrixWorld)) // includes the entry's scale/rotation/offset
        const arr = byRole.get(role) ?? []
        arr.push(g)
        byRole.set(role, arr)
      })
      const roles = [...byRole.entries()].map(([role, gs]) => ({ role, geometry: mergeGeometries(gs, false)! }))
      roles.forEach((r) => r.geometry.computeBoundingSphere())
      return { entry: r.entry, roles, flap } as CarParts
    })()
    partsCache.set(key, p)
  }
  return p
}
