import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { dataUrl, fetchJson } from '../../data/fetch'

/**
 * Car asset provider. The procedural car (carModel.ts) is always available; separately supplied,
 * properly licensed glTF models can override the body per season/team without code changes:
 *
 *   assets/cars/{season}/index.json
 *   {
 *     "models": {
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
  const entry = idx[teamId]
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
