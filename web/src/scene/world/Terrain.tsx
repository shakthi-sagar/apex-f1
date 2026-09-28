import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { look } from '../atmosphere/Atmosphere'
import { NOISE_GLSL } from '../shaders/noise'
import type { TerrainSampler } from './terrainSampler'

// class indices — keep in sync with pipeline/f1sim/geo/world.py (LC)
const LC_COLORS: [number, string, number][] = [
  [0, '#6f6a4e', 0.95], // ground (theme-tinted in shader)
  [1, '#56793a', 0.95], // grass
  [2, '#3a5a2a', 0.98], // forest floor
  [3, '#2a3c46', 0.08], // water
  [4, '#3c3e42', 0.85], // road
  [5, '#55575a', 0.9], // minor road / path
  [6, '#6c6d6e', 0.85], // paved / parking
  [7, '#8a8176', 0.95], // urban ground
  [8, '#7c7a76', 0.9], // industrial
  [9, '#c2b28c', 0.95], // sand
  [10, '#4d4f52', 0.85], // runoff tarmac
  [11, '#4f7f3d', 0.9], // pitch
  [12, '#8a4f32', 0.98], // bare soil
  [13, '#59544e', 0.9], // rail
  [14, '#9a8c74', 0.98], // gravel
]

export function Terrain({ rt, sampler }: { rt: RaceRuntime; sampler: TerrainSampler }) {
  const theme = rt.circuit.meta.theme
  const { geometry, material, skirt } = useMemo(() => {
    const N = sampler.N
    const g = new THREE.PlaneGeometry(sampler.size, sampler.size, N - 1, N - 1)
    g.rotateX(-Math.PI / 2)
    // PlaneGeometry rows go from +y (north) to -y; after rotateX, z runs from -size/2 (north) to +size/2
    const pos = g.attributes.position as THREE.BufferAttribute
    const cx = sampler.x0 + sampler.size / 2, cn = sampler.y0 + sampler.size / 2
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx
      const z = pos.getZ(i) - cn
      pos.setXYZ(i, x, sampler.height(x, z), z)
    }
    g.computeVertexNormals()
    g.computeBoundingSphere()

    const tex = new THREE.Texture(rt.data.landcover)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.flipY = false
    tex.colorSpace = THREE.NoColorSpace
    tex.needsUpdate = true
    const pal = new Float32Array(16 * 4)
    const rough = new Float32Array(16)
    for (const [k, col, r] of LC_COLORS) {
      let cc = new THREE.Color(col)
      if (k === 0) cc = new THREE.Color(theme.palette.grass).lerp(new THREE.Color(theme.palette.soil), 0.12).multiplyScalar(0.92)
      if (k === 1 || k === 11) cc = new THREE.Color(theme.palette.grass)
      if (k === 12) cc = new THREE.Color(theme.palette.soil)
      pal[k * 4] = cc.r; pal[k * 4 + 1] = cc.g; pal[k * 4 + 2] = cc.b; pal[k * 4 + 3] = 1
      rough[k] = r
    }
    const palTex = new THREE.DataTexture(pal, 16, 1, THREE.RGBAFormat, THREE.FloatType)
    palTex.needsUpdate = true
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 })
    const uniforms = {
      uLC: { value: tex },
      uPal: { value: palTex },
      uRes: { value: rt.data.world.meta.landcover.res },
      uExt: { value: new THREE.Vector3(sampler.x0, sampler.y0, sampler.size) },
      uWet: { value: 0 },
      uRough: { value: rough },
      uNight: { value: 0 },
    }
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms)
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
${NOISE_GLSL}
uniform sampler2D uLC; uniform sampler2D uPal; uniform float uRes; uniform vec3 uExt; uniform float uWet; uniform float uRough[16]; uniform float uNight; float tFlood;
varying vec3 vWP; float tRough; float tWater;
vec4 lcColor(vec2 texel) {
  float cls = floor(texture2D(uLC, (texel + 0.5) / uRes).r * 255.0 + 0.5);
  vec4 c = texture2D(uPal, vec2((cls + 0.5) / 16.0, 0.5));
  return vec4(c.rgb, cls);
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  // landcover UV: x east, image rows run north->south
  vec2 uv = vec2((vWP.x - uExt.x) / uExt.z, (uExt.y + uExt.z + vWP.z) / uExt.z);
  vec2 wp = vWP.xz;
  // jitter the lookup a little so class borders are organic, then bilinear-blend class colours
  vec2 jit = (vec2(vnoise(wp * 0.35), vnoise(wp * 0.35 + 17.0)) - 0.5) * 2.2;
  vec2 t = uv * uRes - 0.5 + jit / (uExt.z / uRes);
  vec2 f = fract(t); vec2 i0 = floor(t);
  vec4 a = lcColor(i0), b = lcColor(i0 + vec2(1, 0)), c = lcColor(i0 + vec2(0, 1)), d = lcColor(i0 + vec2(1, 1));
  vec3 col = mix(mix(a.rgb, b.rgb, f.x), mix(c.rgb, d.rgb, f.x), f.y);
  float cls = f.x < 0.5 ? (f.y < 0.5 ? a.a : c.a) : (f.y < 0.5 ? b.a : d.a);
  float n = fbm5(wp * 0.06);
  float fine = vnoise(wp * 2.5);
  col *= 0.78 + 0.4 * n;
  col *= 0.92 + 0.14 * fine;
  // dry patches / soil show-through on grass
  float isGrass = step(0.5, cls) * step(cls, 2.5) + step(10.5, cls) * step(cls, 11.5);
  col = mix(col, col * vec3(1.15, 1.05, 0.75), isGrass * smoothstep(0.55, 0.75, vnoise(wp * 0.02)) * 0.6);
  tWater = step(2.5, cls) * step(cls, 3.5);
  float isRoad = step(3.5, cls) * step(cls, 6.5) + step(9.5, cls) * step(cls, 10.5);
  // lane markings on the bigger roads (dashed centre line)
  col = mix(col, col * 0.8, isRoad * uWet * 0.8);
  col = mix(col, col * 0.7, (1.0 - isRoad) * uWet * 0.35);
  tRough = mix(0.95, 0.9, isRoad);
  tRough = mix(tRough, 0.15, isRoad * uWet);
  tRough = mix(tRough, 0.18, tWater);
  // outside the mapped area fade to a neutral ground
  float edge = smoothstep(0.0, 0.03, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  diffuseColor.rgb = mix(vec3(0.33, 0.34, 0.28) * (0.8 + 0.3 * n), col, edge);
  // night: darkness grows with distance from the lit circuit (G = metres to track)
  float dTrack = texture2D(uLC, uv).g * 255.0;
  diffuseColor.rgb *= mix(1.0, mix(0.55, 0.08, smoothstep(12.0, 160.0, dTrack)), uNight);
  tFlood = uNight * (1.0 - smoothstep(8.0, 55.0, dTrack)) * 0.45;
}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = tRough;`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = tWater * 0.0;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * tFlood;`)
    }
    m.customProgramCacheKey = () => 'terrain-v3'
    m.polygonOffset = true
    m.polygonOffsetFactor = 2
    m.polygonOffsetUnits = 2
    ;(m.userData as { u: typeof uniforms }).u = uniforms

    // far skirt: big ring so the horizon is never a cliff
    const sk = new THREE.RingGeometry(sampler.size * 0.49, 22000, 64, 4)
    sk.rotateX(-Math.PI / 2)
    const sp = sk.attributes.position as THREE.BufferAttribute
    let edgeH = 0
    let cnt = 0
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2
      edgeH += sampler.height(cx + Math.cos(a) * sampler.size * 0.49, -cn + Math.sin(a) * sampler.size * 0.49)
      cnt++
    }
    edgeH /= cnt
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i), z = sp.getZ(i)
      const r = Math.hypot(x, z)
      const hills = Math.sin(x * 0.0011) * Math.cos(z * 0.0009) * 60 + Math.sin(x * 0.0003 + 2) * 90
      const w = THREE.MathUtils.smoothstep(r, sampler.size * 0.5, sampler.size * 1.2)
      sp.setXYZ(i, x + cx, edgeH - 3 + hills * w, z - cn)
    }
    sk.computeVertexNormals()
    const skm = new THREE.Mesh(sk, new THREE.MeshStandardMaterial({ color: new THREE.Color(theme.palette.grass).multiplyScalar(0.7), roughness: 1 }))
    skm.receiveShadow = false
    return { geometry: g, material: m, skirt: skm }
  }, [rt, sampler, theme])

  useEffect(() => () => { geometry.dispose(); material.dispose() }, [geometry, material])
  useFrame(() => {
    const u = (material.userData as { u: { uWet: { value: number }; uNight: { value: number } } }).u
    u.uWet.value = look.wet
    u.uNight.value += ((look.night ? 1 : 0) - u.uNight.value) * 0.1
  })
  return (
    <>
      <mesh geometry={geometry} material={material} receiveShadow name="terrain" />
      <primitive object={skirt} />
    </>
  )
}
