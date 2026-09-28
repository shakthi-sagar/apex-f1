import * as THREE from 'three'

/** Physically-inspired gradient sky with sun disc, fbm cloud deck and overcast blend. */
export function createSkyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uCloud: { value: 0.5 },
      uNight: { value: 0 },
      uTime: { value: 0 },
      uZenith: { value: new THREE.Color('#2e63b8') },
      uHorizon: { value: new THREE.Color('#b8cde0') },
      uGround: { value: new THREE.Color('#4a4f55') },
      uOvercast: { value: new THREE.Color('#8e959c') },
      uSunColor: { value: new THREE.Color('#fff2d6') },
      uWind: { value: new THREE.Vector2(1, 0.3) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uSunDir; uniform float uCloud; uniform float uNight; uniform float uTime;
      uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround; uniform vec3 uOvercast; uniform vec3 uSunColor;
      uniform vec2 uWind;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
      float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<6;i++){ s+=a*noise(p); p*=2.03; a*=0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // base clear-sky gradient
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
        float sunAmt = max(dot(d, normalize(uSunDir)), 0.0);
        // Mie-ish forward glow around the sun, warmer near horizon
        sky += uSunColor * (pow(sunAmt, 8.0) * 0.35 + pow(sunAmt, 64.0) * 0.6) * (1.0 - uCloud * 0.8);
        // sun disc
        sky += uSunColor * smoothstep(0.9994, 0.9998, sunAmt) * 18.0 * (1.0 - smoothstep(0.35, 0.8, uCloud));
        // cloud deck projected on a plane
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.08) * 1.6 + uWind * uTime * 0.004;
          float c = fbm(uv);
          float cover = mix(0.25, 1.15, uCloud);
          float dens = smoothstep(1.0 - cover, 1.0 - cover + 0.35, c);
          vec3 lit = mix(vec3(1.0), uOvercast * 1.1, uCloud) * (0.75 + 0.35 * pow(sunAmt, 4.0));
          vec3 shade = uOvercast * mix(0.9, 0.55, uCloud);
          vec3 cloudCol = mix(lit, shade, smoothstep(0.4, 1.0, c));
          float fade = smoothstep(0.0, 0.18, h);
          sky = mix(sky, cloudCol, dens * fade * (0.6 + 0.4 * uCloud));
          // overall overcast veil
          sky = mix(sky, uOvercast * (0.8 + 0.25 * h), smoothstep(0.55, 1.0, uCloud) * 0.85);
        } else {
          sky = mix(uHorizon, uGround, smoothstep(0.0, -0.25, h));
        }
        // night: deep blue + stars
        if (uNight > 0.0) {
          vec3 night = mix(vec3(0.015,0.02,0.045), vec3(0.05,0.06,0.12), clamp(1.0-h,0.0,1.0)*0.6);
          night += vec3(0.22, 0.12, 0.07) * exp(-max(h, 0.0) * 9.0) * 0.9; // light pollution over the city
          float st = step(0.9985, hash(floor(d.xz / (h+0.2) * 300.0))) * smoothstep(0.1, 0.4, h) * (1.0 - uCloud);
          night += vec3(st);
          sky = mix(sky, night, uNight);
        }
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
}

/** Sun direction in three-space from azimuth (deg, clockwise from north) and elevation (deg). */
export function sunDirection(azimuth: number, elevation: number, out = new THREE.Vector3()) {
  const az = THREE.MathUtils.degToRad(azimuth), el = THREE.MathUtils.degToRad(elevation)
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize()
}
