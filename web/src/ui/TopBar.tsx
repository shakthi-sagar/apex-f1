import { useClockTime } from '../lib/useClock'
import { navigate } from '../lib/router'
import type { RaceRuntime } from '../replay/runtime'
import { fmtClock } from '../replay/raceQueries'

const FLAG_LABEL: Record<string, string> = {
  green: 'GREEN', yellow: 'YELLOW', sc: 'SAFETY CAR', vsc: 'VIRTUAL SC', vsc_ending: 'VSC ENDING', red: 'RED FLAG',
}

export function TopBar({ rt }: { rt: RaceRuntime }) {
  const t = useClockTime(rt.clock)
  const r = rt.data.race.race
  const lap = rt.lapAt(t)
  const flag = rt.trackStatusAt(t)
  const w = rt.weather
  const started = t >= r.raceStart
  const finished = rt.events.some((e) => e.type === 'finish' && e.t <= t)
  return (
    <>
      <div className="brand">
        <button className="back glass" onClick={() => navigate('/')} title="All races (Esc)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div className="title">
          <div className="ev">{r.name}</div>
          <div className="sub">{rt.data.race.circuit.name} · {r.season}</div>
        </div>
      </div>
      <div className="topbar">
        <div className="glass chip lapchip">
          <span className="k">LAP</span>
          <b className="tnum">{started ? Math.max(1, lap) : 0}</b>
          <span style={{ color: 'var(--dim)' }}>/ {r.totalLaps}</span>
        </div>
        {finished ? <div className="flag green" style={{ background: '#fff', color: '#111' }}>CHEQUERED FLAG</div>
          : !started ? <div className="flag green">FORMATION</div>
            : <div className={`flag ${flag}`}>{FLAG_LABEL[flag] ?? flag.toUpperCase()}</div>}
        <div className="glass chip">
          <span className="k">RACE</span>
          <span className="tnum">{started ? fmtClock(t - r.raceStart) : `-${fmtClock(r.raceStart - t)}`}</span>
        </div>
        {w && (
          <div className="glass chip" title={`Air ${w.air}°C · Humidity ${w.humidity}%`}>
            {w.rain ? <RainIcon /> : rt.data.race.environment.night ? <MoonIcon /> : <SunIcon />}
            <span className="tnum">{w.track.toFixed(0)}°</span>
            <span className="k">TRACK</span>
            {rt.wetness > 0.3 && <span className="badge" style={{ background: 'rgba(47,140,255,.2)', color: '#7fb6ff' }}>WET</span>}
          </div>
        )}
      </div>
    </>
  )
}

const RainIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7fb6ff" strokeWidth="2"><path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3" /><path d="M8 19v2M8 13v2M16 19v2M16 13v2M12 21v2M12 15v2" /></svg>
)
const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#c9d6ff" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
)
const SunIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd400" strokeWidth="2"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
)
