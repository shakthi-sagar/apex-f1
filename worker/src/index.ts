/**
 * f1-sim edge worker — the app at https://apex.shadster.dev (generated data is served by R2 at
 * https://cdn.shadster.dev/f1-sim/*; this worker also mirrors it for workers.dev / local use)
 *
 *   /api/catalog/:season                 season calendar (from R2)
 *   /api/races/:season                   status of every round (ready / generating / ...)
 *   /api/races/:season/:round            status of one race (+ manifest when ready)
 *   POST /api/races/:season/:round/generate   idempotently start generation
 *   /{races,circuits,catalog,assets}/*   generated artifacts (R2, immutable, gzip)
 *   /*                                   the web app (static assets, SPA fallback)
 *   /f1-sim/*                            legacy prefix -> redirected to the root
 *
 * Generation is asynchronous: the SeasonJobs Durable Object is the single source of truth
 * and lock per season; it launches a Workflow that drives a Cloudflare Container running the
 * FastF1 pipeline and polls it until the bundle is published to R2.
 */
import { Container, getContainer } from '@cloudflare/containers'
import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

export interface Env {
  ASSETS: Fetcher
  BUCKET: R2Bucket
  JOBS: DurableObjectNamespace<SeasonJobs>
  GENERATOR: DurableObjectNamespace<Generator>
  GENERATE: Workflow<GenerateParams>
  R2_PREFIX: string
  /** Versions this deploy expects (must match pipeline/f1sim/__init__.py; pipeline/tests/test_versions.py enforces it). */
  SCHEMA_VERSION: string
  PIPELINE_VERSION: string
  CIRCUIT_VERSION: string
  CDN_HOST: string
  MAX_CONCURRENT_JOBS: string
  /** "container": Workflow drives a Cloudflare Container (Workers Paid).
   *  "agent": generator agents pull queued jobs over HTTPS (works anywhere, no inbound ports). */
  GENERATOR_MODE: 'container' | 'agent'
  /** Shared secret for /api/agent/* (generator agents report progress with it). */
  AGENT_TOKEN: string
  /** Optional Workers rate-limit binding (see wrangler.jsonc); absent in local dev. */
  GEN_LIMITER?: RateLimit
  // secrets (wrangler secret put) — passed to the container only
  R2_ENDPOINT_URL: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET_NAME: string
}

type JobState =
  | 'unavailable' | 'queued' | 'generating_fastf1' | 'generating_circuit' | 'enriching_osm'
  | 'processing' | 'uploading' | 'ready' | 'failed'

interface Job {
  state: JobState
  stage?: string
  progress?: number
  message?: string
  error?: string
  updatedAt: number
  startedAt?: number
  workflowId?: string
  attempts?: number
  manifest?: unknown
}

interface GenerateParams { season: number; round: number }

const ACTIVE: JobState[] = ['queued', 'generating_fastf1', 'generating_circuit', 'enriching_osm', 'processing', 'uploading']
const STALE_MS = 25 * 60 * 1000
const BACKOFF_MS = 60 * 60 * 1000 // background rebuilds: at most one attempt per race per hour
const BASE = '/f1-sim'

// ------------------------------------------------------------------------------------------ container
export class Generator extends Container<Env> {
  defaultPort = 8080
  sleepAfter = '10m'
  enableInternet = true

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env)
    this.envVars = {
      R2_ENDPOINT_URL: env.R2_ENDPOINT_URL,
      AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      AWS_DEFAULT_REGION: 'auto',
      R2_BUCKET: env.R2_BUCKET_NAME,
      R2_PREFIX: env.R2_PREFIX,
    }
  }
}

// ------------------------------------------------------------------------------------------ job registry
export class SeasonJobs extends DurableObject<Env> {
  private async get(round: number): Promise<Job | undefined> {
    return this.ctx.storage.get<Job>(`r${round}`)
  }

