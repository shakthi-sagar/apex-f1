"""Team livery palettes (colour schemes only — no trademarks/logos are reproduced).

primary: dominant body colour, secondary: second body colour, accent: stripes/wing
endplates, number: race-number colour. Keyed by (season, FastF1 TeamName).
The web client's procedural car material uses these; glTF car assets supplied
separately (assets/cars/{season}/{teamId}.glb) take precedence when present.
"""

from __future__ import annotations

import re

LIVERIES_2024 = {
    "Red Bull Racing": dict(primary="#1b2a5c", secondary="#223971", accent="#ffc906", highlight="#e2001a", number="#ffffff", finish="satin"),
    "Ferrari": dict(primary="#dc0000", secondary="#b30000", accent="#ffeb00", highlight="#ffffff", number="#ffffff", finish="gloss"),
    "Mercedes": dict(primary="#0b0b0e", secondary="#9aa2a8", accent="#00d2be", highlight="#ffffff", number="#ffffff", finish="gloss"),
    "McLaren": dict(primary="#ff8000", secondary="#141414", accent="#47c7fc", highlight="#ffffff", number="#ffffff", finish="gloss"),
    "Aston Martin": dict(primary="#00594f", secondary="#003d36", accent="#cedc00", highlight="#ffffff", number="#ffffff", finish="satin"),
    "Alpine": dict(primary="#0055a5", secondary="#f282b4", accent="#ffffff", highlight="#0093cc", number="#ffffff", finish="gloss"),
    "Williams": dict(primary="#041e42", secondary="#00a3e0", accent="#e4002b", highlight="#ffffff", number="#ffffff", finish="satin"),
    "RB": dict(primary="#f2f2f2", secondary="#1534cc", accent="#ee1c25", highlight="#1a1a1a", number="#1534cc", finish="gloss"),
    "Kick Sauber": dict(primary="#111111", secondary="#52e252", accent="#52e252", highlight="#ffffff", number="#52e252", finish="satin"),
    "Haas F1 Team": dict(primary="#f0f0f0", secondary="#1e1e1e", accent="#e6002b", highlight="#b6babd", number="#1e1e1e", finish="gloss"),
}


# additional teams / names in other seasons (colour schemes only)
EXTRA = {
    "AlphaTauri": dict(primary="#1c2a4a", secondary="#f0f0f0", accent="#d71920", highlight="#ffffff", number="#ffffff", finish="satin"),
    "Alfa Romeo": dict(primary="#8a0a0a", secondary="#f2f2f2", accent="#111111", highlight="#ffffff", number="#ffffff", finish="gloss"),
    "Racing Bulls": dict(primary="#f2f2f2", secondary="#1634cb", accent="#e30613", highlight="#1a1a1a", number="#1634cb", finish="gloss"),
    "Audi": dict(primary="#9da2a6", secondary="#121212", accent="#e2002b", highlight="#ffffff", number="#ffffff", finish="satin"),
    "Cadillac": dict(primary="#121212", secondary="#f2f2f2", accent="#c8a24a", highlight="#ffffff", number="#ffffff", finish="gloss"),
}
ALL = {**LIVERIES_2024, **EXTRA}


def team_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def livery(season: int, team: str, team_color: str) -> dict:
    base = ALL.get(team)
    if base:
        return {**base, "teamColor": team_color}
    return dict(primary=team_color, secondary="#1a1a1a", accent="#ffffff", highlight="#ffffff", number="#ffffff",
                finish="gloss", teamColor=team_color)
