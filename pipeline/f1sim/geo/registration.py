"""FastF1 <-> geographic registration.

FastF1 positions live in an arbitrary, unpublished per-circuit frame (units of
1/10 m, unknown rotation/offset, occasionally mirrored). OSM mapped the circuit
as `highway=raceway` ways. We estimate a 2D similarity transform

    enu = scale * R(theta) * M * ff + t          (M = optional mirror)

by global search over rotation (and mirror) followed by trimmed ICP with a
closed-form Umeyama similarity solve. If manual anchors (>= 2 pairs of FastF1
point <-> lat/lon) are configured for a layout they take precedence.

Elevation: FastF1 Z is relative; its offset to the DEM is solved later
(see circuit.world) and stored alongside.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass

import numpy as np
from scipy.spatial import cKDTree

log = logging.getLogger(__name__)


@dataclass
class Registration:
    scale: float
    theta: float  # radians
    mirror: bool
    tx: float
    ty: float
    z_scale: float
    z_offset: float
    rms: float  # metres, residual of FastF1 line vs OSM raceway
    inlier_ratio: float
    method: str  # "icp-osm" | "anchors" | "fallback"

    def matrix(self) -> np.ndarray:
        c, s = np.cos(self.theta), np.sin(self.theta)
        R = np.array([[c, -s], [s, c]])
        M = np.diag([1, -1]) if self.mirror else np.eye(2)
        return self.scale * R @ M

    def apply(self, xyz: np.ndarray) -> np.ndarray:
        out = np.empty_like(xyz, dtype=np.float64)
        out[:, :2] = xyz[:, :2] @ self.matrix().T + [self.tx, self.ty]
        out[:, 2] = xyz[:, 2] * self.z_scale + self.z_offset
        return out

    def to_json(self):
        d = asdict(self)
        d["theta_deg"] = float(np.degrees(self.theta))
        return d


def _umeyama(src: np.ndarray, dst: np.ndarray, allow_reflection: bool = False):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(2)
    if not allow_reflection and np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[1, 1] = -1
    R = U @ S @ Vt
    var = (xs**2).sum() / len(src)
    scale = np.trace(np.diag(D) @ S) / var
    t = mu_d - scale * R @ mu_s
    return scale, R, t


def _icp(src, tree, dst, A, t, iters=60, trim=0.8, fixed_scale: float | None = None, reflect: bool = False):
    """ICP. A = scale*R (2x2), t (2,). With fixed_scale the solve is rigid (rotation + translation);
    FastF1 units are decimetres, so a known scale makes registration far more robust (street circuits).
    Returns A, t, rms, inlier ratio."""
    M = np.diag([1, -1]) if reflect else np.eye(2)
    for _ in range(iters):
        cur = src @ A.T + t
        dist, idx = tree.query(cur)
        keep = dist <= np.quantile(dist, trim)
        if fixed_scale is not None:
            s_src = (src[keep] @ M.T) * fixed_scale
            _, R, _ = _umeyama(s_src, dst[idx[keep]])
            R = R  # rotation only
            A_new = fixed_scale * R @ M
            t_new = dst[idx[keep]].mean(0) - (src[keep] @ A_new.T).mean(0)
            if np.allclose(A_new, A, atol=1e-8) and np.allclose(t_new, t, atol=1e-4):
                A, t = A_new, t_new
                break
            A, t = A_new, t_new
            continue
        sc, R, tt = _umeyama(src[keep], dst[idx[keep]])
        # compose: new transform maps src directly
        A_new, t_new = sc * R, tt
        if np.allclose(A_new, A, atol=1e-7) and np.allclose(t_new, t, atol=1e-4):
            A, t = A_new, t_new
            break
        A, t = A_new, t_new
    cur = src @ A.T + t
    dist, _ = tree.query(cur)
    return A, t, float(np.sqrt(np.mean(np.minimum(dist, 20) ** 2))), float(np.mean(dist < 4.0))


def register_to_osm(ff_xy: np.ndarray, osm_xy: np.ndarray, expected_scale: float = 0.1, fixed_scale: bool = True,
                    search_radius: float = 1800.0) -> Registration:
    """ff_xy: FastF1 racing line points (raw units). osm_xy: densified raceway/road points (local metres).

    Global search over rotation x translation (a dense road grid has many local optima), then ICP on
    the best candidates. FastF1 frames have so far been north-aligned, so rotations near 0 are searched
    finely and preferred slightly; the full circle is still searched as a fallback.
    """
    tree = cKDTree(osm_xy)
    src_c = ff_xy - ff_xy.mean(0)
    sub = src_c[:: max(1, len(src_c) // 80)]
    steps = np.arange(-search_radius, search_radius + 1, 40.0)
    TX, TY = np.meshgrid(steps, steps)
    T = np.stack([TX.ravel(), TY.ravel()], 1)
    rots = sorted(set([float(x) for x in np.arange(-20, 21, 2)] + [float(x) for x in np.arange(0, 360, 6)]))
    cands = []
    for mirror in (False, True):
        M = np.diag([1, -1]) if mirror else np.eye(2)
        for deg in rots:
            th = np.radians(deg)
            A = expected_scale * np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]]) @ M
            p = sub @ A.T  # (k,2)
            q = (p[None, :, :] + T[:, None, :]).reshape(-1, 2)
            dist, _ = tree.query(q, distance_upper_bound=60.0)
            score = np.minimum(dist, 60.0).reshape(len(T), len(sub)).mean(1)
            j = int(np.argmin(score))
            cands.append((float(score[j]), mirror, deg, A, T[j].copy()))
    cands.sort(key=lambda c: c[0])
    best = None
    for score0, mirror, deg, A, t in cands[:8]:
        A2, t2, rms, inl = _icp(src_c, tree, osm_xy, A, t, fixed_scale=expected_scale if fixed_scale else None, reflect=bool(mirror))
        M = np.diag([1, -1]) if mirror else np.eye(2)
        AM = A2 @ M
        theta = float(np.arctan2(AM[1, 0], AM[0, 0]))
        prior = min(abs(np.degrees(theta)), 360 - abs(np.degrees(theta))) / 90.0
        cost = rms - 6.0 * inl + prior + (1.5 if mirror else 0.0)
        log.debug("cand deg=%.1f mirror=%s -> theta=%.2f rms=%.2f inl=%.2f cost=%.2f", deg, mirror, np.degrees(theta), rms, inl, cost)
        if best is None or cost < best[0]:
            best = (cost, mirror, A2, t2, rms, inl, theta)
    _, mirror, A, t, rms, inl, theta = best
    M = np.diag([1, -1]) if mirror else np.eye(2)
    scale = float(np.sqrt(abs(np.linalg.det(A @ M))))
    t_full = t - A @ ff_xy.mean(0)
    reg = Registration(scale=scale, theta=theta, mirror=bool(mirror), tx=float(t_full[0]), ty=float(t_full[1]),
                       z_scale=scale, z_offset=0.0, rms=rms, inlier_ratio=inl, method="icp-osm")
    log.info("registration: scale=%.5f theta=%.2f° mirror=%s rms=%.2fm inliers=%.0f%%",
             scale, np.degrees(theta), mirror, rms, inl * 100)
    return reg


def register_from_anchors(ff_xy: np.ndarray, enu_xy: np.ndarray) -> Registration:
    best = None
    for refl in (False, True):
        sc, R, t = _umeyama(ff_xy, enu_xy, allow_reflection=refl)
        res = np.linalg.norm(ff_xy @ (sc * R).T + t - enu_xy, axis=1)
        if best is None or res.mean() < best[0]:
            best = (res.mean(), sc, R, t, np.linalg.det(R) < 0, res)
    _, sc, R, t, mirror, res = best
    M = np.diag([1, -1]) if mirror else np.eye(2)
    RM = R @ M
    return Registration(scale=float(sc), theta=float(np.arctan2(RM[1, 0], RM[0, 0])), mirror=bool(mirror),
                        tx=float(t[0]), ty=float(t[1]), z_scale=float(sc), z_offset=0.0,
                        rms=float(np.sqrt(np.mean(res**2))), inlier_ratio=1.0, method="anchors")


def fallback(expected_scale: float = 0.1, rotation_deg: float = 0.0) -> Registration:
    return Registration(scale=expected_scale, theta=np.radians(rotation_deg), mirror=False, tx=0, ty=0,
                        z_scale=expected_scale, z_offset=0.0, rms=float("nan"), inlier_ratio=0.0, method="fallback")
