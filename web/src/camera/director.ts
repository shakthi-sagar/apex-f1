import type { RaceEvent } from '../data/types'
import type { RaceRuntime } from '../replay/runtime'
import type { CameraMode } from '../state/ui'

/**
 * Automatic race director. Looks at precomputed events (with anticipation — the bundle
 * knows what is about to happen) and live gaps, scores candidate "stories", and picks
 * a subject + shot type, holding shots for a natural duration and varying cameras.
 */

export interface Decision {
  driver: string
  secondary: string | null
  camera: CameraMode
  caption: string
  reason: string
  until: number // replay time the shot may last until
  minUntil: number // must hold until
}

const EVENT_LEAD: Partial<Record<RaceEvent['type'], number>> = {
  overtake: 7, lead_change: 9, pit_stop: 6, race_start: 12, restart: 10, retirement: 3, safety_car: 2,
  red_flag: 2, finish: 8, fastest_lap: 3, incident: 4,
}
const EVENT_TAIL: Partial<Record<RaceEvent['type'], number>> = {
  overtake: 4, lead_change: 5, pit_stop: 4, race_start: 25, restart: 20, retirement: 8, safety_car: 10,
  red_flag: 6, finish: 12, fastest_lap: 2, incident: 6,
}

const CAMS_BATTLE: CameraMode[] = ['chase', 'tv', 'heli', 'close', 'cinematic', 'tv']
const CAMS_SOLO: CameraMode[] = ['tv', 'chase', 'onboard', 'heli', 'cinematic', 'close', 'tv']

export class Director {
  private current: Decision | null = null
  private lastEval = -1e9
  private shotCount = 0
  private lastWall = 0
  private recentEvents = new Set<number>()

  constructor(private rt: RaceRuntime) {}

  reset() { this.current = null; this.lastEval = -1e9; this.recentEvents.clear() }

  /** Returns the active decision; `cut` true when a new shot starts. */
  update(time: number, wall: number): { d: Decision | null; cut: boolean } {
    // Evaluate at most every 0.5s of wall time, and when replay jumps.
    const jumped = Math.abs(time - this.lastEval) > 30
    if (!jumped && wall - this.lastWall < 0.5 && this.current) return { d: this.current, cut: false }
    this.lastWall = wall
    this.lastEval = time
    const cur = this.current
    if (cur && !jumped && time < cur.minUntil) return { d: cur, cut: false }
    const cand = this.bestStory(time)
    if (!cand) return { d: cur, cut: false }
    const keep = cur && !jumped && time < cur.until && cand.score < (cur as Decision & { score?: number }).score! + 0.25
    if (keep) return { d: cur, cut: false }
    if (cur && !jumped && cand.driver === cur.driver && cand.camera === cur.camera && time < cur.until) return { d: cur, cut: false }
    this.shotCount++
    this.current = cand
    return { d: cand, cut: true }
  }

  private bestStory(t: number): (Decision & { score: number }) | null {
    const rt = this.rt
    const stories: (Decision & { score: number })[] = []
    const rotate = (list: CameraMode[]) => list[this.shotCount % list.length]
    // 1) events around now (anticipated)
    for (const e of rt.events) {
      const lead = EVENT_LEAD[e.type]
      if (lead == null) continue
      const tail = EVENT_TAIL[e.type] ?? 4
      if (t < e.t - lead || t > (e.t_end ?? e.t) + tail) continue
      const drv = e.drivers[0] ?? this.leader(t)
      if (!drv || !rt.byNum.get(drv)?.visible) continue
      let camera: CameraMode = 'tv'
      let score = e.importance
      switch (e.type) {
        case 'race_start': camera = t < e.t + 6 ? 'heli' : 'chase'; score = 2; break
        case 'restart': camera = 'heli'; score = 1.6; break
        case 'overtake': case 'lead_change':
          camera = t < e.t - 2 ? rotate(['chase', 'heli', 'close']) : 'tv'
          score += 0.4; break
        case 'pit_stop': camera = t < e.t + 3 ? 'tv' : 'heli'; break
        case 'finish': camera = t < e.t ? 'chase' : 'heli'; score = 2; break
        case 'retirement': case 'incident': camera = 'heli'; break
        case 'safety_car': case 'red_flag': camera = 'heli'; break
        case 'fastest_lap': camera = 'onboard'; break
      }
      // don't re-show an event we just finished covering unless it's high value
      if (this.recentEvents.has(e.id) && e.importance < 0.8) score -= 0.3
      stories.push({
        driver: drv, secondary: e.drivers[1] ?? null, camera, score,
        caption: e.title + (e.detail ? ` · ${e.detail}` : ''), reason: e.type,
        until: Math.max(t + 5, (e.t_end ?? e.t) + tail), minUntil: t + (e.type === 'race_start' ? 8 : 4.5),
      })
      this.recentEvents.add(e.id)
    }
    // 2) live battles from the timing feed
    const rows = rt.data.timing.at(t)
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]
      if (r.interval == null || r.interval > 1.0 || r.position < 2) continue
      const pose = rt.byNum.get(r.driver)
      if (!pose?.visible || pose.sample.inPit) continue
      const ahead = rows[i - 1]
      const tight = 1 - r.interval
      const score = 0.45 + tight * 0.35 + Math.max(0, (10 - r.position)) * 0.025
      stories.push({
        driver: r.driver, secondary: ahead.driver, camera: rotate(CAMS_BATTLE), score,
        caption: `Battle for P${ahead.position} · ${code(rt, ahead.driver)} vs ${code(rt, r.driver)} · ${r.interval.toFixed(2)}s`,
        reason: 'battle', until: t + 12, minUntil: t + 6,
      })
    }
    // 3) leader fallback
    const lead = this.leader(t)
    if (lead) {
      stories.push({ driver: lead, secondary: null, camera: rotate(CAMS_SOLO), score: 0.3, caption: `Race leader · ${code(rt, lead)}`,
        reason: 'leader', until: t + 10, minUntil: t + 6 })
    }
    stories.sort((a, b) => b.score - a.score)
    return stories[0] ?? null
  }

  private leader(t: number) {
    const rows = this.rt.data.timing.at(t)
    return rows.find((r) => r.position === 1 && this.rt.byNum.get(r.driver)?.visible)?.driver ?? rows[0]?.driver ?? null
  }
}

function code(rt: RaceRuntime, num: string) {
  return rt.byNum.get(num)?.driver.code ?? num
}
