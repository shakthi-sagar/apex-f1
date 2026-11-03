import { useEffect, useMemo, useState } from 'react'
import { loadManifest } from '../data/api'
import { loadRace, type LoadProgress, type LoadedRace } from '../data/loadRace'
import type { Manifest } from '../data/types'
import { RaceRuntime } from '../replay/runtime'
import { RaceScene } from '../scene/RaceScene'
import { DataNote } from '../ui/DataNote'
import { Hud } from '../ui/Hud'
import { LoadingScreen } from '../ui/Screens'
import { useUI } from '../state/ui'
import { href } from '../lib/router'

type Phase =
  | { k: 'checking' }
  | { k: 'loading'; progress: LoadProgress; manifest: Manifest }
  | { k: 'ready'; data: LoadedRace }
  | { k: 'error'; message: string; canRetry: boolean }

export default function RacePage({ season, round }: { season: number; round: number }) {
  const [phase, setPhase] = useState<Phase>({ k: 'checking' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async (manifest: Manifest) => {
      setPhase({ k: 'loading', manifest, progress: { step: 'race', fraction: 0, label: 'Race data' } })
      try {
        const data = await loadRace(manifest, (p) => !cancelled && setPhase({ k: 'loading', manifest, progress: p }))
        if (!cancelled) setPhase({ k: 'ready', data })
      } catch (e) {
        if (!cancelled) setPhase({ k: 'error', message: (e as Error).message, canRetry: true })
      }
    }
    ;(async () => {
      useUI.setState({ selected: null, compare: null, director: true, camera: 'director', directorCaption: null })
      const manifest = await loadManifest(season, round)
      if (cancelled) return
      if (manifest) return load(manifest)
      setPhase({ k: 'error', message: 'This race isn’t available. New races can no longer be generated — Formula 1 now requires authentication for its timing data, so this project is discontinued.', canRetry: false })
    })()
    return () => { cancelled = true }
  }, [season, round, attempt])

  const rt = useMemo(() => (phase.k === 'ready' ? new RaceRuntime(phase.data) : null), [phase])
  useEffect(() => {
    // dev/automation hook (screenshots, debugging)
    if (rt) (window as unknown as { __f1: unknown }).__f1 = { rt, ui: useUI }
  }, [rt])

  if (phase.k === 'ready' && rt) {
    return (
      <>
        <RaceScene rt={rt} />
        <Hud rt={rt} />
        <DataNote manifest={phase.data.manifest} />
      </>
    )
  }
  if (phase.k === 'loading') return <LoadingScreen manifest={phase.manifest} progress={phase.progress} />
  if (phase.k === 'error') {
    return (
      <div className="loading">
        <div className="card">
          <h1>Something went off track</h1>
          <p className="sub">{phase.message}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 24 }}>
            <a className="btn ghost" href={href("/")}>Back to races</a>
            {phase.canRetry && <button className="btn" onClick={() => { setPhase({ k: 'checking' }); setAttempt((a) => a + 1) }}>Retry</button>}
          </div>
        </div>
      </div>
    )
  }
  return <LoadingScreen manifest={null} progress={{ step: 'manifest', fraction: 0, label: 'Checking race' }} />
}
