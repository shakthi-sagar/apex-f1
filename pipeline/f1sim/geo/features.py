"""Parse Overpass `out geom` JSON into local-frame line/area features."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .proj import LocalFrame

AREA_KEYS = {"building", "landuse", "leisure", "natural", "amenity", "water", "man_made", "area:highway", "aeroway"}
LINEAR_NATURAL = {"tree_row", "coastline", "ridge", "cliff"}


@dataclass
class Feature:
    id: int
    tags: dict
    kind: str  # "line" | "area" | "point"
    xy: np.ndarray  # (n,2) outer ring / line / point
    holes: list[np.ndarray] = field(default_factory=list)


def _ring(frame, geom):
    lat = np.array([g["lat"] for g in geom])
    lon = np.array([g["lon"] for g in geom])
    x, y = frame.to_local(lat, lon)
    return np.stack([x, y], axis=1)


def _is_area(tags, xy):
    closed = len(xy) >= 4 and np.allclose(xy[0], xy[-1])
    if not closed:
        return False
    if tags.get("area") == "yes":
        return True
    if tags.get("area") == "no" or "highway" in tags and "area:highway" not in tags:
        return False
    if tags.get("natural") in LINEAR_NATURAL or "barrier" in tags and len(tags) == 1:
        return False
    return any(k in tags for k in AREA_KEYS)


def _stitch(rings: list[np.ndarray]) -> list[np.ndarray]:
    """Join open member ways of a multipolygon into closed rings."""
    rings = [r for r in rings if len(r) >= 2]
    out, pending = [], [r for r in rings]
    while pending:
        cur = pending.pop(0)
        changed = True
        while not np.allclose(cur[0], cur[-1], atol=1e-3) and changed:
            changed = False
            for i, r in enumerate(pending):
                if np.allclose(cur[-1], r[0], atol=1e-3):
                    cur = np.vstack([cur, r[1:]])
                elif np.allclose(cur[-1], r[-1], atol=1e-3):
                    cur = np.vstack([cur, r[::-1][1:]])
                elif np.allclose(cur[0], r[-1], atol=1e-3):
                    cur = np.vstack([r, cur[1:]])
                elif np.allclose(cur[0], r[0], atol=1e-3):
                    cur = np.vstack([r[::-1], cur[1:]])
                else:
                    continue
                pending.pop(i)
                changed = True
                break
        if len(cur) >= 4:
            out.append(cur)
    return out


def parse(data: dict, frame: LocalFrame) -> list[Feature]:
    feats: list[Feature] = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        t = el["type"]
        if t == "node":
            x, y = frame.to_local(el["lat"], el["lon"])
            feats.append(Feature(el["id"], tags, "point", np.array([[x, y]], dtype=np.float64)))
        elif t == "way" and "geometry" in el:
            xy = _ring(frame, el["geometry"])
            feats.append(Feature(el["id"], tags, "area" if _is_area(tags, xy) else "line", xy))
        elif t == "relation":
            outers = [_ring(frame, m["geometry"]) for m in el.get("members", []) if m.get("role") == "outer" and "geometry" in m]
            inners = [_ring(frame, m["geometry"]) for m in el.get("members", []) if m.get("role") == "inner" and "geometry" in m]
            inner_rings = _stitch(inners)
            for ring in _stitch(outers):
                feats.append(Feature(el["id"], tags, "area", ring, holes=inner_rings))
    return feats


def densify(xy: np.ndarray, step: float) -> np.ndarray:
    seg = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    if cum[-1] == 0:
        return xy
    s = np.arange(0, cum[-1], step)
    return np.stack([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])], axis=1)
