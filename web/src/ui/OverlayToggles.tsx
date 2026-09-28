import { useState } from 'react'
import { useUI } from '../state/ui'

export function OverlayToggles() {
  const o = useUI((s) => s.overlays)
  const set = useUI((s) => s.setOverlay)
  const hm = o.heatmap
  const q = useUI((s) => s.quality)
  const [help, setHelp] = useState(false)
  const nextHm = hm === 'off' ? 'speed' : hm === 'speed' ? 'throttle' : hm === 'throttle' ? 'brake' : 'off'
  return (
    <div className="ovl glass">
      <button className={o.labels ? 'on' : ''} onClick={() => set('labels', !o.labels)}>Labels</button>
      <button className={o.racingLine ? 'on' : ''} onClick={() => set('racingLine', !o.racingLine)} title="Derived minimum-curvature line (source positions are map-matched)">Racing line</button>
      <button className={hm !== 'off' ? 'on' : ''} onClick={() => set('heatmap', nextHm)}>Heatmap{hm !== 'off' ? `: ${hm}` : ''}</button>
      <button className={o.sectors ? 'on' : ''} onClick={() => set('sectors', !o.sectors)}>Sectors</button>
      <button className={o.drs ? 'on' : ''} onClick={() => set('drs', !o.drs)}>DRS zones</button>
      <button className={o.corners ? 'on' : ''} onClick={() => set('corners', !o.corners)}>Corners</button>
      <span className="ovl-sep" />
      <button onClick={() => useUI.getState().setQuality(q === 'balanced' ? 'high' : q === 'high' ? 'ultra' : 'balanced')} title="Rendering quality">Quality: {q}</button>
      <button onClick={() => setHelp(!help)}>Shortcuts</button>
      {help && (
        <div className="help glass" onClick={() => setHelp(false)}>
          {[['Space', 'Play / pause'], ['← →', 'Seek 10 s (Shift: 60 s)'], ['[ ]', 'Slower / faster'], ['1', 'Director'], ['2–9, 0', 'Cameras'], ['F', 'Free camera'],
            ['Tab', 'Next car'], ['Shift+click', 'Compare driver'], ['H', 'Hide HUD'], ['Esc', 'All races']].map(([k, v]) => (
            <div key={k}><span className="kbd">{k}</span><span>{v}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}