  async status(round: number): Promise<Job> {
    const j = await this.get(round)
    if (!j) return { state: 'unavailable', updatedAt: Date.now() }
    if (ACTIVE.includes(j.state) && Date.now() - j.updatedAt > STALE_MS) {
      return { ...j, state: 'failed', error: 'Generation timed out', message: 'Timed out' }
    }
    return j
  }

  async all(): Promise<Record<number, Job>> {
    const m = await this.ctx.storage.list<Job>({ prefix: 'r' })
    const out: Record<number, Job> = {}
    for (const [k, v] of m) out[Number(k.slice(1))] = v
    return out
  }

  /** Idempotent start. Single-threaded DO => concurrent callers can never double-launch.
   *  `background` = a stale-while-rebuild trigger (nobody clicked "generate"): it backs off after a
   *  failure and after a rebuild that did not clear the stale flag, so it can never loop. */
  async start(season: number, round: number, background = false): Promise<Job> {
    const cur = await this.status(round)
    if (ACTIVE.includes(cur.state)) return cur
    if (background && (cur.state === 'failed' || cur.state === 'ready') && Date.now() - cur.updatedAt < BACKOFF_MS) return cur
    const active = Object.values(await this.all()).filter((j) => ACTIVE.includes(j.state) && Date.now() - j.updatedAt < STALE_MS)
    const attempts = (cur.attempts ?? 0) + 1
    const id = `race-${season}-${round}-${Date.now()}`
    const job: Job = {
      state: 'queued', stage: 'queued', progress: 0, updatedAt: Date.now(), startedAt: Date.now(), workflowId: id, attempts,
      message: active.length >= Number(this.env.MAX_CONCURRENT_JOBS || 3) ? 'Waiting for a free generator' : 'Queued',
    }
    if (this.env.GENERATOR_MODE === 'container') {
      await this.ctx.storage.put(`r${round}`, job)
      await this.env.GENERATE.create({ id, params: { season, round } })
    } else {
      job.message = 'Waiting for a generator agent'
      await this.ctx.storage.put(`r${round}`, job)
    }
    return job
  }

  /** Agent mode: hand the oldest queued (or abandoned) job to an agent. */
  async claim(season: number, agent: string): Promise<{ season: number; round: number } | null> {
    const all = await this.all()
    const now = Date.now()
    const cand = Object.entries(all)
      .filter(([, j]) => j.state === 'queued' || (ACTIVE.includes(j.state) && now - j.updatedAt > 10 * 60 * 1000)) // agents heartbeat every 45 s
      .sort((a, b) => (a[1].startedAt ?? 0) - (b[1].startedAt ?? 0))[0]
    if (!cand) return null
    const round = Number(cand[0])
    await this.update(round, { state: 'generating_fastf1', stage: 'generating_fastf1', progress: 0, message: `Claimed by ${agent}` })
    return { season, round }
  }

  // ---- generator presence (used on the 'agents' instance): agents poll every ~10 s and
  // heartbeat every 45 s while working, so "seen in the last 90 s" means online.
  async agentSeen(name: string, busy: string | null): Promise<void> {
    await this.ctx.storage.put(`agent:${name}`, { name, lastSeen: Date.now(), busy })
  }

  async agents(): Promise<{ name: string; lastSeen: number; busy: string | null }[]> {
    const m = await this.ctx.storage.list<{ name: string; lastSeen: number; busy: string | null }>({ prefix: 'agent:' })
    const now = Date.now()
    const out = []
    for (const [k, v] of m) {
      if (now - v.lastSeen > 7 * 24 * 3600e3) await this.ctx.storage.delete(k) // forget long-gone agents
      else out.push(v)
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen)
  }

  async update(round: number, patch: Partial<Job>): Promise<void> {
    const cur = (await this.get(round)) ?? { state: 'unavailable', updatedAt: Date.now() }
    await this.ctx.storage.put(`r${round}`, { ...cur, ...patch, updatedAt: Date.now() })
  }
}

