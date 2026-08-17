# Canvas Overture property ETL

Canvas production property evidence is built offline from public bulk data. It never calls BatchData or a synchronous per-property API.

## Source order

1. Overture Addresses discovers addressable properties.
2. Overture Buildings links each address point to a physical structure and contributes building-use evidence.
3. Overture Places and optional OpenStreetMap features contribute commercial, government, institutional, school, hospital, and other exclusion evidence.
4. National Address Database and public assessor/parcel GeoJSON are optional additive inputs. Their absence never blocks an Overture release.
5. Overture Transportation segments provide street linkage and connectivity only. Eligible property counts are the workload authority.

Each address receives a FirstKnock-owned `FKP1_…` identity derived from normalized country, house number, street, unit, locality, region, and postcode components (`fk-property-key-v1`). Source feature IDs never enter the canonical identity. Rows with the same normalized components conflate into one property unless a unit/subaddress distinguishes a physical unit; every distinct source feature remains in the canonical property's provenance. Reports always separate raw source address records, canonical FirstKnock properties, and conflated duplicate rows.

Mixed-tag OSM features use `osm-assertions-v2`: one raw source feature may emit independently typed building, land-use, and place assertions. Assertion IDs include source feature, assertion kind, and canonical property, so the assertions are deterministic and unique while their provenance continues to identify the same raw feature. Classification evaluates all assertions; the raw feature is never duplicated or forced through a building-first precedence rule.

## Maryland property-first vertical slice

Maryland remains the transportation and distribution foundation. Export the normalized Maryland tiles and raw OSM building/land-use/POI evidence intersecting a Damascus or Olney test polygon, then overlay pinned Overture address/building/place evidence without rebuilding road identities. The official CLI currently consults its STAC catalog even for an explicit release; if that catalog is unavailable, use the official Python `record_batch_reader(..., release='2026-07-22.0', stac=False)` API to read the pinned public S3 release directly rather than switching to an unpinned latest release:

```sh
npm run canvas:maryland:property-overlay -- \
  --base-release maryland/release.json --base-tiles maryland/damascus.normalized.ndjson \
  --addresses damascus-addresses.geojson --buildings damascus-buildings.geojson --places damascus-places.geojson \
  --osm maryland/damascus-osm-evidence.geojson \
  --region us-md-damascus-001 --release-version 2026-07-22.0 \
  --observed-at 2026-07-22T00:00:00.000Z --output build/canvas/us-md-damascus-001

node scripts/canvas-evidence/build-release.mjs \
  --release build/canvas/us-md-damascus-001/release.json \
  --input build/canvas/us-md-damascus-001/normalized.ndjson --validate-only
```

The overlay preserves Maryland work-unit identities, neighbor topology, protected groups, source provenance, tile scheme, signing, and publication flow. `ab-report.json` records the old opportunity/transit/excluded/uncertain blockface counts beside discovered properties, eligible/excluded/review counts, eligible doors, and property-authoritative road support counts. Census housing-unit totals belong in a later coverage report and never create `FK_PROPERTY_ID` records.

## Source-derived regional benchmark build

A benchmark road graph is extracted from the pinned OSM PBF with authoritative OSM node IDs and a fixed 2,000-meter halo around the workload polygon. Traversable ways are split only at real shared OSM nodes; geometry nodes between junctions remain in the segment geometry. Neighbor edges exist only when segments share an authoritative node. Terminal-to-junction branches become protected cul-de-sac groups. The workload polygon filters address records before identity/conflation, while halo roads remain zero-door connectivity context; no outside property and no synthetic road edge can contribute workload.

## Standalone regional build

For development regions that do not have an existing normalized transportation graph, use the official `overturemaps download --bbox=west,south,east,north -f geojson` command to export `address`, `building`, `place`, and `segment` files. Then run:

```sh
node scripts/canvas-evidence/overture/build-region.mjs \
  --addresses addresses.geojson --buildings buildings.geojson \
  --places places.geojson --roads segments.geojson \
  --region us-sc-anderson-001 --release-version 2026-07-22.0 \
  --observed-at 2026-07-22T00:00:00.000Z --output build/canvas/us-sc-anderson-001

node scripts/canvas-evidence/build-release.mjs \
  --release build/canvas/us-sc-anderson-001/release.json \
  --input build/canvas/us-sc-anderson-001/normalized.ndjson --validate-only
```

A signed production build uses the existing release command with the production Ed25519 key files and output object prefix. Each region is independently reproducible, so national processing can shard by fixed region/tile, rebuild only changed regions, and publish a new immutable signed manifest.

`etl-report.json` records discovered, signed, unlinked, eligible, excluded, and review counts plus an explicit zero BatchData-call count. Unlinked addresses retain their FirstKnock ID in the report and must be covered by a later road/evidence tile rather than silently assigned to a distant street.