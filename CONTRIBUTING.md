# Contributing

Thanks for helping. You never need the maintainer's keys: everything below runs on public data.

## Setup

See "Run it locally" in the [README](README.md). Before opening a PR:

```bash
npm run typecheck && npm run build
python -m pytest pipeline/tests
```

## What goes where

* **Renderer / UI (`web/`)** — develop against the public data (`npm run dev`); no pipeline run needed.
* **Pipeline (`pipeline/`)** — regenerate a race locally with `python -m f1sim.generate --year 2024 --race monza`
  and look at it in the app. CI also diffs sample races against `main` and shows the result on your PR.
* **Worker / workflows** — security-sensitive; see below.

## Never commit

Generated race/circuit files (`out/` is git-ignored — they are a rebuildable cache), FastF1 caches, API keys,
`.env*` files. Config the code needs lives in `worker/wrangler.jsonc` vars; secrets are set with `wrangler secret put`.

## Versioning rules (the PR must follow these)

| You changed… | Do this |
|---|---|
| race motion / timing / events output | bump `PIPELINE_VERSION` in `pipeline/f1sim/__init__.py` **and** `worker/wrangler.jsonc` |
| circuit, terrain, buildings, trees | bump `CIRCUIT_VERSION` in both places |
| the file format (anything the renderer parses) | bump `SCHEMA_VERSION` in `pipeline/f1sim/__init__.py`, `web/src/data/version.ts` and `worker/wrangler.jsonc`, and change renderer + pipeline **in this same PR** |

`pipeline/tests/test_versions.py` fails CI if the three places disagree. After a pipeline bump, a maintainer can run
the *Rebuild popular races* workflow; everything else rebuilds the first time someone opens it.

## Workflows and the Worker

Fork PRs run with a read-only token and no secrets (`pull_request`, never `pull_request_target`). Don't add steps that
need secrets to PR-triggered workflows. Changes under `.github/` and `worker/` need maintainer review (CODEOWNERS).

## Data & trademarks

Don't add F1 logos, team/sponsor artwork or official imagery. See [`NOTICE.md`](NOTICE.md).
