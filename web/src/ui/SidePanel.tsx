import { useEffect, useMemo, useRef, useState } from 'react'
import { useClockTime } from '../lib/useClock'
import type { RaceRuntime } from '../replay/runtime'
import { useUI } from '../state/ui'
import { EVENT_COLORS, FILTER_GROUPS } from './eventStyle'
import { ComparePanel } from './ComparePanel'

export function SidePanel({ rt }: { rt: RaceRuntime }) {
  const panel = useUI((s) => s.panel)
  return (
    <div className="sidepanel glass">
      <div className="tabs">
        <button className={panel === 'events' ? 'on' : ''} onClick={() => useUI.getState().setPanel('events')}>EVENTS</button>
        <button className={panel === 'compare' ? 'on' : ''} onClick={() => useUI.getState().setPanel('compare')}>COMPARE</button>
      </div>
      {panel === 'compare' ? <ComparePanel rt={rt} /> : <Events rt={rt} />}
    </div>
  )
}

function Events({ rt }: { rt: RaceRuntime }) {
  const t = useClockTime(rt.clock)
  const [on, setOn] = useState<Set<string>>(() => new Set(['key', 'passes', 'pits', 'flags']))
  const list = useMemo(() => {
    const types = new Set(FILTER_GROUPS.filter((g) => on.has(g.key)).flatMap((g) => g.types))
    return rt.events.filter((e) => types.has(e.type))
  }, [rt, on])
  const box = useRef<HTMLDivElement>(null)
  const nowIdx = list.findIndex((e) => e.t > t)
  useEffect(() => {
    const el = box.current?.querySelector('.evitem.now') as HTMLElement | null
    if (el && box.current) box.current.scrollTo({ top: el.offsetTop - 80, behavior: 'smooth' })
  }, [nowIdx])
  return (
    <>
      <div className="filters">
        {FILTER_GROUPS.map((g) => (
          <button key={g.key} className={on.has(g.key) ? 'on' : ''} onClick={() => {
            const n = new Set(on)
            if (n.has(g.key)) n.delete(g.key); else n.add(g.key)
            setOn(n)
          }}>{g.label}</button>
        ))}
      </div>
      <div className="evlist" ref={box}>
        {list.map((e, i) => (
          <div key={e.id}
            className={`evitem ${e.t < t - 10 ? 'past' : ''} ${i === nowIdx - 1 || (nowIdx === -1 && i === list.length - 1) ? 'now' : ''}`}
            onClick={() => {
              rt.clock.seek(e.t - (e.type === 'overtake' || e.type === 'lead_change' ? 7 : 4), true)
              if (e.drivers[0] && !useUI.getState().director) useUI.getState().select(e.drivers[0])
            }}>
            <div className="lap">{e.lap ? `L${e.lap}` : '—'}</div>
            <div>
              <div className="t"><span className="dot" style={{ background: EVENT_COLORS[e.type] }} />{e.title}</div>
              {e.detail && <div className="d">{e.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
