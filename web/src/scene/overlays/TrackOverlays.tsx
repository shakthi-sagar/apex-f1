import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { useUI } from '../../state/ui'
import { ribbon } from '../track/trackGeometry'

/** Speed → colour ramp (blue slow → teal → yellow → red fast), perceptually ordered. */
export function speedColor(v: number, out = new THREE.Color()) {
  const t = THREE.MathUtils.clamp((v - 70) / 250, 0, 1)
  const stops = ['#2b59ff', '#00c2d1', '#2fe38a', '#ffe14d', '#ff7a1a', '#ff2255']
  const f = t * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(f))
  return out.set(stops[i]).lerp(new THREE.Color(stops[i + 1]), f - i)
}

/**
 * Analytic overlays drawn on the track surface: derived racing line, heatmap strip
 * (speed / throttle / braking from the race's green-flag laps), sector gates, DRS zones.
 */
export function TrackOverlays({ rt }: { rt: RaceRuntime }) {
  const c = rt.circuit
  const prof = rt.data.timing.profile
  const overlays = useUI((s) => s.overlays)
  const objs = useMemo(() => {
    const L = c.length
    const binOf = (s: number) => Math.min(prof.speed.length - 1, Math.floor(c.wrap(s) / 5))
    // racing line: thin glowing ribbon
    const rl = ribbon(c, {
      step: 1, across: 1,
      inner: (_s, i) => c.racing[i] - 0.18, outer: (_s, i) => c.racing[i] + 0.18, height: () => 0.06,
    })
    const rlMat = new THREE.MeshBasicMaterial({ color: '#7df9ff', transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false })
    const racing = new THREE.Mesh(rl, rlMat)
    // heatmap: full-width strip coloured per vertex, updated when mode changes
    const hm = ribbon(c, {
      step: 2, across: 2,
      inner: (_s, i) => c.right[i] + 0.4, outer: (_s, i) => c.left[i] - 0.4, height: () => 0.05,
      extra: { aBin: (s) => binOf(s) },
    })
    const colors = new Float32Array(hm.attributes.position.count * 3)
    hm.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const hmMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, depthWrite: false, toneMapped: false })
    const heat = new THREE.Mesh(hm, hmMat)
    // sector gates + DRS zones
    const gates = new THREE.Group()
    const gateMat = (col: string) => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false })
    const sectorCols = ['#ff3b5c', '#00d1ff', '#ffd400']
    const bounds = [0, ...c.meta.sectors]
    bounds.forEach((s, k) => {
      const gm = ribbon(c, {
        s0: s - 0.8, s1: s + 0.8, step: 0.8, across: 1,
        inner: (_s, i) => c.right[i] - 1, outer: (_s, i) => c.left[i] + 1, height: () => 0.08,
      })
      gates.add(new THREE.Mesh(gm, gateMat(sectorCols[k % 3])))
    })
    const drs = new THREE.Group()
    for (const [a, b] of c.meta.drsZones) {
      const zm = ribbon(c, {
        s0: a, s1: b, step: 4, across: 1,
        inner: (_s, i) => c.left[i] - 0.9, outer: (_s, i) => c.left[i] - 0.5, height: () => 0.07,
      })
      drs.add(new THREE.Mesh(zm, gateMat('#39ff88')))
      const zm2 = ribbon(c, {
        s0: a, s1: b, step: 4, across: 1,
        inner: (_s, i) => c.right[i] + 0.5, outer: (_s, i) => c.right[i] + 0.9, height: () => 0.07,
      })
      drs.add(new THREE.Mesh(zm2, gateMat('#39ff88')))
    }
    void L
    return { racing, heat, gates, drs, colors, hm }
  }, [c, prof])

  useEffect(() => {
    const { colors, hm } = objs
    const bins = hm.getAttribute('aBin') as THREE.BufferAttribute
    const col = new THREE.Color()
    for (let i = 0; i < bins.count; i++) {
      const b = bins.getX(i)
      if (overlays.heatmap === 'speed') speedColor(prof.speed[b], col)
      else if (overlays.heatmap === 'throttle') col.set('#1b1f2a').lerp(new THREE.Color('#2fe38a'), prof.throttle[b] / 100)
      else col.set('#1b1f2a').lerp(new THREE.Color('#ff2255'), Math.min(1, prof.brake[b] * 2.2))
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b
    }
    ;(hm.attributes.color as THREE.BufferAttribute).needsUpdate = true
  }, [objs, overlays.heatmap, prof])

  useFrame(() => {
    objs.racing.visible = overlays.racingLine
    objs.heat.visible = overlays.heatmap !== 'off'
    objs.gates.visible = overlays.sectors
    objs.drs.visible = overlays.drs
  })
  return (
    <>
      <primitive object={objs.racing} />
      <primitive object={objs.heat} />
      <primitive object={objs.gates} />
      <primitive object={objs.drs} />
    </>
  )
}
