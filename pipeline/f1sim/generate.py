"""RaceBundle generation orchestrator.

    python -m f1sim.generate --year 2024 --race monza        # writes ./out, no credentials needed

Stages (reported through `progress(stage, fraction, message)`):
  generating_fastf1 -> generating_circuit -> enriching_osm -> processing -> uploading -> ready

Idempotency: race bundles are content addressed (b{PIPELINE_VERSION}-{hash}); the
manifest pointer is written last, so a crashed job never publishes a partial bundle.
Circuit/world artifacts are keyed by layout + CIRCUIT_VERSION and reused.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Callable

import numpy as np

from . import BUNDLE_SCHEMA, CIRCUIT_VERSION, PIPELINE_VERSION, SCHEMA_VERSION, binfmt, environment, liveries
from .circuit import registry
from .circuit.build import Circuit, build_circuit
from .circuit.path import ClosedPath
from .geo import features as geofeat
from .geo import osm, registration
from .geo.proj import LocalFrame
from .geo.registration import Registration
from .ingest import fastf1_source
from .race import events as race_events
from .race import motion as race_motion
from .race import timing as race_timing
from .storage import SHORT, Store

log = logging.getLogger("f1sim")
Progress = Callable[[str, float, str], None]
CHUNK_SECONDS = 900
COMPOUND = {"SOFT": 1, "MEDIUM": 2, "HARD": 3, "INTERMEDIATE": 4, "WET": 5, "UNKNOWN": 0, "TEST_UNKNOWN": 0}


def _noop(stage, frac, msg):
    log.info("[%s %3.0f%%] %s", stage, frac * 100, msg)


def circuit_prefix(ref: str, layout: str) -> str:
    return f"circuits/{ref}/{layout}/c{CIRCUIT_VERSION}"


def race_prefix(season: int, rnd: int) -> str:
    return f"races/{season}/{rnd:02d}"


# ----------------------------------------------------------------------------------- circuit I/O
def _circuit_to_bin(circ: Circuit, reg: Registration, frame: LocalFrame, cfg: dict, world, z_offset: float,
                    racing_line: np.ndarray, ref: str, raw) -> bytes:
    p = circ.path
    datum = world.datum if world else 0.0
    zshift = z_offset - datum
    pts = p.pts.copy()
    pts[:, 2] += zshift
    arrays = {
        "path": pts.astype(np.float32),
        "left": circ.left.astype(np.float32),
        "right": circ.right.astype(np.float32),
        "racing": racing_line.astype(np.float32),
        "curvature": circ.curvature.astype(np.float32),
    }
    if world:
        arrays["barrier_left"] = world.barriers["left"]
        arrays["barrier_right"] = world.barriers["right"]
    pit_meta = {"available": False}
    if circ.pit.get("available"):
        pp = circ.pit["pts"].copy()
        pp[:, 2] = np.interp(np.mod(circ.pit["s"], p.length), p.s, pts[:, 2], period=p.length)
        arrays["pit_path"] = pp.astype(np.float32)
        arrays["pit_s"] = circ.pit["s"].astype(np.float32)
        arrays["pit_d"] = circ.pit["d"].astype(np.float32)
        pit_meta = {k: circ.pit[k] for k in ("available", "s_start", "s_end", "side", "width")}
    meta = {
        "ref": ref,
        "name": raw.circuit_name,
        "layout": cfg["layout"],
        "version": CIRCUIT_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "pipelineVersion": PIPELINE_VERSION,
        "length": p.length,
        "ds": p.ds,
        "origin": frame.to_json(),
        "datum": datum,
        "registration": reg.to_json(),
        "corners": circ.corners,
        "sectors": circ.sectors,
        "marshalSectors": circ.marshal_sectors,
        "drsZones": circ.drs_zones,
        "kerbs": circ.kerbs,
        "garages": circ.garages,
        "pit": pit_meta,
        "stands": world.stands if world else [],
        "widthSource": circ.extra.get("width_source"),
        "drsSource": circ.extra.get("drs_source"),
        "lineModel": "reference=median of all car positions; racing=derived min-curvature",
        "theme": cfg["theme"],
        "street": bool(cfg.get("street")),
        "fastf1": {"circuitKey": raw.circuit_key, "rotation": raw.circuit_rotation},
    }
    return binfmt.pack(arrays, meta)


def _circuit_from_bin(buf: bytes) -> tuple[Circuit, Registration, np.ndarray, dict]:
    meta, a = binfmt.unpack(buf)
    path = ClosedPath(a["path"].astype(np.float64), meta["ds"])
    pit = {"available": False}
    if meta["pit"].get("available"):
        pit = {**meta["pit"], "s": a["pit_s"].astype(np.float64), "d": a["pit_d"].astype(np.float64),
               "pts": a["pit_path"].astype(np.float64)}
    circ = Circuit(path=path, left=a["left"].astype(np.float64), right=a["right"].astype(np.float64), pit=pit,
                   garages=meta["garages"], corners=meta["corners"], sectors=meta["sectors"],
                   marshal_sectors=meta["marshalSectors"], drs_zones=meta["drsZones"], kerbs=meta["kerbs"],
                   curvature=a["curvature"].astype(np.float64))
    r = meta["registration"]
    reg = Registration(**{k: r[k] for k in ("scale", "theta", "mirror", "tx", "ty", "z_scale", "z_offset", "rms",
                                            "inlier_ratio", "method")})
    return circ, reg, a["racing"].astype(np.float64), meta


def _world_to_bin(world) -> bytes:
    N = world.terrain.shape[0]
    arrays = {
        "terrain": np.round(world.terrain * 10).astype(np.int16),  # decimetres
        "bld_offsets": world.bld["offsets"],
        "bld_xy": world.bld["xy"].astype(np.float32),
        "bld_height": world.bld["height"],
        "bld_base": world.bld["base"],
        "bld_kind": world.bld["kind"],
        "bld_tri": world.bld["tri"],
        "bld_tri_offsets": world.bld["tri_offsets"],
        "trees": world.trees.astype(np.float32),
        "road_offsets": world.roads["offsets"],
        "road_xy": world.roads["xy"],
        "road_width": world.roads["width"],
        "road_kind": world.roads["kind"],
    }
    meta = {"extent": world.extent, "terrainN": N, "terrainScale": 0.1, "datum": world.datum,
            "landcover": {"file": "landcover.png", "res": world.lc_res}, "attribution": world.attribution,
            "counts": {"buildings": int(len(world.bld["height"])), "trees": int(len(world.trees)),
                       "roads": int(len(world.roads["width"]))}}
    return binfmt.pack(arrays, meta)



def _line_hash(circ: Circuit, racing_line: np.ndarray) -> str:
    """Fingerprint of everything race telemetry is fused against (line, edges, pit lane, corners, sectors).
    Terrain / buildings / trees / barriers are deliberately excluded: an environment change must not
    force telemetry regeneration. Float32 + 0.1 m rounding makes it identical whether the circuit was
    just built (float64) or loaded back from circuit.bin (float32)."""
    h = hashlib.sha256()
    def q(a):  # points (N, 3) -> xy; per-sample scalars (N,) as-is
        a = np.asarray(a, np.float32)
        return np.round((a[:, :2] if a.ndim == 2 else a).astype(np.float64), 1).tobytes()

    for a in (circ.path.pts, circ.left, circ.right, racing_line):
        h.update(q(a))
    if circ.pit.get("available"):
        h.update(np.round(np.asarray(circ.pit["s"], np.float32).astype(np.float64), 1).tobytes())
        h.update(np.round(np.asarray(circ.pit["d"], np.float32).astype(np.float64), 1).tobytes())
    h.update(json.dumps([round(float(circ.path.length), 1), circ.corners, circ.sectors, circ.drs_zones],
                        sort_keys=True, default=float).encode())
    return h.hexdigest()[:12]


def _read_manifest(store: Store, rpre: str) -> dict | None:
    blob = store.get(f"{rpre}/manifest.json")
    try:
        return json.loads(blob) if blob else None
    except ValueError:
        return None

# ----------------------------------------------------------------------------------- main pipeline
def generate(season: int, rnd: int, store: Store, progress: Progress = _noop, force_circuit: bool = False,
             cache_root: str | None = None, force_race: bool = False) -> dict:
    t_begin = time.time()
    cache_root = cache_root or os.environ.get("F1SIM_CACHE", os.path.expanduser("~/.cache/f1sim"))
    progress("generating_fastf1", 0.02, f"Loading {season} round {rnd} from FastF1")
    fastf1_source.enable_cache(os.path.join(cache_root, "fastf1"))
    raw = fastf1_source.load_race(season, rnd, "R")
    progress("generating_fastf1", 1.0, f"{raw.event_name}: {len(raw.drivers)} cars, {len(raw.laps)} laps")

    cfg = registry.get(raw.circuit_ref)
    cpre = circuit_prefix(raw.circuit_ref, cfg["layout"])
    frame = LocalFrame(raw.lat, raw.lon)
    existing = None if force_circuit else store.get(f"{cpre}/circuit.bin")

    world = None
    if existing:
        progress("generating_circuit", 0.5, "Reusing registered circuit layout")
        circ, reg, racing_line, cmeta = _circuit_from_bin(existing)
        datum = cmeta["datum"]
        z_offset_total = reg.z_offset
        enu = {k: reg.apply(d.pos_xyz) for k, d in raw.drivers.items()}
        for k in enu:
            enu[k][:, 2] += 0  # z already in circuit datum frame via reg.z_offset
        progress("generating_circuit", 1.0, "Circuit ready")
        progress("enriching_osm", 1.0, "Environment cached")
    else:
        # --- OSM (needed for registration) -------------------------------------------------
        progress("enriching_osm", 0.05, "Querying OpenStreetMap (cached per circuit)")
        okey = lambda h: f"circuits/{raw.circuit_ref}/osm/{h}.json.gz"  # noqa: E731
        data = osm.fetch_area(raw.lat, raw.lon, int(cfg["osm_radius"]), os.path.join(cache_root, "osm"),
                              remote_get=lambda h: store.get(okey(h)),
                              remote_put=lambda h, blob: store.put(okey(h), blob, "application/json", gzip=False))
        feats = geofeat.parse(data, frame)
        progress("enriching_osm", 0.4, f"{len(feats)} OSM features")

        # --- registration -------------------------------------------------------------------
        progress("generating_circuit", 0.1, "Registering FastF1 coordinates to geography")
        green = [l for l in raw.laps if l["time"] and l["start"] and not l["pit_in"] and not l["pit_out"] and l["lap"] > 1]
        best = min(green, key=lambda l: l["time"])
        d = raw.drivers[best["driver"]]
        m = (d.pos_t >= best["start"]) & (d.pos_t <= best["end"]) & d.pos_ok
        if cfg.get("anchors"):
            A = np.array(cfg["anchors"], float)
            ax, ay = frame.to_local(A[:, 2], A[:, 3])
            reg = registration.register_from_anchors(A[:, :2], np.stack([ax, ay], 1))
        else:
            rw = [f for f in feats if f.tags.get("highway") == "raceway" and f.kind == "line"]
            lap_len = float(np.sum(np.linalg.norm(np.diff(d.pos_xyz[m, :2], axis=0), axis=1))) * 0.1
            rw_len = sum(float(np.sum(np.linalg.norm(np.diff(f.xy, axis=0), axis=1))) for f in rw)
            if rw_len < 0.7 * lap_len:
                # street circuit: the racing surface is mapped as ordinary roads
                roads = [f for f in feats if f.kind == "line" and f.tags.get("highway") in
                         ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service",
                          "primary_link", "secondary_link", "tertiary_link", "trunk_link", "raceway")]
                log.info("raceway coverage %.0f m < lap %.0f m: registering against %d road ways", rw_len, lap_len, len(roads))
                rw = roads
            if rw:
                osm_pts = np.vstack([geofeat.densify(f.xy, 2.0) for f in rw])
                reg = registration.register_to_osm(d.pos_xyz[m, :2], osm_pts)
                if reg.rms > 15:
                    log.warning("registration residual high (%.1f m) — consider manual anchors", reg.rms)
            else:
                reg = registration.fallback()
        enu = {k: reg.apply(dd.pos_xyz) for k, dd in raw.drivers.items()}
        corners_ff = np.array([[c["x"], c["y"], 0] for c in raw.corners]) if raw.corners else np.zeros((0, 3))
        raw.extra["corners_enu"] = reg.apply(corners_ff)[:, :2] if len(corners_ff) else None
        ms_ff = np.array([[c["x"], c["y"], 0] for c in raw.marshal_sectors]) if raw.marshal_sectors else np.zeros((0, 3))
        raw.extra["marshal_enu"] = reg.apply(ms_ff)[:, :2] if len(ms_ff) else None

        progress("generating_circuit", 0.4, "Reconstructing reference line, edges, pit lane")
        circ = build_circuit(raw, enu, cfg)
        racing_line = race_motion.min_curvature_line(circ)
        progress("generating_circuit", 1.0, f"Circuit {circ.path.length:.0f} m")

        progress("enriching_osm", 0.6, "Generating terrain, buildings, vegetation")
        from .geo import world as geoworld

        world, z_off = geoworld.build_world(frame, feats, circ, 0.0, os.path.join(cache_root, "dem"),
                                            float(cfg["osm_radius"]), cfg["theme"], seed=f"{raw.circuit_ref}/{cfg['layout']}",
                                            street=bool(cfg.get("street")))
        datum = world.datum
        # bake the vertical transform into the registration so later races reuse it
        reg.z_offset = float(z_off - datum)
        z_offset_total = reg.z_offset
        cbin = _circuit_to_bin(circ, reg, frame, cfg, world, z_off, racing_line, raw.circuit_ref, raw)
        # _circuit_to_bin shifted path z by (z_off - datum); keep the in-memory circuit consistent
        circ.path = ClosedPath(circ.path.pts + np.array([0, 0, z_off - datum]), circ.path.ds)
        if circ.pit.get("available"):
            circ.pit["pts"][:, 2] += z_off - datum
        progress("enriching_osm", 0.9, "Uploading circuit & world")
        store.put(f"{cpre}/circuit.bin", binfmt.gz(cbin), "application/octet-stream", gzip=True)
        store.put(f"{cpre}/world.bin", binfmt.gz(_world_to_bin(world)), "application/octet-stream", gzip=True)
        store.put(f"{cpre}/landcover.png", world.landcover_png, "image/png")
        store.put(f"{cpre}/registration.json", binfmt.gz_json(reg.to_json()), "application/json", gzip=True)
        progress("enriching_osm", 1.0, f"{len(world.bld['height'])} buildings, {len(world.trees)} trees")
    del z_offset_total

    # --- reuse the telemetry bundle when only the environment changed -----------------------------
    line_hash = _line_hash(circ, racing_line)
    rpre = race_prefix(season, rnd)
    prev = None if force_race else _read_manifest(store, rpre)
    if (prev and prev.get("schemaVersion", 1) == SCHEMA_VERSION and prev.get("pipelineVersion") == PIPELINE_VERSION
            and prev.get("lineHash") == line_hash):
        manifest = {**prev, "circuitVersion": CIRCUIT_VERSION, "circuit": f"{cpre}/"}
        store.put(f"{rpre}/manifest.json", json.dumps(manifest, indent=1).encode(), "application/json", cache=SHORT)
        progress("ready", 1.0, f"Telemetry unchanged — reused bundle, circuit/environment v{CIRCUIT_VERSION} only ({time.time() - t_begin:.0f}s)")
        return manifest

    # --- race processing -------------------------------------------------------------------------
    progress("processing", 0.05, "Reconstructing car motion (Kalman fusion of position + speed)")
    mot = race_motion.reconstruct(raw, enu, circ, racing_line)
    progress("processing", 0.45, "Computing race order, gaps and intervals")
    tim = race_timing.compute(raw, mot, circ.path.length)
    progress("processing", 0.65, "Detecting race events")
    evs = race_events.detect(raw, mot, tim, circ.path.length, circ.corners)
    progress("processing", 0.8, f"{len(evs)} events")
    t_start, race_start, t_end = race_motion.race_window(raw)
    env = environment.describe(raw, t_start, t_end, cfg["theme"])

    # --- serialise ----------------------------------------------------------------------------------
    progress("uploading", 0.05, "Packing RaceBundle")
    drivers = list(mot.s.keys())
    files: dict[str, tuple[bytes, str, bool]] = {}
    chunks = []
    step = int(CHUNK_SECONDS * race_motion.HZ)
    for ci, a in enumerate(range(0, mot.n, step)):
        b = min(mot.n, a + step + 1)  # 1-sample overlap so interpolation never straddles files
        arrays = {}
        for k in drivers:
            sl = slice(a, b)
            arrays[f"{k}/s"] = mot.s[k][sl].astype(np.float32)
            arrays[f"{k}/v"] = np.clip(np.round(np.nan_to_num(mot.v[k][sl]) * 100), 0, 65535).astype(np.uint16)
            arrays[f"{k}/d"] = np.clip(np.round(mot.d[k][sl] * 100), -32768, 32767).astype(np.int16)
            arrays[f"{k}/speed"] = np.clip(np.round(mot.speed[k][sl]), 0, 65535).astype(np.uint16)
            arrays[f"{k}/rpm"] = np.clip(np.round(mot.rpm[k][sl]), 0, 65535).astype(np.uint16)
            arrays[f"{k}/gear"] = np.clip(mot.gear[k][sl], 0, 9).astype(np.uint8)
            arrays[f"{k}/throttle"] = np.clip(np.round(mot.throttle[k][sl]), 0, 100).astype(np.uint8)
            arrays[f"{k}/brake"] = np.clip(np.round(mot.brake[k][sl] * 100), 0, 100).astype(np.uint8)
            arrays[f"{k}/drs"] = np.clip(mot.drs[k][sl], 0, 255).astype(np.uint8)
            arrays[f"{k}/flags"] = mot.flags[k][sl].astype(np.uint8)
        blob = binfmt.gz(binfmt.pack(arrays, {"t0": mot.t0 + a * race_motion.DT, "hz": race_motion.HZ, "n": b - a}))
        name = f"motion-{ci:02d}.bin"
        files[name] = (blob, "application/octet-stream", True)
        chunks.append({"file": name, "t0": round(mot.t0 + a * race_motion.DT, 3), "n": b - a, "bytes": len(blob)})

    # timing + track profile
    tarr = {
        "position": tim.position,
        "gap": np.where(np.isfinite(tim.gap), np.clip(np.round(tim.gap * 1000), 0, 2**31 - 1), -1).astype(np.int32),
        "interval": np.where(np.isfinite(tim.interval), np.clip(np.round(tim.interval * 1000), 0, 2**31 - 1), -1).astype(np.int32),
        "laps_down": tim.laps_down,
        "lap": tim.lap,
    }
    tarr.update(_track_profile(raw, mot, circ))
    files["timing.bin"] = (binfmt.gz(binfmt.pack(tarr, {"t0": tim.t0, "step": tim.step, "n": tim.n,
                                                         "drivers": tim.drivers, "gapUnit": "ms"})),
                           "application/octet-stream", True)

    race = _race_json(raw, cfg, cpre, circ, drivers, evs, env, mot, chunks, tim, t_start, race_start, t_end)
    files["race.json"] = (binfmt.gz_json(race), "application/json", True)

    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode())
        digest.update(files[name][0])
    bundle_id = f"b{PIPELINE_VERSION}-{digest.hexdigest()[:10]}"
    progress("uploading", 0.2, f"Uploading {len(files)} files")
    for i, (name, (blob, ctype, gz)) in enumerate(sorted(files.items())):
        store.put(f"{rpre}/{bundle_id}/{name}", blob, ctype, gzip=gz)
        progress("uploading", 0.2 + 0.7 * (i + 1) / len(files), name)
    manifest = {
        "schema": BUNDLE_SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "season": season,
        "round": rnd,
        "pipelineVersion": PIPELINE_VERSION,
        "circuitVersion": CIRCUIT_VERSION,
        "lineHash": line_hash,
        "bundle": f"{rpre}/{bundle_id}/",
        "circuit": f"{cpre}/",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "bytes": sum(len(v[0]) for v in files.values()),
        "event": raw.event_name,
    }
    store.put(f"{rpre}/manifest.json", json.dumps(manifest, indent=1).encode(), "application/json", cache=SHORT)
    progress("ready", 1.0, f"Done in {time.time() - t_begin:.0f}s")
    return manifest


def _track_profile(raw, mot, circ: Circuit) -> dict:
    """Median speed / throttle / brake along the lap from green-flag laps (for overlays)."""
    L = circ.path.length
    nb = int(np.ceil(L / 5.0))
    acc = {k: [[] for _ in range(nb)] for k in ("speed", "throttle", "brake")}
    sums = {k: np.zeros(nb) for k in acc}
    cnt = np.zeros(nb)
    brake_cnt = np.zeros(nb)
    for l in raw.laps:
        if not l["time"] or l["pit_in"] or l["pit_out"] or l["lap"] == 1:
            continue
        if l["track_status"] and set(l["track_status"]) - {"1"}:
            continue
        k = l["driver"]
        if k not in mot.s:
            continue
        a = int((l["start"] - mot.t0) * race_motion.HZ)
        b = int((l["end"] - mot.t0) * race_motion.HZ)
        if a < 0 or b > mot.n:
            continue
        sl = slice(a, b)
        bi = (np.mod(mot.s[k][sl], L) / 5.0).astype(int) % nb
        np.add.at(sums["speed"], bi, mot.speed[k][sl])
        np.add.at(sums["throttle"], bi, mot.throttle[k][sl])
        np.add.at(brake_cnt, bi, mot.brake[k][sl] > 0.5)
        np.add.at(cnt, bi, 1)
    cnt = np.maximum(cnt, 1)
    del acc
    return {
        "profile_speed": (sums["speed"] / cnt).astype(np.float32),
        "profile_throttle": (sums["throttle"] / cnt).astype(np.float32),
        "profile_brake": (brake_cnt / cnt).astype(np.float32),
    }


def _race_json(raw, cfg, cpre, circ, drivers, evs, env, mot, chunks, tim, t_start, race_start, t_end) -> dict:
    import fastf1

    laps_by: dict[str, list] = {}
    for l in raw.laps:
        laps_by.setdefault(l["driver"], []).append(l)

    def r3(x):
        return None if x is None else round(float(x), 3)

    laps_out, stints_out = {}, {}
    for k, laps in laps_by.items():
        laps.sort(key=lambda l: l["lap"])
        laps_out[k] = [[l["lap"], r3(l["start"]), r3(l["end"]), r3(l["time"]), r3(l["s1"]), r3(l["s2"]), r3(l["s3"]),
                        COMPOUND.get(l["compound"] or "UNKNOWN", 0), l["tyre_life"], r3(l["pit_in"]), r3(l["pit_out"]),
                        l["position"], int(l["deleted"]), int(l["personal_best"]), l["speed_trap"]] for l in laps]
        st = []
        for l in laps:
            if l["stint"] is None:
                continue
            if not st or st[-1]["stint"] != l["stint"]:
                st.append({"stint": l["stint"], "compound": l["compound"], "fromLap": l["lap"], "toLap": l["lap"],
                           "startAge": (l["tyre_life"] or 1) - 1, "fresh": l["fresh"]})
            else:
                st[-1]["toLap"] = l["lap"]
        stints_out[k] = st

    drv = []
    for k in sorted(raw.drivers, key=lambda k: raw.drivers[k].position or 99):
        d = raw.drivers[k]
        drv.append({
            "num": k, "code": d.code, "first": d.first_name, "last": d.last_name, "team": d.team,
            "teamId": liveries.team_id(d.team), "color": d.team_color, "grid": d.grid, "position": d.position,
            "classified": d.classified, "status": d.status, "points": d.points, "headshot": d.headshot_url,
            "hasMotion": k in mot.s, "livery": liveries.livery(raw.season, d.team, d.team_color),
        })
    ts_labels = {"1": "green", "2": "yellow", "4": "sc", "5": "red", "6": "vsc", "7": "vsc_ending"}
    return {
        "schema": BUNDLE_SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "pipelineVersion": PIPELINE_VERSION,
        "circuitVersion": CIRCUIT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"fastf1": fastf1.__version__, "session": "R"},
        "race": {
            "season": raw.season, "round": raw.round, "name": raw.event_name, "officialName": raw.official_name,
            "country": raw.country, "countryCode": raw.country_code, "location": raw.location,
            "date": raw.t0_utc.strftime("%Y-%m-%d"), "t0Utc": raw.date_utc, "gmtOffset": raw.gmt_offset_h,
            "totalLaps": raw.total_laps, "raceStart": round(race_start, 3), "window": [round(t_start, 3), round(t_end, 3)],
        },
        "circuit": {"ref": raw.circuit_ref, "name": raw.circuit_name, "layout": cfg["layout"], "path": f"{cpre}/",
                    "length": circ.path.length},
        "drivers": drv,
        "laps": {"columns": ["lap", "start", "end", "time", "s1", "s2", "s3", "compound", "tyreLife", "pitIn", "pitOut",
                             "position", "deleted", "personalBest", "speedTrap"], "byDriver": laps_out},
        "compounds": {v: k for k, v in COMPOUND.items() if k in ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET")},
        "stints": stints_out,
        "events": evs,
        "trackStatus": [{"t": r3(s["t"]), "status": ts_labels.get(s["status"], s["status"]), "message": s["message"]}
                        for s in raw.track_status],
        "sessionStatus": raw.session_status,
        "raceControl": [{k: v for k, v in rc.items()} for rc in raw.race_control if t_start - 60 <= rc["t"] <= t_end],
        "environment": env,
        "motion": {
            "hz": race_motion.HZ, "t0": round(mot.t0, 3), "n": mot.n, "chunks": chunks,
            "channels": {"s": "f32 m cumulative arc length (fused)", "v": "u16 cm/s fused speed",
                         "d": "i16 cm lateral offset", "speed": "u16 km/h raw", "rpm": "u16 raw", "gear": "u8 raw",
                         "throttle": "u8 % raw", "brake": "u8 0/100 raw", "drs": "u8 raw FastF1 code",
                         "flags": "u8 1=visible 2=pit 4=stopped"},
            "raw": ["speed", "rpm", "gear", "throttle", "brake", "drs"],
            "derived": {"s": "Kalman/RTS fusion of map-matched position and measured speed",
                        "v": "fused", "d": "track: derived racing line + side-by-side lanes (source positions are "
                                           "map-matched to a single line); pit lane: measured"},
        },
        "timing": {"file": "timing.bin", "t0": round(tim.t0, 3), "step": tim.step, "n": tim.n, "drivers": tim.drivers},
        "attribution": ["Timing & telemetry: FastF1 / Formula 1 live timing (unofficial, non-commercial use)",
                        "© OpenStreetMap contributors (ODbL)", "Terrain: Mapzen Terrain Tiles / AWS Open Data"],
    }


def resolve_round(season: int, race: str, cache_root: str) -> int:
    """`--race 16` or a name fragment (`monza`, `italy`, `silverstone`) -> round number."""
    if race.isdigit():
        return int(race)
    import fastf1

    fastf1_source.enable_cache(os.path.join(cache_root, "fastf1"))
    return int(fastf1.get_event(season, race)["RoundNumber"])


def main():
    ap = argparse.ArgumentParser(
        description="Generate one race locally. Writes JSON/bin artifacts to ./out and needs no credentials "
                    "(FastF1 + OpenStreetMap + terrain tiles are public). Upload only happens with --upload.")
    ap.add_argument("--year", "--season", dest="season", type=int, required=True)
    ap.add_argument("--race", help="round number or name fragment, e.g. 16 or monza")
    ap.add_argument("--round", type=int, help="round number (same as --race N)")
    ap.add_argument("--out", default="out", help="local output directory (default ./out)")
    ap.add_argument("--upload", action="store_true", help="also upload to R2 (needs R2_* env vars; CI only)")
    ap.add_argument("--force-circuit", action="store_true", help="rebuild circuit + world even if present in --out")
    ap.add_argument("--force-race", action="store_true", help="rebuild the telemetry bundle even if unchanged")
    a = ap.parse_args()
    if a.round is None and not a.race:
        ap.error("give --race (name or number) or --round")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("fastf1").setLevel(logging.WARNING)
    cache_root = os.environ.get("F1SIM_CACHE", os.path.expanduser("~/.cache/f1sim"))
    rnd = a.round if a.round is not None else resolve_round(a.season, a.race, cache_root)
    store = Store(local_root=a.out, upload=a.upload)
    m = generate(a.season, rnd, store, force_circuit=a.force_circuit, force_race=a.force_race, cache_root=cache_root)
    print(json.dumps(m, indent=1))


if __name__ == "__main__":
    main()