// ------------------------------------------------------------------------------------------ workflow
export class GenerateRaceWorkflow extends WorkflowEntrypoint<Env, GenerateParams> {
  async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep) {
    const { season, round } = event.payload
    const jobs = this.env.JOBS.get(this.env.JOBS.idFromName(`season-${season}`))
    const container = () => getContainer(this.env.GENERATOR, `race-${season}-${round}`)

    await step.do('start-container-job', { retries: { limit: 6, delay: '20 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
      const res = await container().fetch(new Request('http://generator/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ season, round }),
      }))
      if (!res.ok) throw new Error(`container start failed: ${res.status} ${await res.text()}`)
      const j = (await res.json()) as Partial<Job>
      await jobs.update(round, { state: (j.state as JobState) ?? 'queued', message: j.message ?? 'Started', progress: j.progress ?? 0 })
      return true
    })

    for (let i = 0; i < 200; i++) {
      await step.sleep(`wait-${i}`, i < 4 ? '10 seconds' : '15 seconds')
      const st = await step.do(`poll-${i}`, { retries: { limit: 4, delay: '10 seconds' }, timeout: '1 minute' }, async () => {
        const res = await container().fetch(new Request(`http://generator/jobs/${season}/${round}`))
        if (!res.ok) throw new Error(`poll failed: ${res.status}`)
        const j = (await res.json()) as Job & { stage?: string }
        if (j.state === 'unavailable') {
          // container restarted and lost its in-memory job -> restart it (bundle writes are atomic)
          throw new Error('container lost job state')
        }
        await jobs.update(round, { state: j.state, stage: j.stage, progress: j.progress, message: j.message, error: j.error, manifest: j.manifest })
        return { state: j.state, error: j.error ?? null }
      })
      if (st.state === 'ready') return { ok: true }
      if (st.state === 'failed') throw new Error(st.error ?? 'generation failed')
    }
    await jobs.update(round, { state: 'failed', error: 'Timed out after 50 minutes' })
    throw new Error('timeout')
  }
}

// ------------------------------------------------------------------------------------------ http
const json = (obj: unknown, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': cache } })

/** Constant-time string compare (timingSafeEqual needs equal lengths, so hash first). */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const h = async (x: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))
  return crypto.subtle.timingSafeEqual(await h(a), await h(b))
}

function pad(r: number) { return String(r).padStart(2, '0') }

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const o = await env.BUCKET.get(`${env.R2_PREFIX}/${key}`)
  if (!o) return null
  const enc = o.httpMetadata?.contentEncoding
  const stream = enc === 'gzip' ? o.body.pipeThrough(new DecompressionStream('gzip')) : o.body
  return JSON.parse(await new Response(stream).text()) as T
}

interface Manifest { schemaVersion?: number; pipelineVersion: number; circuitVersion?: number; bundle: string; circuit: string }

/** A manifest with a different schema is unreadable by this renderer, so it counts as missing and must
 *  regenerate before being served. An older pipeline/circuit version is merely stale: still served,
 *  rebuilt in the background. (Manifests written before schemaVersion existed are schema 1.) */
async function manifestFor(env: Env, season: number, round: number) {
  const m = await readJson<Manifest>(env, `races/${season}/${pad(round)}/manifest.json`)
  if (!m || (m.schemaVersion ?? 1) !== Number(env.SCHEMA_VERSION)) return null
  const current = m.pipelineVersion >= Number(env.PIPELINE_VERSION) && (m.circuitVersion ?? 0) >= Number(env.CIRCUIT_VERSION)
  return { manifest: m, current }
}

