"""Core algorithm tests (no network): SimBin, registration, path projection, solar position."""

import math
import os
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from f1sim import binfmt  # noqa: E402
from f1sim.circuit.path import ClosedPath, resample_closed  # noqa: E402
from f1sim.environment import solar_position  # noqa: E402
from f1sim.geo import registration  # noqa: E402


def _loop(n=4000):
    """A closed test circuit with no mirror symmetry (metres), densely sampled."""
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    x = 600 * np.cos(t) + 120 * np.cos(3 * t) + 80 * np.sin(2 * t)
    y = 380 * np.sin(t) + 90 * np.sin(2 * t) + 60 * np.cos(3 * t)
    return np.stack([x, y], 1)


def test_simbin_roundtrip():
    arrays = {"a": np.arange(10, dtype=np.float32), "b": np.array([[1, 2], [3, 4]], dtype=np.int16),
              "c": np.array([255, 0, 7], dtype=np.uint8)}
    meta, out = binfmt.unpack(binfmt.gz(binfmt.pack(arrays, {"k": 1})))
    assert meta == {"k": 1}
    for k, v in arrays.items():
        assert out[k].dtype == v.dtype and np.array_equal(out[k], v)


def test_registration_recovers_known_transform():
    enu = _loop()
    theta, t = np.radians(1.3), np.array([250.0, -140.0])
    R = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    ff = (enu - t) @ R / 0.1  # inverse of enu = 0.1 * R @ ff + t
    reg = registration.register_to_osm(ff[::30], enu, search_radius=600)
    assert abs(reg.scale - 0.1) < 1e-6
    assert abs(math.degrees(reg.theta) - 1.3) < 0.3
    assert reg.rms < 1.0 and not reg.mirror


def test_registration_handles_mirrored_frame():
    enu = _loop()
    ff = enu.copy() / 0.1
    ff[:, 1] *= -1  # mirrored source frame
    reg = registration.register_to_osm(ff[::30], enu, search_radius=600)
    assert reg.mirror and reg.rms < 1.0


def test_projection_is_continuous_and_signed():
    pts = resample_closed(np.column_stack([_loop(), np.zeros(4000)]), 1.0)
    path = ClosedPath(pts, 1.0)
    # drive two laps 2 m left of the line at 60 m/s
    s_true = np.arange(0, 2 * path.length, 15.0)
    xy = path.point_at(s_true, 2.0)[:, :2]
    s, d = path.project_sequence(s_true / 60.0, xy, np.full(len(s_true), 60.0))
    assert np.all(np.diff(s) > 0), "cumulative s must be monotonic across the lap wrap"
    assert np.allclose(d, 2.0, atol=0.2)
    assert abs((s[-1] - s[0]) - (s_true[-1] - s_true[0])) < 5.0


def test_solar_position_sanity():
    # Interlagos, 2024-11-03 15:50 UTC (12:50 local): sun high in the sky, northern azimuth (southern hemisphere)
    az, el = solar_position(datetime(2024, 11, 3, 15, 50, tzinfo=timezone.utc), -23.7036, -46.6997)
    assert el > 60
    # Singapore 20:00 local (12:00 UTC): sun below the horizon
    _, el2 = solar_position(datetime(2024, 9, 22, 12, 0, tzinfo=timezone.utc), 1.2914, 103.864)
    assert el2 < -10
