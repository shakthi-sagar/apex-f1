import { memo, useMemo, useRef, useState } from 'react'
import type { RaceEvent } from '../data/types'
import { useClockTime } from '../lib/useClock'
import type { RaceRuntime } from '../replay/runtime'
import { fmtClock } from '../replay/raceQueries'
import { EVENT_COLORS } from './eventStyle'

const RATES = [0.5, 1, 2, 4, 8, 16, 32]
const STATUS_COL: Record<string, string> = { yellow: 'rgba(255,212,0,.35)', sc: 'rgba(255,184,0,.55)', vsc: 'rgba(255,184,0,.4)', vsc_ending: 'rgba(255,184,0,.25)', red: 'rgba(255,42,42,.6)' }

export function Transport({ rt }: { rt: RaceRuntime }) {
  const t = useClockTime(rt.clock)
  const c = rt.clock
  const [hover, setHover] = useState<{ x: number; t: number; label: string } | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const span = c.end - c.start
  const pct = (x: number) => ((x - c.start) / span) * 100
  const r = rt.data.race.race
  const keyEvents = useMemo(() => rt.events.filter((e) => e.importance >= 0.55 && e.type !== 'battle'), [rt])
  const statusSpans = useMemo(() => {
    const ts = rt.data.race.trackStatus
    return ts.map((s, i) => ({ s: s.status, a: s.t, b: ts[i + 1]?.t ?? c.end })).filter((x) => STATUS_COL[x.s] && x.b > c.start)
  }, [rt, c.end, c.start])
  const lapMarks = useMemo(() => {
    const lead = rt.data.race.laps.byDriver[rt.data.race.drivers[0].num] ?? []
    return lead.filter((l) => (l[0] as number) % 10 === 0).map((l) => ({ lap: l[0] as number, t: l[1] as number }))
  }, [rt])

  const toTime = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect()
    return c.start + THREE_clamp((clientX - rect.left) / rect.width) * span
  }
  const onPointer = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return
    c.seek(toTime(e.clientX))
  }
  return (
    <div className="transport glass">
      <button className="play" onClick={() => c.toggle()} title="Play / pause (Space)">
        {c.playing
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>}
      </button>
      <div
        className="timeline"
        ref={bar}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); c.seek(toTime(e.clientX)) }}
        onPointerMove={(e) => {
          onPointer(e)
          const tt = toTime(e.clientX)
          const rect = bar.current!.getBoundingClientRect()
          const near = keyEvents.find((ev) => Math.abs(pct(ev.t) - pct(tt)) < 0.35)
          setHover({ x: e.clientX - rect.left, t: tt, label: near ? near.title : (tt < r.raceStart ? `-${fmtClock(r.raceStart - tt)}` : `Lap ${rt.lapAt(tt)} · ${fmtClock(tt - r.raceStart)}`) })
        }}
        onPointerLeave={() => setHover(null)}
      >
        <Markers events={keyEvents} start={c.start} span={span} onSeek={(tt) => c.seek(tt, true)} />
        <div className="track">
          {statusSpans.map((x, i) => (
            <div key={i} className="status" style={{ left: `${pct(Math.max(x.a, c.start))}%`, width: `${pct(x.b) - pct(Math.max(x.a, c.start))}%`, background: STATUS_COL[x.s] }} />
          ))}
          <div className="fill" style={{ width: `${pct(t)}%`, opacity: 0.55 }} />
        </div>
        <div className="head" style={{ left: `${pct(t)}%` }} />
        <div className="laps">
          {lapMarks.map((m) => <span key={m.lap} style={{ left: `${pct(m.t)}%` }}>L{m.lap}</span>)}
        </div>
        {hover && <div className="hover glass" style={{ left: hover.x }}>{hover.label}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div className="clock">
          <b>{t < r.raceStart ? `-${fmtClock(r.raceStart - t)}` : fmtClock(t - r.raceStart)}</b>
          <span>{new Date(Date.parse(rt.data.race.race.t0Utc) + t * 1000 + rt.data.race.race.gmtOffset * 3600e3).toISOString().slice(11, 19)} LOCAL</span>
        </div>
        <div className="rates">
          {RATES.map((x) => <button key={x} className={c.rate === x ? 'on' : ''} onClick={() => c.setRate(x)}>{x}×</button>)}
        </div>
      </div>
    </div>
  )
}

function THREE_clamp(x: number) { return Math.max(0, Math.min(1, x)) }

/** Event ticks never change during playback: render once. */
const Markers = memo(function Markers({ events, start, span, onSeek }: { events: RaceEvent[]; start: number; span: number; onSeek: (t: number) => void }) {
  return (
    <>
      {events.map((e) => (
        <div key={e.id} className="ev" style={{ left: `${((e.t - start) / span) * 100}%` }} onPointerDown={(ev) => { ev.stopPropagation(); onSeek(e.t - 6) }}>
          <i style={{ background: EVENT_COLORS[e.type], opacity: 0.4 + e.importance * 0.6 }} />
        </div>
      ))}
    </>
  )
}, (a, b) => a.events === b.events && a.start === b.start && a.span === b.span)
