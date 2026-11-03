"""Schema/pipeline/circuit versions must agree across the pipeline, the web renderer and the Worker config.

A schema change = renderer + pipeline in the same PR; this test is what makes a half-done bump fail CI.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from f1sim import CIRCUIT_VERSION, PIPELINE_VERSION, SCHEMA_VERSION  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")


def _wrangler_vars() -> dict:
    text = open(os.path.join(ROOT, "worker", "wrangler.jsonc")).read()
    text = re.sub(r"^\s*//.*$", "", text, flags=re.M)  # jsonc line comments
    return json.loads(text)["vars"]


def test_worker_vars_match_pipeline():
    v = _wrangler_vars()
    assert int(v["SCHEMA_VERSION"]) == SCHEMA_VERSION
    assert int(v["PIPELINE_VERSION"]) == PIPELINE_VERSION
    assert int(v["CIRCUIT_VERSION"]) == CIRCUIT_VERSION


def test_web_schema_matches_pipeline():
    src = open(os.path.join(ROOT, "web", "src", "data", "version.ts")).read()
    assert int(re.search(r"SCHEMA_VERSION\s*=\s*(\d+)", src).group(1)) == SCHEMA_VERSION
