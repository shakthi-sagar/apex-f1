import { useEffect, useMemo, useState } from 'react'
import { getCatalog, getSeasons, getStatuses, loadManifest } from '../data/api'
import type { CatalogRace, RaceStatus } from '../data/types'
import { navigate } from '../lib/router'
import { Logo } from '../ui/Screens'
import './home.css'

const FEATURED = { season: 2024, round: 21 }

type StatusMap = Record<number, RaceStatus | undefined>

export function Home() {
  const [seasons, setSeasons] = useState<number[]>([2024])
  const [season, setSeason] = useState(() => Number(new URLSearchParams(location.search).get('season')) || 2024)
  const [featuredCat, setFeaturedCat] = useState<CatalogRace[]>([])
  useEffect(() => { getSeasons().then(setSeasons); getCatalog(FEATURED.season).then(setFeaturedCat).catch(() => {}) }, [])
  const pickSeason = (y: number) => {
    if (y === season) return
    setSeason(y)
    history.replaceState(null, '', `?season=${y}`)
  }
  const [races, setRaces] = useState<CatalogRace[] | null>(null)
  const [status, setStatus] = useState<StatusMap>({})
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // reset + load in the same effect so the grid can never be left in the loading state
    setRaces(null)
    setStatus({})
    setErr(null)
    const catalog = getCatalog(season)
    catalog.then((r) => alive && setRaces(r)).catch((e) => alive && setErr(String(e)))
    let timer: ReturnType<typeof setTimeout> | undefined
    let probed = false
    const refresh = async () => {
      if (document.hidden) return schedule(60_000)
      const api = await getStatuses(season)
      let st: StatusMap
      if (api) st = api
      else {
        // no API (static hosting / local dev): probe published manifests once, not on every tick
        if (probed) return schedule(60_000)
        probed = true
        const cat = await catalog.catch(() => [] as CatalogRace[])
        const entries = await Promise.all(cat.map(async (r) => [r.round, (await loadManifest(season, r.round)) ? { state: 'ready' } : { state: 'unavailable' }] as const))
        st = Object.fromEntries(entries) as StatusMap
      }
      if (!alive) return
      setStatus(st)
      schedule(60_000)
    }
    const schedule = (ms: number) => { if (alive) timer = setTimeout(refresh, ms) }
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); refresh() } }
    document.addEventListener('visibilitychange', onVisible)
    refresh()
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [season])

  const featured = useMemo(() => featuredCat.find((r) => r.round === FEATURED.round), [featuredCat])
  const open = (r: { season: number; round: number }) => navigate(`/race/${r.season}/${r.round}`)

  return (
    <div className="home">
      <header className="home-nav">
        <div className="home-brand"><Logo size={34} /><span>APEX</span><em>Race Replays</em></div>
        <nav>
          <a className="notice-pill" href="https://github.com/shakthi-sagar/apex-f1/blob/main/DISCONTINUED.md" target="_blank" rel="noreferrer" title="Why new races can’t be generated">Discontinued · no new races</a>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">REAL TELEMETRY · REAL PLACES · RECONSTRUCTED IN 3D</div>
          <h1>Every lap.<br />Every overtake.<br /><span>Rebuilt.</span></h1>
          <p>
            Formula 1 races reconstructed from timing and telemetry, registered onto the real circuit and its
            surroundings, and replayed with an automatic race director, onboard cameras and live analytics.
          </p>
          <div className="hero-cta">
            <button className="btn big" onClick={() => open(FEATURED)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z" /></svg>
              Watch {featured?.name.replace(' Grand Prix', '') ?? 'São Paulo'} {FEATURED.season}
            </button>
            <a className="btn ghost big" href="#races">Browse races</a>
          </div>
          <div className="hero-stats">
            <div><b>20</b><span>cars in the field</span></div>
            <div><b>4 Hz</b><span>telemetry, fused &amp; interpolated</span></div>
            <div><b>30k</b><span>buildings from OpenStreetMap</span></div>
          </div>
        </div>
        <div className="hero-art">
          {featured?.outline && <HeroTrace d={featured.outline} />}
          <div className="hero-tag glass">
            <div className="k">FEATURED · ROUND {FEATURED.round}</div>
            <div className="v">{featured?.name ?? 'São Paulo Grand Prix'}</div>
            <div className="s">Rain · Red flag · P17 → P1</div>
          </div>
        </div>
      </section>

      <section className="races" id="races">
        <div className="season-tabs" role="tablist" aria-label="Season">
          {seasons.map((y) => (
            <button key={y} role="tab" aria-selected={y === season} className={`season-tab ${y === season ? 'on' : ''}`} onClick={() => pickSeason(y)}>
              {y}
            </button>
          ))}
        </div>
        <div className="races-head">
          <h2>{season} Season</h2>
          <p>
            Races marked <span className="dot ready" /> are ready to watch instantly.
            <br /><b className="warn">New races can no longer be generated</b> — Formula 1 now requires authentication for its timing data, so this project is discontinued.{' '}
            <a href="https://github.com/shakthi-sagar/apex-f1/blob/main/DISCONTINUED.md" target="_blank" rel="noreferrer">Read why</a>
          </p>
        </div>
        {err && <p className="dim">Couldn’t load the calendar: {err}</p>}
        <div className="grid">
          {(races ?? Array.from({ length: 12 }, () => null)).map((r, i) =>
            r ? <RaceCard key={r.round} r={r} st={status[r.round]} onOpen={() => open(r)} /> : <div key={i} className="card skeleton" />,
          )}
        </div>
      </section>

      <footer className="home-foot">
        <span>Timing &amp; telemetry via FastF1 (unofficial, non-commercial). Map data © OpenStreetMap contributors (ODbL). Terrain: Mapzen / AWS Open Data.</span>
        <span>Unofficial; not affiliated with Formula 1, the FIA or any team. F1 and FORMULA 1 are trademarks of Formula One Licensing B.V. Liveries are colour schemes only.</span>
      </footer>
    </div>
  )
}

