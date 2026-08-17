# Damascus Property Benchmark v3 — production-authoritative candidate

The historical Overture extraction investigation is closed. Exact polygon, bbox, shared halo, geometry predicates, Places categories, theme/type selection, reader serialization, and likely post-filters did not produce one coherent contract matching the historical 1,303 / 2,453 / 151 slice. The project now uses the explicit `2026-07-22.0` contract in `src/data/damascusPropertyBenchmarkV3SourceManifest.json`; old counts are not acceptance criteria.

## Gate A — deterministic construction

Two clean builds were byte-identical. Both produced 1,225 in-polygon address records, 1,222 canonical properties, no duplicate property IDs, no unlinked properties, and identical identity, conflation, source-tile, normalized-evidence, ledger, release-metadata, and ETL-report hashes.

## Gate B — HomeData policy

Before HomeData: 227 eligible, 53 excluded, 942 review (77.09%). After HomeData: 1,055 eligible, 26 excluded, 141 review (11.54%). The transition matrix is frozen in `src/data/damascusPropertyBenchmarkV3Freeze.json`; eligible→excluded and excluded→eligible are both zero. Automatic promotion still requires high-confidence conflation, conflicts and ambiguity remain review, property type remains separate from eligibility, access remains independent, and paid provider calls remain zero.

## Gate C — signed five-way path

The production release compiler generated and verified two signed tiles. `EvidenceRepository` verified the manifest and tile hashes, stitched both tiles, clipped workload to the manager polygon, retained real outside-road connectivity with zero outside doors, and exposed `workload_authority=eligible_properties` with no street fallback. The 1,055 eligible doors split 240 / 199 / 200 / 198 / 218 against a target of 211, for 13.74% maximum deviation. Connected cores, protected groups, exclusive property ownership, explicit-island accounting, and deterministic rerun all passed.

## Remaining Gate D prerequisite

The freeze metadata and intended immutable object keys are committed, but raw artifacts are still local. Do not mark Damascus complete, run statewide publication, or deploy this release until every source artifact is uploaded to the immutable `canvas-source-artifacts/maryland/damascus-v3/` prefix and re-read by hash. The workspace currently has no R2/S3 write credentials.