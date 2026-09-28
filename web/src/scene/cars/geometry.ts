import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Geometry toolkit for the procedural car: lofts of superellipse cross-sections,
 * airfoil extrusions and lathed tyres. Car frame: +X forward, +Y up, +Z right,
 * origin on the ground at the middle of the wheelbase. Units: metres.
 */

export interface Section {
  x: number
  w: number // full width
  top: number // y of top
  bot: number // y of bottom
  zc?: number // centre z
  n?: number // superellipse exponent (2 = ellipse, higher = boxier)
  nb?: number // bottom exponent
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

/** Smoothly interpolated loft through sections (ordered front -> back or back -> front). */
export function loft(sections: Section[], radial = 40, subdiv = 6, capStart = true, capEnd = true): THREE.BufferGeometry {
  const S: Section[] = []
  const keys: (keyof Section)[] = ['x', 'w', 'top', 'bot', 'zc', 'n', 'nb']
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[Math.max(0, i - 1)], b = sections[i], c = sections[i + 1], d = sections[Math.min(sections.length - 1, i + 2)]
    for (let k = 0; k < subdiv; k++) {
      const t = k / subdiv
      const o: Record<string, number> = {}
      for (const key of keys) {
        const va = (a[key] ?? (key === 'zc' ? 0 : 2.5)) as number, vb = (b[key] ?? (key === 'zc' ? 0 : 2.5)) as number
        const vc = (c[key] ?? (key === 'zc' ? 0 : 2.5)) as number, vd = (d[key] ?? (key === 'zc' ? 0 : 2.5)) as number
        o[key] = key === 'x' ? vb + (vc - vb) * t : catmull(va, vb, vc, vd, t)
      }
      S.push(o as unknown as Section)
    }
  }
  S.push({ zc: 0, n: 2.5, nb: 2.5, ...sections[sections.length - 1] })
  const pos: number[] = []
  const idx: number[] = []
  const uv: number[] = []
  for (let i = 0; i < S.length; i++) {
    const s = S[i]
    const cy = (s.top + s.bot) / 2
    const hy = Math.max(0.001, (s.top - s.bot) / 2)
    const hz = Math.max(0.001, s.w / 2)
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const ca = Math.cos(a), sa = Math.sin(a)
      const n = sa >= 0 ? (s.n ?? 2.5) : (s.nb ?? s.n ?? 2.5)
      const e = 2 / n
      const z = (s.zc ?? 0) + hz * Math.sign(ca) * Math.pow(Math.abs(ca), e)
      const y = cy + hy * Math.sign(sa) * Math.pow(Math.abs(sa), e)
      pos.push(s.x, y, z)
      uv.push(j / radial, i / (S.length - 1))
    }
  }
  const R = radial + 1
  for (let i = 0; i < S.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * R + j, b = a + 1, c = a + R, d = c + 1
      idx.push(a, c, b, b, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  // orientation: if sections go back->front, flip winding
  if (S[0].x < S[S.length - 1].x) g.setIndex(idx.reverse())
  g.computeVertexNormals()
  const parts = [g]
  const cap = (s: Section, flip: boolean) => {
    const shape = new THREE.Shape()
    const cy = (s.top + s.bot) / 2, hy = (s.top - s.bot) / 2, hz = s.w / 2
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const ca = Math.cos(a), sa = Math.sin(a)
      const n = sa >= 0 ? (s.n ?? 2.5) : (s.nb ?? s.n ?? 2.5)
      const e = 2 / n
      const z = (s.zc ?? 0) + hz * Math.sign(ca) * Math.pow(Math.abs(ca), e)
      const y = cy + hy * Math.sign(sa) * Math.pow(Math.abs(sa), e)
      if (j === 0) shape.moveTo(z, y); else shape.lineTo(z, y)
    }
    const cg = new THREE.ShapeGeometry(shape, 1)
    const p = cg.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) { const z = p.getX(i), y = p.getY(i); p.setXYZ(i, s.x, y, z) }
    cg.deleteAttribute('normal')
    if (flip) cg.setIndex(Array.from(cg.index!.array).reverse())
    cg.computeVertexNormals()
    return cg
  }
  if (capStart) parts.push(cap(S[0], S[0].x > S[S.length - 1].x))
  if (capEnd) parts.push(cap(S[S.length - 1], S[0].x < S[S.length - 1].x))
  return mergeGeometries(parts, false) ?? g
}

