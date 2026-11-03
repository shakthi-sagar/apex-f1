# Running your own deployment

The project is discontinued (see [`DISCONTINUED.md`](../DISCONTINUED.md)); this is the short version for forkers.

## Data availability

Since ~15 Oct 2026 `livetiming.formula1.com/static/<year>/…` returns **401** to anonymous requests
([FastF1 #978](https://github.com/theOehrly/Fast-F1/issues/978)). A race only generates if FastF1 can get its data:
from a **warm FastF1 cache**, or with an authenticated session (FastF1 ≥ 3.9 and an F1 TV token — check F1 TV's terms
and note the maintainers report it fails from cloud IPs). Alternatively write a new source for
`pipeline/f1sim/ingest/` (e.g. OpenF1). Do not publish raw archives.

## Generator modes (`GENERATOR_MODE` in `worker/wrangler.jsonc`)

| Mode | Runs where | Needs |
|---|---|---|
| `agent` (default) | any machine: `python -m f1sim.agent --api https://<host>/api` | `F1SIM_AGENT_TOKEN` = Worker `AGENT_TOKEN`, R2 env vars |
| `container` | Cloudflare Container (Workers Paid) | R2 secrets on the Worker |

## Secrets

Never commit them. Worker secrets: `npx wrangler secret put AGENT_TOKEN` . Generator
credentials come from the environment only: `R2_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`R2_BUCKET`, `R2_PREFIX`. Keep local copies in `.secrets/` or `*.env` (git-ignored). Use a **dedicated R2 bucket** with a
token scoped to it (R2 has no write-only token).

## Versions

`SCHEMA_VERSION` (format), `PIPELINE_VERSION` (race telemetry) and `CIRCUIT_VERSION` (circuit + environment) live in
`pipeline/f1sim/__init__.py` and must match `worker/wrangler.jsonc` vars (and `web/src/data/version.ts` for the schema);
`python -m pytest pipeline/tests` checks that.

* Lower pipeline/circuit version → the race is **stale**: served immediately, rebuilt in the background
  (one attempt per race per hour).
* Different schema → the manifest counts as missing and regenerates before it is served.
* A circuit rebuild reuses the telemetry bundle if the line geometry (`lineHash`) is unchanged.

The Worker limits `generate` requests to 6/min/IP via the `GEN_LIMITER` rate-limit binding and only accepts races
present in the season catalog.

## Deploy

```bash
npm run deploy      # builds the web app and runs wrangler deploy
```
