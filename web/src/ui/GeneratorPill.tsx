import type { GeneratorStatus } from '../data/api'
import { lastSeenText } from '../lib/useGenerator'

export function GeneratorPill({ g }: { g: GeneratorStatus | null | undefined }) {
  if (g === undefined) return null
  const online = !!g?.online
  const title = !g ? 'Generation service unreachable'
    : online ? `Generator online${g.busy.length ? ` · working on ${g.busy.join(', ')}` : ' · idle'}`
      : `Generator offline · last seen ${lastSeenText(g.lastSeen)}`
  return (
    <span className={`gen-pill ${online ? 'on' : 'off'}`} title={title}>
      <span className="gen-dot" />
      {online ? (g!.busy.length ? 'Generator busy' : 'Generator online') : 'Generator offline'}
    </span>
  )
}
