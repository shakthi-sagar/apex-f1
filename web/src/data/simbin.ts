/** SimBin reader — zero-copy typed-array views over the pipeline's binary container. */

export type TypedArray =
  | Float32Array | Float64Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array

const CTORS = {
  f32: Float32Array, f64: Float64Array, i8: Int8Array, u8: Uint8Array,
  i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array,
} as const

interface ArrayIndex { dtype: keyof typeof CTORS; shape: number[]; offset: number; length: number }

export interface SimBin<M = Record<string, unknown>> {
  meta: M
  arrays: Record<string, TypedArray>
  shapes: Record<string, number[]>
  get<T extends TypedArray = Float32Array>(name: string): T
}

export function parseSimBin<M = Record<string, unknown>>(buf: ArrayBuffer): SimBin<M> {
  const dv = new DataView(buf)
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== 'F1SB') throw new Error('Not a SimBin file')
  const hlen = dv.getUint32(8, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hlen))) as {
    meta: M
    arrays: Record<string, ArrayIndex>
  }
  const body = 12 + hlen
  const arrays: Record<string, TypedArray> = {}
  const shapes: Record<string, number[]> = {}
  for (const [name, a] of Object.entries(header.arrays)) {
    const C = CTORS[a.dtype]
    arrays[name] = new C(buf, body + a.offset, a.length)
    shapes[name] = a.shape
  }
  return {
    meta: header.meta,
    arrays,
    shapes,
    get<T extends TypedArray>(name: string) {
      const a = arrays[name]
      if (!a) throw new Error(`SimBin: missing array ${name}`)
      return a as T
    },
  }
}
