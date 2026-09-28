import * as THREE from 'three'
import { NOISE_GLSL } from './noise'

/** Ribbed metal roof (standing-seam) using ribbon uv = (d, s); weathered, wet-aware. */
export function roofMaterial(base = '#8a9098') {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.55, side: THREE.DoubleSide })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBase = { value: new THREE.Color(base) }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDS = uv;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${NOISE_GLSL}
uniform vec3 uBase; varying vec2 vDS;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float rib = smoothstep(0.06, 0.0, abs(fract(vDS.y / 1.1) - 0.5) - 0.44);
  float seam = smoothstep(0.08, 0.0, abs(fract(vDS.x / 9.0) - 0.5) - 0.46);
  float grime = fbm3(vDS * vec2(0.08, 0.02));
  vec3 col = uBase * (0.8 + 0.25 * grime) * (1.0 - 0.18 * rib) * (1.0 - 0.3 * seam);
  diffuseColor.rgb = col;
}`)
  }
  m.customProgramCacheKey = () => 'roof-v1'
  return m
}
