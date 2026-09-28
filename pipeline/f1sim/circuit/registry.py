"""Hand-curated per-layout knowledge that the timing data cannot provide.

Keyed by Ergast circuit id. Everything is optional; unknown circuits fall back
to DEFAULT. `layout` identifies a physical track configuration: races on the
same layout share the circuit/world artifacts and the registration.

anchors: optional manual registration pairs [[ff_x, ff_y, lat, lon], ...] in raw
         FastF1 units -> overrides automatic OSM ICP when >= 2 are given.
drs:     zones as [start, end] specs; "C<n>+<m>" = corner n arc position + m metres.
theme:   art direction consumed by the renderer (see web/src/scene/theme.ts).
"""

from __future__ import annotations

DEFAULT = {
    "layout": "default",
    "street": False,
    "track_width": 13.0,
    "straight_width": 15.0,
    "osm_radius": 2200,
    "anchors": [],
    "drs": [],
    "theme": {
        "biome": "temperate",
        "palette": {"grass": "#4d6b34", "soil": "#7a6a4f", "building": "#c9c4ba", "accent": "#e10600"},
        "vegetation_density": 0.6,
        "haze": 0.35,
        "night": False,
    },
}

CIRCUITS: dict[str, dict] = {
    "interlagos": {
        "layout": "2024",
        "track_width": 13.5,
        "straight_width": 16.0,
        "osm_radius": 2300,
        "drs": [["C14+120", "C1-110"], ["C3+90", "C4-130"]],
        "theme": {
            "biome": "subtropical-urban",
            "palette": {"grass": "#4a6b2c", "soil": "#8a4f32", "building": "#d8d2c4", "accent": "#009c3b"},
            "vegetation_density": 0.8,
            "haze": 0.55,
            "night": False,
            "notes": "Red laterite soil, dense low-rise São Paulo favela/urban ring, lake by Descida do Lago.",
        },
    },
    "marina_bay": {
        "layout": "2023",
        "street": True,
        "track_width": 12.0,
        "straight_width": 14.0,
        "osm_radius": 2000,
        "theme": {"biome": "tropical-city", "palette": {"grass": "#3d6b3a", "soil": "#6b5a45", "building": "#9aa3ad",
                                                        "accent": "#ff2a6d"}, "vegetation_density": 0.5,
                  "haze": 0.6, "night": True},
    },
    "monaco": {
        "layout": "2015",
        "street": True,
        "track_width": 10.0,
        "straight_width": 11.5,
        "osm_radius": 1600,
        "theme": {"biome": "mediterranean", "palette": {"grass": "#587a3a", "soil": "#9b8563", "building": "#e8d9bf",
                                                         "accent": "#ce1126"}, "vegetation_density": 0.4, "haze": 0.3,
                  "night": False},
    },
    "bahrain": {
        "layout": "gp",
        "track_width": 15.0,
        "straight_width": 18.0,
        "theme": {"biome": "desert", "palette": {"grass": "#a89060", "soil": "#c9a36a", "building": "#d9c9a8",
                                                  "accent": "#ce1126"}, "vegetation_density": 0.05, "haze": 0.5,
                  "night": True},
    },
    "yas_marina": {
        "layout": "2021",
        "track_width": 15.0,
        "straight_width": 17.0,
        "theme": {"biome": "desert-coastal", "palette": {"grass": "#6a7a3a", "soil": "#d0b27a", "building": "#e0dcd4",
                                                          "accent": "#00a3e0"}, "vegetation_density": 0.15,
                  "haze": 0.45, "night": True},
    },
    "spa": {
        "layout": "2007",
        "track_width": 12.5,
        "straight_width": 14.0,
        "osm_radius": 2800,
        "theme": {"biome": "forest", "palette": {"grass": "#3f6a2c", "soil": "#5b4a36", "building": "#bdb8ae",
                                                  "accent": "#fdda24"}, "vegetation_density": 1.0, "haze": 0.6,
                  "night": False},
    },
    "silverstone": {
        "layout": "2011",
        "track_width": 15.0,
        "straight_width": 17.0,
        "osm_radius": 2600,
        "theme": {"biome": "temperate-open", "palette": {"grass": "#51772f", "soil": "#7a6a4f", "building": "#c9c4ba",
                                                          "accent": "#012169"}, "vegetation_density": 0.35,
                  "haze": 0.45, "night": False},
    },
    "baku": {"layout": "2016", "street": True, "track_width": 11.5, "straight_width": 13.0,
             "theme": {"biome": "desert-coastal-city", "palette": {"grass": "#6f7a45", "soil": "#b39a72", "building": "#d8c7a6",
                                                                     "accent": "#00b5e2"}, "vegetation_density": 0.15, "haze": 0.4, "night": False}},
    "jeddah": {"layout": "2021", "street": True, "track_width": 12.5, "straight_width": 14.0,
               "theme": {"biome": "desert-coastal", "palette": {"grass": "#7a8050", "soil": "#cdb487", "building": "#e3dccd",
                                                                 "accent": "#1f8f4e"}, "vegetation_density": 0.08, "haze": 0.5, "night": True}},
    "vegas": {"layout": "2023", "street": True, "track_width": 13.0, "straight_width": 15.0,
              "theme": {"biome": "desert-city", "palette": {"grass": "#8a8058", "soil": "#c2a878", "building": "#b8bcc4",
                                                             "accent": "#e40046"}, "vegetation_density": 0.05, "haze": 0.3, "night": True}},
}


def get(circuit_ref: str) -> dict:
    cfg = {**DEFAULT, **CIRCUITS.get(circuit_ref, {})}
    cfg["theme"] = {**DEFAULT["theme"], **CIRCUITS.get(circuit_ref, {}).get("theme", {})}
    return cfg


def resolve_arc(spec: str, corners: list[dict], length: float) -> float | None:
    """'C14+120' -> arc position of corner 14 plus 120 m."""
    import re

    m = re.fullmatch(r"C(\d+)([a-z]?)([+-]\d+(?:\.\d+)?)?", spec)
    if not m:
        return None
    num, letter, off = int(m.group(1)), m.group(2) or "", float(m.group(3) or 0)
    for c in corners:
        if c["number"] == num and (c.get("letter") or "") == letter:
            return (c["s"] + off) % length
    return None
