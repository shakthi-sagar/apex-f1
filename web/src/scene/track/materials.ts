import * as THREE from 'three'
import { NOISE_GLSL } from '../shaders/noise'

export const trackUniforms = {
  uWet: { value: 0 },
  uTime: { value: 0 },
  uLength: { value: 4000 },
  uGridSlots: { value: 20 },
  uPoleSide: { value: 1 },
  uFlood: { value: 0 }, // night floodlighting: extra light on trackside surfaces
}

/** Inject the floodlight term (albedo-proportional light) into a material's shader. */
function flood(sh: { fragmentShader: string; uniforms: Record<string, unknown> }) {
  sh.uniforms.uFlood = trackUniforms.uFlood
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uFlood;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uFlood;')
}

/**
 * Asphalt: macro/micro grain, darker rubbered racing line, edge lines, start/finish line,
 * grid boxes, wet response (darkening, low roughness, puddles, rain ripples).
 * Ribbon attributes: uv = (d, s); aL/aR = edge offsets; aRL = racing line offset.
 */
export function asphaltMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ color: 0x3a3b3e, roughness: 0.9, metalness: 0, clearcoat: 0, envMapIntensity: 1 })
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, trackUniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aL; attribute float aR; attribute float aRL;
varying vec2 vDS; varying float vL; varying float vR; varying float vRL; varying vec3 vWP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vDS = uv; vL = aL; vR = aR; vRL = aRL;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;`)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${NOISE_GLSL}
uniform float uWet; uniform float uTime; uniform float uLength; uniform float uGridSlots; uniform float uPoleSide;
varying vec2 vDS; varying float vL; varying float vR; varying float vRL; varying vec3 vWP;
float paintMask; float wetMask;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float d = vDS.x; float s = vDS.y;
  vec2 wp = vWP.xz;
  // asphalt grain
  float g1 = fbm3(wp * 0.9);
  float g2 = vnoise(wp * 7.0);
  float g3 = n_hash(floor(wp * 60.0));
  vec3 base = vec3(0.16, 0.162, 0.168) * (0.82 + 0.28 * g1) * (0.92 + 0.12 * g2) * (0.95 + 0.1 * g3);
  // subtle warm/cool variation across the track
  base *= 1.0 + 0.04 * sin(d * 2.5 + fbm3(wp * 0.01) * 6.0);
  // patches / resurfacing
  float patchN = smoothstep(0.62, 0.66, fbm3(wp * 0.035 + 7.0));
  base = mix(base, base * 0.78, patchN * 0.6);
  // rubber on the racing line
  float rub = exp(-pow((d - vRL) / 1.6, 2.0)) * (0.6 + 0.4 * fbm3(vec2(s * 0.05, d)));
  base *= 1.0 - 0.32 * rub;
  // tire marks: dark streaks along the racing line, offset to wheel positions
  float tm1 = exp(-pow((d - vRL - 0.8) / 0.25, 2.0)) * smoothstep(0.3, 0.7, fbm3(vec2(s * 0.08, d * 3.0)));
  float tm2 = exp(-pow((d - vRL + 0.8) / 0.25, 2.0)) * smoothstep(0.3, 0.7, fbm3(vec2(s * 0.08 + 5.0, d * 3.0)));
  float tm3 = exp(-pow((d - vRL - 0.35) / 0.15, 2.0)) * smoothstep(0.4, 0.8, fbm3(vec2(s * 0.12, d * 4.0)));
  float tm4 = exp(-pow((d - vRL + 0.35) / 0.15, 2.0)) * smoothstep(0.4, 0.8, fbm3(vec2(s * 0.12 + 3.0, d * 4.0)));
  float tireMarks = tm1 * 0.18 + tm2 * 0.18 + tm3 * 0.12 + tm4 * 0.12;
  base *= 1.0 - tireMarks * (1.0 - wetMask);
  // skid marks at heavy braking zones (corners)
  float skid = smoothstep(0.75, 0.95, fbm3(vec2(s * 0.15, d * 2.0))) * exp(-pow((d - vRL) / 2.0, 2.0));
  base *= 1.0 - skid * 0.15 * (1.0 - wetMask);
  // edge lines (white, ~20 cm) just inside the edges
  float lw = 0.22;
  float eL = smoothstep(lw + 0.025, lw, abs(d - (vL - 0.18)));
  float eR = smoothstep(lw + 0.025, lw, abs(d - (vR + 0.18)));
  paintMask = max(eL, eR);
  // start / finish line (s = 0)
  float sw = min(abs(s), abs(s - uLength));
  float startLine = step(sw, 0.5) * step(vR, d) * step(d, vL);
  // grid boxes behind the line: alternate sides every 8 m, 16 m per row pair
  float gs = uLength - s; // metres behind the line
  float slot = floor((gs - 6.0) / 8.0);
  float inGrid = step(6.0, gs) * step(slot, uGridSlots - 1.0);
  float side = mod(slot, 2.0) < 0.5 ? uPoleSide : -uPoleSide;
  float slotFront = abs(gs - (6.0 + slot * 8.0));
  float boxLat = abs(d - side * 3.0);
  float gridLine = inGrid * step(slotFront, 0.12) * step(boxLat, 1.1);
  float gridSide = inGrid * step(abs(boxLat - 1.1), 0.09) * step(gs - (6.0 + slot * 8.0), 1.6);
  paintMask = max(paintMask, max(startLine, max(gridLine, gridSide)));
  vec3 paint = vec3(0.86);
  // worn paint
  paint *= 0.85 + 0.15 * g2;
  diffuseColor.rgb = mix(base, paint, paintMask);
  // wetness: darkening + puddles in low / worn spots
  float pud = smoothstep(0.52, 0.72, fbm3(wp * 0.12 + 3.0) + 0.15 * g1);
  wetMask = clamp(uWet * (0.75 + 0.5 * pud), 0.0, 1.0);
  diffuseColor.rgb *= mix(1.0, 0.42, wetMask * (1.0 - paintMask * 0.5));
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(0.86 - 0.12 * paintMask, 0.07, wetMask);
roughnessFactor = mix(roughnessFactor, 0.02, wetMask * smoothstep(0.55, 0.8, fbm3(vWP.xz * 0.12 + 3.0)));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // micro grain + rain ripples perturb the normal
  vec2 wp = vWP.xz;
  float e = 0.05;
  float h0 = vnoise(wp * 18.0);
  vec2 grad = vec2(vnoise(wp * 18.0 + vec2(e, 0.0)) - h0, vnoise(wp * 18.0 + vec2(0.0, e)) - h0) / e;
  float amp = mix(0.025, 0.006, wetMask);
  // ripples: expanding rings on a jittered grid
  vec2 cell = floor(wp * 1.3); vec2 f = fract(wp * 1.3) - 0.5;
  float ph = fract(uTime * 1.3 + n_hash(cell));
  float r = length(f + (vec2(n_hash(cell + 3.1), n_hash(cell + 7.7)) - 0.5) * 0.5);
  float ring = sin((r - ph * 0.5) * 60.0) * exp(-r * 8.0) * (1.0 - ph);
  vec2 rip = normalize(f + 1e-4) * ring * 0.25 * uWet;
  vec3 nWorld = normalize(vec3(-(grad.x * amp + rip.x), 1.0, -(grad.y * amp + rip.y)));
  normal = normalize(mix(normal, (viewMatrix * vec4(nWorld, 0.0)).xyz, 0.8));
}`)
  }
  const inner = m.onBeforeCompile
  m.onBeforeCompile = (sh, r) => { inner(sh, r); flood(sh) }
  m.customProgramCacheKey = () => 'asphalt-v3'
  return m
}

