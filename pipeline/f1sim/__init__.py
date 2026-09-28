"""f1sim — FastF1 -> RaceBundle generation pipeline.

Bumping a version here invalidates every artifact that depends on it:
  PIPELINE_VERSION  race bundles (motion, timing, events)
  CIRCUIT_VERSION   circuit geometry + world/environment data
"""

PIPELINE_VERSION = 3
CIRCUIT_VERSION = 4
BUNDLE_SCHEMA = "f1sim.racebundle/1"
