import { useSyncExternalStore } from 'react'
import type { Duel } from '../replay/duel'
import { fmtLap } from '../replay/raceQueries'
import type { RaceRuntime } from '../replay/runtime'
import { useUI } from '../state/ui'

/** Lap-duel banner: names, running lap clock and live delta. */
export function CompareHud({ rt }: { rt: RaceRuntime }) {
  const duel = useUI((s) => s.duel)
  void rt
  if (!duel) return null
  return <Banner duel={duel} />
}

function Banner({ duel }: { duel: Duel }) {
  useSyncExternalStore(duel.clock.subscribe, () => duel.clock.snapshotVersion)
  const st = duel.status()
  const A = duel.a, B = duel.b
  const colB = B.driver.color === A.driver.color ? '#ffffff' : B.driver.color
  const tau = Math.max(0, st.tau)
  return (
    <div className="duel-banner glass">
      <span className="tag">LAP DUEL</span>
      <span className="who"><i style={{ background: A.driver.color }} />{A.driver.code} <em>L{A.lap}</em></span>
      <b className="tnum clock">{fmtLap(Math.min(tau, Math.max(A.lapTime, B.lapTime)))}</b>
      <span className="who"><i style={{ background: colB }} />{B.driver.code} <em>L{B.lap}</em></span>
      <b className="tnum delta" style={{ color: st.delta > 0 ? A.driver.color : colB }}>{st.delta > 0 ? '+' : ''}{st.delta.toFixed(3)}</b>
      <span className="dim tnum">{Math.abs(st.gapMeters).toFixed(1)} m</span>
    </div>
  )
}
