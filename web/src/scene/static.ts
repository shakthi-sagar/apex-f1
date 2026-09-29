import type * as THREE from 'three'

/**
 * Mark a subtree as static: bake its world matrices once and stop three.js from recomputing
 * (or even traversing) them every frame. Call again after adding children.
 */
export function freeze(obj: THREE.Object3D) {
  obj.matrixAutoUpdate = true
  obj.matrixWorldAutoUpdate = true
  obj.updateMatrixWorld(true)
  obj.traverse((o) => { o.matrixAutoUpdate = false })
  obj.matrixWorldAutoUpdate = false
  return obj
}
