/**
 * Wall-clock override for headless visual regression.
 *
 * Several per-frame effects (camera shake, tree sway, rain, asphalt ripples, cloud drift) are
 * driven by `state.clock.elapsedTime`, which is different on every run. That makes two renders
 * of the *same* build differ by ~1.6% of pixels, which is enough noise to hide a real material
 * change. Setting `globalThis.__f1t` to a fixed value pins all of them so `shotset.mjs` +
 * `pixdiff.mjs` measure the build rather than the clock.
 *
 * Unset in normal use -- falls back to real elapsed time.
 */
export function scriptTime(fallback: number): number {
  const t = (globalThis as { __f1t?: number }).__f1t
  return typeof t === 'number' ? t : fallback
}

/** True when a scripted clock is pinned (i.e. we're inside a headless capture). */
export function scripting(): boolean {
  return typeof (globalThis as { __f1t?: number }).__f1t === 'number'
}

/**
 * Fixed timestep while scripting. The camera rig eases with `1 - exp(-dt * k)`, so a
 * single long frame (dt clamped to 0.1) changes the convergence path and leaves a
 * different residual position each run -- which for a long lens moves most of the frame
 * (~49% of pixels on trackside). With a fixed step the residual is frame-count independent.
 */
export function scriptDt(raw: number, fixed = 1 / 60): number {
  return scripting() ? fixed : Math.min(0.1, raw)
}