async function catalogRound(env: Env, season: number, round: number) {
  const cat = await readJson<{ races: { round: number; date: string; unavailable?: boolean }[] }>(env, `catalog/${season}.json`)
  return cat?.races.find((r) => r.round === round) ?? null
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const parts = path.split('/').filter(Boolean) // [api, ...]
  const jobsFor = (season: number) => env.JOBS.get(env.JOBS.idFromName(`season-${season}`))

  // ---- generator agents (pull model): authenticated with AGENT_TOKEN
  if (parts[1] === 'agent') {
    if (!env.AGENT_TOKEN || !(await sameSecret(req.headers.get('authorization') ?? '', `Bearer ${env.AGENT_TOKEN}`))) return json({ error: 'unauthorized' }, 401)
    const url = new URL(req.url)
    const presence = env.JOBS.get(env.JOBS.idFromName('agents'))
    if (parts[2] === 'next' && req.method === 'POST') {
      const seasons = (url.searchParams.get('seasons') || '2024').split(',').map(Number).filter(Boolean)
      const agent = (url.searchParams.get('agent') || 'agent').slice(0, 40)
      await presence.agentSeen(agent, null)
      for (const season of seasons) {
        const job = await jobsFor(season).claim(season, agent)
        if (job) return json(job)
      }
      return json(null)
    }
    if (parts[2] === 'progress' && req.method === 'POST') {
      const b = (await req.json()) as Partial<Job> & { season: number; round: number; agent?: string }
      if (!Number.isInteger(b.season) || !Number.isInteger(b.round)) return json({ error: 'bad request' }, 400)
      const done = b.state === 'ready' || b.state === 'failed'
      await presence.agentSeen((b.agent || 'agent').slice(0, 40), done ? null : `${b.season}/${b.round}`)
      await jobsFor(b.season).update(b.round, {
        state: b.state, stage: b.stage, progress: b.progress, message: b.message, error: b.error, manifest: b.manifest,
      })
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  // ---- generator status for the UI
  if (parts[1] === 'generator' && req.method === 'GET') {
    const agents = (await env.JOBS.get(env.JOBS.idFromName('agents')).agents()) as { name: string; lastSeen: number; busy: string | null }[]
    const now = Date.now()
    const live = agents.filter((a) => now - a.lastSeen < 90_000)
    return json({
      mode: env.GENERATOR_MODE,
      online: env.GENERATOR_MODE === 'container' || live.length > 0,
      agents: live.length,
      busy: live.filter((a) => a.busy).map((a) => a.busy),
      lastSeen: agents[0]?.lastSeen ?? null,
    })
  }

  if (parts[1] === 'seasons' && req.method === 'GET') {
    const list = await env.BUCKET.list({ prefix: `${env.R2_PREFIX}/catalog/` })
    const seasons = list.objects.map((o) => Number(o.key.split('/').pop()!.replace('.json', ''))).filter(Boolean).sort((a, b) => b - a)
    return json({ seasons }, 200, 'public, max-age=30')
  }

  if (parts[1] === 'catalog' && parts.length === 3) {
    const season = Number(parts[2])
    const cat = await readJson(env, `catalog/${season}.json`)
    return cat ? json(cat, 200, 'public, max-age=300') : json({ error: 'unknown season' }, 404)
  }

  if (parts[1] === 'races' && parts.length === 3 && req.method === 'GET') {
    const season = Number(parts[2])
    const list = await env.BUCKET.list({ prefix: `${env.R2_PREFIX}/races/${season}/`, delimiter: '/' })
    const out: Record<number, Partial<Job>> = {}
    await Promise.all(list.delimitedPrefixes.map(async (p) => {
      const round = Number(p.split('/').filter(Boolean).pop())
      const m = await manifestFor(env, season, round)
      if (m) out[round] = { state: 'ready', manifest: m.manifest }
    }))
    const jobs = (await jobsFor(season).all()) as Record<number, Job>
    for (const [r, j] of Object.entries(jobs)) {
      const round = Number(r)
      if (out[round]?.state === 'ready') continue
      const stale = ACTIVE.includes(j.state) && Date.now() - j.updatedAt > STALE_MS
      out[round] = stale ? { ...j, state: 'failed', error: 'timed out' } : j
    }
    return json(out)
  }

  if (parts[1] === 'races' && parts.length >= 4) {
    const season = Number(parts[2]), round = Number(parts[3])
    if (!Number.isInteger(season) || !Number.isInteger(round)) return json({ error: 'bad request' }, 400)
    // Only races in the catalog ever reach a Durable Object: arbitrary ids are rejected up front.
    const cr = await catalogRound(env, season, round)
    if (!cr || cr.unavailable) return json({ state: 'failed', error: 'Race not in catalog' }, 404)
    const m = await manifestFor(env, season, round)
    const allowed = async () => !env.GEN_LIMITER || (await env.GEN_LIMITER.limit({ key: req.headers.get('cf-connecting-ip') ?? 'anon' })).success
    if (parts[4] === 'generate' && req.method === 'POST') {
      if (m?.current) return json({ state: 'ready', manifest: m.manifest })
      if (Date.parse(cr.date) > Date.now() - 36 * 3600e3) return json({ state: 'failed', error: 'Race has not happened yet' }, 409)
      if (!(await allowed())) return json({ state: 'failed', error: 'Too many requests — slow down' }, 429)
      const job = await jobsFor(season).start(season, round)
      return json(job, 202)
    }
    if (req.method === 'GET') {
      if (!m) return json(await jobsFor(season).status(round))
      if (m.current) return json({ state: 'ready', manifest: m.manifest, stale: false })
      // Stale-while-rebuild: serve the old file now, rebuild in the background (no regenerate button).
      const job = (await (await allowed() ? jobsFor(season).start(season, round, true) : jobsFor(season).status(round))) as unknown as Job
      return json({ state: 'ready', manifest: m.manifest, stale: true, rebuilding: ACTIVE.includes(job.state), rebuild: { state: job.state, progress: job.progress, message: job.message } })
    }
  }
  return json({ error: 'not found' }, 404)
}

async function artifact(req: Request, env: Env, key: string): Promise<Response> {
  // On the cdn.shadster.dev route the R2 custom domain is our origin: pass through (edge-cached).
  const url = new URL(req.url)
  if (url.hostname === env.CDN_HOST) return fetch(req)
  const obj = await env.BUCKET.get(`${env.R2_PREFIX}/${key}`)
  if (!obj) return new Response('not found', { status: 404 })
  const h = new Headers()
  obj.writeHttpMetadata(h)
  h.set('etag', obj.httpEtag)
  h.set('access-control-allow-origin', '*')
  // body is already gzip-encoded in R2: tell the runtime not to re-encode it
  return new Response(obj.body, { headers: h, encodeBody: obj.httpMetadata?.contentEncoding ? 'manual' : 'automatic' })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    // the CDN hostname is a pure R2 asset host — never handle it here (stale routes pass straight to origin)
    if (url.hostname === env.CDN_HOST) return fetch(req)
    if (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`)) {
      const rest = url.pathname.slice(BASE.length) || '/'
      return Response.redirect(`${url.origin}${rest}${url.search}`, 301)
    }
    const path = url.pathname
    try {
      if (path.startsWith('/api/')) return await api(req, env, path)
      if (/^\/(races|circuits|catalog|assets)\//.test(path)) return await artifact(req, env, path.slice(1))
      // static app (built with base /f1-sim/); SPA fallback handled by the assets binding
      const assetUrl = new URL(path, url.origin)
      const res = await env.ASSETS.fetch(new Request(assetUrl, req))
      if (path.startsWith('/_app/')) {
        const r = new Response(res.body, res)
        r.headers.set('cache-control', 'public, max-age=31536000, immutable')
        return r
      }
      return res
    } catch (e) {
      return json({ error: (e as Error).message }, 500)
    }
  },
} satisfies ExportedHandler<Env>
