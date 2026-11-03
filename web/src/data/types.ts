/** RaceBundle schema (f1sim.racebundle/1). Mirrors pipeline/f1sim/generate.py. */

export type EventType =
  | 'race_start' | 'restart' | 'finish' | 'yellow' | 'safety_car' | 'red_flag' | 'vsc' | 'vsc_ending'
  | 'pit_stop' | 'overtake' | 'lead_change' | 'battle' | 'fastest_lap' | 'retirement' | 'incident'
  | 'penalty' | 'drs' | 'weather'

export interface RaceEvent {
  id: number
  type: EventType
  t: number
  t_end?: number
  lap?: number | null
  drivers: string[]
  s?: number
  importance: number
  title: string
  detail: string
  data?: Record<string, unknown>
}

export interface Livery {
  primary: string
  secondary: string
  accent: string
  highlight: string
  number: string
  finish: 'gloss' | 'satin' | 'matte'
  teamColor: string
}

export interface DriverInfo {
  num: string
  code: string
  first: string
  last: string
  team: string
  teamId: string
  color: string
  grid: number | null
  position: number | null
  classified: string
  status: string
  points: number
  headshot: string | null
  hasMotion: boolean
  livery: Livery
}

export interface WeatherSample {
  t: number
  rain: boolean
  wetness: number
  air: number
  track: number
  humidity: number
  windDir: number
  windSpeed: number
}

export interface Theme {
  biome: string
  palette: { grass: string; soil: string; building: string; accent: string }
  vegetation_density: number
  haze: number
  night: boolean
  notes?: string
}

export interface Environment {
  localStart: string
  utcOffsetHours: number
  sun: { t: number; azimuth: number; elevation: number }[]
  night: boolean
  rainFraction: number
  cloudCover: number
  fog: number
  weather: WeatherSample[]
  theme: Theme
}

export interface Stint {
  stint: number
  compound: string | null
  fromLap: number
  toLap: number
  startAge: number
  fresh: boolean | null
}

export interface RaceJson {
  schema: string
  pipelineVersion: number
  generatedAt: string
  race: {
    season: number
    round: number
    name: string
    officialName: string
    country: string
    countryCode: string
    location: string
    date: string
    t0Utc: string
    gmtOffset: number
    totalLaps: number
    raceStart: number
    window: [number, number]
  }
  circuit: { ref: string; name: string; layout: string; path: string; length: number }
  drivers: DriverInfo[]
  laps: { columns: string[]; byDriver: Record<string, (number | null)[][]> }
  compounds: Record<string, string>
  stints: Record<string, Stint[]>
  events: RaceEvent[]
  trackStatus: { t: number; status: string; message: string }[]
  raceControl: { t: number; category: string; message: string; flag: string | null; lap: number | null }[]
  environment: Environment
  motion: { hz: number; t0: number; n: number; chunks: { file: string; t0: number; n: number; bytes: number }[] }
  timing: { file: string; t0: number; step: number; n: number; drivers: string[] }
  attribution: string[]
}

export interface Manifest {
  schema: string
  schemaVersion?: number
  season: number
  round: number
  pipelineVersion: number
  circuitVersion: number
  bundle: string
  circuit: string
  generatedAt: string
  bytes: number
  event: string
}

export interface CircuitMeta {
  ref: string
  name: string
  layout: string
  length: number
  ds: number
  origin: { lat0: number; lon0: number }
  datum: number
  registration: Record<string, number | string | boolean>
  corners: { number: number; letter: string; s: number; side: 'left' | 'right'; label: string }[]
  sectors: number[]
  drsZones: [number, number][]
  kerbs: { s0: number; s1: number; side: 'left' | 'right'; type: 'apex' | 'exit' }[]
  garages: { team: string; s: number; d: number }[]
  pit: { available: boolean; s_start?: number; s_end?: number; side?: 'left' | 'right'; width?: number }
  stands: { s0: number; s1: number; side: 'left' | 'right'; offset: number; depth: number; height: number; name: string }[]
  theme: Theme
  widthSource: string
  drsSource: string
}

export interface CatalogRace {
  season: number
  round: number
  name: string
  officialName: string
  location: string
  country: string
  date: string
  winner?: { code: string; name: string; team: string; teamId: string; color: string }
  podium?: string[]
  laps?: number
  circuit?: { key: number; short: string }
  outline?: string | null
  unavailable?: boolean
}

export type JobState =
  | 'unavailable' | 'queued' | 'generating_fastf1' | 'generating_circuit' | 'enriching_osm'
  | 'processing' | 'uploading' | 'ready' | 'failed'

export interface RaceStatus {
  state: JobState
  stage?: string
  progress?: number
  message?: string
  updatedAt?: string
  manifest?: Manifest | null
  error?: string
  /** ready but built by an older pipeline: served as-is while a background rebuild runs */
  stale?: boolean
  rebuilding?: boolean
}
