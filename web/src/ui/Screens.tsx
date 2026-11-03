import type { LoadProgress } from '../data/loadRace'
import type { Manifest } from '../data/types'

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
