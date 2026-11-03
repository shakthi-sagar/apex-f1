# Apex — Formula 1 races rebuilt in 3D

> **This project is discontinued.** Formula 1 now requires authentication for its timing archive, so new races can't be
> generated anonymously. The code is MIT-licensed: please fork it and do whatever you like. See [`DISCONTINUED.md`](DISCONTINUED.md).

Real timing & telemetry, registered onto the real circuit and its OpenStreetMap surroundings, replayed as a
broadcast-style 3D experience with an automatic race director. Unofficial, non-commercial, MIT-licensed code.

**Live:** https://apex.shadster.dev · Architecture & data schema: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## How it works

```
pipeline/   Python: FastF1 + OpenStreetMap + terrain tiles → race & circuit files (JSON / binary)
worker/     Cloudflare Worker: API, job state, serves the app
web/        React + TypeScript + Vite + React Three Fiber renderer
```

A race is **not a video**. It is a set of generated data files that the browser renders live. Those files are
**build output**: a rebuildable cache stored in Cloudflare R2, **never committed** to this repo. The repo holds the
pipeline, the schema and the renderer.

1. Open an ungenerated race → the Worker checks it exists in the catalog and queues a job (one per race, however many people click).
2. A generator agent runs the pipeline and uploads the files to R2; the page shows progress, then plays the race.
3. Data is versioned, so improving the pipeline never breaks the site:

| Version | Meaning | When it changes |
|---|---|---|
| `schemaVersion` | the format the renderer reads | renderer + pipeline change **in the same PR**. Old-schema files are regenerated before being served. |
| `pipelineVersion` | how race telemetry was generated | an old file is served immediately while a **background rebuild** runs ("newer data loading" in the UI). No regenerate button. |
| `circuitVersion` | how circuit/terrain/buildings were generated | the circuit is rebuilt; the race telemetry is **reused** if the line geometry is unchanged (`lineHash`). |

Circuit/environment data is one set of files per track; race telemetry is one bundle per session.
The footer shows the data version and generation date.

## Run it locally (no keys needed)

```bash
npm install
cd pipeline && python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]' && cd ..

# renderer only: develop against the public data (no pipeline run, no keys)
VITE_DATA_BASE=https://cdn.shadster.dev/f1-sim/ npm run dev      # http://localhost:5173

# pipeline: generate a race yourself into ./out (public sources only, nothing is uploaded)
cd pipeline && .venv/bin/python -m f1sim.generate --year 2024 --race monza && cd ..
npm run dev                       # dev serves ./out at /data by default; open /race/2024/16
```

`--race` takes a round number or a name fragment. Tests: `python -m pytest pipeline/tests`; types: `npm run typecheck`.

> **Data availability.** Since mid-October 2026 Formula 1's timing archive requires authentication, which
> breaks anonymous FastF1 downloads (see [`docs/OPERATIONS.md`](docs/OPERATIONS.md#data-availability)). Races
> already in your FastF1 cache still generate; new ones need an authenticated FastF1 session.

## Forking

No PRs or issues are being handled (see [`DISCONTINUED.md`](DISCONTINUED.md)). To run your own deployment see
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Adding a circuit

Add an entry to `pipeline/f1sim/circuit/registry.py` (layout id, track width, DRS zones as corner-relative
specs, art-direction theme, optional manual registration anchors). Everything else is derived.

## License & credits

Code and original assets: [MIT](LICENSE). Data, attribution and trademark notes: [`NOTICE.md`](NOTICE.md).

Timing & telemetry: [FastF1](https://github.com/theOehrly/Fast-F1) (unofficial F1 live-timing data, non-commercial; no rights to it are claimed).
Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Terrain: Mapzen Terrain Tiles on AWS Open Data.
Unofficial project, not affiliated with Formula 1, the FIA or any team. F1 and FORMULA 1 are trademarks of Formula One Licensing B.V.;
liveries are colour schemes only and car geometry is original.
