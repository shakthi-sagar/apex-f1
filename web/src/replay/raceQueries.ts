import type { RaceRuntime } from './runtime'

export const COMPOUND_NAMES: Record<number, string> = { 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTER', 5: 'WET', 0: '—' }
export const COMPOUND_SHORT: Record<number, string> = { 1: 'S', 2: 'M', 3: 'H', 4: 'I', 5: 'W', 0: '?' }

// lap row columns (see RaceJson.laps.columns)
export const LAP = { lap: 0, start: 1, end: 2, time: 3, s1: 4, s2: 5, s3: 6, compound: 7, tyreLife: 8, pitIn: 9, pitOut: 10, position: 11, deleted: 12, pb: 13, st: 14 } as const

export function lapRowAt(rt: RaceRuntime, driver: string, t: number) {
  const rows = rt.data.race.laps.byDriver[driver]
  if (!rows?.length) return null
  let best = rows[0]
  for (const r of rows) {
    const st = r[LAP.start] as number | null
    if (st != null && st <= t) best = r
    else if (st != null && st > t) break
  }
  return best
}

export function compoundAt(rt: RaceRuntime, driver: string, t: number) {
  const r = lapRowAt(rt, driver, t)
  if (!r) return 0
  // after pit-out on the lap following a stop, the new tyre applies (table already reflects it)
  return (r[LAP.compound] as number) ?? 0
}

export function tyreAgeAt(rt: RaceRuntime, driver: string, t: number) {
  const r = lapRowAt(rt, driver, t)
  return r ? (r[LAP.tyreLife] as number | null) : null
}

export function lastLapTime(rt: RaceRuntime, driver: string, t: number) {
  const rows = rt.data.race.laps.byDriver[driver]
  if (!rows) return null
  let last: number | null = null
  for (const r of rows) {
    const end = r[LAP.end] as number | null
    if (end != null && end <= t && r[LAP.time] != null) last = r[LAP.time] as number
  }
  return last
}

export function bestLapTime(rt: RaceRuntime, driver: string, t: number) {
  const rows = rt.data.race.laps.byDriver[driver]
  if (!rows) return null
  let best: number | null = null
  for (const r of rows) {
    const end = r[LAP.end] as number | null
    const lt = r[LAP.time] as number | null
    if (end != null && end <= t && lt != null && !r[LAP.deleted] && (best == null || lt < best)) best = lt
  }
  return best
}

export function pitStopsBefore(rt: RaceRuntime, driver: string, t: number) {
  return rt.events.filter((e) => e.type === 'pit_stop' && e.drivers[0] === driver && e.t <= t).length
}

export function fmtLap(t: number | null | undefined) {
  if (t == null || !Number.isFinite(t)) return '—'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

export function fmtGap(g: number | null | undefined, lapsDown = 0) {
  if (lapsDown > 0) return `+${lapsDown} LAP${lapsDown > 1 ? 'S' : ''}`
  if (g == null || !Number.isFinite(g)) return ''
  return `+${g.toFixed(g < 10 ? 3 : 1)}`
}

export function fmtClock(sec: number) {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}
