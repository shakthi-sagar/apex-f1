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

### D1 — `orbit` / `free` inherited a buried camera position  *(fixed)*
- **Repro (before):** seek `t=1800`, camera mode `free` — large black polygons across
  the viewport, near-black **37.4%** (`free`) / **31.7%** (`orbit`).
- **Cause:** `CameraRig` only repositions when `|target - orbitFollow| > 200`. On entry
  that delta is ~0, so the camera kept the previous shot's position — here the 0.7 m
  cinematic dolly sitting down among barriers and buildings. `free` has no follow logic
  at all, so it never recovered.
- **Fix:** on entry to `orbit`/`free`, cast six rays from the lens (car meshes excluded);
  if any hits within 2 m the lens is embedded, so fall back to a three-quarter framing at
  `target + (14, 8, 14)`.
- **After:** near-black **37.4% → 18.7%** (`free`), **31.7% → 21.6%** (`orbit`), and
  `/tmp/after/v-free.png` shows the car in clear view rather than black polygons. The
  lower mean luminance is the car's own dark bodywork filling frame, not missing geometry.
- **Regression:** full 11-mode sweep at `t=1800` shows no new blank/black frames; fps
  60.5 (baseline).

### D2 — `cinematic` camera buried inside the street-circuit wall
- **Repro (before):** race 2024/18 (marina_bay), `t=600`, camera `cinematic` —
  `/tmp/mb/v-cinematic.png` showed a flat blue wall panel filling the frame, car invisible.
- **Cause:** the dolly sat `0.7 m` above the road and `3.5 m` outside the **track edge**
  (`c.left`/`c.right`), ignoring the barrier. Interlagos has runoff there; Marina Bay has a
  barrier within a metre or two of the edge, so the lens ended up inside it (nearest
  surface **0.33 m**).
- **Fix:** on circuits flagged `meta.street`, sit outside `barrierLeft/Right` (+6 m) and
  raise to 5 m. Non-street circuits keep the low dolly unchanged.
- **After:** `occlcheck` on marina_bay reports **no camera buried in geometry**;
  `cinematic` dropped out of the flagged list. Interlagos `cinematic` unchanged
  (35.5% near-black before and after).

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
- **Catch fence on street circuits** — `tv`/`trackside` report `track` blocking ~12 m
  before the subject on marina_bay. `occlwho` identifies it as the fence:
  `opacity 0.55, transparent: true`, `color 9aa0a6`. Semi-transparent, so not a real
  occluder; `occlcheck` should treat low-opacity surfaces as foreground, not blockage.

## Clean

- No dead shader writes: `shaderscan` reports none across `src/scene` and `src/camera`.
- No blank/black frames in the 9 script-driven modes at `t=30` or `t=1800`; `orbit` and
  `free` clean after the D1 fix.
- No camera buried in geometry across all 11 modes (`occlcheck`, threshold 1.5 m).
- `npx tsc --noEmit` clean; 60.5 fps, at the recorded baseline.

## Still open — needs a human decision

The six speculative material/lighting changes on this branch are all *live* (pixel-diff
confirms each alters the frame) but none has human sign-off. PostFX and Atmosphere
account for ~92% of the aggregate change. See the audit table in the branch history;
they cannot be resolved without someone judging the images.