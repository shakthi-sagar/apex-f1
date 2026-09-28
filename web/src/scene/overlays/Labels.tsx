import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { useUI } from '../../state/ui'

/**
 * Driver tags as absolutely positioned DOM nodes, projected each frame (no React renders).
 * Cheaper and crisper than 20 WebGL text meshes or drei <Html>.
 */
export function Labels({ rt, container }: { rt: RaceRuntime; container: HTMLDivElement | null }) {
  const nodes = useRef<HTMLDivElement[]>([])
  const { camera, size } = useThree()
  useEffect(() => {
    if (!container) return
    nodes.current = rt.poses.map((p) => {
      const el = document.createElement('div')
      el.className = 'car-tag'
      el.innerHTML = `<span class="pos"></span><span class="bar" style="background:${p.driver.color}"></span><span class="code">${p.driver.code}</span>`
      el.onclick = () => useUI.getState().select(p.driver.num)
      container.appendChild(el)
      return el
    })
    return () => { nodes.current.forEach((n) => n.remove()); nodes.current = [] }
  }, [rt, container])

  const v = new THREE.Vector3()
  useFrame(() => {
    const show = useUI.getState().overlays.labels && !useUI.getState().hudHidden && !useUI.getState().duel
    const sel = useUI.getState().selected
    const cmp = useUI.getState().compare
    const camPos = camera.position
    for (let i = 0; i < nodes.current.length; i++) {
      const el = nodes.current[i]
      const p = rt.poses[i]
      if (!show || !p.visible) { el.style.display = 'none'; continue }
      v.copy(p.position)
      v.y += 1.9
      const dist = v.distanceTo(camPos)
      v.project(camera)
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1 || dist > 1600) { el.style.display = 'none'; continue }
      const focus = p.driver.num === sel || p.driver.num === cmp
      if (dist < 7 && focus) { el.style.display = 'none'; continue } // onboard of this car
      el.style.display = 'flex'
      const x = (v.x * 0.5 + 0.5) * size.width
      const y = (-v.y * 0.5 + 0.5) * size.height
      const sc = THREE.MathUtils.clamp(60 / dist, 0.55, 1)
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${sc.toFixed(3)})`
      el.style.opacity = String(THREE.MathUtils.clamp(1.4 - dist / 1200, 0.25, 1))
      el.style.zIndex = String(10000 - Math.round(dist))
      el.classList.toggle('focus', focus)
      const posEl = el.firstChild as HTMLSpanElement
      const txt = p.racePosition ? String(p.racePosition) : ''
      if (posEl.textContent !== txt) posEl.textContent = txt
    }
  })
  return null
}
