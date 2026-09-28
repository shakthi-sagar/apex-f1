import { useEffect, useMemo, useRef } from 'react'
import type { RaceRuntime } from '../replay/runtime'
import { useUI } from '../state/ui'

/** Circuit map with live car dots (updated imperatively every frame). */
export function Minimap({ rt }: { rt: RaceRuntime }) {
  const c = rt.circuit
  const { d, view, tf } = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < c.n; i++) {
      const x = c.px[i * 3], z = c.px[i * 3 + 2]
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
    const size = Math.max(maxX - minX, maxZ - minZ)
    const s = 170 / size
    const ox = (170 - (maxX - minX) * s) / 2, oz = (170 - (maxZ - minZ) * s) / 2
    const tf = (x: number, z: number) => [ox + (x - minX) * s, oz + (z - minZ) * s] as const
    let path = ''
    for (let i = 0; i < c.n; i += 4) {
      const [x, y] = tf(c.px[i * 3], c.px[i * 3 + 2])
      path += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`
    }
    return { d: path + 'Z', view: '0 0 170 170', tf }
  }, [c])
  const dots = useRef<SVGGElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const g = dots.current
      if (g) {
        const sel = useUI.getState().selected
        rt.poses.forEach((p, i) => {
          const el = g.children[i] as SVGCircleElement
          if (!el) return
          if (!p.visible) { el.setAttribute('opacity', '0'); return }
          const [x, y] = tf(p.position.x, p.position.z)
          el.setAttribute('cx', x.toFixed(1))
          el.setAttribute('cy', y.toFixed(1))
          el.setAttribute('opacity', '1')
          el.setAttribute('r', p.driver.num === sel ? '5' : '3.2')
          el.setAttribute('stroke', p.driver.num === sel ? '#fff' : 'rgba(0,0,0,.6)')
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [rt, tf])
  const start = tf(c.px[0], c.px[2])
  return (
    <div className="minimap glass">
      <svg viewBox={view}>
        <path d={d} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="7" strokeLinejoin="round" />
        <path d={d} fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx={start[0]} cy={start[1]} r="3" fill="none" stroke="#ff1e3c" strokeWidth="1.5" />
        <g ref={dots}>
          {rt.poses.map((p) => (
            <circle key={p.driver.num} r="3.2" fill={p.driver.color} strokeWidth="1.2" style={{ cursor: 'pointer' }}
              onClick={() => { const ui = useUI.getState(); ui.setDirector(false); ui.select(p.driver.num) }} />
          ))}
        </g>
      </svg>
    </div>
  )
}
