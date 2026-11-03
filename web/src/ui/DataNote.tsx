import { useEffect, useState } from 'react'
import { getStatus } from '../data/api'
import type { Manifest } from '../data/types'

/** Shown while a stale race is being rebuilt in the background. The Worker starts the rebuild by itself when it
 *  sees a stale manifest (there is no regenerate button); once it is done the new data is used on the next load. */
export function DataNote({ manifest }: { manifest: Manifest }) {
  const [s, setS] = useState<'idle' | 'rebuilding' | 'done'>('idle')
  useEffect(() => {
    let off = false, t: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const st = await getStatus(manifest.season, manifest.round)
      if (off) return
      if (st?.state === 'ready' && st.stale === false) { setS((p) => (p === 'rebuilding' ? 'done' : p)); return }
      setS(st?.stale ? (st.rebuilding ? 'rebuilding' : 'idle') : 'idle')
      t = setTimeout(tick, st?.rebuilding ? 8000 : 60000)
    }
    void tick()
    return () => { off = true; if (t) clearTimeout(t) }
  }, [manifest.season, manifest.round])
  if (s === 'idle') return null
  return (
    <div className="data-note hud-keep" role="status">
      {s === 'rebuilding'
        ? 'Newer data is loading in the background…'
        : <>Newer data is ready · <button onClick={() => location.reload()}>reload</button></>}
    </div>
  )
}
