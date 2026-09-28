import { Canvas, useFrame } from '@react-three/fiber'
import { Suspense, useMemo, useState } from 'react'
import * as THREE from 'three'
import type { RaceRuntime } from '../replay/runtime'
import { CameraRig } from '../camera/CameraRig'
import { Atmosphere } from './atmosphere/Atmosphere'
import { Cars } from './cars/Cars'
import { SafetyCar } from './cars/SafetyCar'
import { DuelScene } from './overlays/DuelScene'
import { PostFX } from './effects/PostFX'
import { Rain, Spray } from './effects/Weather'
import { Labels } from './overlays/Labels'
import { CornerLabels } from './overlays/CornerLabels'
import { TrackOverlays } from './overlays/TrackOverlays'
import { Track } from './track/Track'
import { Buildings } from './world/Buildings'
import { Stands } from './world/Stands'
import { Terrain } from './world/Terrain'
import { TerrainSampler } from './world/terrainSampler'
import { Trees } from './world/Trees'
import { Floodlights } from './world/Floodlights'
import { TracksideProps } from './world/TracksideProps'
import { useUI } from '../state/ui'

function Driver({ rt }: { rt: RaceRuntime }) {
  useFrame((state, dt) => {
    const duel = useUI.getState().duel
    if (duel) duel.update(Math.min(dt, 0.1))
    else rt.update(Math.min(dt, 0.1))
    ;(window as unknown as { __f1cam: unknown }).__f1cam = state.camera
    ;(window as unknown as { __f1scene: unknown }).__f1scene = state.scene
  }, -100)
  return null
}

export function RaceScene({ rt }: { rt: RaceRuntime }) {
  const terrain = useMemo(() => new TerrainSampler(rt.data.world), [rt])
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null)
  const quality = useUI((s) => s.quality)
  return (
    <div className="scene-root">
      <Canvas
        shadows="soft"
        dpr={quality === 'ultra' ? [1, 2] : [1, 1.5]}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, logarithmicDepthBuffer: false }}
        camera={{ fov: 50, near: 0.25, far: 30000, position: [0, 100, 100] }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NoToneMapping // AgX applied in post
          gl.outputColorSpace = THREE.SRGBColorSpace
          gl.shadowMap.type = THREE.PCFSoftShadowMap
        }}
      >
        <Driver rt={rt} />
        <Suspense fallback={null}>
          <Atmosphere rt={rt} />
          <Terrain rt={rt} sampler={terrain} />
          <Track rt={rt} terrain={terrain} />
          <Stands rt={rt} terrain={terrain} />
          <Buildings rt={rt} />
          <Trees rt={rt} />
          <Floodlights rt={rt} />
          <TracksideProps rt={rt} terrain={terrain} />
          <Cars rt={rt} />
          <DuelScene rt={rt} />
          <SafetyCar rt={rt} />
          <TrackOverlays rt={rt} />
          <Rain rt={rt} />
          <Spray rt={rt} />
          <CameraRig rt={rt} terrain={terrain} />
          <Labels rt={rt} container={labelLayer} />
          <CornerLabels rt={rt} container={labelLayer} />
          <PostFX />
        </Suspense>
      </Canvas>
      <div className="label-layer" ref={setLabelLayer} />
    </div>
  )
}
