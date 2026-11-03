# Apex — Formula 1 races rebuilt in 3D

Real FastF1 timing & telemetry, registered onto the real circuit and its OpenStreetMap surroundings,
replayed as a broadcast-style 3D experience with an automatic race director.

**Live:** https://apex.shadster.dev (generated data: https://cdn.shadster.dev/f1-sim/) · Architecture, schema & pipeline: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

```
pipeline/   Python: FastF1 → RaceBundle generator (+ container service & pull agent)
worker/     Cloudflare Worker: API, SeasonJobs Durable Object, Workflow, Container class, static app
web/        React + TypeScript + Vite + React Three Fiber client
docs/       Architecture
```

## Develop

```bash
npm install                                   # web + worker workspaces
cd pipeline && uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python -e .

# generate a race locally into ./out (no upload)
F1SIM_CACHE=$PWD/../.cache .venv/bin/python -m f1sim.generate --season 2024 --round 21 --out ../out --no-upload

# run the app against ./out (served at /data by the Vite dev plugin)
cd ../web && npx vite                         # http://localhost:5173/race/2024/21
```

Useful dev scripts (headless GPU screenshots): `web/scripts/views.mjs`, `car.mjs`, `scenario.mjs`.
`window.__f1` exposes `{ rt, ui }` for automation.

## Generate & publish

Credentials come from the environment only (never committed): `R2_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `R2_BUCKET=cdn`, `R2_PREFIX=f1-sim`.

```bash
set -a; source ~/.config/shadster/r2.env; set +a
export R2_BUCKET=cdn R2_PREFIX=f1-sim
.venv/bin/python -m f1sim.generate --season 2024 --round 21     # publishes to cdn.shadster.dev/f1-sim/
.venv/bin/python -m f1sim.catalog --season 2024                 # gallery catalog
```

### On-demand generation (selecting an ungenerated race in the app)

The Worker queues the job in the `SeasonJobs` Durable Object. Two executors are supported:

* **Agent mode (active).** Run one or more agents anywhere with outbound HTTPS:
  ```bash
  set -a; source ~/.config/shadster/r2.env; source ~/.config/f1sim/agent.env; set +a
  export R2_BUCKET=cdn R2_PREFIX=f1-sim
  .venv/bin/python -m f1sim.agent --api https://apex.shadster.dev/api     # add --once to drain & exit
  ```
  `F1SIM_AGENT_TOKEN` must match the Worker secret `AGENT_TOKEN`.
* **Container mode.** Requires the Cloudflare **Workers Paid** plan: uncomment `containers` in
  `worker/wrangler.jsonc`, set `GENERATOR_MODE` to `"container"`, add the R2 secrets
  (`R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) and deploy. The Workflow
  then drives `pipeline/Dockerfile` in a Cloudflare Container.

## Deploy

```bash
cd web && npx vite build && cd ../worker && npx wrangler deploy
```

`apex.shadster.dev` is a Worker custom domain (app + API); artifacts are served straight from R2 at `cdn.shadster.dev/f1-sim/`.

## Adding a circuit

Add an entry to `pipeline/f1sim/circuit/registry.py` (layout id, track width, DRS zones as corner-relative
specs, art-direction theme, optional manual registration anchors). Everything else is derived.

## License & credits

Code and original assets: [MIT](LICENSE). Data, attribution and trademark notes: [`NOTICE.md`](NOTICE.md).

Timing & telemetry: [FastF1](https://github.com/theOehrly/Fast-F1) (unofficial F1 live-timing data, non-commercial; no rights to it are claimed).
Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Terrain: Mapzen Terrain Tiles on AWS Open Data.
Unofficial project, not affiliated with Formula 1, the FIA or any team. F1 and FORMULA 1 are trademarks of Formula One Licensing B.V.;
liveries are colour schemes only and car geometry is original.
