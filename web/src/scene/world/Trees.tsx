import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { RaceRuntime } from '../../replay/runtime'
import { look } from '../atmosphere/Atmosphere'

/** Volumetric canopy: many jittered icosphere lobes around an ellipsoid shell (seeded). */
function canopyTree(seed: number, height: number, crownR: number, crownH: number, lobes: number): THREE.BufferGeometry {
  let r = seed
  const rnd = () => { r = (r * 16807) % 2147483647; return (r - 1) / 2147483646 }
  const parts: THREE.BufferGeometry[] = []
  const trunkH = height - crownH * 0.75
  const trunk = new THREE.CylinderGeometry(0.14, 0.26, trunkH + 0.6, 7)
  trunk.translate(0, (trunkH + 0.6) / 2, 0)
  colorize(trunk, 0x4b3a2c)
  parts.push(trunk)
  // a couple of branches
  for (let k = 0; k < 3; k++) {
    const a = rnd() * Math.PI * 2
    const br = new THREE.CylinderGeometry(0.05, 0.1, crownR * 0.9, 5)
    br.translate(0, crownR * 0.45, 0)
    br.rotateZ(0.9)
    br.rotateY(a)
    br.translate(0, trunkH * 0.85, 0)
    colorize(br, 0x4b3a2c)
    parts.push(br)
  }
  const cy = height - crownH / 2
  for (let k = 0; k < lobes; k++) {
    // points on an ellipsoid shell, biased to the upper hemisphere
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2
    const up = Math.abs(u) * 0.8 + 0.1
    const rr = Math.sqrt(1 - u * u)
    const x = Math.cos(th) * rr * crownR * 0.7, z = Math.sin(th) * rr * crownR * 0.7, y = cy + (up - 0.4) * crownH * 0.7
    const size = crownR * (0.38 + rnd() * 0.3)
    const lobe = new THREE.IcosahedronGeometry(size, 1)
    const p = lobe.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const j = 0.85 + rnd() * 0.3
      p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.8, p.getZ(i) * j)
    }
    lobe.translate(x, y, z)
    colorize(lobe, 0x2e4f22, true)
    parts.push(lobe)
  }
  const g = mergeGeometries(parts.map((q) => (q.index ? q.toNonIndexed() : q)))!
  g.computeVertexNormals()
  // soften: push normals outward from the crown centre (smooth "cloud" shading like foliage)
  const n = g.attributes.normal as THREE.BufferAttribute
  const pos = g.attributes.position as THREE.BufferAttribute
  const col = g.attributes.color as THREE.BufferAttribute
  for (let i = 0; i < n.count; i++) {
    if (col.getY(i) < col.getX(i) * 1.05) continue // bark: keep faceted normals
    const dx = pos.getX(i), dy = pos.getY(i) - cy, dz = pos.getZ(i)
    const l = Math.hypot(dx, dy, dz) || 1
    n.setXYZ(i, n.getX(i) * 0.35 + (dx / l) * 0.65, n.getY(i) * 0.35 + (dy / l) * 0.65 + 0.15, n.getZ(i) * 0.35 + (dz / l) * 0.65)
  }
  n.needsUpdate = true
  return g
}

function broadleaf(): THREE.BufferGeometry {
  return canopyTree(12345, 7.5, 3.2, 4.6, 14)
}

function tallTree(): THREE.BufferGeometry {
  return canopyTree(777, 11, 2.6, 6.5, 16)
}

function conifer(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const trunk = new THREE.CylinderGeometry(0.15, 0.25, 2.2, 6)
  trunk.translate(0, 1.1, 0)
  colorize(trunk, 0x4a3628)
  parts.push(trunk)
  for (let k = 0; k < 3; k++) {
    const c = new THREE.ConeGeometry(2.6 - k * 0.6, 3.4, 8)
    c.translate(0, 3.2 + k * 1.9, 0)
    colorize(c, 0x2f5226, true)
    parts.push(c)
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!
}

function palm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const trunk = new THREE.CylinderGeometry(0.16, 0.24, 7, 6)
  trunk.translate(0, 3.5, 0)
  colorize(trunk, 0x6a5540)
  parts.push(trunk)
  for (let k = 0; k < 7; k++) {
    const f = new THREE.PlaneGeometry(0.9, 3.4, 1, 3)
    const p = f.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) { const y = p.getY(i) + 1.7; p.setXYZ(i, p.getX(i), -0.12 * y * y, y) }
    f.rotateY((k / 7) * Math.PI * 2)
    f.translate(0, 7, 0)
    colorize(f, 0x4c7a2e, true)
    parts.push(f.toNonIndexed())
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!
}

