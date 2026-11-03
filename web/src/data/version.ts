/** The data format this renderer reads. Must equal SCHEMA_VERSION in pipeline/f1sim/__init__.py and the Worker's
 *  SCHEMA_VERSION var (pipeline/tests/test_versions.py fails the build if they drift). Bump it only in the same PR
 *  that changes the format: manifests with another schema are treated as "not generated yet". */
export const SCHEMA_VERSION = 1
