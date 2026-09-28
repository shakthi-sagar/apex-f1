import { useUI, type CameraMode } from '../state/ui'

const CAMS: { k: CameraMode; label: string; key: string }[] = [
  { k: 'chase', label: 'Chase', key: '2' },
  { k: 'close', label: 'Close', key: '3' },
  { k: 'onboard', label: 'T-Cam', key: '4' },
  { k: 'cockpit', label: 'Cockpit', key: '5' },
  { k: 'tv', label: 'Trackside', key: '6' },
  { k: 'heli', label: 'Heli', key: '7' },
  { k: 'top', label: 'Tactical', key: '8' },
  { k: 'cinematic', label: 'Cinematic', key: '9' },
  { k: 'orbit', label: 'Orbit', key: '0' },
  { k: 'free', label: 'Free', key: 'F' },
]

export function CameraBar() {
  const cam = useUI((s) => s.camera)
  const director = useUI((s) => s.director)
  return (
    <div className="cambar glass">
      <button className={`dir ${director ? 'on' : ''}`} onClick={() => useUI.getState().setDirector(!director)} title="Automatic race director (D)">
        ● DIRECTOR
      </button>
      <span className="sep" />
      {CAMS.map((c) => (
        <button key={c.k} className={!director && cam === c.k ? 'on' : ''} onClick={() => useUI.getState().setCamera(c.k)} title={`${c.label} (${c.key})`}>
          {c.label}
        </button>
      ))}
    </div>
  )
}
