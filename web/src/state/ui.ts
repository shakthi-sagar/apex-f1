import { create } from 'zustand'
import type { Duel } from '../replay/duel'

export type CameraMode =
  | 'director' | 'chase' | 'close' | 'onboard' | 'cockpit' | 'heli' | 'tv' | 'trackside' | 'top' | 'orbit' | 'free' | 'cinematic'

export interface Overlays {
  labels: boolean
  racingLine: boolean
  heatmap: 'off' | 'speed' | 'throttle' | 'brake'
  sectors: boolean
  corners: boolean
  drs: boolean
}

interface UIState {
  selected: string | null
  compare: string | null
  camera: CameraMode
  director: boolean
  directorCaption: string | null
  overlays: Overlays
  panel: 'none' | 'events' | 'compare' | 'settings'
  quality: 'high' | 'ultra' | 'balanced'
  timeOfDayOverride: number | null
  hudHidden: boolean
  duel: Duel | null
  setDuel: (d: Duel | null) => void
  select: (d: string | null) => void
  setCompare: (d: string | null) => void
  setCamera: (c: CameraMode) => void
  setDirector: (on: boolean) => void
  setCaption: (c: string | null) => void
  setOverlay: <K extends keyof Overlays>(k: K, v: Overlays[K]) => void
  setPanel: (p: UIState['panel']) => void
  setQuality: (q: UIState['quality']) => void
  toggleHud: () => void
}

export const useUI = create<UIState>((set) => ({
  selected: null,
  compare: null,
  camera: 'director',
  director: true,
  directorCaption: null,
  overlays: { labels: true, racingLine: false, heatmap: 'off', sectors: false, corners: true, drs: false },
  panel: 'events',
  quality: 'high',
  timeOfDayOverride: null,
  hudHidden: false,
  duel: null,
  setDuel: (d) => set({ duel: d, director: d ? false : true, camera: d ? 'chase' : 'director' }),
  select: (d) => set({ selected: d }),
  setCompare: (d) => set({ compare: d }),
  setCamera: (c) => set({ camera: c, director: c === 'director' }),
  setDirector: (on) => set((s) => ({ director: on, camera: on ? 'director' : s.camera === 'director' ? 'chase' : s.camera })),
  setCaption: (c) => set({ directorCaption: c }),
  setOverlay: (k, v) => set((s) => ({ overlays: { ...s.overlays, [k]: v } })),
  setPanel: (p) => set({ panel: p }),
  setQuality: (q) => set({ quality: q }),
  toggleHud: () => set((s) => ({ hudHidden: !s.hudHidden })),
}))
