import { useSyncExternalStore } from 'react'
import type { ReplayClock } from '../replay/clock'

/** Re-render at the clock's throttled UI rate (~15 Hz) and return the current time. */
export function useClockTime(clock: ReplayClock) {
  useSyncExternalStore(clock.subscribe, () => clock.snapshotVersion)
  return clock.time
}
