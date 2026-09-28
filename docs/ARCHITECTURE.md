# Apex — F1 race reconstruction & 3D replay

Live: **https://apex.shadster.dev** (Worker custom domain) · data: **https://cdn.shadster.dev/f1-sim/** (R2 custom domain)

A race is processed **once** into a compact, versioned **RaceBundle** on R2; the browser only streams
and replays generated data. FastF1 structures never reach the renderer.

```
                    ┌──────────────────────── generation (once per race) ────────────────────────┐
 FastF1 ──► ingest ─┤ registration (ICP vs OSM raceway) ─► circuit reconstruction ─► world (OSM,   │
 Ergast            │ DEM terrain, landcover, buildings, trees, stands) ─► motion fusion ─► timing  │──► R2
 Overpass / DEM    │ ─► event detection ─► environment (sun, weather) ─► SimBin/JSON packing       │
                    └────────────────────────────────────────────────────────────────────────────┘
 browser: gallery ─► status/generate API ─► manifest ─► race.json + circuit/world + motion chunks ─► replay
```

## 1. Systems

| System | Where | Notes |
|---|---|---|
| Data ingestion | `pipeline/f1sim/ingest/fastf1_source.py` | Only module that touches FastF1/pandas; emits numpy + dicts, times in session seconds |
| Circuit processing | `pipeline/f1sim/circuit/` | Reference line from ~300k samples, edges, pit lane, garages, sectors, kerbs, DRS; per-layout registry |
| Geospatial enrichment | `pipeline/f1sim/geo/` | ENU frame, tiled cached Overpass, registration, Terrarium DEM, landcover raster, buildings, trees |
| Race processing | `pipeline/f1sim/race/` | Kalman/RTS motion fusion, derived lateral lanes, time-at-distance gaps, events |
| RaceBundle generation | `pipeline/f1sim/generate.py` | Content-addressed bundle, manifest written last (atomic publish) |
| Storage | `pipeline/f1sim/storage.py` | R2 (S3 API) + local mirror, gzip + Content-Encoding, cache headers |
| Job orchestration | `worker/src/index.ts` | SeasonJobs DO (lock/state), Workflow + Container, or pull agents |
| Race playback | `web/src/replay/` | ReplayClock (independent of React), MotionStore (Hermite), TimingStore, RaceRuntime |
| 3D rendering | `web/src/scene/` | R3F; track/terrain/buildings/trees/stands/floodlights/cars/weather/post |
| Camera / director | `web/src/camera/` | 11 shot generators, spring rig, auto director scoring events + live battles |
| Telemetry overlays | `web/src/scene/overlays`, `web/src/ui` | Labels, racing line, heatmaps, sector gates, DRS zones, lap duel |
| UI | `web/src/ui`, `web/src/pages` | Gallery, generation/loading screens, broadcast HUD |

## 2. Coordinate frames & registration

* **Local ENU** (metres, x=east, y=north, z=up) around the Ergast circuit coordinate; three.js uses
  `(x, y, z)_three = (east, up, -north)`. All generated geometry is ENU; the renderer never sees FastF1 coordinates.
* **FastF1 → ENU** similarity transform `enu = s·R(θ)·M·ff + t` solved by a global rotation/mirror search
  followed by trimmed ICP with a closed-form Umeyama solve against densified OSM `highway=raceway` ways
  (Interlagos: s = 0.09992, θ = −0.26°, residual 3.4 m ≈ racing line vs mapped centreline).
* **Manual anchors** (`anchors` in `circuit/registry.py`, ≥2 pairs of FastF1 point ↔ lat/lon) override ICP.
* **Elevation**: FastF1 Z is scaled with the same factor; the vertical offset to the DEM is the median
  residual along the reference line; everything is stored relative to a per-layout `datum`.
* The registration is stored with the circuit (`circuit.bin` meta + `registration.json`) and **reused for
  every race on the same layout** (`circuits/{ref}/{layout}/c{version}`).

## 3. RaceBundle schema (`f1sim.racebundle/1`)

