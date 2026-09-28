import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { cameraState } from '../../camera/CameraRig'
import type { RaceRuntime } from '../../replay/runtime'
import { useUI } from '../../state/ui'

/** Corner numbers pinned beside the track (DOM, projected) — shown from wide cameras. */
export function CornerLabels({ rt, container }: { rt: RaceRuntime; container: HTMLDivElement | null }) {
  const { camera, size } = useThree()
  const nodes = useRef<{ el: HTMLDivElement; p: THREE.Vector3 }[]>([])
  useEffect(() => {
    if (!container) return
    const c = rt.circuit
    nodes.current = c.meta.corners.map((k) => {
      const i = Math.floor(k.s / c.ds) % c.n
      const outside = c.curvature[i] > 0 ? -1 : 1
      const d = outside > 0 ? c.left[i] + 9 : c.right[i] - 9
      const p = c.point(k.s, d)
      p.y += 3
      const el = document.createElement('div')
      el.className = 'corner-tag'
      el.textContent = k.label
      container.appendChild(el)
      return { el, p }
    })
    return () => { nodes.current.forEach((n) => n.el.remove()); nodes.current = [] }
  }, [rt, container])
  const v = new THREE.Vector3()
  useFrame(() => {
    const ui = useUI.getState()
    const wide = ['heli', 'top', 'orbit', 'free'].includes(cameraState.mode)
    const show = ui.overlays.corners && wide && !ui.hudHidden
    for (const n of nodes.current) {
      if (!show) { n.el.style.display = 'none'; continue }
      v.copy(n.p).project(camera)
      const dist = n.p.distanceTo(camera.position)
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05 || dist > 2500) { n.el.style.display = 'none'; continue }
      n.el.style.display = 'grid'
      n.el.style.transform = `translate3d(${((v.x * 0.5 + 0.5) * size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * size.height).toFixed(1)}px, 0) translate(-50%, -50%)`
    }
  })
  return null
}
