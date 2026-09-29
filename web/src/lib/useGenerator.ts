import { useEffect, useState } from 'react'
import { getGenerator, type GeneratorStatus } from '../data/api'

/** Polls the generator presence endpoint (agents heartbeat into the Worker). */
export function useGenerator(intervalMs = 15000) {
  const [g, setG] = useState<GeneratorStatus | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const tick = () => getGenerator().then((x) => alive && setG(x))
    tick()
    const id = setInterval(tick, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [intervalMs])
  return g // undefined = loading, null = API unreachable
}

export function lastSeenText(ts: number | null) {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