function colorize(g: THREE.BufferGeometry, hex: number, jitter = false) {
  const c = new THREE.Color(hex)
  const n = g.attributes.position.count
  const col = new Float32Array(n * 3)
  const p = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < n; i++) {
    const j = jitter ? 0.82 + 0.3 * ((Math.sin(p.getX(i) * 12.9 + p.getY(i) * 78.2 + p.getZ(i) * 37.7) + 1) / 2) : 1
    // darker toward the inside/bottom of the canopy (baked occlusion), sun-bleached tops
    const ao = jitter ? 0.55 + 0.6 * THREE.MathUtils.clamp((p.getY(i) - 3.5) / 5, 0, 1) : 1
    col[i * 3] = c.r * j * ao; col[i * 3 + 1] = c.g * j * ao; col[i * 3 + 2] = c.b * j * ao
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
}

export function Trees({ rt }: { rt: RaceRuntime }) {
  const trees = rt.data.world.get<Float32Array>('trees')
  const tropical = /tropical|subtropical/.test(rt.circuit.meta.theme.biome)
  const { meshes, mat } = useMemo(() => {
    const n = trees.length / 5
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 })
    const u = { uTime: { value: 0 }, uWind: { value: 1 }, uDark: { value: 1 } }
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uDark;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= uDark;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float ph = ip.x * 0.05 + ip.z * 0.07;
  float sway = sin(uTime * 1.3 + ph) * 0.06 + sin(uTime * 2.9 + ph * 1.7) * 0.025;
  float hf = max(0.0, transformed.y - 2.0) / 6.0;
  transformed.x += sway * hf * hf * 3.0 * uWind;
  transformed.z += sway * 0.6 * hf * hf * 2.0 * uWind;
}`)
    }
    mat.customProgramCacheKey = () => 'trees-v2'
    ;(mat.userData as { u: typeof u }).u = u
    const geos = [broadleaf(), tropical ? palm() : conifer(), tallTree()]
    const buckets: number[][] = [[], [], []]
    for (let i = 0; i < n; i++) {
      const sp = trees[i * 5 + 4]
      buckets[sp === 1 ? (tropical ? 0 : 1) : sp === 2 ? (tropical ? 1 : 2) : 0].push(i)
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3()
    const col = new THREE.Color()
    const meshes = buckets.map((ids, k) => {
      const im = new THREE.InstancedMesh(geos[k], mat, Math.max(1, ids.length))
      im.count = ids.length
      ids.forEach((i, j) => {
        const x = trees[i * 5], y = trees[i * 5 + 1], z = trees[i * 5 + 2], sc = trees[i * 5 + 3]
        const r = Math.sin(i * 12.9898) * 43758.5453
        const rnd = r - Math.floor(r)
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd * Math.PI * 2)
        const size = sc * (0.85 + rnd * 0.5) * (k === 1 && tropical ? 1.2 : 1)
        s.set(size, size * (0.9 + rnd * 0.3), size)
        p.set(x, z - 0.2, -y)
        m4.compose(p, q, s)
        im.setMatrixAt(j, m4)
        col.setHSL(0.24 + rnd * 0.07, 0.35 + rnd * 0.2, 0.42 + rnd * 0.2)
        im.setColorAt(j, col.clone().multiplyScalar(1.9))
      })
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      im.castShadow = true
      im.receiveShadow = true
      im.frustumCulled = false
      im.name = 'trees'
      return im
    })
    return { meshes, mat }
  }, [trees, tropical])
  useEffect(() => () => { meshes.forEach((m) => { m.geometry.dispose(); m.dispose() }); mat.dispose() }, [meshes, mat])
  useFrame((state) => {
    const u = (mat.userData as { u: { uTime: { value: number }; uWind: { value: number }; uDark: { value: number } } }).u
    u.uDark.value += ((look.night ? 0.3 : 1) - u.uDark.value) * 0.1
    u.uTime.value = state.clock.elapsedTime
    u.uWind.value = 0.6 + Math.min(2, (rt.weather?.windSpeed ?? 1)) * 0.5
  })
  return <>{meshes.map((m, i) => <primitive key={i} object={m} />)}</>
}
