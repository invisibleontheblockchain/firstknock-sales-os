# Canvas Overture property ETL

Canvas production property evidence is built offline from public bulk data. It never calls BatchData or a synchronous per-property API.

## Source order

1. Overture Addresses discovers addressable properties.
2. Overture Buildings links each address point to a physical structure and contributes building-use evidence.
3. Overture Places and optional OpenStreetMap features contribute commercial, government, institutional, school, hospital, and other exclusion evidence.
4. National Address Database and public assessor/parcel GeoJSON are optional additive inputs. Their absence never blocks an Overture release.
5. Overture Transportation segments provide street linkage and connectivity only. Eligible property counts are the workload authority.

Each address receives a FirstKnock-owned `FKP1_…` identity derived from normalized address components. Overture IDs remain provenance and conflation references and are never the canonical property ID.

## Regional build

Use the official `overturemaps download --bbox=west,south,east,north -f geojson` command to export `address`, `building`, `place`, and `segment` files for one bounded region. Then run:

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