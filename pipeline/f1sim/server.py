"""Generator service (runs inside a Cloudflare Container).

    POST /jobs            {"season": 2024, "round": 21}  -> starts (or joins) a job
    GET  /jobs/{s}/{r}    -> {"state", "stage", "progress", "message", "manifest"?, "error"?}
    GET  /health

The Worker/Workflow drives it by polling; no request is held open for the duration of a
job. One container instance is addressed per race, and the service itself also refuses
to run the same race twice concurrently.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import PIPELINE_VERSION
from .generate import generate
from .storage import Store

log = logging.getLogger("f1sim.server")
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()


def _key(season: int, rnd: int) -> str:
    return f"{season}-{rnd}"


def _run(season: int, rnd: int):
    key = _key(season, rnd)

    def progress(stage: str, frac: float, msg: str):
        with LOCK:
            JOBS[key].update(state=stage, stage=stage, progress=round(float(frac), 3), message=msg, updatedAt=time.time())
        log.info("[%s] %s %.0f%% %s", key, stage, frac * 100, msg)

    try:
        store = Store(local_root=None, upload=True)
        manifest = generate(season, rnd, store, progress=progress, cache_root=os.environ.get("F1SIM_CACHE", "/tmp/f1sim"))
        with LOCK:
            JOBS[key].update(state="ready", progress=1.0, message="Ready", manifest=manifest, updatedAt=time.time())
    except Exception as e:  # noqa: BLE001
        log.error("job %s failed: %s", key, traceback.format_exc())
        with LOCK:
            JOBS[key].update(state="failed", error=f"{type(e).__name__}: {e}", message="Generation failed", updatedAt=time.time())


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter access log
        log.debug(fmt, *args)

    def do_GET(self):
        parts = [p for p in self.path.split("/") if p]
        if parts == ["health"]:
            return self._send(200, {"ok": True, "pipelineVersion": PIPELINE_VERSION, "jobs": len(JOBS)})
        if len(parts) == 3 and parts[0] == "jobs":
            key = _key(int(parts[1]), int(parts[2]))
            with LOCK:
                job = dict(JOBS.get(key) or {"state": "unavailable"})
            return self._send(200, job)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/jobs":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
            season, rnd = int(req["season"]), int(req["round"])
        except Exception:  # noqa: BLE001
            return self._send(400, {"error": "expected {season, round}"})
        if not (2018 <= season <= 2030 and 1 <= rnd <= 30):
            return self._send(400, {"error": "season/round out of range"})
        key = _key(season, rnd)
        with LOCK:
            job = JOBS.get(key)
            if job and job["state"] not in ("failed", "ready"):
                return self._send(200, job)  # idempotent: join the running job
            JOBS[key] = {"state": "queued", "stage": "queued", "progress": 0.0, "message": "Starting", "startedAt": time.time(),
                         "updatedAt": time.time(), "pipelineVersion": PIPELINE_VERSION}
            job = dict(JOBS[key])
        threading.Thread(target=_run, args=(season, rnd), daemon=True).start()
        self._send(202, job)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("fastf1").setLevel(logging.WARNING)
    port = int(os.environ.get("PORT", "8080"))
    log.info("f1sim generator listening on :%d (pipeline v%d)", port, PIPELINE_VERSION)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
