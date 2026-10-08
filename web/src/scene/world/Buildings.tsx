import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { look } from '../atmosphere/Atmosphere'
import { freeze } from '../static'
import { NOISE_GLSL } from '../shaders/noise'

const TILE = 700 // metres per culling tile

/**
 * OSM buildings: wall quads + pipeline-triangulated roofs, merged per spatial tile.
 * Attributes: aInfo = (kind, seed, height, isWall); uv = (perimeter m, height m) for facades.
 */
export function Buildings({ rt }: { rt: RaceRuntime }) {
  const w = rt.data.world
  const theme = rt.circuit.meta.theme
  const { meshes, material } = useMemo(() => {
    const offs = w.get<Uint32Array>('bld_offsets')
    const xy = w.get<Float32Array>('bld_xy')
    const hgt = w.get<Float32Array>('bld_height')
    const base = w.get<Float32Array>('bld_base')
    const kind = w.get<Uint8Array>('bld_kind')
    const tri = w.get<Uint32Array>('bld_tri')
    const toffs = w.get<Uint32Array>('bld_tri_offsets')
    const nB = hgt.length
    // bucket buildings by tile
    const buckets = new Map<string, number[]>()
    for (let b = 0; b < nB; b++) {
      const i0 = offs[b]
      const x = xy[i0 * 2], y = xy[i0 * 2 + 1]
      const key = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`
      let arr = buckets.get(key)
      if (!arr) buckets.set(key, (arr = []))
      arr.push(b)
    }
    const mat = buildingMaterial(theme.palette.building)
    const meshes: THREE.Mesh[] = []
    for (const ids of buckets.values()) {
      // count
      let nv = 0, ni = 0
      for (const b of ids) {
        const n = offs[b + 1] - offs[b]
        nv += n * 4 + n
        ni += n * 6 + (toffs[b + 1] - toffs[b])
      }
      const pos = new Float32Array(nv * 3)
      const nor = new Float32Array(nv * 3)
      const uv = new Float32Array(nv * 2)
      const info = new Float32Array(nv * 4)
      const idx = new Uint32Array(ni)
      let v = 0, k = 0
      for (const b of ids) {
        const i0 = offs[b], i1 = offs[b + 1], n = i1 - i0
        const y0 = base[b], y1 = base[b] + hgt[b]
        const seed = ((b * 2654435761) % 1000) / 1000
        let per = 0
        // walls (ring is CCW in ENU; in three-space z = -north flips handedness)
        for (let j = 0; j < n; j++) {
          const a = i0 + j, c = i0 + ((j + 1) % n)
          const ax = xy[a * 2], az = -xy[a * 2 + 1], cx = xy[c * 2], cz = -xy[c * 2 + 1]
          const len = Math.hypot(cx - ax, cz - az)
          // outward normal for CCW (ENU) ring: (dy, -dx) in ENU -> three (dx', dz')
          let nx = (cz - az), nz = -(cx - ax)
          const l = Math.hypot(nx, nz) || 1
          nx /= l; nz /= l
          nx = -nx; nz = -nz
          const quad = [[ax, y0, az, per, 0], [cx, y0, cz, per + len, 0], [cx, y1, cz, per + len, y1 - y0], [ax, y1, az, per, y1 - y0]]
          for (const q of quad) {
            pos[v * 3] = q[0]; pos[v * 3 + 1] = q[1]; pos[v * 3 + 2] = q[2]
            nor[v * 3] = nx; nor[v * 3 + 1] = 0; nor[v * 3 + 2] = nz
            uv[v * 2] = q[3]; uv[v * 2 + 1] = q[4]
            info[v * 4] = kind[b]; info[v * 4 + 1] = seed; info[v * 4 + 2] = hgt[b]; info[v * 4 + 3] = 1
            v++
          }
          const s = v - 4
          idx[k++] = s; idx[k++] = s + 1; idx[k++] = s + 2
          idx[k++] = s; idx[k++] = s + 2; idx[k++] = s + 3
          per += len
        }
        // roof
        const r0 = v
        for (let j = 0; j < n; j++) {
          const a = i0 + j
          pos[v * 3] = xy[a * 2]; pos[v * 3 + 1] = y1; pos[v * 3 + 2] = -xy[a * 2 + 1]
          nor[v * 3 + 1] = 1
          uv[v * 2] = xy[a * 2]; uv[v * 2 + 1] = xy[a * 2 + 1]
          info[v * 4] = kind[b]; info[v * 4 + 1] = seed; info[v * 4 + 2] = hgt[b]; info[v * 4 + 3] = 0
          v++
        }
        for (let t = toffs[b]; t < toffs[b + 1]; t += 3) {
          // choose the winding whose face normal points up (+y) in three-space
          const A = r0 + tri[t], B = r0 + tri[t + 1], C = r0 + tri[t + 2]
          const e1x = pos[B * 3] - pos[A * 3], e1z = pos[B * 3 + 2] - pos[A * 3 + 2]
          const e2x = pos[C * 3] - pos[A * 3], e2z = pos[C * 3 + 2] - pos[A * 3 + 2]
          const ny = e1z * e2x - e1x * e2z
          if (ny >= 0) { idx[k++] = A; idx[k++] = B; idx[k++] = C }
          else { idx[k++] = A; idx[k++] = C; idx[k++] = B }
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      g.setAttribute('aInfo', new THREE.BufferAttribute(info, 4))
      g.setIndex(new THREE.BufferAttribute(idx, 1))
      g.computeBoundingSphere()
      const mesh = new THREE.Mesh(g, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = 'buildings'
      freeze(mesh)
      meshes.push(mesh)
    }
    return { meshes, material: mat }
  }, [w, theme])

  useEffect(() => () => { meshes.forEach((m) => m.geometry.dispose()); material.dispose() }, [meshes, material])
  useFrame(() => {
    const u = (material.userData as { u: Record<string, { value: number }> }).u
    u.uNight.value = look.night ? 1 : 0
    u.uWet.value = look.wet
  })
  return <>{meshes.map((m, i) => <primitive key={i} object={m} />)}</>
}

function buildingMaterial(baseColor: string) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 })
  const u = { uNight: { value: 0 }, uWet: { value: 0 }, uBase: { value: new THREE.Color(baseColor) } }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aInfo; varying vec4 vInfo; varying vec2 vFac;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInfo = aInfo; vFac = uv;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${NOISE_GLSL}
uniform float uNight; uniform float uWet; uniform vec3 uBase;
varying vec4 vInfo; varying vec2 vFac; float bRough; vec3 bEmit;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float kind = vInfo.x; float seed = vInfo.y; float H = vInfo.z; float isWall = vInfo.w;
  // palette: warm plaster / painted concrete / brick / glass, varied per building
  vec3 palA = uBase;
  vec3 palB = vec3(0.72, 0.52, 0.40);  // terracotta / brick
  vec3 palC = vec3(0.86, 0.84, 0.78);  // off-white
  vec3 palD = vec3(0.55, 0.6, 0.66);   // grey-blue concrete
  vec3 palE = vec3(0.85, 0.75, 0.55);  // sand
  float r = fract(seed * 7.13);
  vec3 wallCol = r < 0.3 ? palA : r < 0.5 ? palC : r < 0.65 ? palB : r < 0.82 ? palE : palD;
  wallCol *= 0.8 + 0.3 * fract(seed * 31.7);
  if (kind == 3.0) wallCol = vec3(0.62, 0.64, 0.66);         // industrial
  if (kind == 4.0) wallCol = vec3(0.8, 0.8, 0.82);           // grandstand
  if (kind == 6.0) wallCol = vec3(0.85, 0.86, 0.87);         // tanks
  bEmit = vec3(0.0);
  bRough = 0.85;
  if (isWall > 0.5) {
    // facade: floors every 3.1 m, window bays every ~2.8 m
    float floorH = 3.1;
    float fy = fract(vFac.y / floorH);
    float bay = fract(vFac.x / 2.8 + seed * 3.0);
    float win = step(0.3, fy) * step(fy, 0.8) * step(0.18, bay) * step(bay, 0.82);
    win *= step(1.2, vFac.y) * step(vFac.y, H - 0.6);
    float glassy = step(0.85, fract(seed * 13.1)) * step(18.0, H);
    vec3 glass = mix(vec3(0.12, 0.15, 0.18), vec3(0.25, 0.32, 0.4), glassy);
    vec3 col = mix(wallCol, glass, win * (kind == 3.0 ? 0.3 : 1.0));
    col = mix(col, glass, glassy * 0.75);
    // grime toward the base, weather streaks
    col *= 0.78 + 0.22 * smoothstep(0.0, 4.0, vFac.y);
    col *= 0.9 + 0.1 * vnoise(vec2(vFac.x * 0.6, vFac.y * 0.08));
    // subtle vertical staining
    col *= 0.95 + 0.05 * vnoise(vec2(vFac.x * 0.15, vFac.y * 0.02));
    diffuseColor.rgb = col;
    bRough = mix(0.88, 0.12, max(win, glassy));
    // lit windows at night (random per window)
    vec2 wid = vec2(floor(vFac.x / 2.8 + seed * 3.0), floor(vFac.y / floorH));
    float hr = n_hash(wid + seed * 91.0);
    float lit = step(0.62, hr);
    // mix of warm residential light, cool office LEDs and dim TV-blue, varying intensity
    vec3 lc = hr > 0.93 ? vec3(0.55, 0.7, 1.0) : hr > 0.8 ? vec3(0.95, 0.97, 1.0) : vec3(1.0, 0.78, 0.5);
    bEmit = lc * win * lit * uNight * (0.6 + 1.4 * fract(hr * 17.0));
  } else {
    // roofs: terracotta / concrete / metal
    float rr = fract(seed * 17.9);
    vec3 roof = rr < 0.4 ? vec3(0.62, 0.36, 0.26) : rr < 0.75 ? vec3(0.55, 0.55, 0.53) : vec3(0.45, 0.48, 0.5);
    roof *= 0.8 + 0.35 * vnoise(vFac * 0.4);
    if (kind == 3.0 || H > 20.0) roof = vec3(0.5, 0.51, 0.52) * (0.85 + 0.2 * vnoise(vFac * 0.2));
    diffuseColor.rgb = roof;
    bRough = rr > 0.75 ? 0.5 : 0.9;
  }
  diffuseColor.rgb *= mix(1.0, 0.75, uWet * (1.0 - isWall));
  diffuseColor.rgb *= mix(1.0, 0.22, uNight);
  bRough = mix(bRough, bRough * 0.5, uWet * (1.0 - isWall));
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = bRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += bEmit;')
  }
  m.customProgramCacheKey = () => 'buildings-v2'
  ;(m.userData as { u: typeof u }).u = u
  return m
}
