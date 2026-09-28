"""Race event detection -> a time-ordered, typed event timeline.

Every event: {id, type, t, t_end?, lap?, drivers[], s?, importance 0..1, title, detail, data{}}
`importance` feeds the browser's race director.
"""

from __future__ import annotations

import re

import numpy as np

from ..ingest.fastf1_source import RawRace
from .motion import FLAG_PIT, Motion, race_window
from .timing import Timing

TRACK_STATUS = {
    "2": ("yellow", "Yellow flag", 0.35),
    "4": ("safety_car", "Safety Car deployed", 0.9),
    "5": ("red_flag", "Red flag", 1.0),
    "6": ("vsc", "Virtual Safety Car", 0.7),
    "7": ("vsc_ending", "VSC ending", 0.4),
}


def detect(raw: RawRace, motion: Motion, timing: Timing, lap_length: float, corners: list[dict]) -> list[dict]:
    ev: list[dict] = []
    t_start, race_start, t_end = race_window(raw)
    drivers = timing.drivers
    code = {k: raw.drivers[k].code for k in drivers}
    tg = timing.t0 + np.arange(timing.n) * timing.step

    def lap_at(t):
        leader_laps = [l for l in raw.laps if l["start"] is not None and l["start"] <= t]
        return max((l["lap"] for l in leader_laps), default=0)

    def corner_near(s):
        if not corners:
            return None
        s = s % lap_length
        best = min(corners, key=lambda c: min(abs(c["s"] - s), lap_length - abs(c["s"] - s)))
        dist = min(abs(best["s"] - s), lap_length - abs(best["s"] - s))
        return best["label"] if dist < 180 else None

    # ---- race start / restarts / finish ---------------------------------------------------
    starts = [s["t"] for s in raw.session_status if s["status"] == "Started"]
    for i, t in enumerate(starts):
        ev.append(dict(type="race_start" if i == 0 else "restart", t=t, importance=1.0,
                       title="Lights out" if i == 0 else "Race restart",
                       detail="" if i == 0 else "Standing restart after the red flag"))
    winner = next((k for k, d in raw.drivers.items() if d.position == 1), None)
    if winner:
        wl = max((l for l in raw.laps if l["driver"] == winner and l["end"]), key=lambda l: l["lap"])
        ev.append(dict(type="finish", t=wl["end"], importance=1.0, drivers=[winner],
                       title=f"Chequered flag — {code.get(winner, winner)} wins", lap=wl["lap"]))

    # ---- track status periods --------------------------------------------------------------
    ts = raw.track_status
    for i, s in enumerate(ts):
        if s["status"] not in TRACK_STATUS:
            continue
        kind, title, imp = TRACK_STATUS[s["status"]]
        t_end_s = ts[i + 1]["t"] if i + 1 < len(ts) else t_end
        if kind == "yellow" and t_end_s - s["t"] < 3:
            continue
        ev.append(dict(type=kind, t=s["t"], t_end=t_end_s, importance=imp, title=title,
                       detail=f"{t_end_s - s['t']:.0f}s", lap=lap_at(s["t"])))

    # ---- pit stops -------------------------------------------------------------------------
    laps_by: dict[str, list] = {}
    for l in raw.laps:
        laps_by.setdefault(l["driver"], []).append(l)
    for k, laps in laps_by.items():
        laps.sort(key=lambda l: l["lap"])
        for i, l in enumerate(laps):
            if l["pit_in"] is None or i + 1 >= len(laps):
                continue
            nxt = laps[i + 1]
            if nxt["pit_out"] is None:
                continue
            lane_time = nxt["pit_out"] - l["pit_in"]
            if lane_time > 200:  # red flag: pit lane parking, not a pit stop
                continue
            stationary = None
            if k in motion.speed:
                a = int((l["pit_in"] - motion.t0) / (motion.t[1] - motion.t[0]))
                b = int((nxt["pit_out"] - motion.t0) / (motion.t[1] - motion.t[0]))
                sp = motion.speed[k][max(a, 0) : max(b, 0)]
                if len(sp):
                    stationary = float((sp < 1).sum() * (motion.t[1] - motion.t[0]))
            ev.append(dict(type="pit_stop", t=l["pit_in"], t_end=nxt["pit_out"], drivers=[k], lap=l["lap"],
                           importance=0.55,
                           title=f"{code.get(k, k)} pits",
                           detail=f"{l['compound'] or '?'} → {nxt['compound'] or '?'} · lane {lane_time:.1f}s"
                                  + (f" · stop {stationary:.1f}s" if stationary else ""),
                           data={"from": l["compound"], "to": nxt["compound"], "lane_time": lane_time,
                                 "stationary": stationary}))

    # ---- overtakes / lead changes (continuous order) -----------------------------------------
    pos = timing.position.astype(int)
    m, n = pos.shape
    pit = np.zeros((m, n), bool)
    for r, k in enumerate(drivers):
        f = motion.flags[k][:: int(round(timing.step / (motion.t[1] - motion.t[0])))][:n]
        pit[r, : len(f)] = (f & FLAG_PIT) > 0
    # neutralised periods (SC/VSC/red): no overtakes counted
    neutral = np.zeros(n, bool)
    for i, s in enumerate(ts):
        if s["status"] in ("4", "5", "6", "7"):
            t1 = ts[i + 1]["t"] if i + 1 < len(ts) else t_end
            neutral |= (tg >= s["t"]) & (tg < t1 + 20)
    HOLD = int(6 / timing.step)  # a swap must persist 6 s
    last_pass = {}
    for r in range(m):
        for q in range(m):
            if r == q:
                continue
            ahead = pos[r] < pos[q]  # r ahead of q
            valid = (pos[r] > 0) & (pos[q] > 0) & (tg > race_start + 5)
            flips = np.where(valid[1:] & valid[:-1] & ahead[1:] & ~ahead[:-1])[0] + 1
            for i in flips:
                if i + HOLD >= n or i - HOLD < 0 or not ahead[i : i + HOLD].all() or ahead[i - HOLD : i].any():
                    continue
                # exclude pit-lane related swaps & neutralised periods
                win = slice(max(0, i - 20), min(n, i + 20))
                if pit[r, win].any() or pit[q, win].any() or neutral[i]:
                    continue
                # both must be physically close (real on-track pass, not a retirement)
                prog_gap = abs(timing.progress[r, i] - timing.progress[q, i])
                if prog_gap > 60:
                    continue
                key = (r, q)
                if key in last_pass and tg[i] - last_pass[key] < 20:
                    continue
                last_pass[key] = tg[i]
                new_pos = int(pos[r, i])
                s_here = float(timing.progress[r, i])
                where = corner_near(s_here)
                lead = new_pos == 1
                imp = 0.95 if lead else float(np.clip(0.85 - 0.025 * (new_pos - 1), 0.45, 0.85))
                ev.append(dict(type="lead_change" if lead else "overtake", t=float(tg[i]), drivers=[drivers[r], drivers[q]],
                               importance=imp, lap=int(timing.lap[r, i]), s=s_here % lap_length,
                               title=(f"{code[drivers[r]]} takes the lead from {code[drivers[q]]}" if lead
                                      else f"{code[drivers[r]]} passes {code[drivers[q]]} for P{new_pos}"),
                               detail=f"Turn {where}" if where else "",
                               data={"position": new_pos}))

    # ---- battles (sustained interval < 1.0 s) -------------------------------------------------
    iv = timing.interval
    for r in range(m):
        close = (iv[r] < 1.0) & (pos[r] > 1) & ~neutral & (tg > race_start + 20) & ~pit[r]
        # hysteresis via run detection
        i = 0
        while i < n:
            if close[i]:
                j = i
                while j + 1 < n and (close[j + 1] or (j + 6 < n and close[j + 1 : j + 6].any())):
                    j += 1
                dur = (j - i) * timing.step
                if dur >= 25:
                    seg = slice(i, j + 1)
                    p_mode = int(np.bincount(pos[r, seg]).argmax())
                    ahead_rows = [q for q in range(m) if np.bincount(pos[q, seg], minlength=p_mode).argmax() == p_mode - 1] if p_mode > 1 else []
                    front = drivers[ahead_rows[0]] if ahead_rows else None
                    imp = float(np.clip(0.75 - 0.02 * p_mode + min(dur, 300) / 1500, 0.35, 0.9))
                    ev.append(dict(type="battle", t=float(tg[i]), t_end=float(tg[j]), importance=imp,
                                   drivers=[drivers[r]] + ([front] if front else []),
                                   lap=int(timing.lap[r, i]),
                                   title=f"Battle for P{p_mode - 1}: {code[front]} vs {code[drivers[r]]}" if front
                                   else f"{code[drivers[r]]} closing in",
                                   detail=f"{dur:.0f}s within 1.0s · min {np.nanmin(iv[r, seg]):.2f}s",
                                   data={"min_interval": float(np.nanmin(iv[r, seg])), "position": p_mode - 1}))
                i = j + 1
            else:
                i += 1

    # merge fragmented battles between the same pair
    battles = [e for e in ev if e["type"] == "battle"]
    ev = [e for e in ev if e["type"] != "battle"]
    battles.sort(key=lambda e: (tuple(e["drivers"]), e["t"]))
    merged = []
    for e in battles:
        if len(e["drivers"]) < 2:
            continue
        if merged and merged[-1]["drivers"] == e["drivers"] and e["t"] - merged[-1]["t_end"] < 45:
            prev = merged[-1]
            prev["t_end"] = e["t_end"]
            prev["data"]["min_interval"] = min(prev["data"]["min_interval"], e["data"]["min_interval"])
            dur = prev["t_end"] - prev["t"]
            prev["detail"] = f"{dur:.0f}s within 1.0s · min {prev['data']['min_interval']:.2f}s"
            prev["importance"] = max(prev["importance"], e["importance"])
        else:
            merged.append(e)
    ev += merged

    # ---- fastest lap progression ---------------------------------------------------------------
    best = np.inf
    for l in sorted((l for l in raw.laps if l["time"] and l["end"] and not l["deleted"]), key=lambda l: l["end"]):
        if l["time"] < best - 1e-6:
            improve = best - l["time"]
            best = l["time"]
            if l["lap"] > 1:
                ev.append(dict(type="fastest_lap", t=l["end"], drivers=[l["driver"]], lap=l["lap"],
                               importance=0.45 if improve < 0.3 else 0.55,
                               title=f"Fastest lap — {code.get(l['driver'], l['driver'])}",
                               detail=_fmt_lap(l["time"]), data={"time": l["time"]}))

    # ---- retirements -----------------------------------------------------------------------------
    for k, d in raw.drivers.items():
        if d.status in ("Finished",) or d.status.startswith("+") or k not in laps_by:
            continue
        laps = [l for l in laps_by[k] if l["end"]]
        if not laps:
            continue
        t = max(l["end"] for l in laps)
        if k in motion.flags:
            st = np.where((motion.flags[k] & 4) > 0)[0]
            if len(st):
                t = float(motion.t[st[0]])
        ev.append(dict(type="retirement", t=t, drivers=[k], importance=0.8, lap=max(l["lap"] for l in laps),
                       title=f"{d.code} out of the race", detail=d.status))

    # ---- incidents from race control ----------------------------------------------------------------
    for rc in raw.race_control:
        msg = rc["message"]
        if rc["t"] < t_start or rc["t"] > t_end:
            continue
        cars = re.findall(r"CAR (\d+)", msg) + re.findall(r"CARS ([\d ,()A-Z]+?) (?:NOTED|UNDER|WILL|REVIEWED)", msg)
        nums = sorted(set(re.findall(r"\b(\d{1,2}) \(", msg)) | set(re.findall(r"CAR (\d+)", msg)))
        if "INCIDENT" in msg and "NOTED" in msg:
            ev.append(dict(type="incident", t=rc["t"], drivers=nums, importance=0.6, title="Incident noted",
                           detail=msg.title(), lap=rc["lap"]))
        elif "PENALTY" in msg and "FIA STEWARDS" in msg:
            ev.append(dict(type="penalty", t=rc["t"], drivers=nums, importance=0.4, title="Penalty",
                           detail=msg.replace("FIA STEWARDS: ", "").title(), lap=rc["lap"]))
        elif msg.startswith("DRS ENABLED") or msg.startswith("DRS DISABLED"):
            ev.append(dict(type="drs", t=rc["t"], importance=0.2, title=msg.title(), lap=rc["lap"]))
        del cars

    # ---- weather transitions ----------------------------------------------------------------------
    wx = raw.weather
    if wx:
        rain = np.array([w["rain"] for w in wx], float)
        tw = np.array([w["t"] for w in wx])
        sm = np.convolve(rain, np.ones(5) / 5, mode="same") > 0.5
        for i in range(1, len(sm)):
            if sm[i] != sm[i - 1] and t_start <= tw[i] <= t_end:
                ev.append(dict(type="weather", t=float(tw[i]), importance=0.5,
                               title="Rain begins" if sm[i] else "Rain stops", lap=lap_at(tw[i]),
                               detail=f"Track {wx[i]['track']:.0f}°C · air {wx[i]['air']:.0f}°C · humidity {wx[i]['humidity']:.0f}%"))

    # finalise
    ev = [e for e in ev if t_start - 1 <= e["t"] <= t_end + 1]
    ev.sort(key=lambda e: (e["t"], -e["importance"]))
    for i, e in enumerate(ev):
        e["id"] = i
        e.setdefault("drivers", [])
        e.setdefault("detail", "")
        e["t"] = round(float(e["t"]), 3)
        if "t_end" in e:
            e["t_end"] = round(float(e["t_end"]), 3)
        e["importance"] = round(float(e["importance"]), 3)
        if e.get("lap") is not None:
            e["lap"] = int(e["lap"])
    return ev


def _fmt_lap(t):
    m = int(t // 60)
    return f"{m}:{t - 60 * m:06.3f}"