```
races/{season}/{round:02}/manifest.json            ← pointer, short cache (written last)
races/{season}/{round:02}/b{PIPELINE_VERSION}-{hash}/   ← immutable, content addressed
    race.json      gzip JSON: metadata, drivers (+livery), laps table, stints, events, track status,
                   race control, environment (sun track, weather/wetness timeline, theme), motion/timing index
    motion-NN.bin  SimBin, 15-minute chunks @ 4 Hz, per driver:
                     s f32 (fused cumulative arc length) · v u16 cm/s · d i16 cm · speed u16 · rpm u16
                     gear u8 · throttle u8 · brake u8 · drs u8 · flags u8 (visible|pit|stopped)
    timing.bin     SimBin @ 2 Hz: position u8, gap/interval i32 ms, laps_down u8, lap u8
                   + track profile (median speed/throttle/brake per 5 m) for heatmaps
circuits/{ref}/{layout}/c{CIRCUIT_VERSION}/
    circuit.bin    reference line (1 m, xyz), edges, derived racing line, curvature, barriers, pit lane,
                   meta: corners, sectors, DRS zones, kerbs, garages, stands, registration, theme
    world.bin      terrain (i16 dm grid), buildings (rings + earcut roofs, height, base, kind), trees, roads
    landcover.png  8-bit class raster used as a terrain splat map
    registration.json
circuits/{ref}/osm/{queryhash}.json.gz               raw Overpass cache (never re-queried)
catalog/{season}.json                                  gallery: schedule, winners, circuit outlines
assets/cars/{season}/{teamId}.glb                      optional licensed car models (see Cars)
```

**SimBin** = `F1SB` magic, u32 version, u32 header length, JSON header `{meta, arrays:{name:{dtype,shape,offset,length}}}`,
8-byte aligned little-endian arrays → zero-copy `TypedArray` views in the browser. Files are gzip-compressed and
stored with `Content-Encoding: gzip`, so the browser inflates natively (magic-byte fallback included).
Interlagos 2024: race bundle 5.3 MB, circuit+world 2.9 MB (shared by every race on the layout).

### Raw vs derived (recorded in `race.json.motion`)
* **Raw**: speed, RPM, gear, throttle, brake, DRS, lap/sector times, tyres, track status, weather, race control.
* **Derived**: fused `s(t)` (Kalman/RTS of map-matched position + measured speed), `v`, lateral `d`
  (FastF1 positions since 2023 are map-matched onto a single line, measured spread ±0.1 m, so lateral
  position is a **derived** min-curvature racing line + collision-free side-by-side lanes; pit lane offset is
  measured), grid formation stagger, wetness, cloud cover, steering/roll (render-time only).

## 4. Pipeline

1. **Ingest** (FastF1 + Ergast lat/lon), normalise times to session seconds.
2. **OSM** tiled Overpass queries (raceways → buildings per tile → other features per tile), cached locally and in R2.
3. **Registration** (ICP / anchors / fallback).
4. **Circuit**: seed spline from the fastest lap → iterative robust median refinement on every green-lap
   sample → timing line from lap boundaries → edges (telemetry envelope, or registry width when map-matched)
   → pit lane from pit transits + team garage boxes from stationary points → sectors, corners, DRS, kerbs.
5. **World**: DEM (z15) fitted to the track with a smooth corridor blend; landcover raster; buildings with
   heights/levels (+ plausible defaults); clumped vegetation; generic grandstands where OSM has none.
6. **Motion**: continuity-aware projection → RTS smoother (s, v) → derived lateral lanes → 4 Hz grid.
7. **Timing**: lap-anchored progress `(lap−1)·L + distance past line` (robust to pit/red-flag drift),
   pit-lane-start handling, classification freeze after the flag, time-at-distance gaps.
8. **Events**: starts/restarts/finish, SC/VSC/red/yellow, pit stops (lane + stationary time), overtakes & lead
   changes (6 s hold before and after, excluding pit/neutralised), merged battles, fastest laps, retirements,
   incidents/penalties from race control, weather transitions. Each has an `importance` for the director.
9. **Environment**: NOAA solar position over the race window, wetness model, cloud/fog, circuit theme.
10. **Publish**: pack, content-hash, upload, then manifest.

Idempotent: the same inputs give the same bundle hash; bumping `PIPELINE_VERSION`/`CIRCUIT_VERSION` invalidates.

