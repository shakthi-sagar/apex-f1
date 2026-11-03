"""f1sim — FastF1 -> RaceBundle generation pipeline.

Three independent versions (all stamped into every generated manifest / JSON header):

  SCHEMA_VERSION    the file format the renderer reads. Bump ONLY together with a renderer change in the
                    same PR (web/src/data/version.ts + worker vars). Older-schema files are treated as
                    missing and must be regenerated before they are served.
  PIPELINE_VERSION  how race telemetry was generated (motion, timing, events). Bump when output changes
                    but the format does not: stale races keep being served while they rebuild in the background.
  CIRCUIT_VERSION   how circuit + world/environment data was generated. A bump rebuilds the circuit; the race
                    bundle is reused when the line geometry it was fused against is unchanged (lineHash).

`pipeline/tests/test_versions.py` fails if these drift from the web app / Worker config.
"""

SCHEMA_VERSION = 1
PIPELINE_VERSION = 3
CIRCUIT_VERSION = 4
BUNDLE_SCHEMA = f"f1sim.racebundle/{SCHEMA_VERSION}"
