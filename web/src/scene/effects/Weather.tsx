import { useFrame, useThree } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { look } from '../atmosphere/Atmosphere'
import { scriptTime } from '../scripted'

const DROPS = 14000
const BOX = 60

/** Rain streaks in a camera-relative wrapping volume; direction follows measured wind. */
export function Rain({ rt }: { rt: RaceRuntime }) {
  const { camera } = useThree()
  const { mesh, mat } = useMemo(() => {
    const g = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(0.012, 0.9)
    g.index = quad.index
    g.attributes.position = quad.attributes.position
    g.attributes.uv = quad.attributes.uv
    const offs = new Float32Array(DROPS * 4)
    for (let i = 0; i < DROPS; i++) {
      offs[i * 4] = Math.random() * BOX
      offs[i * 4 + 1] = Math.random() * BOX
      offs[i * 4 + 2] = Math.random() * BOX
      offs[i * 4 + 3] = Math.random()
    }
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(offs, 4))
    g.instanceCount = DROPS
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() },
        uAmount: { value: 0 }, uColor: { value: new THREE.Color('#c8d2dc') }, uNear: { value: 2 }, uLens: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aOff; uniform float uTime; uniform vec3 uCam; uniform vec2 uWind; uniform float uAmount; uniform float uNear; uniform float uLens;
        varying float vA; varying vec2 vUv;
        void main() {
          float speed = 11.0 + aOff.w * 4.0;
          vec3 p = aOff.xyz;
          p.y -= uTime * speed;
          p.xz += uWind * uTime * 0.6;
          p = mod(p - uCam + ${BOX / 2}.0, ${BOX}.0) - ${BOX / 2}.0 + uCam;
          // stretch along fall direction and face the camera (cylindrical billboard)
          vec3 fall = normalize(vec3(uWind.x * 0.06, -1.0, uWind.y * 0.06));
          vec3 toCam = normalize(uCam - p);
          vec3 side = normalize(cross(fall, toCam));
          vec3 wp = p + side * position.x * uLens + fall * position.y;
          vA = step(aOff.w, uAmount) * smoothstep(${BOX / 2}.0, 4.0, length(p - uCam)) * smoothstep(uNear, uNear * 1.6, length(p - uCam));
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uLens; varying float vA; varying vec2 vUv;
        void main() {
          float a = vA * (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.3, vUv.y) * 0.32 * uLens;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 10
    return { mesh, mat }
  }, [])
  useFrame((state) => {
    const w = rt.weather
    const target = w?.rain ? 0.55 + 0.45 * Math.min(1, rt.wetness) : 0
    const u = mat.uniforms
    u.uAmount.value += (target - u.uAmount.value) * 0.02
    u.uTime.value = scriptTime(state.clock.elapsedTime)
    u.uCam.value.copy(camera.position)
    const fov = (camera as THREE.PerspectiveCamera).fov
    u.uNear.value = THREE.MathUtils.clamp(2.5 * (55 / fov), 1.5, 26)
    u.uLens.value = THREE.MathUtils.clamp(fov / 45, 0.18, 1)
    const wd = THREE.MathUtils.degToRad(w?.windDir ?? 0)
    u.uWind.value.set(Math.sin(wd), -Math.cos(wd)).multiplyScalar(w?.windSpeed ?? 0)
    mesh.visible = u.uAmount.value > 0.01
  })
  return <primitive object={mesh} />
}

const PER_CAR = 90

/** Tyre spray plumes behind each car on a wet track (soft sprites, CPU-simulated ring buffer). */
export function Spray({ rt }: { rt: RaceRuntime }) {
  const n = rt.poses.length * PER_CAR
  const { points, pos, life, vel, head } = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(n * 3)
    const life = new Float32Array(n)
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aLife', new THREE.BufferAttribute(life, 1))
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const x = c.getContext('2d')!
    const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32)
    grd.addColorStop(0, 'rgba(255,255,255,0.9)')
    grd.addColorStop(0.5, 'rgba(255,255,255,0.35)')
    grd.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = grd
    x.fillRect(0, 0, 64, 64)
    const tex = new THREE.CanvasTexture(c)
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTex: { value: tex }, uColor: { value: new THREE.Color('#d7dde3') }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float aLife; varying float vL; uniform float uScale;
        void main() {
          vL = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float size = mix(3.2, 0.5, aLife);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform vec3 uColor; varying float vL;
        void main() {
          if (vL <= 0.0) discard;
          float a = texture2D(uTex, gl_PointCoord).a * vL * vL * 0.13;
          gl_FragColor = vec4(uColor, a);
        }`,
    })
    const points = new THREE.Points(g, mat)
    points.frustumCulled = false
    points.renderOrder = 5
    return { points, pos, life, vel: new Float32Array(n * 3), head: new Int32Array(rt.poses.length) }
  }, [n, rt])
  const { size } = useThree()
  useFrame((state, dtRaw) => {
    const dt = Math.min(0.05, dtRaw)
    const wet = look.wet
    ;(points.material as THREE.ShaderMaterial).uniforms.uScale.value = size.height * 0.9
    const playing = rt.clock.playing ? rt.clock.rate : 0
    for (let c = 0; c < rt.poses.length; c++) {
      const p = rt.poses[c]
      const v = p.sample.v
      const emit = p.visible && wet > 0.15 && v > 15 && playing !== 0 ? Math.min(6, (v / 30) * wet * 4) : 0
      for (let e = 0; e < emit; e++) {
        const i = c * PER_CAR + head[c]
        head[c] = (head[c] + 1) % PER_CAR
        const side = e % 2 ? 1 : -1
        const back = -2.2 - Math.random() * 0.8
        const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw)
        const z = side * (0.7 + Math.random() * 0.2)
        pos[i * 3] = p.position.x + back * cy + z * sy
        pos[i * 3 + 1] = p.position.y + 0.3 + Math.random() * 0.2
        pos[i * 3 + 2] = p.position.z - back * sy + z * cy
        const fv = v * 0.25
        vel[i * 3] = p.forward.x * fv + (Math.random() - 0.5) * 2
        vel[i * 3 + 1] = 1.2 + Math.random() * 1.5
        vel[i * 3 + 2] = p.forward.z * fv + (Math.random() - 0.5) * 2
        life[i] = 1
      }
    }
    for (let i = 0; i < n; i++) {
      if (life[i] <= 0) continue
      life[i] -= dt * 0.9
      pos[i * 3] += vel[i * 3] * dt
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt
      vel[i * 3] *= 0.96; vel[i * 3 + 2] *= 0.96; vel[i * 3 + 1] *= 0.97
    }
    const g = points.geometry
    ;(g.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.aLife as THREE.BufferAttribute).needsUpdate = true
    void state
  })
  return <primitive object={points} />
}
