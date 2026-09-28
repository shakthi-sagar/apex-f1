"""Circuit reconstruction from the aggregate of every car position in the race.

Inputs are positions already registered into the local ENU frame. Outputs are
purely geometric (no FastF1 types):

  reference line  closed 1 m polyline: robust median racing line of all green laps
  edges           left/right track edge offsets from the lateral usage envelope
  pit lane        offset curve relative to the reference line + garage boxes
  start line      s = 0 at the timing line
  corners/sectors/DRS zones/kerbs  as arc-length ranges
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
from scipy.interpolate import splev, splprep
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, minimum_filter1d

from ..ingest.fastf1_source import RawRace
from .path import ClosedPath, circular_smooth, refine_path_from_cloud, resample_closed

log = logging.getLogger(__name__)
DS = 1.0  # reference line resolution (m)


@dataclass
class Circuit:
    path: ClosedPath
    left: np.ndarray  # (n,) left edge offset (m, positive)
    right: np.ndarray  # (n,) right edge offset (m, negative)
    pit: dict
    garages: list[dict]
    corners: list[dict]
    sectors: list[float]
    marshal_sectors: list[float]
    drs_zones: list[list[float]]
    kerbs: list[dict]
    curvature: np.ndarray
    extra: dict = field(default_factory=dict)


def _green_laps(raw: RawRace):
    for l in raw.laps:
        if l["time"] is None or l["start"] is None or l["end"] is None:
            continue
        if l["pit_in"] is not None or l["pit_out"] is not None or l["lap"] == 1:
            continue
        if l["track_status"] and set(l["track_status"]) - {"1", "2"}:
            continue
        yield l


def _circular_median(s: np.ndarray, L: float) -> float:
    ang = s / L * 2 * np.pi
    m = np.arctan2(np.median(np.sin(ang)), np.median(np.cos(ang)))
    return float((m / (2 * np.pi) * L) % L)


def build_circuit(raw: RawRace, enu: dict[str, np.ndarray], cfg: dict) -> Circuit:
    """enu: driver -> (n,3) positions in local metres (aligned with raw.drivers[d].pos_t)."""
    green = list(_green_laps(raw))
    # --- seed from the fastest few green laps (time ordered => direction of travel) -----
    fastest = sorted(green, key=lambda l: l["time"])[:5]
    seeds = []
    for l in fastest:
        d = raw.drivers[l["driver"]]
        m = (d.pos_t >= l["start"]) & (d.pos_t <= l["end"]) & d.pos_ok
        pts = enu[l["driver"]][m]
        if len(pts) > 100:
            seeds.append(pts)
    seed = seeds[0]
    tck, _ = splprep([seed[:, 0], seed[:, 1], seed[:, 2]], s=len(seed) * 4.0, per=1)
    u = np.linspace(0, 1, 6000, endpoint=False)
    dense = np.stack(splev(u, tck), axis=1)
    path = ClosedPath(resample_closed(dense, DS), DS)

    # --- dense cloud of every green-lap sample -----------------------------------------
    cloud = []
    for l in green:
        d = raw.drivers[l["driver"]]
        m = (d.pos_t >= l["start"]) & (d.pos_t <= l["end"]) & d.pos_ok
        cloud.append(enu[l["driver"]][m])
    cloud = np.vstack(cloud)
    log.info("reference cloud: %d samples from %d green laps", len(cloud), len(green))
    path = refine_path_from_cloud(path, cloud, iterations=5)

    # --- start/finish: where lap boundaries project -----------------------------------
    cross = []
    for l in green:
        d = raw.drivers[l["driver"]]
        ok = d.pos_ok
        if not ok.any():
            continue
        p = np.array([np.interp(l["end"], d.pos_t[ok], enu[l["driver"]][ok, i]) for i in range(2)])
        cross.append(p)
    s_cross, _, dist = path.project_nearest(np.array(cross), max_dist=30)
    s0 = _circular_median(s_cross[np.isfinite(dist)], path.length)
    i0 = int(round(s0 / DS)) % path.n
    path = ClosedPath(np.roll(path.pts, -i0, axis=0), DS)
    log.info("reference line length %.1f m (start line at original s=%.1f)", path.length, s0)

    # --- track edges from lateral envelope (all laps incl. racing incidents) -------------
    s_all, d_all, dist = path.project_nearest(cloud[:, :2], max_dist=16)
    ok = np.isfinite(dist)
    s_all, d_all = s_all[ok], d_all[ok]
    nb = int(np.ceil(path.length / 4.0))
    b = np.minimum((s_all / 4.0).astype(int), nb - 1)
    lo = np.full(nb, np.nan)
    hi = np.full(nb, np.nan)
    order = np.argsort(b, kind="stable")
    cnt = np.bincount(b, minlength=nb)
    st = np.concatenate([[0], np.cumsum(cnt)])
    for i in range(nb):
        v = d_all[order[st[i] : st[i + 1]]]
        if len(v) > 20:
            lo[i], hi[i] = np.quantile(v, [0.003, 0.997])
    for arr in (lo, hi):
        bad = np.isnan(arr)
        xs = np.arange(nb)
        arr[bad] = np.interp(xs[bad], xs[~bad], arr[~bad], period=nb)
    spread = float(np.median(hi - lo))
    bs = (np.arange(nb) + 0.5) * 4.0
    if spread < 3.0:
        # Map-matched source (all cars on one line): width comes from the registry;
        # straights (low curvature over a long window) get the wider straight width.
        curv = np.abs(path.curvature(30.0))
        straight = circular_smooth((curv < 1 / 600).astype(float), 40 / DS) > 0.9
        w = np.where(straight, cfg["straight_width"], cfg["track_width"])
        w = circular_smooth(w, 25 / DS)
        left, right = w / 2, -w / 2
        width_source = "registry"
    else:
        CAR_HALF, margin = 1.0, 0.6
        lo = circular_smooth(minimum_filter1d(lo - CAR_HALF - margin, 9, mode="wrap"), 4)
        hi = circular_smooth(maximum_filter1d(hi + CAR_HALF + margin, 9, mode="wrap"), 4)
        width = circular_smooth(np.clip(hi - lo, 11.0, 20.0), 6)
        center = circular_smooth((hi + lo) / 2, 6)
        left = np.interp(path.s, bs, center + width / 2, period=path.length)
        right = np.interp(path.s, bs, center - width / 2, period=path.length)
        width_source = "telemetry-envelope"
    log.info("lateral spread %.2f m -> width from %s", spread, width_source)

    # --- pit lane + garages -----------------------------------------------------------------
    pit, garages = _build_pit(raw, enu, path, left, right)

    # --- corners, sectors, DRS --------------------------------------------------------------
    corners = []
    corners_xy = raw.extra.get("corners_enu")
    if corners_xy is not None and len(corners_xy):
        cs, cd, _ = path.project_nearest(corners_xy)
        for c, s, d in zip(raw.corners, cs, cd):
            corners.append({"number": c["number"], "letter": c["letter"], "s": float(s),
                            "side": "left" if d > 0 else "right", "label": f"{c['number']}{c['letter']}"})
    msec = []
    if raw.extra.get("marshal_enu") is not None:
        ms, _, _ = path.project_nearest(raw.extra["marshal_enu"])
        msec = sorted(float(x) for x in ms)

    sectors = _sector_boundaries(raw, enu, path)
    drs_zones = _drs_zones(raw, enu, path)
    drs_source = "telemetry"
    if not drs_zones and cfg.get("drs"):
        from .registry import resolve_arc

        for a, b in cfg["drs"]:
            sa, sb = resolve_arc(a, corners, path.length), resolve_arc(b, corners, path.length)
            if sa is not None and sb is not None:
                drs_zones.append([sa, sb if sb > sa else sb + path.length])
        drs_source = "registry"
    curv = path.curvature(8.0)
    kerbs = _kerbs(path, curv, left, right)
    return Circuit(path=path, left=left, right=right, pit=pit, garages=garages, corners=corners, sectors=sectors,
                   marshal_sectors=msec, drs_zones=drs_zones, kerbs=kerbs, curvature=curv,
                   extra={"width_source": width_source, "drs_source": drs_source})


def _build_pit(raw, enu, path: ClosedPath, left, right):
    L = path.length
    transits = []
    stops = []
    by_driver: dict[str, list] = {}
    for l in raw.laps:
        by_driver.setdefault(l["driver"], []).append(l)
    for drv, laps in by_driver.items():
        laps.sort(key=lambda l: l["lap"])
        d = raw.drivers.get(drv)
        if d is None:
            continue
        for i, l in enumerate(laps):
            if l["pit_in"] is None:
                continue
            nxt = laps[i + 1] if i + 1 < len(laps) else None
            if nxt is None or nxt["pit_out"] is None:
                continue
            t0, t1 = l["pit_in"] - 12, nxt["pit_out"] + 12
            if t1 - t0 > 150:  # red-flag parking etc. — not a clean transit
                continue
            m = (d.pos_t >= t0) & (d.pos_t <= t1) & d.pos_ok
            if m.sum() < 10:
                continue
            xy = enu[drv][m, :2]
            t = d.pos_t[m]
            sp = np.interp(t, d.car_t, d.speed) / 3.6
            s, dd = path.project_sequence(t, xy, sp, radius=150)
            good = np.isfinite(s)
            transits.append((np.mod(s[good], L), dd[good]))
            # stationary point = garage box
            v = np.interp(t, d.car_t, d.speed)
            still = v < 1.0
            if still.sum() >= 2:
                p = xy[still].mean(0)
                stops.append({"driver": drv, "team": d.team, "xy": p})
    if not transits:
        return {"available": False}, []
    s_all = np.concatenate([t[0] for t in transits])
    d_all = np.concatenate([t[1] for t in transits])
    nb = int(np.ceil(L / 2.0))
    b = np.minimum((s_all / 2.0).astype(int), nb - 1)
    med = np.full(nb, np.nan)
    cov = np.bincount(b, minlength=nb)
    order = np.argsort(b, kind="stable")
    st = np.concatenate([[0], np.cumsum(cov)])
    for i in range(nb):
        if cov[i] >= max(3, len(transits) // 4):
            med[i] = np.median(d_all[order[st[i] : st[i + 1]]])
    bs = (np.arange(nb) + 0.5) * 2.0
    lft = np.interp(bs, path.s, left, period=L)
    rgt = np.interp(bs, path.s, right, period=L)
    off = np.isfinite(med) & ((med > lft + 1.0) | (med < rgt - 1.0))
    if off.sum() < 20:
        return {"available": False}, []
    # the pit lane is the longest circular run of "off track" bins (allowing small gaps)
    off_f = maximum_filter1d(off.astype(np.uint8), 15, mode="wrap") > 0
    idx = np.where(off_f)[0]
    runs, start = [], idx[0]
    for a, bnext in zip(idx, np.append(idx[1:], idx[0] + nb)):
        if bnext != a + 1:
            runs.append((start, a))
            start = bnext % nb
    # merge wrap-around run
    if len(runs) > 1 and runs[0][0] == 0 and runs[-1][1] == nb - 1:
        runs[0] = (runs[-1][0] - nb, runs[0][1])
        runs.pop()
    r0, r1 = max(runs, key=lambda r: r[1] - r[0])
    # extend towards the merge points while coverage persists (lane converges to track edge)
    ii = np.arange(r0 - 40, r1 + 41)
    vals = med[np.mod(ii, nb)]
    valid = np.isfinite(vals)
    k0 = np.argmax(valid)
    k1 = len(valid) - 1 - np.argmax(valid[::-1])
    ii, vals = ii[k0 : k1 + 1], vals[k0 : k1 + 1]
    bad = np.isnan(vals)
    if bad.any():
        vals[bad] = np.interp(np.where(bad)[0], np.where(~bad)[0], vals[~bad])
    vals = gaussian_filter1d(vals, 2.5, mode="nearest")
    s_seq = (ii + 0.5) * 2.0
    side = float(np.sign(np.median(vals)))
    pts = path.point_at(s_seq, vals)
    garages = []
    for sp in stops:
        gs, gd, _ = path.project_nearest(sp["xy"][None, :])
        garages.append({"driver": sp["driver"], "team": sp["team"], "s": float(gs[0]), "d": float(gd[0])})
    # one box per team (median)
    teams: dict[str, list] = {}
    for g in garages:
        teams.setdefault(g["team"], []).append(g)
    boxes = []
    for team, gs in teams.items():
        s = _circular_median(np.array([g["s"] for g in gs]), L)
        d = float(np.median([g["d"] for g in gs]))
        boxes.append({"team": team, "s": s, "d": d})
    log.info("pit lane: s %.0f -> %.0f (%.0f m), side=%s, %d team boxes", s_seq[0] % L, s_seq[-1] % L,
             s_seq[-1] - s_seq[0], "left" if side > 0 else "right", len(boxes))
    return {
        "available": True,
        "s_start": float(s_seq[0]),
        "s_end": float(s_seq[-1]),
        "side": "left" if side > 0 else "right",
        "s": s_seq,
        "d": vals,
        "pts": pts,
        "width": 11.0,
    }, boxes


def _sector_boundaries(raw, enu, path):
    out = []
    for key in ("s1_end", "s2_end"):
        pts = []
        for l in _green_laps(raw):
            t = l[key]
            d = raw.drivers[l["driver"]]
            if t is None or not d.pos_ok.any():
                continue
            ok = d.pos_ok
            pts.append([np.interp(t, d.pos_t[ok], enu[l["driver"]][ok, i]) for i in range(2)])
        if pts:
            s, _, dist = path.project_nearest(np.array(pts), max_dist=30)
            out.append(_circular_median(s[np.isfinite(dist)], path.length))
    return out


def _drs_zones(raw, enu, path):
    """Arc ranges where DRS is open in the majority of green laps (codes >= 10)."""
    L = path.length
    nb = int(np.ceil(L / 5.0))
    open_cnt = np.zeros(nb)
    tot = np.zeros(nb)
    for l in _green_laps(raw):
        d = raw.drivers[l["driver"]]
        m = (d.pos_t >= l["start"]) & (d.pos_t <= l["end"]) & d.pos_ok
        if m.sum() < 50:
            continue
        s, _, dist = path.project_nearest(enu[l["driver"]][m, :2], max_dist=20)
        drs = np.interp(d.pos_t[m], d.car_t, d.drs) >= 10
        ok = np.isfinite(dist)
        b = np.minimum((s[ok] / 5.0).astype(int), nb - 1)
        np.add.at(tot, b, 1)
        np.add.at(open_cnt, b, drs[ok])
    frac = np.where(tot > 0, open_cnt / np.maximum(tot, 1), 0)
    on = frac > 0.12  # DRS availability is rare in a wet race; any consistent usage marks a zone
    zones = []
    i = 0
    while i < nb:
        if on[i]:
            j = i
            while j + 1 < nb and on[j + 1]:
                j += 1
            if (j - i) * 5 > 150:
                zones.append([i * 5.0, (j + 1) * 5.0])
            i = j + 1
        else:
            i += 1
    return zones


def _kerbs(path: ClosedPath, curv, left, right):
    """Kerbs on the inside of corners (apex) and outside at exit, from curvature."""
    k = np.abs(curv)
    thr = 1 / 180.0  # radius < 180 m
    on = k > thr
    kerbs = []
    n = path.n
    i = 0
    visited = np.zeros(n, bool)
    while i < n:
        if on[i] and not visited[i]:
            j = i
            while on[(j + 1) % n] and (j + 1) - i < n:
                j += 1
            visited[i : j + 1] = True
            s0, s1 = path.s[i], path.s[j % n] + (path.length if j >= n else 0)
            sign = np.sign(np.median(curv[np.arange(i, j + 1) % n]))
            inside = "left" if sign > 0 else "right"
            outside = "right" if inside == "left" else "left"
            if s1 - s0 > 12:
                kerbs.append({"s0": float(s0 - 6), "s1": float(s1 + 4), "side": inside, "type": "apex"})
                exit_len = min(60.0, 0.5 * (s1 - s0) + 20)
                kerbs.append({"s0": float(s1 - 0.4 * (s1 - s0)), "s1": float(s1 + exit_len), "side": outside, "type": "exit"})
            i = j + 1
        else:
            i += 1
    return kerbs
