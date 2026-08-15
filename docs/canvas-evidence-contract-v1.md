# Canvas Evidence Release Contract v1

This contract is the provider-neutral boundary between an offline evidence compiler and Canvas runtime planning. It does not change Precision mode, the Canvas UI, or campaign deployment.

## Release and trust model

- A release has a deterministic `cer1_…` ID derived from its dataset namespace, dataset version, and generation timestamp.
- Every manifest is canonical-JSON encoded and signed with Ed25519. The envelope names the verification `key_id`; private keys never appear in a manifest or tile.
- Every tile has a deterministic `cet1_…` ID derived from its versioned tile address. The manifest pins its URI, SHA-256 digest, byte length, counts, area, expected opportunity total, and coverage bounds.
- Runtime must verify the manifest signature and each downloaded tile's digest before using evidence. A reviewed campaign can pin the immutable release ID plus a later classification-revision ID.

The manifest deliberately identifies evidence sources by source ID, provider name, source dataset version, capture time, and license. No field assumes OpenStreetMap, a commercial vendor, or a particular tile system.

## Work-unit model

The stable ownership primitive is a short street/block-face work unit. `cewu1_…` IDs are derived from a source namespace, source feature ID, segment index, and millionth-based source range. Each unit contains:

- `canvas_role`: `opportunity`, `transit`, `uncertain`, or `excluded`;
- score-derived confidence tier and ordered reasons;
- ordered provenance records;
- an opportunity range only for `opportunity` units;
- LineString geometry;
- symmetric local neighbor IDs; and
- an optional protected-group ID.

Protected groups are deterministically identified from their kind and complete member set. Selecting one member of a cul-de-sac or other protected pocket selects the whole group.

## Runtime spatial selection

1. Verify the signed manifest once and cache it by release ID.
2. Intersect the manager's boundary bounds with each manifest tile entry's `coverage_bounds`. This selects candidate tile URIs without downloading every tile.
3. Download only candidate tiles, enforce byte limits before parsing, then verify digest and contract validation.
4. Select work units whose LineStrings touch or cross the manager polygon. Expand any selected protected group atomically.
5. Keep neighbor IDs that cross the selected view in `external_neighbor_ids`. This retains cut-edge topology for stitching adjacent tiles or later planner passes.

`selectCanvasEvidenceTiles` and `selectCanvasEvidenceWorkUnits` implement steps 2 and 4 for the local reference contract. The latter returns a view; it does not rewrite the immutable signed tile.

## Enforced safety limits

The v1 defaults cap canonical tile size, work units per tile and square mile, expected opportunities per square mile, neighbor fan-out, geometry coordinates, protected groups, and release tile count. Limits are included in signed release metadata, and bundle validation uses those exact values. A producer may choose stricter limits, but increasing production limits requires a reviewed contract revision and load test.

## Deterministic local fixture

Run:

```sh
node scripts/canvas-evidence/compile-fixture.mjs
node --test test/canvas-evidence-contract.test.mjs
```

The fixture compiler performs no network requests. It sorts unordered inputs, creates canonical IDs, compiles topology and protected groups, enforces limits, signs the manifest with an explicitly test-only key, and verifies the completed bundle. `--json` emits canonical fixture output for inspection. Production must inject a separately managed signing key and must never use the checked-in fixture key.

## Production release builder

The local fixture compiler is still test-only. Production releases use `scripts/canvas-evidence/build-release.mjs`, which consumes normalized partitioned JSON/NDJSON tiles, validates cross-tile and release-boundary topology with a disk-backed pass, derives the same v1 IDs, signs with an externally supplied Ed25519 key, and atomically publishes an immutable local release directory with R2/S3 upload inventory and checksums.

See [Canvas Evidence Release Pipeline](./canvas-evidence-release-pipeline.md) for the normalized input schema, key handling, validate/build/resume commands, object-storage handoff, and the explicit boundary between this compiler and a separately versioned OSM/Overture/Census/vendor ETL. This repository does not claim to ingest or normalize raw continental-US datasets.
