import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitImpl } from 'three-stdlib'
import type { RaceRuntime } from '../replay/runtime'
import { useUI } from '../state/ui'
import type { TerrainSampler } from '../scene/world/terrainSampler'
import { Director } from './director'
import { SHOTS, newShot, tracksideCameras, type ShotContext } from './shots'

/** Camera state shared with post-processing (depth of field focus). */
export const cameraState = { focusDistance: 30, dofAmount: 0, cutAt: 0, mode: 'chase' as string }

export function CameraRig({ rt, terrain }: { rt: RaceRuntime; terrain: TerrainSampler }) {
  const { camera } = useThree() as { camera: THREE.PerspectiveCamera }
  const controls = useRef<OrbitImpl>(null)
  const mode = useUI((s) => s.camera)
  const director = useMemo(() => new Director(rt), [rt])
  const cams = useMemo(() => {
    // building height lookup: sample the world's building data to keep cameras out of structures
    const bldHeight = (x: number, z: number) => {
      const w = rt.data.world
      const offs = w.get<Uint32Array>('bld_offsets')
      const xy = w.get<Float32Array>('bld_xy')
      const hgt = w.get<Float32Array>('bld_height')
      const base = w.get<Float32Array>('bld_base')
      const north = -z
      let maxH = 0
      // check buildings in a coarse grid around the point
      for (let b = 0; b < hgt.length; b++) {
        const i0 = offs[b]
        const bx = xy[i0 * 2], by = -xy[i0 * 2 + 1]
        const d = Math.hypot(bx - x, by - north)
        if (d < 25) maxH = Math.max(maxH, base[b] + hgt[b])
      }
      return maxH
    }
    return tracksideCameras(rt.circuit, (x, z) => terrain.height(x, z), bldHeight)
  }, [rt, terrain])
  const shot = useMemo(() => newShot(), [])
  const cur = useRef({ pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 50, init: false, shotStart: 0, seed: 0.3, lastMode: '', lastDriver: '' })
  const lastTime = useRef(rt.time)
  const orbitFollow = useRef(new THREE.Vector3())
  const intro = useRef({ start: -1, done: false })
  const center = useMemo(() => {
    const c = rt.circuit
    const b = new THREE.Box3()
    for (let i = 0; i < c.n; i += 10) b.expandByPoint(new THREE.Vector3(c.px[i * 3], c.px[i * 3 + 1], c.px[i * 3 + 2]))
    return { c: b.getCenter(new THREE.Vector3()), r: b.getSize(new THREE.Vector3()).length() / 2 }
  }, [rt])

  useEffect(() => {
    // start framed on the grid from above the start line
    const p = rt.circuit.point(-120, 0)
    camera.position.set(p.x + 60, p.y + 45, p.z + 60)
    camera.lookAt(p)
    camera.near = 0.2
    camera.far = 30000
    camera.updateProjectionMatrix()
  }, [camera, rt])

  useEffect(() => {
    // leaving director resets its state so it re-evaluates cleanly when re-enabled
    if (mode !== 'director') director.reset()
    if ((mode === 'orbit' || mode === 'free') && controls.current) {
      const sel = rt.byNum.get(useUI.getState().selected ?? '') ?? rt.poses[0]
      controls.current.target.copy(sel.position)
      orbitFollow.current.copy(sel.position)
    }
  }, [mode, director, rt])

  useFrame((state, dtRaw) => {
    if ((window as unknown as { __f1freeze?: boolean }).__f1freeze) { if (controls.current) controls.current.enabled = false; return }
    const dt = Math.min(0.1, dtRaw)
    const ui = useUI.getState()
    // establishing flyover (first ~6 s, director only); any user camera choice skips it
    if (!intro.current.done) {
      if (intro.current.start < 0) intro.current.start = state.clock.elapsedTime
      const k = (state.clock.elapsedTime - intro.current.start) / 6.5
      if (k >= 1 || !ui.director) { intro.current.done = true; cur.current.init = false }
      else {
        const e = k * k * (3 - 2 * k)
        const a = -0.9 + e * 1.4
        const r = center.r * (1.25 - 0.35 * e)
        camera.position.set(center.c.x + Math.cos(a) * r, center.c.y + center.r * (0.55 - 0.2 * e), center.c.z + Math.sin(a) * r)
        camera.up.set(0, 1, 0)
        camera.lookAt(center.c)
        camera.fov = 38
        camera.near = 2
        camera.updateProjectionMatrix()
        camera.userData.focus = center.c
        cameraState.mode = 'heli'
        if (k < 0.05) useUI.getState().setCaption(`${rt.data.race.circuit.name} · ${rt.data.race.race.location}`)
        return
      }
    }
    const t = rt.time
    const jumped = Math.abs(t - lastTime.current) > 20
    lastTime.current = t
    let camMode = ui.camera
    let driver = ui.selected
    let secondary: string | null = ui.compare
    let cut = false
    if (ui.director && !ui.duel) {
      const r = director.update(t, state.clock.elapsedTime)
      if (r.d) {
        camMode = r.d.camera
        driver = r.d.driver
        secondary = r.d.secondary
        if (r.cut) {
          cut = true
          if (ui.selected !== driver) useUI.setState({ selected: driver })
          useUI.getState().setCaption(r.d.caption)
        }
      }
    }
    const duel = ui.duel
    const duelTarget = duel ? (ui.compare && duel.poses[1].driver.num === ui.compare && ui.selected === ui.compare ? duel.poses[1] : duel.poses[0]) : null
    const target = duelTarget ?? (driver && rt.byNum.get(driver)?.visible ? rt.byNum.get(driver) : null)
      ?? rt.poses.find((p) => p.visible && p.racePosition === 1) ?? rt.poses.find((p) => p.visible) ?? rt.poses[0]
    if (!ui.director && !ui.selected && target) useUI.setState({ selected: target.driver.num })
    const c = cur.current
    if (camMode !== c.lastMode || target.driver.num !== c.lastDriver) {
      c.shotStart = state.clock.elapsedTime
      c.seed = Math.random()
      if (c.lastMode && ui.director) cut = true
      c.lastMode = camMode
      c.lastDriver = target.driver.num
      cameraState.cutAt = state.clock.elapsedTime
    }
    cameraState.mode = camMode
    camera.userData.focus = target.position

    // user-controlled modes
    if (camMode === 'orbit' || camMode === 'free') {
      if (controls.current) {
        controls.current.enabled = true
        if (camMode === 'orbit' && target.visible) {
          // translate camera + target by the car's motion so the orbit follows the car
          const delta = target.position.clone().sub(orbitFollow.current)
          if (delta.length() < 200) { camera.position.add(delta); controls.current.target.add(delta) }
          else { controls.current.target.copy(target.position); camera.position.copy(target.position).add(new THREE.Vector3(12, 6, 12)) }
          orbitFollow.current.copy(target.position)
        }
        controls.current.update()
      }
      c.pos.copy(camera.position)
      c.init = true
      cameraState.dofAmount = 0
      return
    }
    if (controls.current) controls.current.enabled = false

    const gen = SHOTS[camMode] ?? SHOTS.chase!
    const ctx: ShotContext = {
      rt, target, secondary: secondary ? rt.byNum.get(secondary) ?? null : null, cams, camera,
      time: t, shotTime: state.clock.elapsedTime - c.shotStart, seed: c.seed, heightAt: (x, z) => terrain.height(x, z),
    }
    shot.up = undefined
    shot.shake = 0
    shot.dof = undefined
    gen(ctx, shot)
    // keep cameras above ground
    const gh = terrain.inside(shot.pos.x, shot.pos.z) ? terrain.height(shot.pos.x, shot.pos.z) : -1e9
    if (shot.stiffness < 1 && shot.pos.y < gh + 0.6) shot.pos.y = gh + 0.6

    if (!c.init || cut || jumped) {
      c.pos.copy(shot.pos)
      c.look.copy(shot.look)
      c.fov = shot.fov
      c.init = true
    } else {
      const k = 1 - Math.exp(-dt * (2 + shot.stiffness * 40))
      const kl = 1 - Math.exp(-dt * (6 + shot.stiffness * 40))
      c.pos.lerp(shot.pos, shot.stiffness >= 1 ? 1 : k)
      c.look.lerp(shot.look, shot.stiffness >= 1 ? 1 : kl)
      c.fov += (shot.fov - c.fov) * (1 - Math.exp(-dt * 4))
    }
    camera.position.copy(c.pos)
    if (shot.shake) {
      const e = state.clock.elapsedTime
      camera.position.x += (Math.sin(e * 37.1) + Math.sin(e * 23.7)) * shot.shake * 0.5
      camera.position.y += (Math.sin(e * 41.3) + Math.sin(e * 17.9)) * shot.shake * 0.5
    }
    camera.up.copy(shot.up ?? new THREE.Vector3(0, 1, 0))
    camera.lookAt(c.look)
    camera.fov = c.fov
    camera.near = camMode === 'onboard' || camMode === 'cockpit' ? 0.05 : camMode === 'heli' || camMode === 'top' ? 2 : 0.25
    camera.updateProjectionMatrix()
    cameraState.focusDistance = shot.dof ?? camera.position.distanceTo(target.position)
    cameraState.dofAmount = camMode === 'tv' || camMode === 'cinematic' ? 1 : 0
  }, -10)

  return (
    <OrbitControls
      ref={controls as never}
      makeDefault={false}
      enabled={mode === 'orbit' || mode === 'free'}
      enableDamping
      dampingFactor={0.08}
      maxDistance={3000}
      minDistance={3}
      maxPolarAngle={Math.PI * 0.495}
    />
  )
}
