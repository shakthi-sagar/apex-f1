import type { EventType } from '../data/types'

export const EVENT_COLORS: Record<EventType, string> = {
  race_start: '#ffffff', restart: '#ffffff', finish: '#ffffff',
  lead_change: '#ffd400', overtake: '#00d2ff', battle: '#6f7cff',
  pit_stop: '#c9ced6', fastest_lap: '#b36bff',
  yellow: '#ffd400', safety_car: '#ffb800', vsc: '#ffb800', vsc_ending: '#ffb800', red_flag: '#ff2a2a',
  retirement: '#ff5a5a', incident: '#ff8a3d', penalty: '#ff8a3d', drs: '#39ff88', weather: '#7fb6ff',
}

export const EVENT_LABEL: Record<EventType, string> = {
  race_start: 'Start', restart: 'Restart', finish: 'Finish', lead_change: 'Lead', overtake: 'Overtake', battle: 'Battle',
  pit_stop: 'Pit', fastest_lap: 'Fastest', yellow: 'Yellow', safety_car: 'SC', vsc: 'VSC', vsc_ending: 'VSC end',
  red_flag: 'Red flag', retirement: 'DNF', incident: 'Incident', penalty: 'Penalty', drs: 'DRS', weather: 'Weather',
}

export const FILTER_GROUPS: { key: string; label: string; types: EventType[] }[] = [
  { key: 'key', label: 'KEY', types: ['race_start', 'restart', 'finish', 'lead_change', 'safety_car', 'red_flag', 'vsc', 'retirement'] },
  { key: 'passes', label: 'PASSES', types: ['overtake', 'lead_change'] },
  { key: 'battles', label: 'BATTLES', types: ['battle'] },
  { key: 'pits', label: 'PITS', types: ['pit_stop'] },
  { key: 'flags', label: 'FLAGS', types: ['yellow', 'safety_car', 'vsc', 'vsc_ending', 'red_flag'] },
  { key: 'other', label: 'OTHER', types: ['fastest_lap', 'incident', 'penalty', 'weather', 'drs'] },
]
