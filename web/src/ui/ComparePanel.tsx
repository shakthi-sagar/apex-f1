import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Duel, buildLapTrace, type LapTrace } from '../replay/duel'
import { LAP, fmtLap } from '../replay/raceQueries'
import type { RaceRuntime } from '../replay/runtime'
import { useUI } from '../state/ui'

function fastestLap(rt: RaceRuntime, driver: string) {
  const rows = rt.data.race.laps.byDriver[driver] ?? []
  let best: number | null = null, lap = 0
  for (const r of rows) {
    const t = r[LAP.time] as number | null
    if (t != null && !r[LAP.deleted] && (best == null || t < best) && (r[LAP.lap] as number) > 1 && r[LAP.pitIn] == null && r[LAP.pitOut] == null) { best = t; lap = r[LAP.lap] as number }
  }
  return lap
}

export function ComparePanel({ rt }: { rt: RaceRuntime }) {
  const duel = useUI((s) => s.duel)
  const sel = useUI((s) => s.selected)
  const cmp = useUI((s) => s.compare)
  const drivers = useMemo(() => rt.poses.map((p) => p.driver), [rt])
  const [a, setA] = useState(sel ?? drivers[0].num)
  const [b, setB] = useState(cmp ?? drivers.find((d) => d.num !== (sel ?? drivers[0].num))!.num)
  const [lapA, setLapA] = useState(0)
  const [lapB, setLapB] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (cmp && cmp !== a) setB(cmp) }, [cmp, a])
  const lapsOf = (d: string) => (rt.data.race.laps.byDriver[d] ?? []).filter((r) => r[LAP.time] != null && (r[LAP.lap] as number) > 1)

  if (duel) return <DuelView rt={rt} duel={duel} />

  const start = async () => {
    setBusy(true); setErr(null)
    const la = lapA || fastestLap(rt, a), lb = lapB || fastestLap(rt, b)
    const [ta, tb] = await Promise.all([buildLapTrace(rt, a, la), buildLapTrace(rt, b, lb)])
    setBusy(false)
    if (!ta || !tb) { setErr('Lap data unavailable for that selection.'); return }
    rt.clock.setPlaying(false)
    const d = new Duel(rt, ta, tb)
    d.clock.setPlaying(true)
    useUI.getState().select(a)
    useUI.getState().setCompare(b)
    useUI.getState().setDuel(d)
  }

  return (
    <div className="evlist" style={{ padding: 12 }}>
      <div className="cmp-intro">Replay two laps side by side as ghost cars from the same start line. The track is painted by who was faster in every 50 m mini-sector; posts mark where each driver hit the brakes.</div>
      {[['A', a, setA, lapA, setLapA], ['B', b, setB, lapB, setLapB]].map(([k, d, setD, lp, setLp]) => (
        <div className="cmp-row" key={k as string}>
          <span className="cmp-k">{k as string}</span>
          <select value={d as string} onChange={(e) => { (setD as (v: string) => void)(e.target.value); (setLp as (v: number) => void)(0) }}>
            {drivers.map((x) => <option key={x.num} value={x.num}>{x.code} · {x.last}</option>)}
          </select>
          <select value={lp as number} onChange={(e) => (setLp as (v: number) => void)(Number(e.target.value))}>
            <option value={0}>Fastest lap</option>
            {lapsOf(d as string).map((r) => <option key={r[LAP.lap] as number} value={r[LAP.lap] as number}>L{r[LAP.lap] as number} · {fmtLap(r[LAP.time] as number)}</option>)}
          </select>
        </div>
      ))}
      <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} disabled={busy || a === b && lapA === lapB} onClick={start}>
        {busy ? 'Preparing laps…' : 'Start lap duel'}
      </button>
      {err && <div className="cmp-intro" style={{ color: 'var(--accent)' }}>{err}</div>}
    </div>
  )
}

