"""World (environment) generation for a circuit layout.

Produces renderer-ready, compact data in the local ENU frame:
  terrain      DEM heights on a regular grid, fitted to the track surface
  landcover    8-bit class raster (PNG) used as a terrain splat map (roads, grass,
               water, forest, urban, paved, runoff...) — cheap to render, looks rich
  buildings    footprints (+ earcut roof triangulation), heights, base, kind
  trees        instanced points (x, y, z, scale, species)
  stands       grandstands: OSM-tagged + plausible generic placements
  barriers     trackside barrier / fence offsets along the reference line
Heights are metres relative to `datum` (altitude of the lowest track point).
"""

from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass, field

import mapbox_earcut as earcut
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates
from scipy.spatial import cKDTree

from ..circuit.build import Circuit
from . import dem
from .features import Feature, densify
from .proj import LocalFrame

log = logging.getLogger(__name__)

# landcover classes (keep in sync with web/src/scene/world/landcover.ts)
LC = dict(ground=0, grass=1, forest=2, water=3, road=4, minor_road=5, paved=6, urban=7, industrial=8,
          sand=9, runoff=10, pitch=11, soil=12, rail=13, gravel=14)

ROAD_W = {"motorway": 16, "trunk": 14, "primary": 12, "secondary": 10, "tertiary": 8.5, "residential": 7,
          "unclassified": 6.5, "service": 5, "living_street": 5, "busway": 7, "pedestrian": 5, "track": 3.5,
          "footway": 2.2, "path": 2, "cycleway": 2.4, "steps": 2, "motorway_link": 8, "trunk_link": 8,
          "primary_link": 7, "secondary_link": 7, "tertiary_link": 6}

BK = dict(generic=0, residential=1, commercial=2, industrial=3, grandstand=4, paddock=5, tank=6, roof=7,
          religious=8, tower=9)


@dataclass
class World:
    datum: float
    extent: tuple[float, float, float]  # x0, y0, size
    terrain: np.ndarray  # (N,N) float32 heights rel. datum
    landcover_png: bytes
    lc_res: int
    bld: dict
    trees: np.ndarray  # (k,5) x,y,z,scale,species
    stands: list[dict]
    barriers: dict
    roads: dict
    attribution: list[str] = field(default_factory=list)


def _rng(seed_str: str):
    import hashlib

    return np.random.default_rng(int.from_bytes(hashlib.sha256(seed_str.encode()).digest()[:8], "little"))


def _building_height(tags, area, rng):
    h = tags.get("height") or tags.get("building:height")
    if h:
        try:
            return float(str(h).split()[0].replace(",", ".").rstrip("m"))
        except ValueError:
            pass
    lv = tags.get("building:levels")
    if lv:
        try:
            return float(str(lv).split(";")[0].replace(",", ".")) * 3.1 + 1.0
        except ValueError:
            pass
    b = tags.get("building", "yes")
    if b in ("roof", "carport", "canopy"):
        return 5.0
    if b in ("grandstand",):
        return 14.0
    if b in ("industrial", "warehouse"):
        return 9 + rng.random() * 5
    # São Paulo style low-rise with occasional taller blocks, scaled by footprint
    base = 4.0 + 3.0 * rng.integers(0, 3)
    if area > 800:
        base += rng.random() * 12
    return base


def _building_kind(tags):
    b = tags.get("building", "yes")
    if b in ("grandstand",) or tags.get("leisure") == "bleachers":
        return BK["grandstand"]
    if b in ("house", "residential", "apartments", "detached", "terrace"):
        return BK["residential"]
    if b in ("industrial", "warehouse", "train_station", "transportation"):
        return BK["industrial"]
    if b in ("storage_tank",) or tags.get("man_made") in ("storage_tank", "silo"):
        return BK["tank"]
    if b in ("roof", "carport", "canopy"):
        return BK["roof"]
    if b in ("church", "cathedral", "chapel", "mosque", "temple"):
        return BK["religious"]
    if b in ("commercial", "retail", "office", "hotel", "school", "university"):
        return BK["commercial"]
    return BK["generic"]


