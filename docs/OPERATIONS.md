# Operations

How to run your own deployment, where each secret lives, and the repo settings that keep it safe.

## Data availability

Since ~15 Oct 2026 `livetiming.formula1.com/static/<year>/…` returns **401** to anonymous requests
([FastF1 #978](https://github.com/theOehrly/Fast-F1/issues/978)). Consequences for this project:

* A race only generates if FastF1 can get its data: from a **warm FastF1 cache**, or with an authenticated session
  (FastF1 ≥ 3.9 supports an F1 TV token; the maintainers report it is not reliable from cloud IPs, and F1 TV terms
  restrict sharing/automated use — check them before putting a token in CI).
* GitHub-hosted runners therefore cannot generate *new* races anonymously. The generate workflow is ready, but it
  will report `failed` for races whose data it cannot fetch. Already-generated races keep being served.
* FastF1 will not rehost the data, and neither should this project: do not publish raw archives.

Decide how new races get generated (an authenticated self-hosted runner/agent, or an alternative source) before
promising that "anyone can open any race".

## Generator modes (`GENERATOR_MODE` in `worker/wrangler.jsonc`)

| Mode | Runs where | Needs |
|---|---|---|
| `github` (default) | `.github/workflows/generate.yml`, started by the Worker via the Actions API | Worker secret `GITHUB_DISPATCH_TOKEN`; GitHub secrets below |
| `agent` | any machine: `python -m f1sim.agent --api https://<host>/api` | `F1SIM_AGENT_TOKEN` = Worker `AGENT_TOKEN` |
| `container` | Cloudflare Container (Workers Paid) | R2 secrets on the Worker |

## Secrets map

| Secret | Where it lives | Set with |
|---|---|---|
| `GITHUB_DISPATCH_TOKEN` | Worker | `npx wrangler secret put GITHUB_DISPATCH_TOKEN` |
| `AGENT_TOKEN` | Worker | `npx wrangler secret put AGENT_TOKEN` |
| `F1SIM_AGENT_TOKEN` (same value as `AGENT_TOKEN`) | GitHub environment `production` | `gh secret set F1SIM_AGENT_TOKEN --env production` |
| `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | GitHub environment `production` | `gh secret set … --env production` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub environment `production` (deploy only) | `gh secret set … --env production` |
| local keys | `.secrets/` or `*.env` (git-ignored) | — |

Non-secret settings go in GitHub environment **variables**: `F1SIM_API` (`https://<host>/api`), `R2_BUCKET`, `R2_PREFIX`.

### Token scopes

* **GitHub token (Worker):** fine-grained personal access token, *only this repository*, single permission
  **Actions: Read and write** (that is what `workflow_dispatch` needs; it grants no code access). Give it an expiry.
* **R2 token:** scoped to **one bucket**. R2 has no write-only mode (object read/write is the narrowest that can
  upload), so use a **dedicated bucket** rather than a shared one, so a leaked token can only touch generated data.
* The Worker's `AGENT_TOKEN` can only report job progress; it cannot read or write R2.

## Repo settings (do these once)

```bash
# environment holding the secrets; deployments only from main
gh api -X PUT repos/OWNER/REPO/environments/production
gh api -X PUT repos/OWNER/REPO/environments/production \
  -f 'deployment_branch_policy[protected_branches]=false' -f 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/OWNER/REPO/environments/production/deployment-branch-policies -f name=main

# branch protection on main: PR + review + passing CI
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["web-worker", "pipeline"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "require_code_owner_reviews": true },
  "restrictions": null }
JSON
```

Also: *Settings → Actions → General → Fork pull request workflows → Require approval for all outside collaborators*,
and keep default workflow permissions at read-only. No workflow uses `pull_request_target`.

## Staleness behaviour

* `pipelineVersion`/`circuitVersion` lower than the Worker's vars → the race is **stale**: served immediately, rebuilt in
  the background (at most one attempt per race per hour, so a failing build cannot loop).
* `schemaVersion` different → the manifest is treated as missing; the race regenerates before it is served.
* After a **schema** bump, run *Rebuild popular races* **before** deploying the renderer if you do not want first visitors to wait.
* Limits: 6 generate requests / minute / IP (Workers rate-limit binding) and `DAILY_DISPATCH_CAP` dispatches per day.

## Per-PR preview data (not built yet)

Design: previews upload to a **separate staging bucket** with staging-only credentials (never production), keyed
by PR number and expiring after ~14 days; the preview Worker reads staging first and falls back to production.
Because versions are in the manifest, a PR that bumps the pipeline rebuilds only its sample races. On merge a job
copies the tested objects to production instead of rebuilding.
