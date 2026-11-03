"""Pull-based generator agent.

    F1SIM_AGENT_TOKEN=... python -m f1sim.agent --api https://apex.shadster.dev/api
    F1SIM_AGENT_TOKEN=... python -m f1sim.agent --season 2024 --round 21     # one race, then exit (GitHub Actions)

Polls the Worker for queued race jobs, runs the pipeline locally and streams stage
progress back. Needs only outbound HTTPS (plus R2 credentials for uploads), so it runs on
a laptop, a VPS or in CI. The same job protocol is used by the Container mode.
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import threading
import time
import traceback

import requests

from .generate import generate
from .storage import Store

log = logging.getLogger("f1sim.agent")
AGENT_NAME = f"{socket.gethostname()}-{os.getpid()}"


class Reporter:
    """Streams progress to the Worker, plus a heartbeat so long stages (e.g. slow Overpass retries)
    are never mistaken for an abandoned job and re-claimed by another agent."""

    HEARTBEAT_S = 45

    def __init__(self, api: str, token: str, season: int, rnd: int):
        self.api, self.token, self.season, self.round = api, token, season, rnd
        self.last = 0.0
        self.stage = None
        self.fields: dict = {}
        self._stop = threading.Event()
        threading.Thread(target=self._beat, daemon=True).start()

    def _beat(self):
        while not self._stop.wait(self.HEARTBEAT_S):
            if self.fields:
                self.post(**self.fields)

    def close(self):
        self._stop.set()

    def post(self, **fields):
        body = {"season": self.season, "round": self.round, "agent": AGENT_NAME, **fields}
        try:
            requests.post(f"{self.api}/agent/progress", json=body, headers={"authorization": f"Bearer {self.token}"}, timeout=20)
        except requests.RequestException as e:  # keep generating even if a report is lost
            log.warning("progress report failed: %s", e)

    def progress(self, stage: str, frac: float, msg: str):
        log.info("[%s %3.0f%%] %s", stage, frac * 100, msg)
        now = time.time()
        if now - self.last < 1.0 and frac < 1.0 and stage == self.stage:
            return
        self.last = now
        self.stage = stage
        self.fields = dict(state=stage, stage=stage, progress=round(frac, 3), message=msg)
        self.post(**self.fields)


def run_one(api: str, token: str, season: int, rnd: int, cache_root: str) -> bool:
    """Generate exactly one race (GitHub Actions: the Worker dispatched this run), reporting progress to the Worker."""
    rep = Reporter(api, token, season, rnd)
    try:
        manifest = generate(season, rnd, Store(local_root=None, upload=True), progress=rep.progress, cache_root=cache_root)
        rep.post(state="ready", stage="ready", progress=1.0, message="Ready", manifest=manifest)
        return True
    except Exception as e:  # noqa: BLE001
        log.error("job failed: %s", traceback.format_exc())
        rep.post(state="failed", stage="failed", message="Generation failed", error=f"{type(e).__name__}: {e}")
        return False
    finally:
        rep.close()


def _seasons(api: str, fixed: str, cache: dict) -> str:
    """Explicit --seasons, else every season with a published catalog (refreshed every 10 min)."""
    if fixed:
        return fixed
    if time.time() - cache.get("at", 0) > 600:
        try:
            cache["v"] = ",".join(str(y) for y in requests.get(f"{api}/seasons", timeout=20).json()["seasons"]) or "2024"
            cache["at"] = time.time()
        except requests.RequestException as e:
            log.warning("season list unavailable: %s", e)
    return cache.get("v", "2024")


def run(api: str, token: str, seasons: str, once: bool, cache_root: str):
    name = AGENT_NAME
    cache: dict = {}
    log.info("agent %s polling %s (seasons %s)", name, api, seasons or "auto")
    while True:
        try:
            r = requests.post(f"{api}/agent/next", params={"seasons": _seasons(api, seasons, cache), "agent": name},
                              headers={"authorization": f"Bearer {token}"}, timeout=30)
            r.raise_for_status()
            job = r.json()
        except requests.RequestException as e:
            log.warning("poll failed: %s", e)
            job = None
        if job:
            season, rnd = int(job["season"]), int(job["round"])
            rep = Reporter(api, token, season, rnd)
            log.info("claimed %d round %d", season, rnd)
            try:
                manifest = generate(season, rnd, Store(local_root=None, upload=True), progress=rep.progress, cache_root=cache_root)
                rep.post(state="ready", stage="ready", progress=1.0, message="Ready", manifest=manifest)
            except Exception as e:  # noqa: BLE001
                log.error("job failed: %s", traceback.format_exc())
                rep.post(state="failed", stage="failed", message="Generation failed", error=f"{type(e).__name__}: {e}")
            finally:
                rep.close()
        elif once:
            return
        time.sleep(3 if job else 10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("F1SIM_API", "https://apex.shadster.dev/api"))
    ap.add_argument("--seasons", default="", help="comma list; default: every season with a catalog")
    ap.add_argument("--once", action="store_true", help="exit when the queue is empty")
    ap.add_argument("--season", type=int, help="run exactly this race, then exit (with --round)")
    ap.add_argument("--round", type=int)
    a = ap.parse_args()
    token = os.environ.get("F1SIM_AGENT_TOKEN")
    if not token:
        raise SystemExit("F1SIM_AGENT_TOKEN is required")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("fastf1").setLevel(logging.WARNING)
    cache_root = os.environ.get("F1SIM_CACHE", os.path.expanduser("~/.cache/f1sim"))
    if a.season and a.round:
        raise SystemExit(0 if run_one(a.api.rstrip("/"), token, a.season, a.round, cache_root) else 1)
    run(a.api.rstrip("/"), token, a.seasons, a.once, cache_root)


if __name__ == "__main__":
    main()
