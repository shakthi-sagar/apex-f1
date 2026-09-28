import type { LoadProgress } from '../data/loadRace'
import type { JobState, Manifest, RaceStatus } from '../data/types'

const STAGES: { k: JobState; label: string }[] = [
  { k: 'queued', label: 'Queued' },
  { k: 'generating_fastf1', label: 'Fetching timing & telemetry (FastF1)' },
  { k: 'generating_circuit', label: 'Reconstructing the circuit' },
  { k: 'enriching_osm', label: 'Building the world (OpenStreetMap, terrain)' },
  { k: 'processing', label: 'Motion fusion, gaps & race events' },
  { k: 'uploading', label: 'Publishing RaceBundle' },
]

export function GenerationScreen({ season, round, status }: { season: number; round: number; status: RaceStatus }) {
  const idx = Math.max(0, STAGES.findIndex((s) => s.k === status.state))
  const frac = (idx + (status.progress ?? 0)) / STAGES.length
  return (
    <div className="loading">
      <div className="card">
        <Logo />
        <h1>Preparing this race</h1>
        <p className="sub">{season} · ROUND {round} — processed once, then replayed instantly for everyone</p>
        <div className="progress"><i style={{ width: `${Math.max(3, frac * 100)}%` }} /></div>
        <div className="sub" style={{ fontSize: 12 }}>{status.message ?? 'Starting…'}</div>
        <div className="stages">
          {STAGES.map((s, i) => (
            <div key={s.k} className={`stage ${i < idx ? 'done' : i === idx ? 'active' : ''}`}>
              <span className="ic" />
              <span>{s.label}</span>
              <span className="tnum" style={{ fontSize: 11 }}>{i === idx && status.progress != null ? `${Math.round(status.progress * 100)}%` : ''}</span>
            </div>
          ))}
        </div>
        <p className="sub" style={{ fontSize: 11, marginTop: 26, opacity: .7 }}>You can leave this page — generation continues in the background.</p>
      </div>
    </div>
  )
}

export function LoadingScreen({ manifest, progress }: { manifest: Manifest | null; progress: LoadProgress }) {
  return (
    <div className="loading">
      <div className="card">
        <Logo />
        <h1>{manifest?.event ?? 'Loading race'}</h1>
        <p className="sub">{manifest ? `${manifest.season} · ROUND ${manifest.round}` : ''}</p>
        <div className="progress"><i style={{ width: `${Math.max(4, progress.fraction * 100)}%` }} /></div>
        <div className="sub" style={{ fontSize: 12 }}>Streaming circuit, world and telemetry…</div>
      </div>
    </div>
  )
}

export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#11141a" stroke="rgba(255,255,255,.12)" />
      <path d="M14 44 L30 20 H52 L46 28 H34 L30 34 H44 L38 42 H26 L24 44 Z" fill="#ff1e3c" />
    </svg>
  )
}
