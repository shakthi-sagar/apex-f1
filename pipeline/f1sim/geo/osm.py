"""OpenStreetMap / Overpass access with aggressive caching.

Overpass is queried at most once per circuit (per query hash). The raw response
is cached locally and in R2 (circuits/{id}/osm/{hash}.json.gz) by the caller so
public Overpass instances are never hit when a race is simply opened.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import time

import requests

log = logging.getLogger(__name__)

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "f1sim-pipeline/0.1 (race visualisation; one query per circuit, cached)"

_WAY_KEYS = ["building", "highway", "landuse", "leisure", "natural", "waterway", "man_made", "barrier", "amenity",
             "railway", "aeroway", "surface", "area:highway"]
_REL_KEYS = ["building", "landuse", "leisure", "natural", "water", "amenity"]


def build_query(lat: float, lon: float, radius_m: int) -> str:
    a = f"(around:{radius_m},{lat:.6f},{lon:.6f})"
    parts = [f'way["{k}"]{a};' for k in _WAY_KEYS]
    parts += [f'relation["type"="multipolygon"]["{k}"]{a};' for k in _REL_KEYS]
    parts += [f'node["natural"="tree"]{a};', f'node["man_made"~"mast|tower|flagpole"]{a};']
    return f"[out:json][timeout:180];({''.join(parts)});out geom qt;"


def _bbox_filter(bbox) -> str:
    s, w, n, e = bbox
    return f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"


def _tile_queries(bb: tuple, group: str) -> str:
    f = _bbox_filter(bb)
    if group == "building":
        return f'[out:json][timeout:170];(way["building"]{f};relation["type"="multipolygon"]["building"]{f};);out geom qt;'
    parts = [f'way["{k}"]{f};' for k in _WAY_KEYS if k != "building"]
    parts += [f'relation["type"="multipolygon"]["{k}"]{f};' for k in _REL_KEYS if k != "building"]
    parts += [f'node["natural"="tree"]{f};']
    return f"[out:json][timeout:170];({''.join(parts)});out geom qt;"


def fetch_area(lat: float, lon: float, radius_m: int, cache_dir: str, remote_get=None, remote_put=None, tiles: int = 2) -> dict:
    """Fetch all features for a circuit area: a small raceway query, then feature groups per bbox tile.
    Tiles that keep failing (dense cities on busy public servers) are split into 4 recursively."""
    import math

    seen, elements = set(), []
    missing: list = []

    def add(data):
        for el in data.get("elements", []):
            key = (el["type"], el["id"])
            if key not in seen:
                seen.add(key)
                elements.append(el)

    try:
        add(fetch(f'[out:json][timeout:120];(way["highway"="raceway"](around:{radius_m + 500},{lat:.6f},{lon:.6f}););out geom qt;',
                  cache_dir, remote_get, remote_put))
    except RuntimeError as e:  # registration falls back to anchors/defaults
        log.warning("raceway query failed (%s); continuing without it", e)
        missing.append("raceway")
    dlat = radius_m / 111_320.0
    dlon = radius_m / (111_320.0 * math.cos(math.radians(lat)))
    s0, w0 = lat - dlat, lon - dlon

    def tile(bb, group, depth):
        try:
            add(fetch(_tile_queries(bb, group), cache_dir, remote_get, remote_put, attempts=2 if depth < 2 else 6))
        except RuntimeError as e:
            if depth >= 2:
                # OSM is enrichment only: never fail a race over it — build with partial scenery
                log.warning("OSM tile %s (%s) unavailable after retries (%s); skipping", bb, group, e)
                missing.append((bb, group))
                return
            s_, w_, n_, e_ = bb
            ms, mw = (s_ + n_) / 2, (w_ + e_) / 2
            log.info("splitting OSM tile %s (%s)", bb, group)
            for sub in ((s_, w_, ms, mw), (s_, mw, ms, e_), (ms, w_, n_, mw), (ms, mw, n_, e_)):
                tile(sub, group, depth + 1)

    for i in range(tiles):
        for j in range(tiles):
            bb = (s0 + 2 * dlat * i / tiles, w0 + 2 * dlon * j / tiles, s0 + 2 * dlat * (i + 1) / tiles, w0 + 2 * dlon * (j + 1) / tiles)
            for group in ("building", "other"):
                tile(bb, group, 0)
    if missing:
        log.warning("OSM coverage incomplete: %d tile(s) skipped", len(missing))
    return {"elements": elements, "incomplete": bool(missing)}


def query_hash(q: str) -> str:
    return hashlib.sha256(q.encode()).hexdigest()[:16]


def _post(url: str, query: str, deadline_s: float) -> dict:
    """POST with a hard overall deadline (slow servers can trickle bytes past a read timeout)."""
    t0 = time.time()
    with requests.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=(15, 60), stream=True) as r:
        if r.status_code in (429, 504, 503):
            raise RuntimeError(f"overpass busy {r.status_code}")
        r.raise_for_status()
        buf = bytearray()
        for chunk in r.iter_content(1 << 16):
            buf.extend(chunk)
            if time.time() - t0 > deadline_s:
                raise TimeoutError(f"overpass response exceeded {deadline_s}s")
    return json.loads(bytes(buf))


def fetch(query: str, cache_dir: str, remote_get=None, remote_put=None, attempts: int = 6, deadline_s: float = 200) -> dict:
    """Return Overpass JSON for `query`, using local cache -> remote (R2) cache -> network."""
    h = query_hash(query)
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{h}.json.gz")
    if os.path.exists(path):
        with gzip.open(path, "rb") as f:
            return json.load(f)
    if remote_get:
        blob = remote_get(h)
        if blob:
            with open(path, "wb") as f:
                f.write(blob)
            return json.loads(gzip.decompress(blob))
    last = None
    for attempt in range(attempts):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            log.info("overpass query %s via %s", h, url)
            data = _post(url, query, deadline_s)
            blob = gzip.compress(json.dumps(data).encode(), mtime=0)
            with open(path, "wb") as f:
                f.write(blob)
            if remote_put:
                remote_put(h, blob)
            return data
        except Exception as e:  # pragma: no cover - network
            last = e
            log.warning("overpass attempt %d failed: %s", attempt, e)
            if attempt + 1 < attempts:
                time.sleep(min(60, 5 * 2**attempt))
    raise RuntimeError(f"overpass failed: {last}")
