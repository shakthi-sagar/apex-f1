import { API_BASE, dataUrl, fetchJson } from './fetch'
import type { CatalogRace, Manifest, RaceStatus } from './types'

export async function getCatalog(season: number): Promise<CatalogRace[]> {
  try {
    const r = await fetch(`${API_BASE}/catalog/${season}`)
    if (r.ok) return ((await r.json()) as { races: CatalogRace[] }).races
  } catch { /* fall through to static catalog */ }
  const c = await fetchJson<{ races: CatalogRace[] }>(dataUrl(`catalog/${season}.json`), { cache: 'no-cache' })
  return c.races
}

/** Status of every round; null means the API itself is unreachable (not "nothing generated"). */
export async function getStatuses(season: number): Promise<Record<number, RaceStatus> | null> {
  try {
    const r = await fetch(`${API_BASE}/races/${season}`, { cache: 'no-store' })
    if (r.ok) return (await r.json()) as Record<number, RaceStatus>
  } catch { /* offline/dev without worker */ }
  return null
}

export async function getStatus(season: number, round: number): Promise<RaceStatus | null> {
  try {
    const r = await fetch(`${API_BASE}/races/${season}/${round}`)
    if (r.ok) return (await r.json()) as RaceStatus
  } catch { /* no API available */ }
  return null
}

export async function requestGeneration(season: number, round: number): Promise<RaceStatus> {
  const r = await fetch(`${API_BASE}/races/${season}/${round}/generate`, { method: 'POST' })
  if (!r.ok) throw new Error(`Generation request failed (${r.status})`)
  return (await r.json()) as RaceStatus
}

export async function loadManifest(season: number, round: number): Promise<Manifest | null> {
  try {
    return await fetchJson<Manifest>(dataUrl(`races/${season}/${String(round).padStart(2, '0')}/manifest.json`), { cache: 'no-cache' })
  } catch {
    return null
  }
}

export interface GeneratorStatus { mode: 'agent' | 'container'; online: boolean; agents: number; busy: string[]; lastSeen: number | null }

export async function getGenerator(): Promise<GeneratorStatus | null> {
  try {
    const r = await fetch(`${API_BASE}/generator`, { cache: 'no-store' })
    if (r.ok) return (await r.json()) as GeneratorStatus
  } catch { /* API unreachable */ }
  return null
}

export async function getSeasons(): Promise<number[]> {
  try {
    const r = await fetch(`${API_BASE}/seasons`)
    if (r.ok) return ((await r.json()) as { seasons: number[] }).seasons
  } catch { /* fall through */ }
  return [2024]
}