function DuelView({ rt, duel }: { rt: RaceRuntime; duel: Duel }) {
  useSyncExternalStore(duel.clock.subscribe, () => duel.clock.snapshotVersion)
  const st = duel.status()
  const A = duel.a, B = duel.b
  const colB = B.driver.color === A.driver.color ? '#ffffff' : B.driver.color
  const corners = useMemo(() => cornerStats(rt, A, B), [rt, A, B])
  return (
    <div className="evlist" style={{ padding: 12 }}>
      <div className="duel-head">
        <div><i style={{ background: A.driver.color }} /><b>{A.driver.code}</b> L{A.lap}<span>{fmtLap(A.lapTime)}</span></div>
        <div><i style={{ background: colB }} /><b>{B.driver.code}</b> L{B.lap}<span>{fmtLap(B.lapTime)}</span></div>
      </div>
      <div className="duel-delta" style={{ color: st.delta > 0 ? A.driver.color : colB }}>
        {st.delta > 0 ? '+' : ''}{st.delta.toFixed(3)}<small>s {st.delta > 0 ? `${A.driver.code} ahead` : `${B.driver.code} ahead`}</small>
      </div>
      <SpeedChart a={A} b={B} delta={duel.delta} cursor={st.dA} colA={A.driver.color} colB={colB} />
      <div className="duel-btns">
        <button onClick={() => duel.clock.toggle()}>{duel.clock.playing ? 'Pause' : 'Play'}</button>
        <button onClick={() => { duel.clock.seek(-2); duel.clock.setPlaying(true) }}>Restart</button>
        {[0.25, 0.5, 1].map((r) => <button key={r} className={duel.clock.rate === r ? 'on' : ''} onClick={() => duel.clock.setRate(r)}>{r}×</button>)}
        <button onClick={() => useUI.getState().select(useUI.getState().selected === A.driver.num ? B.driver.num : A.driver.num)}>Follow {useUI.getState().selected === A.driver.num ? B.driver.code : A.driver.code}</button>
        <button className="exit" onClick={() => useUI.getState().setDuel(null)}>Exit duel</button>
      </div>
      <div className="corner-table">
        <div className="ct-h"><span>CORNER</span><span>{A.driver.code}</span><span>{B.driver.code}</span><span>Δ</span></div>
        {corners.map((c) => (
          <div key={c.label} className="ct-r">
            <span>T{c.label}</span>
            <span style={{ color: c.minA >= c.minB ? A.driver.color : undefined }}>{c.minA.toFixed(0)}</span>
            <span style={{ color: c.minB > c.minA ? colB : undefined }}>{c.minB.toFixed(0)}</span>
            <span className="tnum" style={{ color: c.gain > 0 ? A.driver.color : colB }}>{c.gain > 0 ? '+' : ''}{c.gain.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="cmp-intro">Min speed in km/h (measured). Δ = time gained by {A.driver.code} through the corner.</div>
    </div>
  )
}

function cornerStats(rt: RaceRuntime, A: LapTrace, B: LapTrace) {
  const L = rt.circuit.length
  return rt.circuit.meta.corners.map((c) => {
    const at = ((c.s - A.sStart) % L + L) % L
    const lo = Math.max(0, Math.floor(at - 80)), hi = Math.min(A.t.length - 1, Math.floor(at + 60))
    let minA = 1e9, minB = 1e9
    for (let k = lo; k <= hi; k++) { minA = Math.min(minA, A.speed[k]); minB = Math.min(minB, B.speed[k]) }
    const dLo = (B.t[lo] - A.t[lo]), dHi = (B.t[hi] - A.t[hi])
    return { label: c.label, minA, minB, gain: dHi - dLo }
  })
}

function SpeedChart({ a, b, delta, cursor, colA, colB }: { a: LapTrace; b: LapTrace; delta: Float32Array; cursor: number; colA: string; colB: string }) {
  const W = 276, H = 120, DH = 34
  const n = Math.min(a.speed.length, b.speed.length)
  const path = (arr: Float32Array) => {
    let s = ''
    for (let k = 0; k < n; k += 8) s += `${k ? 'L' : 'M'}${((k / n) * W).toFixed(1)} ${(H - (arr[k] / 350) * H).toFixed(1)}`
    return s
  }
  let dmax = 0.2
  for (let k = 0; k < n; k += 8) dmax = Math.max(dmax, Math.abs(delta[k]))
  let dp = ''
  for (let k = 0; k < n; k += 8) dp += `${k ? 'L' : 'M'}${((k / n) * W).toFixed(1)} ${(H + 8 + DH / 2 - (delta[k] / dmax) * (DH / 2)).toFixed(1)}`
  const x = (Math.min(cursor, n) / n) * W
  return (
    <svg viewBox={`0 0 ${W} ${H + DH + 12}`} className="duel-chart">
      <text x="2" y="10" className="lbl">SPEED vs DISTANCE</text>
      <path d={path(b.speed)} stroke={colB} strokeWidth="1.3" fill="none" opacity=".9" />
      <path d={path(a.speed)} stroke={colA} strokeWidth="1.3" fill="none" />
      <line x1="0" x2={W} y1={H + 8 + DH / 2} y2={H + 8 + DH / 2} stroke="rgba(255,255,255,.15)" />
      <path d={dp} stroke="#fff" strokeWidth="1.2" fill="none" />
      <text x="2" y={H + 18} className="lbl">DELTA ±{dmax.toFixed(2)}s</text>
      <line x1={x} x2={x} y1="0" y2={H + DH + 12} stroke="#fff" strokeWidth="1" opacity=".6" />
    </svg>
  )
}