function RaceCard({ r, st, onOpen }: { r: CatalogRace; st?: RaceStatus; onOpen: () => void }) {
  const ready = st?.state === 'ready'
  const color = r.winner?.color ?? '#888'
  const date = new Date(r.date + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return (
    <button className={`card ${ready ? 'is-ready' : ''}`} onClick={onOpen} disabled={!ready} style={{ ['--team' as string]: color }} title={ready ? undefined : 'Not available — new races can no longer be generated'}>
      <div className="card-top">
        <span className="rnd">R{String(r.round).padStart(2, '0')}</span>
        <span className="date">{date}</span>
      </div>
      <div className="card-art">
        {r.outline ? (
          <svg viewBox="0 0 1000 1000">
            <path d={r.outline} className="o-shadow" />
            <path d={r.outline} className="o-line" pathLength={1} />
          </svg>
        ) : <div className="noart" />}
      </div>
      <div className="card-body">
        <div className="loc">{r.country.toUpperCase()}</div>
        <div className="name">{r.name.replace('Grand Prix', 'GP')}</div>
        {r.winner && (
          <div className="winner">
            <i style={{ background: color }} />
            <span>{r.winner.name}</span>
            <em>{r.winner.team}</em>
          </div>
        )}
      </div>
      <div className="card-foot">
        {ready && <span className="status ready"><span className="dot ready" />Ready to watch</span>}
        {!ready && <span className="status">Not available</span>}
      </div>
    </button>
  )
}

function HeroTrace({ d }: { d: string }) {
  return (
    <svg className="hero-trace" viewBox="-40 -40 1080 1080">
      <defs>
        <linearGradient id="hg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff1e3c" />
          <stop offset="0.5" stopColor="#ff7a1a" />
          <stop offset="1" stopColor="#00d2ff" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="10" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d={d} className="ht-base" />
      <path d={d} className="ht-glow" filter="url(#glow)" pathLength={1} />
      <path d={d} className="ht-car" pathLength={1} />
    </svg>
  )
}