/** Cambered airfoil (NACA-ish) extruded along Z, chord along -X. */
export function airfoil(chord: number, thickness: number, span: number, camber = 0.06, segs = 24): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const top: [number, number][] = [], bot: [number, number][] = []
  for (let i = 0; i <= segs; i++) {
    const x = (1 - Math.cos((i / segs) * Math.PI)) / 2
    const yt = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4)
    const yc = camber * 4 * x * (1 - x)
    top.push([x, yc + yt])
    bot.push([x, yc - yt])
  }
  shape.moveTo(-top[0][0] * chord, top[0][1] * chord)
  for (const [x, y] of top) shape.lineTo(-x * chord, y * chord)
  for (let i = bot.length - 1; i >= 0; i--) shape.lineTo(-bot[i][0] * chord, bot[i][1] * chord)
  const g = new THREE.ExtrudeGeometry(shape, { depth: span, bevelEnabled: false, steps: 12, curveSegments: 4 })
  g.translate(0, 0, -span / 2)
  g.computeVertexNormals()
  return g
}

/** Bend a wing along its span: y += up * |z/halfSpan|^p, rotate chord (angle of attack) */
export function sweepWing(g: THREE.BufferGeometry, halfSpan: number, up: number, p = 2, aoaCenter = 0, aoaTip = 0) {
  const pos = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i)
    const z = pos.getZ(i)
    const f = Math.min(1, Math.abs(z) / halfSpan)
    const aoa = aoaCenter + (aoaTip - aoaCenter) * f
    const c = Math.cos(aoa), s = Math.sin(aoa)
    const nx = x * c - y * s, ny = x * s + y * c
    x = nx; y = ny + up * Math.pow(f, p)
    pos.setXYZ(i, x, y, z)
  }
  g.computeVertexNormals()
  return g
}

/** Tyre: lathed rounded profile around the Z axis. */
export function tyre(radius: number, width: number, rimR: number, segs = 56): THREE.BufferGeometry {
  const w = width / 2
  const pts: THREE.Vector2[] = []
  const prof: [number, number][] = [
    [rimR, -w * 0.92], [rimR + 0.03, -w], [radius - 0.05, -w], [radius - 0.018, -w + 0.012], [radius - 0.004, -w + 0.04],
    [radius, -w + 0.07], [radius, w - 0.07], [radius - 0.004, w - 0.04], [radius - 0.018, w - 0.012], [radius - 0.05, w],
    [rimR + 0.03, w], [rimR, w * 0.92],
  ]
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y))
  const g = new THREE.LatheGeometry(pts, segs)
  g.rotateX(Math.PI / 2)
  g.computeVertexNormals()
  return g
}

export function disc(r: number, segs = 40) {
  const g = new THREE.CircleGeometry(r, segs)
  return g
}

export function plate(points: [number, number][], depth: number, bevel = 0.004): THREE.BufferGeometry {
  const s = new THREE.Shape()
  points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)))
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 8 })
  g.translate(0, 0, -depth / 2)
  g.computeVertexNormals()
  return g
}

export function tube(points: THREE.Vector3[], radius: number, segs = 64, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.5)
  return new THREE.TubeGeometry(curve, segs, radius, 12, closed)
}

export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const len = a.distanceTo(b)
  const g = new THREE.CylinderGeometry(r, r, len, 8, 1)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  g.applyQuaternion(q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

export function mirrorZ(g: THREE.BufferGeometry) {
  const m = g.clone()
  m.scale(1, 1, -1)
  const idx = m.index
  if (idx) {
    const a = idx.array as ArrayLike<number>
    const out: number[] = []
    for (let i = 0; i < a.length; i += 3) out.push(a[i], a[i + 2], a[i + 1])
    m.setIndex(out)
  } else {
    const p = m.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i += 3) {
      for (const attr of Object.values(m.attributes) as THREE.BufferAttribute[]) {
        const s = attr.itemSize
        for (let c = 0; c < s; c++) {
          const t = attr.array[(i + 1) * s + c]
          ;(attr.array as Float32Array)[(i + 1) * s + c] = attr.array[(i + 2) * s + c]
          ;(attr.array as Float32Array)[(i + 2) * s + c] = t
        }
      }
    }
  }
  m.computeVertexNormals()
  return m
}

export function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const norm = gs.map((g) => {
    let x = g.index ? g.toNonIndexed() : g
    x = x.clone()
    for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') x.deleteAttribute(k)
    if (!x.attributes.uv) x.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((x.attributes.position.count) * 2), 2))
    if (!x.attributes.normal) x.computeVertexNormals()
    return x
  })
  return mergeGeometries(norm, false)!
}
