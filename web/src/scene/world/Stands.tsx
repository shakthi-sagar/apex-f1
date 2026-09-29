import { useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { NOISE_GLSL } from '../shaders/noise'
import { ribbon } from '../track/trackGeometry'
import { roofMaterial } from '../shaders/roof'
import { freeze } from '../static'
import type { TerrainSampler } from './terrainSampler'

/**
 * Grandstands placed by the pipeline (generic placements where OSM has none):
 * raked seating deck with a procedural crowd, back wall and cantilever roof.
 */
export function Stands({ rt, terrain }: { rt: RaceRuntime; terrain: TerrainSampler }) {
  const c = rt.circuit
  const group = useMemo(() => {
    const g = new THREE.Group()
    const crowd = crowdMaterial()
    const steel = new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.7, metalness: 0.3, side: THREE.DoubleSide })
    const roofM = roofMaterial('#b9bec5')
    for (const st of c.meta.stands) {
      const sign = st.side === 'left' ? 1 : -1
      let s0 = st.s0, s1 = st.s1
      if (s1 < s0) s1 += c.length
      const edge = (i: number) => (sign > 0 ? c.barrierLeft[i] : c.barrierRight[i])
      const ground = (x: number, z: number, base: number) => Math.max(base, terrain.height(x, z))
      const deck = ribbon(c, {
        s0, s1, step: 2, across: 12,
        inner: (_s, i) => edge(i) + sign * 4, outer: (_s, i) => edge(i) + sign * (4 + st.depth),
        yFn: (x, z, base, u) => ground(x, z, base) + 1.5 + u * st.height,
        extra: { aRow: (_s, u) => u },
      })
      const dm = new THREE.Mesh(deck, crowd)
      dm.receiveShadow = true
      dm.castShadow = true
      g.add(dm)
      const back = ribbon(c, {
        s0, s1, step: 4, across: 1,
        inner: (_s, i) => edge(i) + sign * (4 + st.depth), outer: (_s, i) => edge(i) + sign * (4 + st.depth + 0.01),
        yFn: (x, z, base, u) => ground(x, z, base) + u * (st.height + 5),
      })
      g.add(new THREE.Mesh(back, steel))
      const roof = ribbon(c, {
        s0, s1, step: 4, across: 2,
        inner: (_s, i) => edge(i) + sign * (4 + st.depth * 0.35), outer: (_s, i) => edge(i) + sign * (4 + st.depth + 0.5),
        yFn: (x, z, base, u) => ground(x, z, base) + st.height + 4.2 + u * 1.6,
      })
      const rm = new THREE.Mesh(roof, roofM)
      rm.castShadow = true
      g.add(rm)
    }
    return freeze(g)
  }, [c, terrain])
  return <primitive object={group} />
}

function crowdMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRow; varying float vRow; varying vec2 vDS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRow = aRow; vDS = uv;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${NOISE_GLSL}
varying float vRow; varying vec2 vDS;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // rows of seats with spectators: fine jittered cells, filtered toward the average with distance
  float rows = vRow * 46.0;
  float row = floor(rows);
  float seat = floor(vDS.y / 0.55 + n_hash(vec2(row, 1.0)) * 0.5);
  float h = n_hash(vec2(seat, row));
  float occupied = step(0.22, h);
  vec3 seatCol = vec3(0.07, 0.12, 0.26);
  float k = fract(h * 7.31);
  vec3 shirt = k < 0.4 ? vec3(0.05, 0.055, 0.07) : k < 0.58 ? vec3(0.62, 0.63, 0.65) : k < 0.7 ? vec3(0.1, 0.16, 0.34)
             : k < 0.8 ? vec3(0.55, 0.1, 0.08) : k < 0.88 ? vec3(0.8, 0.62, 0.1) : vec3(0.08, 0.36, 0.16);
  shirt *= 0.75 + 0.35 * fract(h * 13.7);
  float step_ = smoothstep(0.7, 0.92, fract(rows));
  vec3 col = mix(seatCol, shirt, occupied);
  col *= 1.0 - step_ * 0.55;
  vec3 avg = vec3(0.16, 0.16, 0.18);
  float fw = max(fwidth(rows), fwidth(vDS.y / 0.55));
  col = mix(col, avg, smoothstep(0.35, 1.2, fw));
  diffuseColor.rgb = col;
}`)
  }
  m.customProgramCacheKey = () => 'crowd-v2'
  return m
}
