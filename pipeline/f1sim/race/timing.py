"""Continuous race order, gap-to-leader and interval from reconstructed progress.

Gap of car i to reference car j at time t = t - T_j(s_i(t)), where T_j is the
inverse of j's cumulative distance (time at which j was where i is now). This
is the classic "time-at-distance" gap used by broadcast graphics.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..ingest.fastf1_source import RawRace
from .motion import DT, Motion, race_window

TIMING_HZ = 2


@dataclass
class Timing:
    t0: float
    n: int
    step: float
    drivers: list[str]
    position: np.ndarray  # (m, n) uint8, 0 = not classified/running
    gap: np.ndarray  # (m, n) float seconds to leader (NaN n/a)
    interval: np.ndarray  # (m, n) float seconds to car ahead
    laps_down: np.ndarray  # (m, n) uint8
    lap: np.ndarray  # (m, n) current lap (1-based, 0 before start)
    progress: np.ndarray  # (m, n) cumulative distance


def compute(raw: RawRace, motion: Motion, lap_length: float) -> Timing:
    _, race_start, _ = race_window(raw)
    stride = int(round(1 / (DT * TIMING_HZ)))
    drivers = list(motion.s.keys())
    tg = motion.t[::stride]
    n = len(tg)
    m = len(drivers)
    S = np.stack([motion.s[k][::stride] for k in drivers])
    F = np.stack([motion.flags[k][::stride] for k in drivers])
    t_full = motion.t

    S = np.nan_to_num(S, nan=-1e9)
    # last classified moment per driver: retired cars drop to the back after their last lap
    last_lap_end = {}
    laps_by = {}
    for l in raw.laps:
        laps_by.setdefault(l["driver"], []).append(l)
        if l["end"] is not None:
            last_lap_end[l["driver"]] = max(last_lap_end.get(l["driver"], 0), l["end"])
    finished = {k for k, d in raw.drivers.items() if d.status in ("Finished",) or d.status.startswith("+")}

    # progress for ordering, anchored to the official lap table so drift (pit lane, red flag
    # parking) can never accumulate: P = (lap-1)*L + distance travelled since that lap's line crossing
    fin_t = [x["t"] for x in raw.session_status if x["status"] == "Finished"]
    chequer = fin_t[-1] if fin_t else np.inf
    P = np.full_like(S, np.nan)
    alive = np.zeros_like(S, dtype=bool)
    lap_idx = np.zeros((m, n), np.int32)
    for r, k in enumerate(drivers):
        laps = sorted((l for l in laps_by.get(k, []) if l["start"] is not None), key=lambda l: l["lap"])
        s_full = motion.s[k]
        for l in laps:
            sel = tg >= l["start"]
            lap_idx[r, sel] = l["lap"]
        x = np.mod(S[r], lap_length)  # physical distance past the timing line
        for li, l in enumerate(laps):
            sel = lap_idx[r] == l["lap"]
            if not sel.any():
                continue
            t_end_l = l["end"] if l["end"] is not None else (laps[li + 1]["start"] if li + 1 < len(laps) else l["start"] + 120)
            frac = np.clip((tg[sel] - l["start"]) / max(1.0, t_end_l - l["start"]), 0, 1)
            expect = frac * lap_length
            xs = x[sel]
            cand = np.stack([xs - lap_length, xs, xs + lap_length])
            pick = np.argmin(np.abs(cand - expect[None, :]), axis=0)
            P[r, sel] = (l["lap"] - 1) * lap_length + cand[pick, np.arange(len(xs))]
        # pit-lane starters are behind the whole field until they leave the pit lane
        fl = motion.flags[k][::stride][:n]
        i_start = int(np.searchsorted(tg, race_start))
        if i_start < len(fl) and fl[i_start] & 2:
            out = np.where((np.arange(len(fl)) > i_start) & ((fl & 2) == 0))[0]
            j_end = out[0] if len(out) else n
            P[r, i_start:j_end] -= lap_length
        end = last_lap_end.get(k, race_start)
        alive[r] = (tg >= race_start) & (tg <= end + 2) & np.isfinite(P[r])
        if k in finished:
            alive[r] |= (tg > end) & (tg >= race_start)
        # freeze after the last timed lap (retired: drops back; finished: classified order below)
        last = np.where(tg <= end)[0]
        if len(last):
            P[r, last[-1] + 1 :] = P[r, last[-1]]
    Pn = np.nan_to_num(P, nan=-1e9)
    retired = ~alive & (tg[None, :] > race_start)
    key = Pn - retired * 1e8
    # after the chequered flag, drivers that took it rank by classification
    cls_pos = np.array([raw.drivers[k].position or 99 for k in drivers], float)
    for r, k in enumerate(drivers):
        if k in finished:
            done = tg >= last_lap_end.get(k, np.inf) - 0.01
            done &= tg >= chequer - 1
            key[r, done] = 1e12 - cls_pos[r] * 1e6
    # red flag: official order from the lap table is frozen
    red = np.zeros(n, bool)
    for i, x in enumerate(raw.track_status):
        if x["status"] == "5":
            t1 = raw.track_status[i + 1]["t"] if i + 1 < len(raw.track_status) else np.inf
            red |= (tg >= x["t"]) & (tg < t1)
    if red.any():
        for r, k in enumerate(drivers):
            laps = sorted((l for l in laps_by.get(k, []) if l["start"] is not None and l["position"]), key=lambda l: l["lap"])
            if laps:
                t_red = tg[red][0]
                done = [l for l in laps if l["start"] <= t_red]
                pos_r = done[-1]["position"] if done else 99
                key[r, red] = 1e10 - pos_r * 1e6 if alive[r, red].any() else key[r, red]
    order = np.argsort(-key, axis=0)  # (m, n) row index of car at each position
    position = np.zeros((m, n), np.uint8)
    rows = np.arange(n)
    for p in range(m):
        position[order[p], rows] = p + 1
    # before the start: official grid order
    grid = {k: raw.drivers[k].grid or 99 for k in drivers}
    pre = tg < race_start
    if pre.any():
        g_order = sorted(range(m), key=lambda r: grid[drivers[r]] if grid[drivers[r]] else 99)
        for p, r in enumerate(g_order):
            position[r, pre] = p + 1

    # rebase each car's physical cumulative distance onto lap-anchored progress (whole laps only):
    # pit-lane starters begin past the timing line and would otherwise read ~1 lap ahead
    shift = np.zeros(m)
    for r in range(m):
        ok = alive[r] & np.isfinite(S[r]) & (S[r] > -1e8)
        if ok.sum() > 10:
            shift[r] = np.round(np.median(Pn[r, ok] - S[r, ok]) / lap_length) * lap_length
    S = S + shift[:, None]
    # inverse distance functions T_j(s) on the full-rate data
    inv = []
    for r_, k in enumerate(drivers):
        s = np.nan_to_num(motion.s[k] + shift[r_], nan=-1e9)
        s = np.maximum.accumulate(s)
        inv.append((s, t_full))

    # T[j][i] = time at which car j reached car i's current progress
    gap = np.full((m, n), np.nan)
    interval = np.full((m, n), np.nan)
    laps_down = np.zeros((m, n), np.uint8)
    Tji = np.empty((m, m, n))
    for j in range(m):
        sj, tj = inv[j]
        valid = sj > -1e8
        if valid.sum() < 2:
            Tji[j] = np.nan
            continue
        Tji[j] = np.interp(S, sj[valid], tj[valid], left=np.nan, right=np.nan)
    leader = order[0]
    for p in range(m):
        r = order[p, rows]
        g = tg - Tji[leader, r, rows]
        gap[r, rows] = np.where(p == 0, 0.0, g)
        if p > 0:
            ahead = order[p - 1, rows]
            interval[r, rows] = tg - Tji[ahead, r, rows]
        laps_down[r, rows] = np.clip(np.floor((Pn[leader, rows] - Pn[r, rows]) / lap_length), 0, 255)
    gap[~alive] = np.nan
    interval[~alive] = np.nan
    gap[:, pre] = np.nan
    interval[:, pre] = np.nan

    # lap number from the lap table (authoritative)
    lap = np.zeros((m, n), np.uint8)
    lap[:] = np.clip(lap_idx, 0, 255)
    lap[:, pre] = 0
    return Timing(t0=float(tg[0]), n=n, step=1 / TIMING_HZ, drivers=drivers, position=position, gap=gap,
                  interval=interval, laps_down=laps_down, lap=lap, progress=Pn)