def build_world(frame: LocalFrame, feats: list[Feature], circ: Circuit, racing_z_ref: float, dem_cache: str,
                radius: float, theme: dict, seed: str, street: bool = False) -> tuple[World, float]:
    rng = _rng(seed)
    path = circ.path
    # ------------------------------------------------------------------ extent
    c = path.pts[:, :2].mean(0)
    size = 2 * radius
    x0, y0 = c[0] - radius, c[1] - radius
    N = 385  # terrain grid (≈ 12 m cells for a 4.6 km square)
    # ------------------------------------------------------------------ DEM + datum
    Z = dem.sample_grid(frame, x0, y0, size, N, dem_cache, z=15)
    Z = gaussian_filter(Z, 1.0)
    gx = (path.pts[:, 0] - x0) / size * (N - 1)
    gy = (path.pts[:, 1] - y0) / size * (N - 1)
    dem_at_track = map_coordinates(Z, [gy, gx], order=1)
    z_offset = float(np.median(dem_at_track - path.pts[:, 2]))
    track_alt = path.pts[:, 2] + z_offset  # absolute altitude of the reference line
    datum = float(np.floor(track_alt.min()))
    resid = float(np.quantile(np.abs(dem_at_track - track_alt), 0.9))
    log.info("DEM fit: track Z + %.2f m -> altitude; datum %.0f m; DEM residual p90 %.2f m", z_offset, datum, resid)
    if resid > 8.0:
        # SRTM is a surface model: in dense flat cities it contains building blocks. Keep only the
        # large-scale landform so buildings don't sit on (or inside) phantom hills.
        Z = gaussian_filter(Z, 8.0)
        log.info("DEM smoothed (surface-model artefacts)")
    H = (Z - datum).astype(np.float64)

    # --- fit terrain to track surface: carve a corridor using distance to the reference line
    lines = [path.pts]
    if circ.pit.get("available"):
        pit_pts = circ.pit["pts"].copy()
        pit_pts[:, 2] = np.interp(np.mod(circ.pit["s"], path.length), path.s, path.pts[:, 2], period=path.length)
        lines.append(pit_pts)
    allp = np.vstack(lines)
    tree = cKDTree(allp[:, :2])
    xs = np.linspace(x0, x0 + size, N)
    ys = np.linspace(y0, y0 + size, N)
    GX, GY = np.meshgrid(xs, ys)
    dist, idx = tree.query(np.stack([GX.ravel(), GY.ravel()], 1))
    dist = dist.reshape(N, N)
    tz = (allp[idx, 2] + z_offset - datum).reshape(N, N)
    half = 0.5 * (circ.left - circ.right).max()
    # the reference-line height field is extended smoothly outward (not a flat shelf), then blended
    # into the DEM over a wide band so embankments look natural rather than cut
    tz_s = gaussian_filter(tz, 3.0)
    w = np.clip((dist - (half + 14)) / 170.0, 0, 1)
    w = w * w * (3 - 2 * w)  # smoothstep: 0 = on track corridor, 1 = natural terrain
    near = np.clip((dist - half) / 14.0, 0, 1)
    corridor = (1 - near) * tz + near * tz_s
    H = (1 - w) * (corridor - 0.35) + w * gaussian_filter(H, 1.5)
    terrain = H.astype(np.float32)

    # ------------------------------------------------------------------ landcover raster
    R = 2048
    px = R / size
    img = Image.new("L", (R, R), LC["ground"])
    dr = ImageDraw.Draw(img)

    def P(xy):
        return [((x - x0) * px, (y0 + size - y) * px) for x, y in xy]  # image y down = north up

    def poly(f: Feature, cls):
        if len(f.xy) >= 3:
            dr.polygon(P(f.xy), fill=cls)
            for h in f.holes:
                if len(h) >= 3:
                    dr.polygon(P(h), fill=LC["ground"])

    order = []  # (priority, fn)
    for f in feats:
        t = f.tags
        if f.kind != "area":
            continue
        lu, le, na, am = t.get("landuse"), t.get("leisure"), t.get("natural"), t.get("amenity")
        cls, pr = None, 0
        if na in ("water",) or lu in ("reservoir", "basin") or "water" in t and na != "wetland" and t.get("water"):
            cls, pr = LC["water"], 9
        elif na == "wetland":
            cls, pr = LC["grass"], 3
        elif na in ("wood",) or lu in ("forest",):
            cls, pr = LC["forest"], 4
        elif na in ("scrub", "heath"):
            cls, pr = LC["forest"], 3
        elif lu in ("grass", "meadow", "village_green", "recreation_ground", "cemetery", "orchard", "farmland") or le in ("park", "garden", "golf_course", "nature_reserve"):
            cls, pr = LC["grass"], 2
        elif le in ("pitch", "sports_centre", "stadium", "track"):
            cls, pr = LC["pitch"], 5
        elif le == "swimming_pool":
            cls, pr = LC["water"], 8
        elif am in ("parking",) or t.get("area:highway") or lu in ("garages",):
            cls, pr = LC["paved"], 6
        elif lu in ("residential",):
            cls, pr = LC["urban"], 1
        elif lu in ("industrial", "commercial", "retail", "depot", "railway", "military"):
            cls, pr = LC["industrial"], 1
        elif lu in ("construction", "brownfield", "landfill", "quarry"):
            cls, pr = LC["soil"], 2
        elif na in ("sand", "beach", "bare_rock", "scree"):
            cls, pr = LC["sand"], 3
        if cls is not None:
            order.append((pr, f, cls))
    order.sort(key=lambda o: o[0])
    for _, f, cls in order:
        poly(f, cls)

    road_lines = []
    for f in feats:
        t = f.tags
        hw = t.get("highway")
        if f.kind == "line" and hw and hw != "raceway" and hw in ROAD_W:
            wdt = ROAD_W[hw]
            cls = LC["road"] if wdt >= 6 else LC["minor_road"]
            if t.get("tunnel") in ("yes", "building_passage") or t.get("layer", "0").startswith("-"):
                continue
            dr.line(P(f.xy), fill=cls, width=max(1, int(round(wdt * px))), joint="curve")
            road_lines.append((f.xy, wdt, cls, t.get("bridge") == "yes"))
        elif f.kind == "line" and t.get("railway") in ("rail", "light_rail", "subway") and t.get("tunnel") != "yes":
            dr.line(P(f.xy), fill=LC["rail"], width=max(1, int(5 * px)))
        elif f.kind == "line" and t.get("waterway") in ("river", "stream", "canal"):
            dr.line(P(f.xy), fill=LC["water"], width=max(1, int((12 if t["waterway"] == "river" else 4) * px)))
        elif f.kind == "line" and hw == "raceway":
            # secondary raceways (old layouts, kart tracks, service loops) read as plain tarmac
            dr.line(P(f.xy), fill=LC["road"], width=max(1, int(8 * px)), joint="curve")
    lc = np.array(img)
    # G channel: distance to the circuit (metres, clamped 255) — used for night floodlight falloff
    yy, xx = np.mgrid[0:R, 0:R]
    step = 4  # evaluate on a coarse grid, then upsample
    cx_ = x0 + (xx[::step, ::step] + 0.5) / px
    cy_ = y0 + size - (yy[::step, ::step] + 0.5) / px
    dtr, _ = cKDTree(allp[:, :2]).query(np.stack([cx_.ravel(), cy_.ravel()], 1))
    dgrid = np.clip(dtr.reshape(cx_.shape), 0, 255).astype(np.uint8)
    dfull = np.array(Image.fromarray(dgrid).resize((R, R), Image.BILINEAR))
    rgb = np.stack([lc, dfull, np.zeros_like(lc)], axis=-1)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, format="PNG", optimize=True)

    # ------------------------------------------------------------------ buildings
    def h_at(x, y):
        return map_coordinates(terrain, [(np.asarray(y) - y0) / size * (N - 1), (np.asarray(x) - x0) / size * (N - 1)],
                               order=1, mode="nearest")

    track_tree = cKDTree(allp[:, :2])
    offs, xy_all, heights, bases, kinds, idx_all, idx_offs = [0], [], [], [], [], [], [0]
    n_skip = 0
    for f in feats:
        t = f.tags
        if f.kind != "area" or not ("building" in t or t.get("leisure") == "bleachers" or t.get("man_made") in ("storage_tank", "silo")):
            continue
        if t.get("building") in ("no", "ruins") or t.get("location") == "underground":
            continue
        ring = f.xy[:-1] if np.allclose(f.xy[0], f.xy[-1]) else f.xy
        if len(ring) < 3:
            continue
        cx, cy = ring.mean(0)
        if abs(cx - c[0]) > radius or abs(cy - c[1]) > radius:
            continue
        # never let a building sit on the racing surface
        dmin, _ = track_tree.query(ring)
        if dmin.min() < half + 2.0:
            n_skip += 1
            continue
        area = 0.5 * abs(np.dot(ring[:, 0], np.roll(ring[:, 1], 1)) - np.dot(ring[:, 1], np.roll(ring[:, 0], 1)))
        if area < 6:
            continue
        # CCW orientation
        signed = 0.5 * (np.dot(ring[:, 0], np.roll(ring[:, 1], -1)) - np.dot(ring[:, 1], np.roll(ring[:, 0], -1)))
        if signed < 0:
            ring = ring[::-1]
        tri = earcut.triangulate_float64(ring.astype(np.float64), np.array([len(ring)], dtype=np.uint32))
        if len(tri) == 0:
            continue
        hb = h_at(ring[:, 0], ring[:, 1])
        xy_all.append(ring.astype(np.float32))
        offs.append(offs[-1] + len(ring))
        idx_all.append(tri.astype(np.uint32))
        idx_offs.append(idx_offs[-1] + len(tri))
        heights.append(_building_height(t, area, rng))
        bases.append(float(hb.min()) - 0.5)
        kinds.append(_building_kind(t))
    bld = {
        "offsets": np.array(offs, np.uint32),
        "xy": np.vstack(xy_all) if xy_all else np.zeros((0, 2), np.float32),
        "height": np.array(heights, np.float32),
        "base": np.array(bases, np.float32),
        "kind": np.array(kinds, np.uint8),
        "tri": np.concatenate(idx_all) if idx_all else np.zeros(0, np.uint32),
        "tri_offsets": np.array(idx_offs, np.uint32),
    }
    log.info("buildings: %d (skipped %d on/near track)", len(heights), n_skip)

    # ------------------------------------------------------------------ trees
    trees = []
    density = float(theme.get("vegetation_density", 0.6))

    def lc_at(x, y):
        ix = np.clip(((np.asarray(x) - x0) * px).astype(int), 0, R - 1)
        iy = np.clip(((y0 + size - np.asarray(y)) * px).astype(int), 0, R - 1)
        return lc[iy, ix]

    for f in feats:
        t = f.tags
        if f.kind == "point" and t.get("natural") == "tree":
            trees.append((*f.xy[0], 1.0 + 0.4 * rng.random(), 0))
        elif f.kind == "line" and t.get("natural") == "tree_row":
            for p in densify(f.xy, 7.0):
                trees.append((*p, 0.9 + 0.3 * rng.random(), 0))
    # scatter by landcover class with Poisson-ish jitter
    build_mask = Image.new("L", (R, R), 0)
    bd = ImageDraw.Draw(build_mask)
    for i in range(len(heights)):
        ring = bld["xy"][bld["offsets"][i] : bld["offsets"][i + 1]]
        bd.polygon(P(ring), fill=1)
    bmask = np.array(build_mask) > 0
    free = ~bmask & ~np.isin(lc, [LC["road"], LC["minor_road"], LC["water"], LC["paved"], LC["runoff"], LC["gravel"],
                                  LC["rail"], LC["pitch"]])
    # distance from built / roads so trees don't clip; also keep a clear corridor around the track
    free_d = distance_transform_edt(free) / px
    cell = 7.0
    gxs = np.arange(x0 + cell / 2, x0 + size, cell)
    gys = np.arange(y0 + cell / 2, y0 + size, cell)
    TX, TY = np.meshgrid(gxs, gys)
    TX = TX.ravel() + rng.uniform(-cell / 2, cell / 2, TX.size)
    TY = TY.ravel() + rng.uniform(-cell / 2, cell / 2, TY.size)
    cls = lc_at(TX, TY)
    ix = np.clip(((TX - x0) * px).astype(int), 0, R - 1)
    iy = np.clip(((y0 + size - TY) * px).astype(int), 0, R - 1)
    fd = free_d[iy, ix]
    dtrack, _ = track_tree.query(np.stack([TX, TY], 1))
    # clumped distribution (noise field) reads far more natural than uniform scatter
    clump = 0.5 + 0.5 * np.sin(TX * 0.013 + np.sin(TY * 0.009) * 2.1) * np.cos(TY * 0.011 + np.sin(TX * 0.007) * 1.7)
    prob = np.select([cls == LC["forest"], cls == LC["grass"], cls == LC["ground"], cls == LC["urban"], cls == LC["soil"]],
                     [0.8, 0.22, 0.16, 0.06, 0.03], 0.0) * density
    prob = np.where(cls == LC["forest"], prob, prob * np.clip(clump * 1.6 - 0.3, 0, 1.3))
    prob = np.where(dtrack < half + (14 if street else 34), 0, prob)
    prob = np.where(fd < 2.0, 0, prob)
    keep = rng.random(TX.size) < prob
    for x, y, cl in zip(TX[keep], TY[keep], cls[keep]):
        trees.append((x, y, 0.75 + 0.6 * rng.random(), 1 if cl == LC["forest"] else (2 if rng.random() < 0.25 else 0)))
    trees = np.array(trees, np.float64) if trees else np.zeros((0, 4))
    inside = (np.abs(trees[:, 0] - c[0]) < radius) & (np.abs(trees[:, 1] - c[1]) < radius)
    trees = trees[inside]
    tz_ = h_at(trees[:, 0], trees[:, 1])
    trees = np.column_stack([trees[:, 0], trees[:, 1], tz_, trees[:, 2], trees[:, 3]]).astype(np.float32)
    log.info("trees: %d", len(trees))

    # ------------------------------------------------------------------ grandstands (generic)
    stands = _generic_stands(circ, bmask, lc, x0, y0, size, px, R, h_at)

    # ------------------------------------------------------------------ barriers
    k = np.abs(circ.curvature)
    left_off = np.zeros(path.n)
    right_off = np.zeros(path.n)
    for side, edge, out in (("left", circ.left, left_off), ("right", circ.right, right_off)):
        sign = 1 if side == "left" else -1
        outside = (np.sign(circ.curvature) == -sign) & (k > 1 / 250)
        if street:
            # street circuit: concrete walls hug the kerbs; small escape roads only at slow corners
            run = np.where(outside & (k > 1 / 60), 6.0, 1.3)
            run = np.convolve(np.concatenate([run[-40:], run, run[:40]]), np.ones(81) / 81, mode="same")[40:-40]
            out[:] = edge + sign * np.clip(run, 1.2, 8.0)
            continue
        run = np.where(outside, 12 + 1000 * k, 4.5)
        run = np.convolve(np.concatenate([run[-60:], run, run[:60]]), np.ones(121) / 121, mode="same")[60:-60]
        out[:] = edge + sign * np.clip(run, 4.0, 45.0)
    # keep barriers clear of the pit lane (wall sits between pit lane and track)
    if circ.pit.get("available"):
        ps = np.mod(circ.pit["s"], path.length)
        pd = circ.pit["d"]
        ii = (ps / path.ds).astype(int) % path.n
        for i, d_ in zip(ii, pd):
            if d_ > 0 and d_ - 6 < left_off[i]:
                left_off[i] = max(circ.left[i] + 1.5, min(left_off[i], d_ - 6.5))
            if d_ < 0 and d_ + 6 > right_off[i]:
                right_off[i] = min(circ.right[i] - 1.5, max(right_off[i], d_ + 6.5))
    barriers = {"left": left_off.astype(np.float32), "right": right_off.astype(np.float32)}

    # roads as renderable ribbons near the circuit (farther roads live in the landcover raster)
    r_offs, r_xy, r_w, r_k = [0], [], [], []
    for xy, wdt, cls, bridge in road_lines:
        if wdt < 5:
            continue
        pts = densify(xy, 8.0)
        if len(pts) < 2:
            continue
        r_xy.append(pts.astype(np.float32))
        r_offs.append(r_offs[-1] + len(pts))
        r_w.append(wdt)
        r_k.append(1 if bridge else 0)
    roads = {"offsets": np.array(r_offs, np.uint32), "xy": np.vstack(r_xy) if r_xy else np.zeros((0, 2), np.float32),
             "width": np.array(r_w, np.float32), "kind": np.array(r_k, np.uint8)}

    return World(datum=datum, extent=(float(x0), float(y0), float(size)), terrain=terrain, landcover_png=buf.getvalue(),
                 lc_res=R, bld=bld, trees=trees, stands=stands, barriers=barriers, roads=roads,
                 attribution=["© OpenStreetMap contributors (ODbL)", "Terrain: Mapzen Terrain Tiles / AWS Open Data"]), z_offset


