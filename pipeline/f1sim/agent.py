"""Pull-based generator agent.

    F1SIM_AGENT_TOKEN=... python -m f1sim.agent --api https://apex.shadster.dev/api

Polls the Worker for queued race jobs, runs the pipeline locally and streams stage
progress back. Needs only outbound HTTPS (plus R2 credentials for uploads), so it runs on
a laptop, a VPS or in CI. The same job protocol is used by the Container mode.
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import time
import traceback

import requests

from .generate import generate
from .storage import Store

log = logging.getLogger("f1sim.agent")


class Reporter:
    def __init__(self, api: str, token: str, season: int, rnd: int):
        self.api, self.token, self.season, self.round = api, token, season, rnd
        self.last = 0.0
        self.stage = None

    def post(self, **fields):
        body = {"season": self.season, "round": self.round, **fields}
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
        self.post(state=stage, stage=stage, progress=round(frac, 3), message=msg)


def run(api: str, token: str, seasons: str, once: bool, cache_root: str):
    name = f"{socket.gethostname()}-{os.getpid()}"
    log.info("agent %s polling %s (seasons %s)", name, api, seasons)
    while True:
        try:
            r = requests.post(f"{api}/agent/next", params={"seasons": seasons, "agent": name},
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
        elif once:
            return
        time.sleep(3 if job else 10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=os.environ.get("F1SIM_API", "https://apex.shadster.dev/api"))
    ap.add_argument("--seasons", default="2024")
    ap.add_argument("--once", action="store_true", help="exit when the queue is empty")
    a = ap.parse_args()
    token = os.environ.get("F1SIM_AGENT_TOKEN")
    if not token:
        raise SystemExit("F1SIM_AGENT_TOKEN is required")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("fastf1").setLevel(logging.WARNING)
    run(a.api.rstrip("/"), token, a.seasons, a.once, os.environ.get("F1SIM_CACHE", os.path.expanduser("~/.cache/f1sim")))


if __name__ == "__main__":
    main()
