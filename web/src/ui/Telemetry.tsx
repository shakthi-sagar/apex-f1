import { useCallback, useSyncExternalStore } from 'react'
import { useClockTime } from '../lib/useClock'
import type { RaceRuntime } from '../replay/runtime'
import { COMPOUND_NAMES, bestLapTime, compoundAt, fmtLap, lastLapTime, pitStopsBefore, tyreAgeAt } from '../replay/raceQueries'
import { compoundColor } from '../scene/cars/carModel'
import { useUI } from '../state/ui'
import { speedColor } from '../scene/overlays/TrackOverlays'

export function Telemetry({ rt }: { rt: RaceRuntime }) {
  const t = useClockTime(rt.clock)
  const sel = useUI((s) => s.selected)
  const duel = useUI((s) => s.duel)
  const subscribe = useCallback((cb: () => void) => (duel ? duel.clock.subscribe(cb) : () => {}), [duel])
  useSyncExternalStore(subscribe, () => duel?.clock.snapshotVersion ?? 0)
  const ghost = duel ? (duel.poses.find((p) => p.driver.num === sel) ?? duel.poses[0]) : null
  const pose = ghost ?? (sel ? rt.byNum.get(sel) : null)
  if (!pose) return null
  const d = pose.driver
  const s = pose.sample
  const rows = rt.data.timing.at(t)
  const idx = rows.findIndex((r) => r.driver === d.num)
  const me = rows[idx]
  const behind = rows[idx + 1]
  const comp = compoundAt(rt, d.num, t)
  const age = tyreAgeAt(rt, d.num, t)
  const trace = rt.data.motion.channelWindow(d.num, t - 20, t, 'speed')
  return (
    <div className="telemetry glass">
      <div className="tele-head">
        <div className="num" style={{ color: d.color }}>{d.num}</div>
        <div className="who">
          <b>{d.first} {d.last.toUpperCase()}</b>
          <span>{d.team}</span>
        </div>
        <div className="posbig">{ghost ? `L${ghost.index === 0 ? duel!.a.lap : duel!.b.lap}` : `P${me?.position ?? '–'}`}</div>
      </div>
      <div className="speedo">
        <div className="kmh">{Math.round(s.speed)}<small>KM/H</small></div>
        <div className="gear">{s.gear === 0 ? 'N' : s.gear}</div>
      </div>
      <div className="rpm"><i style={{ width: `${Math.min(100, (s.rpm / 12500) * 100)}%` }} /></div>
      <div className="pedals">
        <div className="pedal">THROTTLE <span className="tnum" style={{ float: 'right', color: 'var(--text)' }}>{Math.round(s.throttle)}%</span>
          <div className="bar"><i style={{ width: `${s.throttle}%`, background: 'var(--green)' }} /></div>
        </div>
        <div className="pedal">BRAKE <span style={{ float: 'right' }}>{s.brake > 50 ? <b style={{ color: 'var(--accent)' }}>ON</b> : 'OFF'}</span>
          <div className="bar"><i style={{ width: `${s.brake}%`, background: 'var(--accent)' }} /></div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span className={`badge ${s.drs >= 10 ? 'drs' : 'off'}`}>DRS</span>
        <span className="badge" style={{ background: 'rgba(255,255,255,.06)', color: compoundColor(comp) }}>● {COMPOUND_NAMES[comp]} {age != null ? `· ${age}L` : ''}</span>
        {s.inPit && <span className="badge" style={{ background: '#fff', color: '#111' }}>PIT LANE</span>}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--dim)', fontWeight: 700, letterSpacing: '.1em' }}>{Math.round(s.rpm)} RPM</span>
      </div>
      {!ghost && <div className="kv">
        <div><div className="k">AHEAD</div><div className="v">{me?.interval != null ? `+${me.interval.toFixed(2)}` : '—'}</div></div>
        <div><div className="k">BEHIND</div><div className="v">{behind?.interval != null ? `-${behind.interval.toFixed(2)}` : '—'}</div></div>
        <div><div className="k">STOPS</div><div className="v">{pitStopsBefore(rt, d.num, t)}</div></div>
        <div><div className="k">LAST LAP</div><div className="v">{fmtLap(lastLapTime(rt, d.num, t))}</div></div>
        <div><div className="k">BEST</div><div className="v" style={{ color: 'var(--purple)' }}>{fmtLap(bestLapTime(rt, d.num, t))}</div></div>
        <div><div className="k">GRID</div><div className="v">P{d.grid ?? '–'}</div></div>
      </div>}
      {!ghost && trace && trace.t.length > 2 && <Spark t={trace.t} y={trace.y} t0={t - 20} t1={t} />}
    </div>
  )
}

function Spark({ t, y, t0, t1 }: { t: number[]; y: number[]; t0: number; t1: number }) {
  const W = 272, H = 54
  const max = 340
  const pts = t.map((ti, i) => `${(((ti - t0) / (t1 - t0)) * W).toFixed(1)},${(H - (y[i] / max) * H).toFixed(1)}`)
  const last = y[y.length - 1]
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={`#${speedColor(last).getHexString()}`} stopOpacity=".35" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill="url(#sg)" />
      <polyline points={pts.join(' ')} fill="none" stroke={`#${speedColor(last).getHexString()}`} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <text x="2" y="10" fontSize="8" fill="#8c94a3" fontWeight="700" letterSpacing="1.5">SPEED · LAST 20 S</text>
    </svg>
  )
}
