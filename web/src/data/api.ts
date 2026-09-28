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

export async function getStatuses(season: number): Promise<Record<number, RaceStatus>> {
  try {
    const r = await fetch(`${API_BASE}/races/${season}`)
    if (r.ok) return (await r.json()) as Record<number, RaceStatus>
  } catch { /* offline/dev without worker */ }
  return {}
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
