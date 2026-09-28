"""Local tangent-plane (ENU) projection around a geographic origin.

For circuit-sized areas (< 10 km) a local ellipsoidal tangent plane is accurate
to centimetres, which is far below FastF1's positional precision.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)


@dataclass(frozen=True)
class LocalFrame:
    lat0: float
    lon0: float

    @property
    def _radii(self):
        phi = math.radians(self.lat0)
        s = math.sin(phi)
        rn = _A / math.sqrt(1 - _E2 * s * s)  # prime vertical
        rm = _A * (1 - _E2) / (1 - _E2 * s * s) ** 1.5  # meridional
        return rm, rn * math.cos(phi)

    def to_local(self, lat, lon):
        rm, rp = self._radii
        x = np.radians(np.asarray(lon) - self.lon0) * rp
        y = np.radians(np.asarray(lat) - self.lat0) * rm
        return x, y

    def to_geo(self, x, y):
        rm, rp = self._radii
        lon = self.lon0 + np.degrees(np.asarray(x) / rp)
        lat = self.lat0 + np.degrees(np.asarray(y) / rm)
        return lat, lon

    def to_json(self):
        return {"lat0": self.lat0, "lon0": self.lon0, "crs": "local-ENU (x=east, y=north, z=up, metres)"}
