import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { createSkyMaterial, sunDirection } from './sky'
import { useUI } from '../../state/ui'

export interface LookState {
  sunDir: THREE.Vector3
  cloud: number
  night: boolean
  fogColor: THREE.Color
  wet: number
}

/** Shared look parameters (read by materials that need sun/wetness each frame). */
export const look: LookState = {
  sunDir: new THREE.Vector3(0.3, 0.8, 0.2).normalize(),
  cloud: 0.5,
  night: false,
  fogColor: new THREE.Color('#9aa4ad'),
  wet: 0,
}

/**
 * Sky, sun, ambient, fog, environment lighting. Driven by the bundle's environment block:
 * real solar position for the race time & place, cloud cover and wetness from weather data.
 */
export function Atmosphere({ rt }: { rt: RaceRuntime }) {
  const env = rt.data.race.environment
  const { scene, gl } = useThree()
  const skyMat = useMemo(() => createSkyMaterial(), [])
  const sun = useRef<THREE.DirectionalLight>(null!)
  const hemi = useRef<THREE.HemisphereLight>(null!)
  const target = useMemo(() => new THREE.Object3D(), [])
  const night = env.night || env.theme.night
  const timeOfDay = useUI((s) => s.timeOfDayOverride)
  const quality = useUI((s) => s.quality)

  // environment map: rendered from the sky dome once (and when the weather changes a lot)
  const envRT = useRef<THREE.WebGLRenderTarget | null>(null)
  const pmrem = useMemo(() => new THREE.PMREMGenerator(gl), [gl])
  const envScene = useMemo(() => {
    const s = new THREE.Scene()
    const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat)
    s.add(dome)
    // a dark "ground" half so reflections of the road/horizon look grounded
    const ground = new THREE.Mesh(new THREE.CircleGeometry(100, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#3b3e42' }))
    ground.position.y = -2
    s.add(ground)
    const band = new THREE.Mesh(new THREE.CylinderGeometry(95, 95, 9, 48, 1, true), new THREE.MeshBasicMaterial({ color: '#2a2f2b', side: THREE.BackSide }))
    band.position.y = 2.5
    s.add(band)
    const band2 = new THREE.Mesh(new THREE.CylinderGeometry(94, 94, 3, 48, 1, true), new THREE.MeshBasicMaterial({ color: '#4a4f55', side: THREE.BackSide }))
    band2.position.y = 7
    s.add(band2)
    return s
  }, [skyMat])
  const lastEnvCloud = useRef(-1)

  useEffect(() => {
    scene.fog = new THREE.FogExp2(look.fogColor.getHex(), 0.0004)
    return () => { scene.fog = null; envRT.current?.dispose(); pmrem.dispose() }
  }, [scene, pmrem])

  useFrame((state, dt) => {
    const t = rt.time
    // interpolate sun track from the bundle
    const sArr = env.sun
    let i = 0
    while (i + 1 < sArr.length && sArr[i + 1].t <= t) i++
    const a = sArr[i], b = sArr[Math.min(i + 1, sArr.length - 1)]
    const u = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0
    let az = a.azimuth + (b.azimuth - a.azimuth) * u
    let el = a.elevation + (b.elevation - a.elevation) * u
    if (timeOfDay != null) { az = 60 + timeOfDay * 240; el = Math.sin(timeOfDay * Math.PI) * 70 - 5 }
    const isNight = timeOfDay == null ? night : el < 0
    if (isNight) look.sunDir.set(0.18, 0.95, 0.25).normalize() // floodlight truss: near-overhead key
    else sunDirection(az, Math.max(el, 3), look.sunDir)
    const w = rt.weather
    const rainNow = w?.rain ? 1 : 0
    const cloud = THREE.MathUtils.clamp(env.cloudCover * 0.7 + rainNow * 0.35 + rt.wetness * 0.1, 0, 1)
    look.cloud += (cloud - look.cloud) * Math.min(1, dt * 0.5)
    look.wet = rt.wetness
    look.night = isNight

    const U = skyMat.uniforms
    U.uSunDir.value.copy(look.sunDir)
    U.uCloud.value = look.cloud
    U.uNight.value = isNight ? 1 : 0
    U.uTime.value = state.clock.elapsedTime + t * 0.05
    const lowSun = THREE.MathUtils.clamp(1 - el / 25, 0, 1)
    ;(U.uSunColor.value as THREE.Color).setRGB(1, 0.93 - lowSun * 0.25, 0.82 - lowSun * 0.45)
    ;(U.uHorizon.value as THREE.Color).set('#b9cbdc').lerp(new THREE.Color('#f0c9a0'), lowSun * 0.5)
    const wd = w ? THREE.MathUtils.degToRad(w.windDir) : 0
    ;(U.uWind.value as THREE.Vector2).set(Math.sin(wd), -Math.cos(wd)).multiplyScalar(0.5 + (w?.windSpeed ?? 1))

    // lights
    const L = sun.current
    const focus = state.camera.userData.focus as THREE.Vector3 | undefined
    const center = focus ?? state.camera.position
    target.position.copy(center)
    L.position.copy(center).addScaledVector(look.sunDir, 600)
    L.target = target
    const overcast = look.cloud
    L.intensity = isNight ? 1.35 : THREE.MathUtils.lerp(3.4, 1.1, overcast) * THREE.MathUtils.clamp(el / 12, 0.2, 1)
    if (isNight) L.color.set('#f2f4ff')
    else L.color.setRGB(1, 0.95 - lowSun * 0.2, 0.88 - lowSun * 0.35)
    L.shadow.intensity = THREE.MathUtils.lerp(1, 0.55, overcast)
    hemi.current.intensity = isNight ? 0.1 : THREE.MathUtils.lerp(0.55, 0.7, overcast)
    hemi.current.color.set(isNight ? '#35425e' : '#cfdcea').lerp(new THREE.Color('#aeb4ba'), overcast)
    hemi.current.groundColor.set(isNight ? '#0b0c10' : '#5a5448')

    // fog: humidity/haze from the environment, heavier in rain
    const fog = state.scene.fog as THREE.FogExp2
    const fogCol = look.fogColor
    if (isNight) fogCol.set('#1b1a24').lerp(new THREE.Color('#3a2a22'), 0.35) // sodium city glow
    else fogCol.set('#b3c1cf').lerp(new THREE.Color('#9aa1a8'), overcast).lerp(new THREE.Color('#e8cfb0'), lowSun * 0.25 * (1 - overcast))
    fog.color.copy(fogCol)
    const baseDensity = 0.00012 + env.fog * 0.00045 + rainNow * 0.00055
    fog.density += (baseDensity - fog.density) * Math.min(1, dt)

    // refresh env map when cloud cover changes noticeably
    if (Math.abs(look.cloud - lastEnvCloud.current) > 0.08 || !envRT.current) {
      lastEnvCloud.current = look.cloud
      envRT.current?.dispose()
      envRT.current = pmrem.fromScene(envScene, 0, 0.1, 200)
      state.scene.environment = envRT.current.texture
      state.scene.environmentIntensity = isNight ? 0.3 : THREE.MathUtils.lerp(0.9, 0.62, overcast)
    }
  }, -50)

  return (
    <>
      <mesh geometry={useMemo(() => new THREE.SphereGeometry(15000, 48, 24), [])} material={skyMat} frustumCulled={false} renderOrder={-10} />
      <primitive object={target} />
      <directionalLight
        key={quality}
        ref={sun}
        castShadow
        shadow-mapSize={quality === 'ultra' ? [4096, 4096] : [2048, 2048]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
        shadow-camera-near={10}
        shadow-camera-far={1400}
        shadow-camera-left={-110}
        shadow-camera-right={110}
        shadow-camera-top={110}
        shadow-camera-bottom={-110}
      />
      <hemisphereLight ref={hemi} args={['#cfdcea', '#5a5448', 1]} />
    </>
  )
}