/** Kerb: red/white (or theme) stripes along s, slight sheen, wet gloss. */
export function kerbMaterial(colA = '#d4202a', colB = '#f2f2f2') {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWet = trackUniforms.uWet
    sh.uniforms.uA = { value: new THREE.Color(colA) }
    sh.uniforms.uB = { value: new THREE.Color(colB) }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDS = uv;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uA; uniform vec3 uB; uniform float uWet; varying vec2 vDS;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float stripe = step(0.5, fract(vDS.y / 2.0));
diffuseColor.rgb = mix(uA, uB, stripe) * mix(1.0, 0.7, uWet);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(0.5, 0.1, uWet);`)
  }
  const innerK = m.onBeforeCompile
  m.onBeforeCompile = (sh, r) => { innerK(sh, r); flood(sh) }
  m.customProgramCacheKey = () => 'kerb-v2'
  return m
}

/** Runoff: painted verge, grass, tarmac runoff with coloured bands, gravel. aSurf = 0 grass, 1 tarmac, 2 gravel. */
export function runoffMaterial(grass = '#4a6b2c', soil = '#8a4f32') {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWet = trackUniforms.uWet
    sh.uniforms.uGrass = { value: new THREE.Color(grass) }
    sh.uniforms.uSoil = { value: new THREE.Color(soil) }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSurf; attribute float aEdge; varying float vSurf; varying float vEdge; varying vec3 vWP; varying vec2 vDS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf; vEdge = aEdge; vDS = uv;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${NOISE_GLSL}
uniform float uWet; uniform vec3 uGrass; uniform vec3 uSoil;
varying float vSurf; varying float vEdge; varying vec3 vWP; varying vec2 vDS; float rgh;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 wp = vWP.xz;
  float n = fbm5(wp * 0.25);
  float fine = vnoise(wp * 6.0);
  vec3 grass = uGrass * (0.75 + 0.45 * n) * (0.9 + 0.2 * fine);
  grass = mix(grass, grass * vec3(1.1, 1.05, 0.8), smoothstep(0.55, 0.75, vnoise(wp * 0.07)));
  // patches of worn/yellow grass near the track edge
  float worn = smoothstep(0.3, 0.0, vEdge) * smoothstep(0.5, 0.8, vnoise(wp * 0.05));
  grass = mix(grass, vec3(0.55, 0.5, 0.25), worn * 0.4);
  // mowing stripes
  grass *= 0.93 + 0.07 * step(0.5, fract(vDS.y / 12.0));
  vec3 tarmac = vec3(0.3, 0.31, 0.32) * (0.85 + 0.25 * n);
  // painted runoff bands near the kerb (green/blue F1 style)
  float band = smoothstep(0.0, 0.02, vEdge) * (1.0 - smoothstep(2.5, 2.52, vEdge));
  tarmac = mix(tarmac, vec3(0.12, 0.42, 0.25), band * 0.9);
  float stripes = step(0.5, fract(vDS.y / 6.0)) * (1.0 - smoothstep(3.5, 3.52, vEdge)) * smoothstep(2.5, 2.52, vEdge);
  tarmac = mix(tarmac, vec3(0.1, 0.25, 0.55), stripes * 0.7);
  vec3 gravel = mix(vec3(0.62, 0.55, 0.45), uSoil, 0.25) * (0.75 + 0.35 * n) * (0.85 + 0.3 * n_hash(floor(wp * 40.0)));
  // painted verge right next to the kerb (astroturf strip)
  float verge = 1.0 - smoothstep(1.4, 1.45, vEdge);
  vec3 astro = vec3(0.16, 0.42, 0.2) * (0.9 + 0.2 * fine);
  vec3 col = grass;
  col = mix(col, tarmac, smoothstep(0.5, 0.6, vSurf) * (1.0 - smoothstep(1.5, 1.6, vSurf)));
  col = mix(col, gravel, smoothstep(1.5, 1.6, vSurf));
  col = mix(col, astro, verge * (1.0 - smoothstep(0.5, 0.6, vSurf)));
  float isTar = smoothstep(0.5, 0.6, vSurf) * (1.0 - smoothstep(1.5, 1.6, vSurf));
  col *= mix(1.0, mix(0.8, 0.6, isTar), uWet);
  diffuseColor.rgb = col;
  rgh = mix(0.95, mix(0.85, 0.12, uWet), isTar);
  rgh = mix(rgh, mix(0.9, 0.5, uWet), 1.0 - isTar - smoothstep(1.5, 1.6, vSurf));
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = rgh;`)
  }
  const innerR = m.onBeforeCompile
  m.onBeforeCompile = (sh, r) => { innerR(sh, r); flood(sh) }
  m.customProgramCacheKey = () => 'runoff-v2'
  return m
}

