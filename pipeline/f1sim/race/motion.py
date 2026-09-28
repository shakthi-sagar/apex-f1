"""Per-car motion reconstruction on a uniform time grid.

RAW (measured):
  - arc position s(t)      FastF1 X/Y projected onto the reference line
  - speed, rpm, gear, throttle, brake, DRS   FastF1 car data
  - pit-lane lateral offset (pit lane is a separate line in the source)

DERIVED (visual reconstruction, flagged as such in the bundle):
  - s(t) is fused with measured speed by a constant-acceleration Kalman/RTS
    smoother so interpolation never shows jumps.
  - lateral offset on track: FastF1 positions are map-matched to one line, so
    the lateral position is a derived minimum-curvature racing line plus
    collision-free "lanes" when cars run side by side.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d

from ..circuit.build import Circuit
from ..ingest.fastf1_source import RawDriver, RawRace

log = logging.getLogger(__name__)

HZ = 4
DT = 1.0 / HZ

FLAG_VISIBLE = 1
FLAG_PIT = 2
FLAG_STOPPED = 4  # retired / stationary out of the pit lane
FLAG_INTERP = 8  # sample bridged over a data gap


@dataclass
class Motion:
    t0: float
    n: int
    s: dict[str, np.ndarray]  # cumulative arc length (m)
    v: dict[str, np.ndarray]  # smoothed speed (m/s)
    d: dict[str, np.ndarray]  # lateral offset (m) final (derived on track, measured in pit)
    d_meas: dict[str, np.ndarray]
    speed: dict[str, np.ndarray]  # km/h raw
    rpm: dict[str, np.ndarray]
    gear: dict[str, np.ndarray]
    throttle: dict[str, np.ndarray]
    brake: dict[str, np.ndarray]
    drs: dict[str, np.ndarray]
    flags: dict[str, np.ndarray]

    @property
    def t(self):
        return self.t0 + np.arange(self.n) * DT


def race_window(raw: RawRace) -> tuple[float, float, float]:
    started = [s["t"] for s in raw.session_status if s["status"] == "Started"]
    race_start = started[0] if started else min(l["start"] for l in raw.laps if l["lap"] == 1 and l["start"])
    finished = [s["t"] for s in raw.session_status if s["status"] == "Finished"]
    last_lap = max(l["end"] for l in raw.laps if l["end"])
    end = min(last_lap, finished[-1] + 120) if finished else last_lap
    return race_start - 150.0, race_start, end


def _kalman_rts(z_s, z_v, dt, sig_s=1.2, sig_v=0.6, sig_a=9.0):
    """Constant-velocity model with acceleration noise; measurements of s and v (NaN = missing)."""
    n = len(z_s)
    F = np.array([[1, dt], [0, 1]])
    G = np.array([[0.5 * dt * dt], [dt]])
    Q = G @ G.T * sig_a**2
    xs = np.zeros((n, 2))
    Ps = np.zeros((n, 2, 2))
    xp = np.zeros((n, 2))
    Pp = np.zeros((n, 2, 2))
    first = np.where(np.isfinite(z_s))[0]
    if len(first) == 0:
        return np.full(n, np.nan), np.full(n, np.nan)
    x = np.array([z_s[first[0]], z_v[first[0]] if np.isfinite(z_v[first[0]]) else 0.0])
    P = np.diag([25.0, 25.0])
    Rs, Rv = sig_s**2, sig_v**2
    for k in range(n):
        if k > 0:
            x = F @ x
            P = F @ P @ F.T + Q
        xp[k], Pp[k] = x, P
        if np.isfinite(z_s[k]):
            y = z_s[k] - x[0]
            if abs(y) > 150:  # re-acquire after a long gap
                x = np.array([z_s[k], x[1]])
                P = np.diag([25.0, P[1, 1]])
            else:
                S = P[0, 0] + Rs
                K = P[:, 0] / S
                x = x + K * y
                P = P - np.outer(K, P[0, :])
        if np.isfinite(z_v[k]):
            y = z_v[k] - x[1]
            S = P[1, 1] + Rv
            K = P[:, 1] / S
            x = x + K * y
            P = P - np.outer(K, P[1, :])
        xs[k], Ps[k] = x, P
    # RTS smoother
    for k in range(n - 2, -1, -1):
        C = Ps[k] @ F.T @ np.linalg.inv(Pp[k + 1])
        xs[k] = xs[k] + C @ (xs[k + 1] - xp[k + 1])
        Ps[k] = Ps[k] + C @ (Ps[k + 1] - Pp[k + 1]) @ C.T
    return xs[:, 0], xs[:, 1]


def _interp_gappy(t_grid, t, y, max_gap=1.5):
    out = np.interp(t_grid, t, y, left=np.nan, right=np.nan)
    idx = np.searchsorted(t, t_grid)
    idx = np.clip(idx, 1, len(t) - 1)
    gap = t[idx] - t[idx - 1]
    out[gap > max_gap] = np.nan
    return out


def reconstruct(raw: RawRace, enu: dict[str, np.ndarray], circ: Circuit, racing_line: np.ndarray) -> Motion:
    t_start, race_start, t_end = race_window(raw)
    n = int(np.ceil((t_end - t_start) * HZ)) + 1
    tg = t_start + np.arange(n) * DT
    L = circ.path.length
    out = {k: {} for k in ("s", "v", "d", "d_meas", "speed", "rpm", "gear", "throttle", "brake", "drs", "flags")}
    for num, drv in raw.drivers.items():
        m = drv.pos_ok & (drv.pos_t >= t_start - 30) & (drv.pos_t <= t_end + 30)
        if m.sum() < 20:
            log.info("driver %s (%s): no on-track data in window; skipped", num, drv.code)
            continue
        t = drv.pos_t[m]
        xy = enu[num][m, :2]
        sp = np.interp(t, drv.car_t, drv.speed) / 3.6
        # start near the grid: first sample may be behind the line -> negative cumulative distance
        s_seq, d_seq = circ.path.project_sequence(t, xy, sp, radius=150)
        first = s_seq[np.isfinite(s_seq)][0]
        if first > L / 2 and t[0] < race_start:
            s_seq -= L
        z_s = _interp_gappy(tg, t, s_seq)
        d_meas = _interp_gappy(tg, t, d_seq)
        speed = np.interp(tg, drv.car_t, drv.speed, left=np.nan, right=np.nan)
        z_v = speed / 3.6
        vis = np.isfinite(z_s)
        s_f, v_f = _kalman_rts(z_s, np.where(vis, z_v, np.nan), DT)
        # keep monotonic-ish (cars never reverse meaningfully): clamp tiny negative velocity noise
        v_f = np.maximum(v_f, 0)
        d_meas = np.where(np.isfinite(d_meas), d_meas, 0.0)
        d_meas = gaussian_filter1d(d_meas, 1.2)

        flags = np.where(vis, FLAG_VISIBLE, 0).astype(np.uint8)
        in_pit = np.abs(d_meas) > 2.5
        flags |= np.where(in_pit, FLAG_PIT, 0).astype(np.uint8)

        # stationary outside pit for long -> stopped/retired
        stopped = (np.nan_to_num(speed) < 2) & ~in_pit & (tg > race_start + 30)
        run = gaussian_filter1d(stopped.astype(float), 20) > 0.95
        flags |= np.where(run, FLAG_STOPPED, 0).astype(np.uint8)

        out["s"][num] = s_f
        out["v"][num] = v_f
        out["d_meas"][num] = d_meas
        out["speed"][num] = np.nan_to_num(speed)
        out["rpm"][num] = np.nan_to_num(np.interp(tg, drv.car_t, drv.rpm, left=0, right=0))
        out["gear"][num] = np.interp(tg, drv.car_t, drv.gear, left=0, right=0).round()
        thr = np.interp(tg, drv.car_t, np.clip(drv.throttle, 0, 100), left=0, right=0)
        out["throttle"][num] = thr
        out["brake"][num] = np.interp(tg, drv.car_t, drv.brake.astype(float), left=0, right=0)
        out["drs"][num] = np.interp(tg, drv.car_t, drv.drs, left=0, right=0).round()
        out["flags"][num] = flags

    _derive_lateral(out, circ, racing_line, tg)
    _grid_formation(out, raw, circ, tg, race_start)
    return Motion(t0=float(t_start), n=n, **out)


def _derive_lateral(out, circ: Circuit, racing_line: np.ndarray, tg: np.ndarray):
    """Racing line + side-by-side lanes. Purely visual, labelled 'derived'."""
    L = circ.path.length
    drivers = list(out["s"].keys())
    S = np.stack([out["s"][k] for k in drivers])  # (m, n)
    F = np.stack([out["flags"][k] for k in drivers])
    m, n = S.shape
    ds = circ.path.ds
    idx = lambda s: (np.mod(s, L) / ds).astype(int) % circ.path.n  # noqa: E731
    base = racing_line[idx(np.nan_to_num(S))]
    lane = np.zeros_like(S)
    half = np.stack([circ.left[idx(np.nan_to_num(S))], -circ.right[idx(np.nan_to_num(S))]])  # (2,m,n)
    # side preference: inside of the next corner (attackers dive up the inside)
    curv = circ.curvature
    look = np.round(np.arange(40, 200, 10) / ds).astype(int)
    ahead = np.stack([curv[(idx(np.nan_to_num(S)) + k) % circ.path.n] for k in look]).sum(0)
    active = (F & FLAG_VISIBLE).astype(bool) & ~(F & FLAG_PIT).astype(bool)
    SEP = 2.6  # m centre-to-centre required when overlapping
    for k in range(n):
        a = np.where(active[:, k] & np.isfinite(S[:, k]))[0]
        if len(a) < 2:
            continue
        sm = np.mod(S[a, k], L)
        order = np.argsort(sm)
        a, sm = a[order], sm[order]
        # neighbours along track (circular)
        gaps = np.diff(np.append(sm, sm[0] + L))
        for i in np.where(gaps < 9.0)[0]:
            j = (i + 1) % len(a)
            behind, front = a[i], a[j]
            if abs(S[behind, k] - S[front, k]) > L / 2:  # lapped car in other lap: still physically overlapping
                pass
            side = 1.0 if ahead[behind, k] >= 0 else -1.0
            overlap = 1 - gaps[i] / 9.0
            lane[behind, k] += side * SEP * 0.5 * (0.4 + 0.6 * overlap)
            lane[front, k] -= side * SEP * 0.5 * (0.4 + 0.6 * overlap)
    lane = gaussian_filter1d(lane, 4.0, axis=1)  # ~1 s smoothing in time
    d = np.clip(base + lane, -half[1] + 1.1, half[0] - 1.1)
    for r, key in enumerate(drivers):
        dm = out["d_meas"][key]
        w = np.clip((np.abs(dm) - 0.8) / 2.0, 0, 1)  # blend into the measured pit-lane offset
        out["d"][key] = w * dm + (1 - w) * d[r]


def _grid_formation(out, raw: RawRace, circ: Circuit, tg: np.ndarray, race_start: float):
    """Staggered 2-wide grid (derived): pole on the inside of turn 1, alternating sides."""
    t1 = circ.corners[0]["s"] if circ.corners else 300.0
    i1 = int(t1 / circ.path.ds) % circ.path.n
    pole_side = 1.0 if circ.curvature[max(0, i1 - 30) : i1 + 30].sum() > 0 else -1.0
    w = np.clip((tg - (race_start - 75)) / 25, 0, 1) * np.clip((race_start + 7 - tg) / 7, 0, 1)
    w = w * w * (3 - 2 * w)
    starters = sorted((k for k in out["s"] if raw.drivers[k].grid), key=lambda k: raw.drivers[k].grid)
    for slot, k in enumerate(starters):
        if out["flags"][k][int(np.searchsorted(tg, race_start))] & FLAG_PIT:
            continue  # pit lane starter
        side = pole_side if slot % 2 == 0 else -pole_side
        half = circ.left[0] if side > 0 else -circ.right[0]
        target = side * min(3.2, half - 1.6)
        out["d"][k] = (1 - w) * out["d"][k] + w * target


def min_curvature_line(circ: Circuit, margin: float = 1.4, iters: int = 400) -> np.ndarray:
    """Approximate minimum-curvature racing line as lateral offsets within track bounds.

    Iterative Laplacian smoothing of the path offset with box constraints — a
    well-known approximation that yields outside-inside-outside lines."""
    p = circ.path
    lo = p_right = circ.right + margin
    hi = circ.left - margin
    off = np.zeros(p.n)
    base = p.pts[:, :2]
    nrm = p.nrm
    for it in range(iters):
        pts = base + nrm * off[:, None]
        lap = 0.5 * (np.roll(pts, 1, 0) + np.roll(pts, -1, 0)) - pts
        # use a wider stencil for faster convergence
        lap2 = 0.5 * (np.roll(pts, 8, 0) + np.roll(pts, -8, 0)) - pts
        step = np.einsum("ij,ij->i", 0.3 * lap + 0.7 * lap2 / 8.0, nrm)
        off = np.clip(off + 1.6 * step, lo, hi)
    del p_right
    return gaussian_filter1d(off, 4.0, mode="wrap")
