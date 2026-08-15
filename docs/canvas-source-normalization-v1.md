# Canvas Source Evidence Normalization v1

## Purpose and honest boundary

Canvas source normalization is the deterministic classification seam between source-specific geospatial ETL and FirstKnock's signed evidence release builder.

```text
OSM / Overture / Census / county / licensed-provider extracts
  -> source-specific acquisition, licensing, conflation, and tiling adapters
  -> strict provider-neutral source-evidence v1 tiles
  -> this normalizer
  -> normalized Canvas evidence v1 tiles
  -> existing signed immutable release builder
  -> object storage and Canvas analysis service
```

This repository now implements the two middle contract steps: strict source-evidence validation, deterministic classification, and normalized release-builder output. It does **not** download OpenStreetMap, Overture, Census, county, parcel, address, or commercial data. It does not schedule national refreshes, resolve provider licenses, operate object storage, or deploy a continental-US release. Those remain explicit operational/source-adapter tasks.

The distinction matters. A successful normalization and release-build validation proves that the supplied evidence is structurally valid, consistently classified, topologically coherent, deterministic, and compatible with the signed Canvas contract. It does not prove that an upstream dataset is complete, current, legally usable, or nationally deployed.

## Safety model

The normalizer makes two independent decisions for every short street/block-face work unit:

1. **Residential opportunity:** whether audited evidence supports countable residential doors and which evidence tier supplies the estimate.
2. **Legal pedestrian access:** whether the segment is public/permitted, denied, or unresolved after access and barrier evidence.

Those decisions are combined only at the end:

| Source decision | Signed Canvas role | Behavior |
| --- | --- | --- |
| `knock` | `opportunity` | Counted residential workload; may be exclusively owned by a territory |
| `transit_only` | `transit` | Zero workload; may connect work areas but is not a knocking target |
| `excluded` | `excluded` | Zero workload; field, commercial/industrial geography, or denied access |
| `uncertain` | `uncertain` | Zero workload until a manager resolves it in a versioned classification revision |

Denied access always removes workload. Unresolved or conflicting access always produces `uncertain`. The normalizer never converts uncertainty into guessed doors.

The library export `normalizeCanvasSourceEvidenceTileWithAudit` returns the strict normalized tile plus a deterministic per-work-unit audit view containing both pass states, the source role, signed-contract role, opportunity basis/range, and confidence. The audit view is diagnostic metadata and is not inserted into the release-builder tile, whose schema remains closed.

## Input schemas

Every input is one of:

- a JSON object with schema `firstknock.canvas-source-evidence-tile`, version `1`;
- a JSON collection with schema `firstknock.canvas-source-evidence-collection`, version `1`, and a non-empty `tiles` array; or
- NDJSON/JSONL with exactly one source-evidence v1 tile per nonblank line.

Unknown fields fail closed at the tile, road, evidence, association, attribute, provenance, coverage, and geometry levels.

### Tile

```json
{
  "schema": "firstknock.canvas-source-evidence-tile",
  "schema_version": 1,
  "tile_address": {
    "scheme": "firstknock-us-grid",
    "scheme_version": 1,
    "key": "us-az-000123"
  },
  "coverage": {
    "area_sq_mi": 25,
    "bounds": {
      "min_lng": -112.2,
      "min_lat": 33.4,
      "max_lng": -112.1,
      "max_lat": 33.5
    }
  },
  "road_segments": [],
  "evidence": [],
  "protected_groups": []
}
```

The tile scheme and road identities must be stable across releases. A source adapter must not derive IDs from input order, process IDs, or mutable database row numbers.

### Road segment

```json
{
  "identity": {
    "source_namespace": "overture-segment",
    "source_feature_id": "stable-provider-or-conflated-id",
    "segment_index": 0,
    "from_millionths": 0,
    "to_millionths": 1000000
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [[-112.18, 33.45], [-112.17, 33.45]]
  },
  "road_class": "residential",
  "legal_access": "public",
  "provenance": [],
  "neighbors": []
}
```

Allowed road classes cover local/service streets, arterial/link roads, motorway/trunk roads, pedestrian/path/cycle/track context, and `unknown`. Legal access is required and must be `public`, `permitted`, `denied`, or `unknown`; absence is not treated as permission. Source adapters must mark pedestrian-forbidden motorway or trunk segments denied instead of assuming their road class alone proves access.

