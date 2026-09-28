import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { dataUrl } from '../data/fetch'

/**
 * Loader for the Blender-authored asset library (assets-src/apex_assets.blend → glb on R2 under assets/).
 * Static props are flattened into one merged geometry per material so they can be drawn as
 * InstancedMeshes (hundreds of floodlights / towers for a few draw calls).
 */

const gltfCache = new Map<string, Promise<THREE.Group>>()

export function loadGltf(key: string): Promise<THREE.Group> {
  let p = gltfCache.get(key)
  if (!p) {
    p = new GLTFLoader().loadAsync(dataUrl(key)).then((g) => g.scene)
    gltfCache.set(key, p)
  }
  return p
}

export interface InstancePart { geometry: THREE.BufferGeometry; material: THREE.Material; name: string }

const partCache = new Map<string, Promise<InstancePart[]>>()

/** Flatten a glTF scene into merged (geometry, material) parts in the asset's root frame. */
export function loadInstanceParts(key: string): Promise<InstancePart[]> {
  let p = partCache.get(key)
  if (!p) {
    p = loadGltf(key).then((root) => {
      root.updateMatrixWorld(true)
      const byMat = new Map<string, { m: THREE.Material; g: THREE.BufferGeometry[] }>()
      root.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const mat = mesh.material as THREE.Material
        const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k)
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2))
        const e = byMat.get(mat.name) ?? { m: mat, g: [] }
        e.g.push(g.index ? g.toNonIndexed() : g)
        byMat.set(mat.name, e)
      })
      return [...byMat.entries()].map(([name, { m, g }]) => ({ name, material: m, geometry: mergeGeometries(g, false)! }))
    })
    partCache.set(key, p)
  }
  return p
}

/** Build instanced meshes for `parts` at the given transforms. */
export function instanced(parts: InstancePart[], mats: THREE.Matrix4[], override?: (p: InstancePart) => THREE.Material | undefined) {
  const group = new THREE.Group()
  for (const part of parts) {
    const im = new THREE.InstancedMesh(part.geometry, override?.(part) ?? part.material, Math.max(1, mats.length))
    im.count = mats.length
    mats.forEach((m, i) => im.setMatrixAt(i, m))
    im.instanceMatrix.needsUpdate = true
    im.castShadow = true
    im.receiveShadow = true
    im.frustumCulled = false
    im.name = part.name
    group.add(im)
  }
  return group
}
