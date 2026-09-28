import { useEffect } from 'react'
import type { RaceRuntime } from '../replay/runtime'
import { useUI, type CameraMode } from '../state/ui'
import { navigate } from '../lib/router'
import { CameraBar } from './CameraBar'
import { Caption } from './Caption'
import { Minimap } from './Minimap'
import { SidePanel } from './SidePanel'
import { Telemetry } from './Telemetry'
import { TimingTower } from './TimingTower'
import { TopBar } from './TopBar'
import { Transport } from './Transport'
import { OverlayToggles } from './OverlayToggles'
import { CompareHud } from './CompareHud'

const KEY_CAMS: Record<string, CameraMode> = {
  '1': 'director', '2': 'chase', '3': 'close', '4': 'onboard', '5': 'cockpit', '6': 'tv', '7': 'heli', '8': 'top', '9': 'cinematic', '0': 'orbit',
}

export function Hud({ rt }: { rt: RaceRuntime }) {
  const hidden = useUI((s) => s.hudHidden)
  const duel = useUI((s) => s.duel)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      const c = rt.clock
      const ui = useUI.getState()
      if (e.code === 'Space') { e.preventDefault(); c.toggle() }
      else if (e.key === 'ArrowRight') c.seek(c.time + (e.shiftKey ? 60 : 10))
      else if (e.key === 'ArrowLeft') c.seek(c.time - (e.shiftKey ? 60 : 10))
      else if (e.key === ']') c.setRate(Math.min(64, c.rate * 2))
      else if (e.key === '[') c.setRate(Math.max(0.25, c.rate / 2))
      else if (e.key === 'h' || e.key === 'H') ui.toggleHud()
      else if (e.key === 'd' || e.key === 'D') ui.setDirector(!ui.director)
      else if (e.key === 'f' || e.key === 'F') ui.setCamera('free')
      else if (e.key === 'Escape') navigate('/')
      else if (KEY_CAMS[e.key]) ui.setCamera(KEY_CAMS[e.key])
      else if (e.key === 'Tab') {
        e.preventDefault()
        const order = rt.data.timing.at(rt.time).map((r) => r.driver).filter((d) => rt.byNum.get(d)?.visible)
        const i = order.indexOf(ui.selected ?? '')
        const next = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]
        ui.setDirector(false)
        ui.select(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rt])

  return (
    <div className={`hud ${hidden ? 'hidden' : ''}`}>
      {!duel && <TopBar rt={rt} />}
      {!duel && <TimingTower rt={rt} />}
      <Telemetry rt={rt} />
      <OverlayToggles />
      <SidePanel rt={rt} />
      {!duel && <Minimap rt={rt} />}
      {!duel && <Caption />}
      <CompareHud rt={rt} />
      <div className="bottom">
        <CameraBar />
        {!duel && <Transport rt={rt} />}
      </div>
      <div className="attrib hud-keep">
        Data: FastF1 (unofficial) · Map © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · Terrain: Mapzen/AWS · Press <span className="kbd">H</span> to hide HUD
      </div>
    </div>
  )
}
