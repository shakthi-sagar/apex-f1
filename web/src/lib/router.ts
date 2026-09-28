import { useSyncExternalStore } from 'react'

/** Minimal History-API router: "/" and "/race/:season/:round". */
const listeners = new Set<() => void>()
/** App base path ("/" in dev, "/f1-sim/" in production). */
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, '/')
const strip = (p: string) => '/' + (p.startsWith(BASE) ? p.slice(BASE.length) : p.replace(/^\/+/, ''))
export const href = (p: string) => BASE + p.replace(/^\/+/, '')
window.addEventListener('popstate', () => listeners.forEach((l) => l()))

export function navigate(path: string) {
  const full = href(path)
  if (full === location.pathname) return
  history.pushState(null, '', full)
  listeners.forEach((l) => l())
}

export function usePath() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, () => strip(location.pathname))
}

export type Route = { name: 'home' } | { name: 'race'; season: number; round: number } | { name: 'notfound' }

export function parse(path: string): Route {
  if (path === '/' || path === '') return { name: 'home' }
  const m = path.match(/^\/race\/(\d{4})\/(\d{1,2})\/?$/)
  if (m) return { name: 'race', season: Number(m[1]), round: Number(m[2]) }
  return { name: 'notfound' }
}