/** Concrete wall with advertising panels (generic colour blocks, no trademarks). */
export function wallMaterial(accent = '#e10600') {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAccent = { value: new THREE.Color(accent) }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH; varying float vH; varying vec2 vDS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = aH; vDS = uv;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${NOISE_GLSL}
uniform vec3 uAccent; varying float vH; varying vec2 vDS;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float s = vDS.y;
  float panel = floor(s / 24.0);
  float r = n_hash(vec2(panel, 3.0));
  vec3 concrete = vec3(0.78, 0.78, 0.76) * (0.85 + 0.15 * vnoise(vec2(s * 0.5, vH * 4.0)));
  vec3 adCol = r < 0.33 ? uAccent : (r < 0.6 ? vec3(0.05, 0.07, 0.12) : (r < 0.8 ? vec3(0.95) : vec3(0.0, 0.3, 0.7)));
  vec3 txt = r < 0.6 ? vec3(0.95) : vec3(0.08);
  float band = step(0.18, vH) * step(vH, 0.92);
  float fx = fract(s / 24.0);
  float letters = step(0.2, fx) * step(fx, 0.8) * step(0.42, vH) * step(vH, 0.68) * step(0.35, n_hash(vec2(floor(s * 1.2), panel)));
  vec3 ad = mix(adCol, txt, letters);
  diffuseColor.rgb = mix(concrete, ad, band * step(0.3, r));
}`)
  }
  const innerW = m.onBeforeCompile
  m.onBeforeCompile = (sh, r) => { innerW(sh, r); flood(sh) }
  m.customProgramCacheKey = () => 'wall-v2'
  return m
}

let fenceTex: THREE.Texture | null = null
export function fenceMaterial() {
  if (!fenceTex) {
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    const g = c.getContext('2d')!
    g.clearRect(0, 0, 64, 64)
    g.strokeStyle = 'rgba(200,205,210,1)'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64)
    g.stroke()
    fenceTex = new THREE.CanvasTexture(c)
    fenceTex.wrapS = fenceTex.wrapT = THREE.RepeatWrapping
    fenceTex.anisotropy = 8
  }
  const m = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, map: fenceTex, alphaMap: fenceTex, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.8 })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
vMapUv = vec2(uv.y * 5.0, position.y * 5.0);
#endif
#ifdef USE_ALPHAMAP
vAlphaMapUv = vec2(uv.y * 5.0, position.y * 5.0);
#endif`)
  }
  m.customProgramCacheKey = () => 'fence-v1'
  return m
}
