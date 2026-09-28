"""Season catalog for the race gallery: schedule, winner, circuit outline preview.

    python -m f1sim.catalog --season 2024 [--out ./out] [--no-upload]

Outlines come from each race's fastest lap (FastF1 position data), rotated by
the official circuit-map rotation and normalised to a 1000x1000 SVG viewBox.
"""

from __future__ import annotations

import argparse
import json
import logging
import os

import numpy as np

from . import binfmt
from .ingest.fastf1_source import enable_cache
from .liveries import team_id
from .storage import SHORT, Store

log = logging.getLogger("f1sim.catalog")


def _outline(session) -> tuple[str, float] | tuple[None, None]:
    try:
        lap = session.laps.pick_fastest()
        pos = lap.get_pos_data()
        xy = pos[["X", "Y"]].to_numpy(float)
        rot = np.radians(session.get_circuit_info().rotation)
    except Exception as e:
        log.warning("outline failed: %s", e)
        return None, None
    c, s = np.cos(rot), np.sin(rot)
    xy = xy @ np.array([[c, s], [-s, c]])
    xy -= xy.min(0)
    scale = 900 / xy.max()
    xy = xy * scale + (1000 - xy.max(0) * scale) / 2
    xy[:, 1] = 1000 - xy[:, 1]
    # light simplification
    keep = [0]
    for i in range(1, len(xy)):
        if np.linalg.norm(xy[i] - xy[keep[-1]]) > 6:
            keep.append(i)
    pts = xy[keep]
    d = "M" + " L".join(f"{x:.0f} {y:.0f}" for x, y in pts) + " Z"
    return d, None


def build(season: int, cache_root: str) -> dict:
    import fastf1

    enable_cache(os.path.join(cache_root, "fastf1"))
    sched = fastf1.get_event_schedule(season, include_testing=False)
    races = []
    for _, ev in sched.iterrows():
        rnd = int(ev["RoundNumber"])
        entry = {
            "season": season,
            "round": rnd,
            "name": str(ev["EventName"]),
            "officialName": str(ev.get("OfficialEventName") or ev["EventName"]),
            "location": str(ev["Location"]),
            "country": str(ev["Country"]),
            "date": str(ev["EventDate"].date()),
            "format": str(ev.get("EventFormat", "")),
        }
        try:
            s = fastf1.get_session(season, rnd, "R")
            s.load(laps=True, telemetry=True, weather=False, messages=False)
            res = s.results.sort_values("Position")
            w = res.iloc[0]
            entry["winner"] = {"code": str(w["Abbreviation"]), "name": f"{w['FirstName']} {w['LastName']}",
                               "team": str(w["TeamName"]), "teamId": team_id(str(w["TeamName"])),
                               "color": "#" + str(w["TeamColor"] or "888888")}
            entry["podium"] = [str(x) for x in res["Abbreviation"].iloc[:3]]
            entry["laps"] = int(s.total_laps or 0)
            info = s.session_info
            entry["circuit"] = {"key": int(info["Meeting"]["Circuit"]["Key"]),
                                "short": str(info["Meeting"]["Circuit"]["ShortName"])}
            d, _ = _outline(s)
            entry["outline"] = d
            entry["startUtc"] = str(s.t0_date)
        except Exception as e:
            log.warning("round %d unavailable: %s", rnd, e)
            entry["unavailable"] = True
        races.append(entry)
        log.info("catalog %d/%d %s", rnd, len(sched), entry["name"])
    return {"season": season, "races": races}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-upload", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("fastf1").setLevel(logging.ERROR)
    cache_root = os.environ.get("F1SIM_CACHE", os.path.expanduser("~/.cache/f1sim"))
    cat = build(a.season, cache_root)
    store = Store(local_root=a.out, upload=not a.no_upload)
    store.put(f"catalog/{a.season}.json", binfmt.gz_json(cat), "application/json", gzip=True, cache=SHORT)
    print(json.dumps({"races": len(cat["races"])}))


if __name__ == "__main__":
    main()
