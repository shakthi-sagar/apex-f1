import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { CircuitModel } from '../../data/circuit'
import type { RaceRuntime } from '../../replay/runtime'
import type { TerrainSampler } from '../world/terrainSampler'
import { asphaltMaterial, fenceMaterial, kerbMaterial, runoffMaterial, trackUniforms, wallMaterial } from './materials'
import { ranges, ribbon } from './trackGeometry'
import { look } from '../atmosphere/Atmosphere'
import { roofMaterial } from '../shaders/roof'

function pitOffsetFn(c: CircuitModel) {
  const pit = c.pit!
  return (s: number) => {
    // pit.s is monotonic (may exceed length); map s into that range
    let x = s
    if (x < pit.s[0]) x += c.length
    const n = pit.s.length
    if (x <= pit.s[0]) return pit.d[0]
    if (x >= pit.s[n - 1]) return pit.d[n - 1]
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pit.s[m] <= x) lo = m; else hi = m }
    const u = (x - pit.s[lo]) / (pit.s[hi] - pit.s[lo])
    return pit.d[lo] + (pit.d[hi] - pit.d[lo]) * u
  }
}

/** Track surface, kerbs, runoff, barriers, catch fences, pit lane + pit building, start gantry. */
export function Track({ rt, terrain }: { rt: RaceRuntime; terrain: TerrainSampler }) {
  const c = rt.circuit
  const theme = c.meta.theme
  const street = !!(c.meta as { street?: boolean }).street
  const group = useMemo(() => {
    const g = new THREE.Group()
    g.name = 'track'
    const L = c.length
    trackUniforms.uLength.value = L
    // pole side = inside of T1
    const t1 = c.meta.corners[0]?.s ?? 300
    let k = 0
    for (let s = t1 - 40; s < t1 + 40; s += 2) k += c.scalarAt(c.curvature, s)
    trackUniforms.uPoleSide.value = k >= 0 ? 1 : -1

    // ------------------------------------------------------------------ asphalt
    const asphalt = ribbon(c, {
      step: 1.5,
      across: 14,
      inner: (_s, i) => c.right[i] - 1.2,
      outer: (_s, i) => c.left[i] + 1.2,
      height: (_s, u) => 0.03 * Math.sin(Math.PI * u), // subtle crown for drainage
      extra: {
        aL: (_s, _u, _d, i) => c.left[i],
        aR: (_s, _u, _d, i) => c.right[i],
        aRL: (_s, _u, _d, i) => c.racing[i],
      },
    })
    const road = new THREE.Mesh(asphalt, asphaltMaterial())
    road.receiveShadow = true
    road.name = 'asphalt'
    g.add(road)

    // ------------------------------------------------------------------ kerbs
    const kerbGeo: THREE.BufferGeometry[] = []
    for (const kb of c.meta.kerbs) {
      const left = kb.side === 'left'
      const w = kb.type === 'apex' ? 1.3 : 1.1
      kerbGeo.push(ribbon(c, {
        s0: kb.s0, s1: kb.s1, step: 0.5, across: 6,
        inner: (_s, i) => (left ? c.left[i] - 0.35 : c.right[i] + 0.35),
        outer: (_s, i) => (left ? c.left[i] + w : c.right[i] - w),
        height: (s, u) => {
          const ramp = Math.min(1, Math.min(s - kb.s0, kb.s1 - s) / 3)
          return ramp * (0.02 + 0.055 * Math.sin(Math.PI * Math.min(1, u * 1.3)) * (1 - u * 0.4))
        },
      }))
    }
    if (kerbGeo.length) {
      for (const kg of kerbGeo) {
        const mesh = new THREE.Mesh(kg, kerbMaterial())
        mesh.receiveShadow = true
        g.add(mesh)
      }
    }

    // ------------------------------------------------------------------ runoff (both sides)
    const K = (i: number) => c.curvature[i]
    const surf = (side: 1 | -1) => (s: number, _u: number, _d: number, i: number) => {
      // tarmac outside of medium/fast corners, gravel at the tightest ones, grass otherwise
      let acc = 0
      for (let o = -40; o <= 40; o += 10) acc += c.scalarAt(c.curvature, s + o)
      const outside = Math.sign(acc) === -side && Math.abs(acc) / 9 > 1 / 260
      if (!outside) return 0
      return Math.abs(acc) / 9 > 1 / 70 && ((i / 400) | 0) % 3 === 0 ? 2 : 1
    }
    void K
    for (const side of [1, -1] as const) {
      const geo = ribbon(c, {
        step: 3,
        across: 8,
        inner: (_s, i) => (side > 0 ? c.left[i] + 1.2 : c.right[i] - 1.2),
        outer: (_s, i) => (side > 0 ? Math.max(c.left[i] + 1.4, c.barrierLeft[i] - 0.3) : Math.min(c.right[i] - 1.4, c.barrierRight[i] + 0.3)),
        yFn: (x, z, base, u) => {
          const th = terrain.height(x, z) + 0.05
          const w = Math.pow(u, 1.8)
          return base * (1 - w) + Math.max(th, base - 3) * w - 0.02
        },
        extra: {
          aSurf: street ? () => 1 : surf(side),
          aEdge: (_s, _u, d, i) => Math.abs(d - (side > 0 ? c.left[i] : c.right[i])),
        },
      })
      const mesh = new THREE.Mesh(geo, runoffMaterial(theme.palette.grass, theme.palette.soil))
      mesh.receiveShadow = true
      g.add(mesh)
    }

    // ------------------------------------------------------------------ barriers + fences
    const pitD = c.pit ? pitOffsetFn(c) : null
    const inPitGap = (s: number) => {
      if (!c.pit || c.meta.pit.s_start === undefined) return false
      const a = c.meta.pit.s_start!, b = c.meta.pit.s_end!
      const x = s < a ? s + c.length : s
      return x > a - 10 && x < b + 10
    }
    for (const side of [1, -1] as const) {
      const off = side > 0 ? c.barrierLeft : c.barrierRight
      const pitSide = c.meta.pit.side === (side > 0 ? 'left' : 'right')
      const segs = ranges(c, (i) => !(pitSide && inPitGap(i * c.ds)), 2, 20)
      for (const [s0, s1] of segs) {
        const wall = ribbon(c, {
          s0, s1, step: 2, across: 1,
          inner: (_s, i) => off[i], outer: (_s, i) => off[i] + side * 0.001,
          height: (_s, u) => u * 1.05,
          extra: { aH: (_s, u) => u },
        })
        const wm = new THREE.Mesh(wall, wallMaterial(theme.palette.accent))
        wm.castShadow = true
        wm.receiveShadow = true
        g.add(wm)
        const fence = ribbon(c, {
          s0, s1, step: 4, across: 1,
          inner: (_s, i) => off[i] + side * 0.15, outer: (_s, i) => off[i] + side * 0.1501,
          height: (_s, u) => 1.05 + u * 2.9,
        })
        g.add(new THREE.Mesh(fence, fenceMaterial()))
      }
    }
    // pit wall (between track and pit lane)
    if (c.pit && pitD && c.meta.pit.s_start !== undefined) {
      const side = c.meta.pit.side === 'left' ? 1 : -1
      const a = c.meta.pit.s_start!, b = c.meta.pit.s_end!
      const edge = (i: number) => (side > 0 ? c.left[i] : c.right[i])
      const wallD = (s: number, i: number) => {
        const pd = pitD(s)
        const gap = side * (pd - edge(i))
        return gap > 10 ? edge(i) + side * Math.min(gap - 6, Math.max(2.5, (gap - 5.5) * 0.35)) : NaN
      }
      const valid = ranges(c, (i) => {
        const s = i * c.ds
        const x = s < a ? s + c.length : s
        return x > a && x < b && Number.isFinite(wallD(s, i))
      }, 2, 30)
      for (const [s0, s1] of valid) {
        const pw = ribbon(c, {
          s0, s1, step: 2, across: 1,
          inner: (s, i) => wallD(s, i), outer: (s, i) => wallD(s, i) + side * 0.001,
          height: (_s, u) => u * 1.2, extra: { aH: (_s, u) => u },
        })
        const m = new THREE.Mesh(pw, wallMaterial(theme.palette.accent))
        m.castShadow = true
        g.add(m)
        const pf = ribbon(c, {
          s0, s1, step: 4, across: 1,
          inner: (s, i) => wallD(s, i), outer: (s, i) => wallD(s, i) + side * 0.001,
          height: (_s, u) => 1.2 + u * 2.6,
        })
        g.add(new THREE.Mesh(pf, fenceMaterial()))
      }
      // pit lane surface
      const pl = ribbon(c, {
        s0: a, s1: b, step: 2, across: 6,
        inner: (s) => pitD(s) - side * 5.5, outer: (s) => pitD(s) + side * 5.5,
        height: () => 0.01,
        extra: { aL: () => 5.2, aR: () => -5.2, aRL: () => 0 },
      })
      // pit lane shares the asphalt shader; aL/aR are relative so reuse offsets via uv override
      const uvA = pl.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uvA.count; i++) {
        const u = (i % 7) / 6
        uvA.setX(i, (u - 0.5) * 11 * side)
        uvA.setY(i, uvA.getY(i) + 1e5) // move pit lane far from start-line/grid markings
      }
      const pm = new THREE.Mesh(pl, asphaltMaterial())
      pm.receiveShadow = true
      g.add(pm)
      // garages: long building behind the pit boxes
      const gs = c.meta.garages.map((x) => x.s)
      if (gs.length) {
        const gd = c.meta.garages.map((x) => x.d)
        let sMin = Math.min(...gs) - 45, sMax = Math.max(...gs) + 45
        const bent = (s: number) => Math.abs(c.scalarAt(c.curvature, s)) > 1 / 900
        while (sMax > Math.max(...gs) + 5 && bent(sMax)) sMax -= 5
        while (sMin < Math.min(...gs) - 5 && bent(sMin)) sMin += 5
        const dBack = gd.reduce((p, x) => p + x, 0) / gd.length
        const build = ribbon(c, {
          s0: sMin, s1: sMax, step: 4, across: 1,
          inner: () => dBack + side * 7, outer: () => dBack + side * 7.001,
          height: (_s, u) => u * 11,
          extra: { aH: (_s, u) => u },
        })
        const bm = new THREE.Mesh(build, garageFrontMaterial())
        bm.castShadow = true
        bm.receiveShadow = true
        g.add(bm)
        const roof = ribbon(c, {
          s0: sMin, s1: sMax, step: 4, across: 2,
          inner: () => dBack + side * 7, outer: () => dBack + side * 32,
          height: () => 11,
        })
        const rm = new THREE.Mesh(roof, roofMaterial('#7e858d'))
        rm.castShadow = true
        g.add(rm)
        // media centre / hospitality upper floor with glass
        const upper = ribbon(c, {
          s0: sMin + 20, s1: sMax - 20, step: 4, across: 1,
          inner: () => dBack + side * 9, outer: () => dBack + side * 9.001,
          height: (_s, u) => 11 + u * 7,
          extra: { aH: (_s, u) => u },
        })
        const um = new THREE.Mesh(upper, glassMaterial())
        g.add(um)
        const upperRoof = ribbon(c, {
          s0: sMin + 18, s1: sMax - 18, step: 4, across: 2,
          inner: () => dBack + side * 7.5, outer: () => dBack + side * 30,
          height: () => 18.2,
        })
        const ur = new THREE.Mesh(upperRoof, roofMaterial('#a7adb4'))
        ur.castShadow = true
        g.add(ur)
      }
    }

    // ------------------------------------------------------------------ start gantry
    g.add(startGantry(c))
    return g
  }, [c, terrain, theme, street])

  useEffect(() => () => {
    group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()) }
    })
  }, [group])

  useFrame((state) => {
    trackUniforms.uWet.value = look.wet
    trackUniforms.uFlood.value += ((look.night ? 0.55 : 0) - trackUniforms.uFlood.value) * 0.1
    trackUniforms.uTime.value = state.clock.elapsedTime
  })
  return <primitive object={group} />
}

function garageFrontMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aH; varying float vH; varying vec2 vDS;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = aH; vDS = uv;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH; varying vec2 vDS; float gEm;')
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float bay = fract(vDS.y / 13.0);
  float door = step(0.08, bay) * step(bay, 0.92) * step(vH, 0.55);
  vec3 wall = vec3(0.86, 0.87, 0.88);
  vec3 inside = mix(vec3(0.16, 0.17, 0.19), vec3(0.55, 0.57, 0.6), smoothstep(0.35, 0.55, vH));
  float stripe = step(0.6, vH) * step(vH, 0.68);
  diffuseColor.rgb = mix(mix(wall, vec3(0.12), stripe), inside, door);
  gEm = door;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.0, 0.96, 0.9) * gEm * smoothstep(0.42, 0.55, vH) * 0.35;`)
  }
  m.customProgramCacheKey = () => 'garage-v1'
  return m
}

function glassMaterial() {
  return new THREE.MeshPhysicalMaterial({ color: '#28323c', roughness: 0.08, metalness: 0.2, clearcoat: 1, side: THREE.DoubleSide, envMapIntensity: 1.4 })
}

function startGantry(c: CircuitModel) {
  const g = new THREE.Group()
  const s = 2
  const f = c.frame(s, 0, { x: 0, y: 0, z: 0, tx: 1, tz: 0, nx: 0, nz: 0, grade: 0, curvature: 0 })
  const i = Math.floor(s / c.ds)
  const wl = c.left[i] + 2.2, wr = c.right[i] - 2.2
  const metal = new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.4, metalness: 0.8 })
  const pillar = new THREE.BoxGeometry(0.6, 8, 0.6)
  for (const d of [wl, wr]) {
    const m = new THREE.Mesh(pillar, metal)
    m.position.set(f.x + f.nx * d, f.y + 4, f.z + f.nz * d)
    m.castShadow = true
    g.add(m)
  }
  const span = wl - wr
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, span + 0.6), metal)
  beam.position.set(f.x + f.nx * (wl + wr) / 2, f.y + 7.2, f.z + f.nz * (wl + wr) / 2)
  beam.rotation.y = Math.atan2(-f.tz, f.tx)
  beam.castShadow = true
  g.add(beam)
  // five light pods
  const lights = new THREE.MeshStandardMaterial({ color: '#111', emissive: '#ff0000', emissiveIntensity: 0.4 })
  for (let k = -2; k <= 2; k++) {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.7), lights)
    const d = (wl + wr) / 2 + k * 1.2
    pod.position.set(f.x + f.nx * d - f.tx * 0.7, f.y + 7.0, f.z + f.nz * d - f.tz * 0.7)
    pod.rotation.y = beam.rotation.y
    g.add(pod)
  }
  g.userData.lights = lights
  return g
}
