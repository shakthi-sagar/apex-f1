import { useFrame } from '@react-three/fiber'
import { Bloom, BrightnessContrast, DepthOfField, EffectComposer, HueSaturation, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode, type DepthOfFieldEffect } from 'postprocessing'
import { useRef } from 'react'
import { cameraState } from '../../camera/CameraRig'
import { useUI } from '../../state/ui'

export function PostFX() {
  const quality = useUI((s) => s.quality)
  const dof = useRef<DepthOfFieldEffect>(null)
  useFrame(() => {
    const d = dof.current
    if (!d) return
    const coc = d.cocMaterial as unknown as { worldFocusDistance: number; worldFocusRange: number }
    const target = cameraState.focusDistance
    coc.worldFocusDistance += (target - coc.worldFocusDistance) * 0.2
    coc.worldFocusRange = Math.max(6, target * 0.35)
    d.bokehScale = cameraState.dofAmount * (quality === 'ultra' ? 3.2 : 2.2)
  })
  if (quality === 'balanced') {
    // light path: no AO / DOF, cheap AA
    return (
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <Bloom mipmapBlur luminanceThreshold={1.0} luminanceSmoothing={0.2} intensity={0.5} radius={0.65} />
        <ToneMapping mode={ToneMappingMode.AGX} />
        <HueSaturation saturation={0.22} />
        <BrightnessContrast brightness={0.0} contrast={0.22} />
        <Vignette offset={0.24} darkness={0.65} />
        <SMAA />
      </EffectComposer>
    )
  }
  return (
    <EffectComposer multisampling={4} enableNormalPass={false}>
      <N8AO aoRadius={2.2} distanceFalloff={1.2} intensity={2.2} quality={quality === 'ultra' ? 'high' : 'performance'} halfRes={quality !== 'ultra'} />
      <DepthOfField ref={dof} worldFocusDistance={30} worldFocusRange={12} bokehScale={0} resolutionScale={0.5} />
      <Bloom mipmapBlur luminanceThreshold={1.0} luminanceSmoothing={0.2} intensity={0.6} radius={0.75} />
      <ToneMapping mode={ToneMappingMode.AGX} />
      <HueSaturation saturation={0.22} />
      <BrightnessContrast brightness={0.0} contrast={0.22} />
      <Vignette offset={0.24} darkness={0.65} />
    </EffectComposer>
  )
}
