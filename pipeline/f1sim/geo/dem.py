"""Terrain elevation from open Terrarium DEM tiles (AWS Open Data / Mapzen).

Source attribution: Mapzen Terrain Tiles (SRTM, GMTED, NED, ETOPO1 and others),
hosted on AWS Open Data. Heights are metres above sea level.
"""

from __future__ import annotations

import io
import logging
import os

import numpy as np
import requests
from PIL import Image
from scipy.ndimage import map_coordinates

from .proj import LocalFrame

log = logging.getLogger(__name__)
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def _tile_xy(lat, lon, z):
    n = 2**z
    x = (lon + 180) / 360 * n
    y = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
    return x, y


def _tile(z, x, y, cache_dir) -> np.ndarray:
    p = os.path.join(cache_dir, f"{z}_{x}_{y}.png")
    if not os.path.exists(p):
        import time

        for attempt in range(6):
            try:
                r = requests.get(TILE_URL.format(z=z, x=x, y=y), timeout=60)
                r.raise_for_status()
                break
            except requests.RequestException as e:
                if attempt == 5:
                    raise
                log.warning("DEM tile %s/%s/%s failed (%s), retrying", z, x, y, e)
                time.sleep(3 * 2**attempt)
        with open(p, "wb") as f:
            f.write(r.content)
    im = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
    return im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768


def sample_grid(frame: LocalFrame, x0: float, y0: float, size: float, n: int, cache_dir: str, z: int = 14) -> np.ndarray:
    """Heights on an n x n grid covering [x0, x0+size] x [y0, y0+size] (local metres). Row = y."""
    os.makedirs(cache_dir, exist_ok=True)
    xs = np.linspace(x0, x0 + size, n)
    ys = np.linspace(y0, y0 + size, n)
    gx, gy = np.meshgrid(xs, ys)
    lat, lon = frame.to_geo(gx, gy)
    fx, fy = _tile_xy(lat, lon, z)
    tx0, tx1 = int(np.floor(fx.min())), int(np.floor(fx.max()))
    ty0, ty1 = int(np.floor(fy.min())), int(np.floor(fy.max()))
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mosaic[(ty - ty0) * 256 : (ty - ty0 + 1) * 256, (tx - tx0) * 256 : (tx - tx0 + 1) * 256] = _tile(z, tx, ty, cache_dir)
    px = (fx - tx0) * 256 - 0.5
    py = (fy - ty0) * 256 - 0.5
    return map_coordinates(mosaic, [py, px], order=1, mode="nearest")