def _generic_stands(circ: Circuit, bmask, lc, x0, y0, size, px, R, h_at):
    """Place grandstands along the main straight (opposite the pits) and outside of slow corners."""
    path = circ.path
    stands = []
    pit_side = circ.pit.get("side", "left")
    main_side = "right" if pit_side == "left" else "left"
    L = path.length
    ptree = cKDTree(path.pts[:, :2])

    def clear(s0, s1, side, off, depth):
        ss = np.arange(s0, s1, 4.0)
        sign = 1 if side == "left" else -1
        edge = circ.left if side == "left" else circ.right
        for dd in (off, off + depth / 2, off + depth):
            p = path.point_at(ss, edge[path.index_at(ss)] + sign * dd)[:, :2]
            ix = np.clip(((p[:, 0] - x0) * px).astype(int), 0, R - 1)
            iy = np.clip(((y0 + size - p[:, 1]) * px).astype(int), 0, R - 1)
            if bmask[iy, ix].any() or np.isin(lc[iy, ix], [3, 4]).mean() > 0.2:
                return False
            # stay away from every other part of the track (and the pit lane)
            dist, j = ptree.query(p)
            far_s = np.abs(((path.s[j % path.n] - ss + L / 2) % L) - L / 2) > 150
            if ((dist < max(10.0, dd - 2)) & far_s).any():
                return False
        return True

    cands = [(-260.0, 120.0, main_side, 16.0, 26.0, 16.0, "main")]
    # slow corners: outside
    k = circ.curvature
    for c in circ.corners:
        i = path.index_at(c["s"])
        kk = k[i]
        if abs(kk) < 1 / 70:
            continue
        side = "right" if kk > 0 else "left"
        cands.append((c["s"] - 60, c["s"] + 70, side, 30.0, 18.0, 10.0, f"T{c['label']}"))
    for s0, s1, side, off, depth, height, name in cands:
        if clear(s0, s1, side, off, depth):
            stands.append({"s0": s0 % L if s0 >= 0 else s0 + L, "s1": s1 % L, "side": side, "offset": off,
                           "depth": depth, "height": height, "name": name, "source": "generic"})
    return stands
