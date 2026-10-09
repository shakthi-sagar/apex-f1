# Visual defect sweep — `viz-improvements`

Evidence-based sweep across the 11-mode camera matrix. Every entry below was produced
by a script in `web/scripts/` and is reproducible; false positives are recorded too,
because ruling those out is what makes the real findings trustworthy.

## Harness

| script | purpose |
|---|---|
| `shotset.mjs` | deterministic render matrix (clock paused, `window.__f1t` pinned) |
| `pixdiff.mjs` | per-view % changed pixels between two renders |
| `shaderscan.mjs` | dead shader writes (value overwritten before being read) |
| `blackcheck.mjs` | mean luminance + near-black share of the central viewport |
| `occlcheck.mjs` | line-of-sight raycast + burial probe per camera mode |
| `occlwho.mjs` | identifies the occluder with its ancestor chain and material |
| `occlsoak.mjs` | resamples a mode across N random seeds to measure failure rate |

Noise floor is **0.000%** (same build twice); positive control (asphalt base
`0.16 → 0.19`) is **20.493%**.

## Fixed

### D0 — TV / trackside cameras buried inside their own tower  *(fixed in 89ce169)*
Raycast from lens to subject hit `ts_dark` at **0.2 m**; the camera sat inside the
`camera-tower.glb` prop that `TracksideProps` places at the same XZ. With a 0.25 m near
plane it filled the frame → black. Towers now sit `TOWER_BACK = 4` m outward along the
track→camera vector. Nearest surface went **0.2 m → 3.48 m**.

## Open

### D1 — `orbit` / `free` can inherit a camera position buried in trackside geometry
- **Repro:** seek `t=1800`, camera mode `free` (or `orbit`) — `/tmp/sweep2/v-free.png`,
  `/tmp/sweep2/v-orbit.png`
- **Evidence:** `blackcheck` near-black share **37.4%** (`free`) / **31.7%** (`orbit`) vs
  ~3.6% on the grid. Screenshot shows large black polygons *in front of* visible car tags,
  i.e. the camera is embedded in geometry rather than the subject being hidden.
- **Root cause:** `CameraRig` only repositions the camera when
  `|target.position - orbitFollow| > 200`. On entry that delta is ≈0, so the camera keeps
  the previous mode's position — e.g. the 0.7 m cinematic dolly, which sits down among
  barriers and buildings. `free` has no follow logic at all, so it never recovers.
- **Note:** `views.mjs` cannot position `orbit`/`free` independently (they inherit the
  prior mode), so the automated matrix treats them as a shared sample. This is a harness
  limitation, not evidence that the modes are independently broken.

## Ruled out (false positives)

- **cinematic "100% occluded"** — `occlsoak` reports 12/12 blocked, but the occluder is
  `asphalt`/`track` ~4 m before the subject: a 0.7 m dolly camera *always* looks across
  the road. Screenshot confirms the car fully visible with kerb as deliberate foreground.
  Framing choice, not a defect. `occlcheck` now reports this separately and never fails on it.
- **cockpit "0.23 m burial"** — the cockpit camera is inside its own car by design; the
  probe was counting the car's halo/cockpit rim. Excluding `car-*` objects moved it to 5.07 m.
- **`roughnessFactor` overwrite** — flagged by `shaderscan`, but line 105 is
  `mix(roughnessFactor, …)`, a read-modify-write. Scanner now tracks reads; reports clean.
- **Heatmap overlay occluder** — `MeshBasicMaterial` white, flagged by raycast but
  `visible === false` (heatmap is off by default). THREE raycasts invisible geometry.

## Clean

- No dead shader writes: `shaderscan` reports none across `src/scene` and `src/camera`.
- No blank/black frames in the 9 script-driven modes at `t=30` or `t=1800`.
- `npx tsc --noEmit` clean; 60.5 fps, at the recorded baseline.