Each neighbor contains the canonical target `identity` and a `scope` of:

- `release`: the target must exist in the eventual release and reciprocate the edge; or
- `outside_release`: the target must not exist in the release.

Local edges must already be symmetric. The release builder independently validates all cross-tile and release-boundary edges.

### Provenance

Every road and evidence record has at least one provenance item:

```json
{
  "source_id": "overture-transportation",
  "dataset_version": "2026-08-13.0",
  "feature_id": "provider-feature-id",
  "observed_at": "2026-08-13T00:00:00.000Z",
  "license": "recorded-license-identifier"
}
```

The normalizer unions, deduplicates, and canonically sorts all provenance that informed a road. Conflicting records for the same source/version/feature identity fail. The resulting provenance must match the source inventory in the normalized release metadata; the release builder enforces that match.

### Evidence and attributes

Each evidence record has a stable, already-conflated `evidence_id`, one `kind`, strict kind-specific `attributes`, one or more `associations`, and provenance.

| Kind | Required attributes | Supported values / notes |
| --- | --- | --- |
| `address` | `address_key`, `unit_keys`, `occupancy` | Occupancy: `residential`, `commercial`, `mixed`, `unknown`; keys should be opaque normalized IDs, not homeowner data |
| `building` | `building_use`; optional `unit_count` | Includes `yes`, residential types, `apartments`, `dormitory`, `mixed_use`, and negative commercial/office/warehouse/industrial types |
| `site` | `site_use`; optional `unit_count` | Residential/apartments/mixed-use or negative commercial/industrial/agricultural evidence |
| `entrance` | `entrance_key`, `entrance_type`, `use` | Entrance type: `main`, `home`, `staircase`, `service`, `unknown` |
| `land_use` | `land_use` | Residential/mixed use or commercial, industrial, field, forest, quarry, and construction exclusions |
| `place` | `place_use` | Residential/mixed use or shop/commercial/office/warehouse/industrial evidence |
| `access` | `pedestrian_access` | `allowed`, `denied`, or `unknown` |
| `barrier` | `barrier_type`, `pedestrian_access` | A gate/barrier without resolved pedestrian access remains unknown |

Source adapters own geometry intersection, address normalization, unit-key normalization, and feature conflation. Two provider rows for the same real building must not be emitted as two independently countable buildings merely because their provider IDs differ.

## Street association hierarchy

Addresses, buildings, sites, and entrances may carry multiple candidate associations. The normalizer selects exactly one road using this precedence:

1. `address_street`
2. `entrance_driveway`
3. `side_of_street`
4. `nearest_road`

Each association identifies a canonical road identity. If more than one road remains at the strongest available level, normalization fails with `ambiguous_evidence_association`; it never picks whichever candidate appeared first. A nearest-road association is fallback-only, requires `distance_m`, and defaults to a 60-meter maximum. The CLI can set a stricter audited threshold with `--max-nearest-road-meters`; values beyond it fail.

Area context (`land_use` and `place`) uses explicit `area_overlap` associations and may apply to multiple segments. Access and barrier evidence uses explicit `network_link` associations. These contextual methods are not mixed into the address-to-street hierarchy.

Deduplicated address/unit keys may not be owned by different road segments within one normalization batch. That conflict fails with `ambiguous_opportunity_ownership`. National source adapters must also conflate and audit duplicate ownership across their batch/partition seams before release promotion.

## Residential opportunity classification

Commercial evidence is not a blanket veto. A shop or commercial land-use signal can coexist with reliable residential evidence on a mixed-use block. Supported mixed-use residential opportunity is preserved and the reason `residential_mixed_use_preserved` is recorded.

If residential evidence is valid, exactly one opportunity tier is selected in this order:

1. **Deduplicated address/unit evidence.** Unique unit keys count individually; an address without units counts once.
2. **Explicit unit count.** `unit_count` is used only on explicitly residential/mixed-use buildings or sites.
3. **Residential entrances.** Non-service residential/mixed-use entrances provide a lower-confidence range.
4. **Residential footprints.** Explicit residential house/building/site records provide a lower-confidence fallback.

