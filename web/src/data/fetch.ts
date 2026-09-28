/** Fetch helpers. Artifacts are stored gzip'd with Content-Encoding: gzip (browser inflates);
 *  if a proxy strips the header we still detect the gzip magic and inflate with DecompressionStream. */

export const DATA_BASE: string = (import.meta.env.VITE_DATA_BASE as string | undefined)
  ?? (import.meta.env.DEV ? '/data/' : 'https://cdn.shadster.dev/f1-sim/')

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

export function dataUrl(key: string) {
  return DATA_BASE + key.replace(/^\/+/, '')
}

async function inflateIfNeeded(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength))
  if (b[0] === 0x1f && b[1] === 0x8b) {
    const ds = new DecompressionStream('gzip')
    const stream = new Blob([buf]).stream().pipeThrough(ds)
    return await new Response(stream).arrayBuffer()
  }
  return buf
}

export interface ProgressCb { (loaded: number, total: number): void }

export async function fetchBuffer(url: string, onProgress?: ProgressCb, init?: RequestInit): Promise<ArrayBuffer> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  if (!onProgress || !res.body) return inflateIfNeeded(await res.arrayBuffer())
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    loaded += value.byteLength
    onProgress(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.byteLength }
  return inflateIfNeeded(out.buffer)
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const buf = await fetchBuffer(url, undefined, init)
  return JSON.parse(new TextDecoder().decode(buf)) as T
}
