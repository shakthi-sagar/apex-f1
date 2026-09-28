import { useUI } from '../state/ui'

export function Caption() {
  const cap = useUI((s) => s.directorCaption)
  const director = useUI((s) => s.director)
  if (!director || !cap) return null
  return (
    <div className="caption glass" key={cap}>
      <span className="tag">LIVE DIRECTOR</span>
      <span>{cap}</span>
    </div>
  )
}
