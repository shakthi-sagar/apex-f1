/** Shared GLSL noise helpers (value noise / fbm), injected into material shaders. */
export const NOISE_GLSL = /* glsl */ `
float n_hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float n_hash3(vec3 p){ return fract(sin(dot(p, vec3(17.1, 113.7, 51.3))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(n_hash(i), n_hash(i + vec2(1.0, 0.0)), u.x), mix(n_hash(i + vec2(0.0, 1.0)), n_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }
float fbm5(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`
