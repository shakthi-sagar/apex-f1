import { CircuitModel } from './circuit'
import { dataUrl, fetchBuffer, fetchJson } from './fetch'
import { parseSimBin, type SimBin } from './simbin'
import type { CircuitMeta, Manifest, RaceJson } from './types'
import { MotionStore } from '../replay/motion'
import { TimingStore } from '../replay/timing'

export interface WorldMeta {
  extent: [number, number, number]
  terrainN: number
  terrainScale: number
  datum: number
  landcover: { file: string; res: number }
  attribution: string[]
  counts: { buildings: number; trees: number; roads: number }
}

export interface LoadedRace {
  manifest: Manifest
  race: RaceJson
  circuit: CircuitModel
  world: SimBin<WorldMeta>
  landcover: ImageBitmap
  motion: MotionStore
  timing: TimingStore
  circuitBase: string
  bundleBase: string
}

export type LoadStep = 'manifest' | 'race' | 'circuit' | 'world' | 'motion' | 'timing' | 'done'
export interface LoadProgress { step: LoadStep; fraction: number; label: string }

export { loadManifest } from './api'

export async function loadRace(manifest: Manifest, onProgress: (p: LoadProgress) => void): Promise<LoadedRace> {
  const bundleBase = manifest.bundle
  const circuitBase = manifest.circuit
  const bytes: Record<string, [number, number]> = {}
  const report = (step: LoadStep, label: string) => {
    let l = 0, t = 0
    for (const [a, b] of Object.values(bytes)) { l += a; t += Math.max(a, b) }
    onProgress({ step, fraction: t ? l / t : 0, label })
  }
  const track = (key: string, est: number) => (l: number, t: number) => { bytes[key] = [l, t || est]; report('world', key) }
  bytes.race = [0, 60e3]; bytes.circuit = [0, 100e3]; bytes.world = [0, 2.7e6]; bytes.lc = [0, 220e3]; bytes.timing = [0, 950e3]; bytes.motion = [0, 650e3]

  onProgress({ step: 'race', fraction: 0, label: 'Race data' })
  const race = await fetchJson<RaceJson>(dataUrl(bundleBase + 'race.json'))
  bytes.race = [60e3, 60e3]
  const startT = race.race.raceStart - 25
  const motion = new MotionStore(race, bundleBase)
  const firstChunk = motion.chunkIndexAt(startT)
  const [circuitBuf, worldBuf, lcBuf, timingBuf] = await Promise.all([
    fetchBuffer(dataUrl(circuitBase + 'circuit.bin'), track('circuit', 100e3)),
    fetchBuffer(dataUrl(circuitBase + 'world.bin'), track('world', 2.7e6)),
    fetchBuffer(dataUrl(circuitBase + 'landcover.png'), track('lc', 220e3)),
    fetchBuffer(dataUrl(bundleBase + race.timing.file), track('timing', 950e3)),
    motion.ensure(firstChunk, track('motion', 650e3)),
  ])
  const circuit = new CircuitModel(parseSimBin<CircuitMeta>(circuitBuf))
  const world = parseSimBin<WorldMeta>(worldBuf)
  const landcover = await createImageBitmap(new Blob([lcBuf], { type: 'image/png' }), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  const timing = new TimingStore(parseSimBin(timingBuf))
  onProgress({ step: 'done', fraction: 1, label: 'Ready' })
  // stream the rest of the race in the background
  void motion.prefetchAround(startT)
  return { manifest, race, circuit, world, landcover, motion, timing, circuitBase, bundleBase }
}
