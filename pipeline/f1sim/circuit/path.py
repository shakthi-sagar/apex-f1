"""Closed reference-path geometry + robust (s, d) projection.

The reference path is a closed 3D polyline sampled every `ds` metres. Every car
position is expressed as (s, d): arc length along the path and signed lateral
offset (positive = left of travel direction). This gives the renderer a smooth,
noise-free frame for vehicle motion while keeping the measured lateral line.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree


def circular_smooth(v: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return v
    return gaussian_filter1d(v, sigma, axis=0, mode="wrap")


def resample_closed(pts: np.ndarray, ds: float) -> np.ndarray:
    """Resample a closed polyline (n,k) at uniform arc length."""
    closed = np.vstack([pts, pts[:1]])
    seg = np.linalg.norm(np.diff(closed[:, :2], axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    L = cum[-1]
    n = max(8, int(round(L / ds)))
    s = np.linspace(0, L, n, endpoint=False)
    return np.stack([np.interp(s, cum, closed[:, i]) for i in range(pts.shape[1])], axis=1)


@dataclass
class ClosedPath:
    pts: np.ndarray  # (n,3) x,y,z metres (ENU: x east, y north, z up)
    ds: float

    def __post_init__(self):
        p = self.pts
        n = len(p)
        nxt = np.roll(p, -1, axis=0)
        seg = np.linalg.norm((nxt - p)[:, :2], axis=1)
        self.s = np.concatenate([[0], np.cumsum(seg[:-1])])
        self.length = float(seg.sum())
        t = np.roll(p, -1, axis=0) - np.roll(p, 1, axis=0)
        t = t[:, :2] / np.linalg.norm(t[:, :2], axis=1, keepdims=True)
        self.tan = t
        self.nrm = np.stack([-t[:, 1], t[:, 0]], axis=1)  # left normal
        self.tree = cKDTree(p[:, :2])
        self.n = n

    # ---- geometry queries -------------------------------------------------
    def wrap(self, s):
        return np.mod(s, self.length)

    def index_at(self, s):
        return np.searchsorted(self.s, self.wrap(s), side="right") - 1

    def point_at(self, s, d=0.0):
        s = self.wrap(np.asarray(s, dtype=np.float64))
        i = np.clip(np.searchsorted(self.s, s, side="right") - 1, 0, self.n - 1)
        j = (i + 1) % self.n
        seglen = np.where(j == 0, self.length - self.s[i], self.s[j] - self.s[i])
        f = (s - self.s[i]) / np.maximum(seglen, 1e-9)
        p = self.pts[i] + (self.pts[j] - self.pts[i]) * f[..., None]
        nrm = self.nrm[i] + (self.nrm[j] - self.nrm[i]) * f[..., None]
        nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
        out = p.copy()
        out[..., :2] += nrm * np.asarray(d)[..., None]
        return out

    def curvature(self, sigma_m: float = 6.0) -> np.ndarray:
        ang = np.unwrap(np.arctan2(self.tan[:, 1], self.tan[:, 0]))
        # heading derivative w.r.t. arc length (handle wrap discontinuity by differencing)
        dang = np.diff(np.concatenate([ang, ang[:1] + (ang[-1] - ang[0] + (ang[1] - ang[0]))]))
        dang = (dang + np.pi) % (2 * np.pi) - np.pi
        k = dang / self.ds
        return circular_smooth(k, sigma_m / self.ds)

    # ---- projection -------------------------------------------------------
    def project_nearest(self, xy: np.ndarray, max_dist: float = np.inf):
        """Unconstrained projection (for dense clouds). Returns s, d, dist."""
        dist, i = self.tree.query(xy, k=1, distance_upper_bound=max_dist)
        ok = np.isfinite(dist)
        i = np.where(ok, i, 0)
        rel = xy - self.pts[i, :2]
        along = np.einsum("ij,ij->i", rel, self.tan[i])
        d = np.einsum("ij,ij->i", rel, self.nrm[i])
        s = self.wrap(self.s[i] + along)
        return s, d, np.where(ok, dist, np.inf)

    def project_sequence(self, t: np.ndarray, xy: np.ndarray, speed_ms: np.ndarray | None = None,
                         k: int = 24, radius: float = 120.0, s0: float | None = None):
        """Continuity-aware projection of a time-ordered trajectory.

        Near crossings / parallel sections (pit lane next to the straight) the
        nearest path vertex can belong to the wrong part of the circuit, so we
        choose among k nearest candidates the one most consistent with the
        previous arc position advanced by the measured speed.
        Returns unwrapped cumulative s, lateral d.
        """
        n = len(t)
        dist, idx = self.tree.query(xy, k=k, distance_upper_bound=radius)
        s_out = np.full(n, np.nan)
        d_out = np.full(n, np.nan)
        prev = s0
        prev_t = None
        L = self.length
        for m in range(n):
            ok = np.isfinite(dist[m])
            if not ok.any():
                prev = None
                continue
            cand = idx[m][ok]
            cd = dist[m][ok]
            rel = xy[m] - self.pts[cand, :2]
            along = np.einsum("ij,ij->i", rel, self.tan[cand])
            cs = self.s[cand] + along
            if prev is None:
                j = int(np.argmin(cd))
                cum = cs[j] + (np.floor(s0 / L) * L if s0 is not None else 0)
            else:
                dt = t[m] - prev_t
                v = speed_ms[m] if speed_ms is not None else 60.0
                expect = prev + v * dt
                # candidate cumulative positions nearest to expectation
                cum_c = cs + np.round((expect - cs) / L) * L
                err = np.abs(cum_c - expect)
                cost = err + 2.0 * cd
                j = int(np.argmin(cost))
                cum = cum_c[j]
                if err[j] > max(60.0, 3 * v * dt):  # lost track -> re-acquire nearest
                    j = int(np.argmin(cd))
                    cum = cs[j] + np.round((expect - cs[j]) / L) * L
            s_out[m] = cum
            rel = xy[m] - self.pts[cand[j], :2]
            d_out[m] = rel @ self.nrm[cand[j]]
            prev, prev_t = cum, t[m]
        return s_out, d_out


def refine_path_from_cloud(path: ClosedPath, xyz: np.ndarray, iterations: int = 4,
                           accept: float = 14.0, bin_m: float = 2.0, sigma_m: float = 5.0) -> ClosedPath:
    """Move the path onto the robust median of a dense cloud of car positions."""
    for it in range(iterations):
        s, d, dist = path.project_nearest(xyz[:, :2], max_dist=accept)
        ok = np.isfinite(dist)
        s, d, z = s[ok], d[ok], xyz[ok, 2]
        nb = int(np.ceil(path.length / bin_m))
        b = np.minimum((s / bin_m).astype(int), nb - 1)
        med_d = np.zeros(nb)
        med_z = np.zeros(nb)
        cnt = np.bincount(b, minlength=nb)
        order = np.argsort(b, kind="stable")
        starts = np.concatenate([[0], np.cumsum(cnt)])
        for i in range(nb):
            sl = order[starts[i] : starts[i + 1]]
            if len(sl) >= 3:
                med_d[i] = np.median(d[sl])
                med_z[i] = np.median(z[sl])
            else:
                med_d[i] = np.nan
                med_z[i] = np.nan
        for arr in (med_d, med_z):
            bad = np.isnan(arr)
            if bad.any():
                xs = np.arange(nb)
                arr[bad] = np.interp(xs[bad], xs[~bad], arr[~bad], period=nb)
        med_d = circular_smooth(med_d, sigma_m / bin_m)
        med_z = circular_smooth(med_z, 2 * sigma_m / bin_m)
        bs = (np.arange(nb) + 0.5) * bin_m
        dd = np.interp(path.s, bs, med_d, period=path.length)
        zz = np.interp(path.s, bs, med_z, period=path.length)
        new = path.pts.copy()
        new[:, :2] += path.nrm * dd[:, None]
        new[:, 2] = zz
        new = resample_closed(new, path.ds)
        new[:, :2] = circular_smooth(new[:, :2], 1.5)
        path = ClosedPath(new, path.ds)
        accept = max(9.0, accept * 0.8)
    return path