## 5. Backend & job lifecycle

`unavailable → queued → generating_fastf1 → generating_circuit → enriching_osm → processing → uploading → ready | failed`

* `POST /api/races/:s/:r/generate` → validates against the catalog (race must have happened) →
  `SeasonJobs` Durable Object (one per season, single-threaded ⇒ no duplicate jobs; stale jobs time out after 25 min).
* **Container mode** (`GENERATOR_MODE=container`, needs the Workers Paid plan): the DO starts the
  `GenerateRaceWorkflow`, which starts the job in a Cloudflare Container (`pipeline/Dockerfile`, one instance
  per race) and polls it with durable steps/sleeps, mirroring progress into the DO.
* **Agent mode** (`GENERATOR_MODE=agent`, current): any machine runs `python -m f1sim.agent`; it claims queued
  jobs over HTTPS (`/api/agent/next`), runs the same pipeline and reports progress (`/api/agent/progress`).
  Needs only outbound HTTPS — laptop, VPS or CI.
* The browser never holds a request open: it polls `GET /api/races/:s/:r` every 2.5 s.

## 6. Frontend

* `ReplayClock` owns race time outside React; the R3F loop calls `RaceRuntime.update()` first each frame,
  computing all car poses once; cameras, cars, labels, director and minimap read those poses. React UI
  re-renders at ~15 Hz via `useSyncExternalStore`.
* `MotionStore` streams 15-min chunks around the playhead; `s(t)` is cubic Hermite with fused speed as the
  tangent (C¹, no jumps), `d(t)` Catmull-Rom, telemetry linear / sample-and-hold.
* Scene: procedural sky + real sun path, PMREM environment with horizon band, fog; asphalt shader (grain,
  rubbered line, markings, grid boxes, wet darkening/roughness/puddles/ripples); kerbs; runoff (grass/tarmac/
  gravel bands); walls with generic ad panels; catch fences; pit lane, pit wall, garages; stands with crowd;
  OSM buildings (tiles, procedural facades, lit windows at night); instanced trees with wind; terrain splat;
  floodlights for night races; rain streaks and tyre spray; N8AO, bloom, DOF (long-lens shots), AgX, vignette.
* Cars: original procedural 2022+-regulation model (lofted monocoque/sidepods, wing stacks, halo, lathed
  tyres), livery shader driven by team colour schemes (no trademarks), steering/rotating wheels, DRS flap,
  blinking FIA rain light, compound sidewall band. `assets/cars/{season}/{teamId}.glb` is the extension point for
  separately supplied, licensed models.
* Cameras: chase, close, T-cam, cockpit, trackside TV (auto-placed towers, long-lens framing + DOF), heli,
  tactical top-down, cinematic low dolly, orbit, free — plus the **director** (anticipates bundle events,
  scores live battles, varies shot types, lower-third captions).
* Lap duel: two laps as ghost cars on a shared clock, mini-sector dominance painted on track, braking points,
  live delta, speed-vs-distance with delta trace, per-corner minimum speed & time gained.

## 7. Milestones

1. ✅ Architecture, pipeline, RaceBundle, registration, circuit & world reconstruction (Interlagos 2024)
2. ✅ 20-car replay with fused motion, HUD, timing tower, telemetry, timeline/events, cameras, director
3. ✅ Weather (rain, spray, wet track), night-race lighting path, post-processing, lap duel comparison
4. ✅ Worker API + Durable Object job registry + Workflow/Container + agent mode; deployed at cdn.shadster.dev/f1-sim
5. ⏭ More circuits/seasons through the generator (each new layout: registry entry for width/DRS/theme)
6. ⏭ Licensed glTF car models per season; pit-crew & garage detail; OSM `building:part` massing
7. ⏭ Container mode once the account is on Workers Paid (flip `GENERATOR_MODE`, uncomment `containers`)

## 8. Attribution & licensing

Timing/telemetry via FastF1 (unofficial, non-commercial). Map data © OpenStreetMap contributors (ODbL) —
credited in the app footer and HUD. Terrain: Mapzen Terrain Tiles on AWS Open Data. No F1/team trademarks,
logos or commercial 3D models are redistributed; liveries are colour schemes only.