Apartment and dormitory footprint size is never used to infer floors or units. Without reliable addresses or an explicit unit count, each apartment/multi-unit site receives the deliberately wide range `1 / 8 / 40` (minimum / expected / maximum). Mixed-use footprint fallback is also wide. These ranges describe uncertainty; they are not claims about unit count.

`building=yes` is always `uncertain` with no opportunity range unless separate reliable evidence proves residential use. A `unit_count` attached to an otherwise generic `building=yes` does not silently make it residential. Manager overrides happen later as audited, versioned classification revisions; they are intentionally not accepted as raw provider evidence.

Commercial, retail, office, warehouse, industrial, hotel, agricultural, field, forest, quarry, and construction evidence is excluded when there is no reliable residential opportunity. Residential land-use context alone, with no countable address/site/building/entrance, remains uncertain rather than manufacturing doors. A traversable road with no residential or exclusion evidence is `transit_only` and carries zero workload.

## Access classification

Access is evaluated independently of residential evidence:

- an explicit denial or denied road is excluded;
- an unknown gate/barrier or unresolved road access is uncertain;
- more-specific access evidence may resolve an unknown road baseline;
- contradictory allowed/denied evidence is uncertain; and
- public/permitted access is knockable only if the residential pass also finds countable opportunity.

This prevents a residential building behind unresolved private access from being sent to a rep merely because it has an address.

## Cul-de-sacs and topology

Source adapters emit protected groups after deriving road topology. Contract v1 supports local `cul_de_sac` groups:

```json
{
  "kind": "cul_de_sac",
  "members": [{ "...": "canonical road identity" }],
  "entries": [{ "...": "canonical road identity" }]
}
```

The normalizer requires each group to:

- contain distinct local members;
- be connected through the supplied road graph;
- not overlap another protected group; and
- have at least one entry member with a connection outside the group.

Members and entries are sorted by derived canonical work-unit ID. Road units, neighbors, evidence, provenance, reasons, groups, and tiles are also canonicalized, so input file and record order do not affect normalized output. Protected groups may not cross tile boundaries in evidence contract v1; the upstream partitioner must choose tile boundaries accordingly.

## Commands

Normalize source evidence without writing:

```sh
node scripts/canvas-evidence/normalize-source.mjs \
  --input ./source-evidence \
  --validate-only
```

Create canonical normalized NDJSON:

```sh
node scripts/canvas-evidence/normalize-source.mjs \
  --input ./source-evidence \
  --output ./normalized/tiles.ndjson \
  --max-nearest-road-meters 60
```

Existing output files are never overwritten. The write uses a private temporary file and an atomic no-clobber filesystem link.

Validate the exact normalized output through the production release builder:

```sh
node scripts/canvas-evidence/build-release.mjs \
  --release ./normalized/release.json \
  --input ./normalized/tiles.ndjson \
  --validate-only
```

Then use the signed release workflow in `docs/canvas-evidence-release-pipeline.md`.

The normalizer currently materializes one invocation's tiles so it can enforce deterministic tile ordering and duplicate address/unit ownership. For continental-US operations, source-specific ETL must produce audited, bounded partitions, conflate opportunity ownership across partition seams, run this normalizer per bounded batch, and pass the complete normalized set through the release builder's disk-spooled global topology validation. Do not feed an unbounded national extract to one normalizer process.

## What remains before a national production release

The following are deployment/operations work, not values obtainable from the OpenStreetMap Overpass website:

1. choose and license the actual transportation, address, building, land-use, place, access, and barrier sources;
2. implement source-specific acquisition adapters and scheduled incremental refreshes;
3. conflate duplicate addresses/sites/buildings and assign stable IDs across provider and partition seams;
4. derive short street/block-face units, neighbor topology, cul-de-sac groups, and the national tile plan;
5. run market QA for dense urban, suburban cul-de-sac, rural, mixed-use, gated, tribal, campus, and incomplete-data areas;
6. build and sign an immutable national release with production-owned Ed25519 keys;
7. upload and independently verify every inventory artifact in R2/S3-compatible storage;
8. promote the immutable manifest pointer and pinned public key to the analysis service; and
9. run authenticated staging, rollback, refresh-lag, and representative national-load tests.

Until those steps are complete, the correct status is “source-normalization and signed-release code ready for provider adapters and production data,” not “continental-US evidence deployed.”
