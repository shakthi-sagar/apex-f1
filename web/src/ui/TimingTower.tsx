import { useRef, useState } from 'react'
import { useClockTime } from '../lib/useClock'
import type { RaceRuntime } from '../replay/runtime'
import { COMPOUND_SHORT, compoundAt, fmtGap, tyreAgeAt } from '../replay/raceQueries'
import { compoundColor } from '../scene/cars/carModel'
import { useUI } from '../state/ui'

const ROW_H = 23

export function TimingTower({ rt }: { rt: RaceRuntime }) {
  const t = useClockTime(rt.clock)
  const [mode, setMode] = useState<'interval' | 'leader'>('interval')
  const sel = useUI((s) => s.selected)
  const cmp = useUI((s) => s.compare)
  const rows = rt.data.timing.at(t).filter((r) => r.position > 0 && rt.byNum.has(r.driver))
  const prev = useRef<Record<string, number>>({})
  const changes: Record<string, number> = {}
  for (const r of rows) {
    const p = prev.current[r.driver]
    if (p && p !== r.position) changes[r.driver] = p - r.position
  }
  // remember positions for flash arrows (reset slowly)
  if (Math.random() < 0.05) for (const r of rows) prev.current[r.driver] = r.position
  const started = t >= rt.data.race.race.raceStart
  return (
    <div className="tower glass">
      <div className="tower-head">
        <span>{started ? 'RACE ORDER' : 'STARTING GRID'}</span>
        <button onClick={() => setMode(mode === 'interval' ? 'leader' : 'interval')}>{mode === 'interval' ? 'INTERVAL' : 'LEADER'}</button>
      </div>
      <div style={{ position: 'relative', height: rows.length * ROW_H }}>
        {rows.map((r, i) => {
          const pose = rt.byNum.get(r.driver)!
          const d = pose.driver
          const comp = compoundAt(rt, r.driver, t)
          const age = tyreAgeAt(rt, r.driver, t)
          const out = !pose.visible || pose.sample.stopped
          const gapTxt = !started ? '' : i === 0 ? (mode === 'interval' ? 'LEADER' : 'LEADER')
            : out ? 'OUT' : mode === 'interval' ? fmtGap(r.interval, 0) : fmtGap(r.gap, r.lapsDown)
          return (
            <div
              key={r.driver}
              className={`trow ${sel === r.driver ? 'sel' : ''} ${cmp === r.driver ? 'cmp' : ''}`}
              style={{ position: 'absolute', left: 0, right: 0, transform: `translateY(${i * ROW_H}px)` }}
              onClick={(e) => {
                const ui = useUI.getState()
                if (e.shiftKey || e.metaKey) { ui.setCompare(r.driver === ui.compare ? null : r.driver); return }
                ui.setDirector(false)
                ui.select(r.driver)
                if (ui.camera === 'director') ui.setCamera('chase')
              }}
              title="Click to follow · Shift+click to compare"
            >
              {changes[r.driver] ? <span className={`chg ${changes[r.driver] > 0 ? 'up' : 'dn'}`}>{changes[r.driver] > 0 ? '▲' : '▼'}</span> : null}
              <span className="p">{i + 1}</span>
              <span className="tc" style={{ background: d.color }} />
              <span>{d.code}</span>
              <span className={`gap ${out ? 'out' : ''}`}>{gapTxt}</span>
              {pose.sample.inPit ? <span className="pit">PIT</span> : <span />}
              <span className="tyre" style={{ color: compoundColor(comp) }} title={`${COMPOUND_SHORT[comp]} · ${age ?? '?'} laps`}>{COMPOUND_SHORT[comp]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
