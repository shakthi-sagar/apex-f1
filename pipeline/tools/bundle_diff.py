"""Markdown diff of two generation output dirs, for pipeline PRs.

    python tools/bundle_diff.py BASE_DIR HEAD_DIR [--season 2024 --round 22 ...]

Raw JSON diffs of float arrays are noise, so this compares what a reviewer cares about: counts, event types,
lap table, file sizes and numeric deltas of the fused motion (s, v, d) and timing. `generatedAt` is ignored
(it makes bundle hashes differ between identical runs).
"""

from __future__ import annotations

import argparse
import collections
import glob
import gzip
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from f1sim import binfmt  # noqa: E402


def _bundle(root: str, season: int, rnd: int) -> tuple[str, dict] | None:
    mp = os.path.join(root, f"races/{season}/{rnd:02d}/manifest.json")
    if not os.path.exists(mp):
        return None
    m = json.load(open(mp))
    return os.path.join(root, m["bundle"]), m


def _json(path: str):
    raw = open(path, "rb").read()
    return json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)


def _arrays(path: str) -> dict:
    return binfmt.unpack(open(path, "rb").read())[1]


def _rows(title: str, rows: list[tuple[str, object, object]]) -> list[str]:
    out = [f"**{title}**", "", "| | base | head |", "|---|---|---|"]
    for k, a, b in rows:
        out.append(f"| {k}{' ⚠️' if a != b else ''} | {a} | {b} |")
    return out + [""]


def diff_race(base: str, head: str, season: int, rnd: int) -> list[str]:
    out = [f"### {season} round {rnd}", ""]
    b, h = _bundle(base, season, rnd), _bundle(head, season, rnd)
    if not h:
        return out + ["head produced no bundle ❌", ""]
    if not b:
        return out + ["base produced no bundle (new race)", ""]
    (bd, bm), (hd, hm) = b, h
    rb, rh = _json(os.path.join(bd, "race.json")), _json(os.path.join(hd, "race.json"))
    ev = lambda r: dict(collections.Counter(e["type"] for e in r["events"]))  # noqa: E731
    out += _rows("Summary", [
        ("pipelineVersion", bm["pipelineVersion"], hm["pipelineVersion"]),
        ("lineHash", bm.get("lineHash"), hm.get("lineHash")),
        ("bundle bytes", bm["bytes"], hm["bytes"]),
        ("drivers", len(rb["drivers"]), len(rh["drivers"])),
        ("events", len(rb["events"]), len(rh["events"])),
        ("winner", rb["drivers"][0]["code"], rh["drivers"][0]["code"]),
    ])
    et_b, et_h = ev(rb), ev(rh)
    delta = {k: (et_b.get(k, 0), et_h.get(k, 0)) for k in sorted(set(et_b) | set(et_h)) if et_b.get(k, 0) != et_h.get(k, 0)}
    if delta:
        out += ["Event types changed (base → head): " + ", ".join(f"`{k}` {a}→{b}" for k, (a, b) in delta.items()), ""]
    lb, lh = json.dumps(rb["laps"], sort_keys=True), json.dumps(rh["laps"], sort_keys=True)
    out += [f"Lap table: {'identical' if lb == lh else 'CHANGED ⚠️'}", ""]

    # fused motion deltas
    worst = {"s": 0.0, "v": 0.0, "d": 0.0}
    rms = {"s": [], "v": [], "d": []}
    files = sorted(glob.glob(os.path.join(hd, "motion-*.bin")))
    for f in files:
        bf = os.path.join(bd, os.path.basename(f))
        if not os.path.exists(bf):
            out += [f"`{os.path.basename(f)}` only in head ⚠️", ""]
            continue
        ab, ah = _arrays(bf), _arrays(f)
        for key in ah:
            q = key.rsplit("/", 1)[-1]
            if q in worst and key in ab and ab[key].shape == ah[key].shape:
                diff = ah[key].astype(float) - ab[key].astype(float)
                worst[q] = max(worst[q], float(np.abs(diff).max()))
                rms[q].append(float(np.sqrt(np.mean(diff**2))))
    unit = {"s": "m", "v": "cm/s", "d": "cm"}
    out += ["Motion delta (head − base)", "", "| signal | RMS | max abs |", "|---|---|---|"]
    for q in ("s", "v", "d"):
        out.append(f"| {q} | {np.mean(rms[q]) if rms[q] else 0:.3f} {unit[q]} | {worst[q]:.3f} {unit[q]} |")
    out.append("")
    try:
        tb, th = _arrays(os.path.join(bd, rb["timing"]["file"])), _arrays(os.path.join(hd, rh["timing"]["file"]))
        same = float(np.mean(tb["position"] == th["position"])) if tb["position"].shape == th["position"].shape else 0.0
        out += [f"Race order identical in {same * 100:.2f}% of timing samples", ""]
    except Exception as e:  # noqa: BLE001
        out += [f"timing comparison failed: {e}", ""]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("head")
    ap.add_argument("--race", action="append", default=[], help="season:round, repeatable (default: all in head)")
    a = ap.parse_args()
    races = [tuple(map(int, r.split(":"))) for r in a.race]
    if not races:
        for p in sorted(glob.glob(os.path.join(a.head, "races/*/*/manifest.json"))):
            races.append((int(p.split("/")[-3]), int(p.split("/")[-2])))
    print("## Pipeline output diff (head vs base)\n")
    for season, rnd in races:
        print("\n".join(diff_race(a.base, a.head, season, rnd)))


if __name__ == "__main__":
    main()
