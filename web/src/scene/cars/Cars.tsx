import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../../replay/runtime'
import { useUI } from '../../state/ui'
import { Car } from './Car'
import { compoundAt } from '../../replay/raceQueries'
import { cameraState } from '../../camera/CameraRig'

export function Cars({ rt }: { rt: RaceRuntime }) {
  const cars = useMemo(() => rt.poses.map((p) => new Car(p.driver, rt.data.race.race.season)), [rt])
  const group = useMemo(() => {
    const g = new THREE.Group()
    g.name = 'cars'
    cars.forEach((c) => g.add(c.root))
    return g
  }, [cars])
  useEffect(() => () => cars.forEach((c) => c.dispose()), [cars])
  const lastCompound = useRef(-1)
  useFrame((state) => {
    group.visible = !useUI.getState().duel
    if (!group.visible) return
    const t = rt.time
    const sel = useUI.getState().selected
    const cmp = useUI.getState().compare
    const wide = ['heli', 'top', 'orbit', 'free'].includes(cameraState.mode)
    const updateCompound = state.clock.elapsedTime - lastCompound.current > 0.5
    if (updateCompound) lastCompound.current = state.clock.elapsedTime
    for (let i = 0; i < cars.length; i++) {
      const p = rt.poses[i]
      cars[i].update(p, state.clock.elapsedTime)
      cars[i].setSelected(p.driver.num === sel || p.driver.num === cmp, state.clock.elapsedTime, wide)
      if (updateCompound) cars[i].setCompound(compoundAt(rt, p.driver.num, t))
    }
  }, -20)
  return <primitive object={group} />
}
