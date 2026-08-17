# Canvas Evidence Release Pipeline

This pipeline turns already normalized, spatially partitioned Canvas evidence into the signed immutable artifacts consumed by the Canvas analysis service. It is provider-neutral: an upstream job can derive normalized evidence from OpenStreetMap, Overture, Census, county address points, a licensed vendor, or an audited combination of them.

It is important to keep the boundary honest: this repository does **not** download, conflate, classify, or continuously update raw continental-US source datasets. Those source-specific operations are a separately deployed and separately versioned ETL system. The release builder starts only after that ETL has emitted normalized v1 tiles. A successful release build proves contract validity, graph consistency, determinism, artifact integrity, and signer identity; it does not prove that an upstream provider is complete or current.

## Pipeline boundary

```text
raw providers
  -> separately versioned acquire/conflate/classify/partition ETL
  -> normalized release metadata + normalized JSON/NDJSON tiles
  -> this production release builder
  -> signed manifest + immutable canonical tiles + upload inventory
  -> R2/S3-compatible object storage
  -> Canvas analysis service
```

The upstream ETL owns source licensing, download provenance, address/building/parcel conflation into stable `property_key` values, deterministic property type and canvass eligibility signals, road segmentation, tile assignment, and initial neighbor discovery. Property-aware inputs are the production target; omitted `properties` arrays are supported only for compatibility with existing street-only releases. The release builder independently enforces the Canvas evidence v1 output contract and refuses ambiguous graph boundaries.

## Normalized release metadata

The release metadata is a JSON document. `tile_inputs` is optional; when present, paths are resolved relative to this metadata file. Repeated `--input` options override it.

```json
{
  "schema": "firstknock.canvas-normalized-evidence-release",
  "schema_version": 1,
  "release": {
    "dataset_namespace": "firstknock-us-residential",
    "dataset_version": "2026-08-14.1",
    "generated_at": "2026-08-14T12:00:00.000Z"
  },
  "coverage": {
    "country_codes": ["US"],
    "bounds": {
      "min_lng": -124.85,
      "min_lat": 24.39,
      "max_lng": -66.88,
      "max_lat": 49.39
    }
  },
  "tile_scheme": {
    "scheme": "firstknock-us-grid",
    "scheme_version": 1
  },
  "sources": [
    {
      "source_id": "overture-transportation",
      "provider": "Overture Maps Foundation",
      "dataset_version": "upstream-version-from-etl",
      "license": "license-identifier-recorded-by-etl",
      "captured_at": "2026-08-13T00:00:00.000Z"
    }
  ],
  "tile_inputs": ["normalized-tiles"]
}
```

The deterministic release ID is derived from `dataset_namespace`, `dataset_version`, and `generated_at`. Reusing those three values for changed content is an immutable-release conflict. Correct the ETL metadata and create a new release identity; never overwrite a published release.

## Normalized tile input

Each `.json` file can contain one tile or an array of tiles. Each nonblank `.jsonl` or `.ndjson` line contains one tile, which is the recommended format for large jobs because it is streamed. Unknown fields fail closed instead of being silently dropped.

```json
{
  "schema": "firstknock.canvas-normalized-evidence-tile",
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
  "properties": [
    {
      "property_key": "usps-or-assessor-stable-key",
      "work_unit_identity": {
        "source_namespace": "overture-segment",
        "source_feature_id": "stable-upstream-feature-id",
        "segment_index": 0,
        "from_millionths": 0,
        "to_millionths": 1000000
      },
      "point": { "lat": 33.45, "lng": -112.18 },
      "property_type": "residential",
      "canvass_eligibility": "eligible",
      "confidence": { "score": 0.98, "reasons": ["delivery_point_verified", "residential_single_family"] },
      "door_count": 1,
      "display_address": "100 Oak St",
      "provenance": [
        {
          "source_id": "overture-transportation",
          "dataset_version": "upstream-version-from-etl",
          "feature_id": "property-feature-id",
          "observed_at": "2026-08-13T00:00:00.000Z",
          "license": "license-identifier-recorded-by-etl"
        }
      ]
    }
  ],
  "work_units": [
    {
      "identity": {
        "source_namespace": "overture-segment",
        "source_feature_id": "stable-upstream-feature-id",
        "segment_index": 0,
        "from_millionths": 0,
        "to_millionths": 1000000
      },
      "canvas_role": "opportunity",
      "confidence": {
        "score": 0.91,
        "reasons": ["address_points", "residential_buildings"]
      },
      "opportunity": { "min": 12, "expected": 15, "max": 18 },
      "provenance": [
        {
          "source_id": "overture-transportation",
          "dataset_version": "upstream-version-from-etl",
          "feature_id": "stable-upstream-feature-id",
          "observed_at": "2026-08-13T00:00:00.000Z",
          "license": "license-identifier-recorded-by-etl"
        }
      ],
      "geometry": {
        "type": "LineString",
        "coordinates": [[-112.18, 33.45], [-112.17, 33.45]]
      },
      "neighbors": [
        {
          "identity": {
            "source_namespace": "overture-segment",
            "source_feature_id": "adjacent-feature-id",
            "segment_index": 0,
            "from_millionths": 0,
            "to_millionths": 1000000
          },
          "scope": "release"
        }
      ]
    }
  ],
  "protected_groups": [
    {
      "kind": "cul_de_sac",
      "members": [
        {
          "source_namespace": "overture-segment",
          "source_feature_id": "stable-upstream-feature-id",
          "segment_index": 0,
          "from_millionths": 0,
          "to_millionths": 1000000
        }
      ],
      "entries": [
        {
          "source_namespace": "overture-segment",
          "source_feature_id": "stable-upstream-feature-id",
          "segment_index": 0,
          "from_millionths": 0,
          "to_millionths": 1000000
        }
      ]
    }
  ]
}
```

Neighbor scope is explicit:

- `release` means the target work unit must exist somewhere in this release and must point back to the source. This works the same within one tile and across tile seams.
- `outside_release` means the target is intentionally beyond the release boundary. It must not exist anywhere in the release and does not require a reciprocal edge.

This distinction prevents a missing tile or broken seam from being mistaken for a legitimate national or market boundary. Protected groups are required to fit within one tile in contract v1. The compiler derives stable `cewu1_…`, `cepg1_…`, `cet1_…`, and `cer1_…` identifiers; normalized input must not supply those output IDs.

## Validate, build, and resume

Unsigned validation performs no writes and needs no secret:

```sh
node scripts/canvas-evidence/build-release.mjs \
  --release ./release.json \
  --input ./normalized-tiles \
  --validate-only
```

Generate an Ed25519 key outside the repository and place the private half in the deployment platform's secret store. One possible operator workflow is:

```sh
openssl genpkey -algorithm Ed25519 -out canvas-evidence-signing-private.pem
openssl pkey -in canvas-evidence-signing-private.pem -pubout -out canvas-evidence-signing-public.pem
```

Build the release:

```sh
node scripts/canvas-evidence/build-release.mjs \
  --release ./release.json \
  --input ./normalized-tiles \
  --output ./release-output \
  --private-key-file /run/secrets/canvas-evidence-signing-private.pem \
  --public-key-file ./canvas-evidence-signing-public.pem \
  --key-id canvas-evidence-production-2026-08 \
  --object-prefix firstknock/canvas-evidence/releases
```

The file paths and key ID can instead come from:

```text
CANVAS_EVIDENCE_SIGNING_PRIVATE_KEY_FILE
CANVAS_EVIDENCE_SIGNING_PUBLIC_KEY_FILE
CANVAS_EVIDENCE_SIGNING_KEY_ID
```

The private key is read only for signing. It is never copied into output, printed, included in a manifest, or accepted from the checked-in fixture keypair. The public-key SHA-256 fingerprint is written to the upload inventory so deployment can compare it with the analysis service's pinned public key.

The build first writes a release-specific staging directory and validates every artifact. A same-filesystem directory rename publishes it as `<output>/<cer1_release_id>` only after all checks pass. Existing published directories are never overwritten. `--resume` continues a release-specific staging directory or verifies that an already published release is byte-for-byte identical. It fails if the same release identity maps to changed inputs, signer metadata, or upload keys.

## Output and object-storage publication

Each published release directory contains:

```text
cer1_<release-id>/
  manifest.json
  upload-inventory.json
  SHA256SUMS
  tiles/
    cet1_<tile-id>.json
```

`manifest.json` and every tile use canonical JSON without trailing whitespace. The Ed25519 manifest signature pins all tile URIs, SHA-256 hashes, byte lengths, counts, bounds, and workload totals. `upload-inventory.json` supplies an object key, SHA-256 hash, byte length, content type, and immutable cache-control value for the manifest and tiles. `SHA256SUMS` additionally covers the upload inventory.

Use the inventory as the allowlist for an R2/S3 uploader. The uploader should:

1. upload only listed artifacts to their exact `object_key`;
2. apply the listed `content_type` and `cache_control` metadata;
3. verify uploaded byte length and SHA-256 independently (multipart ETags are not SHA-256 checksums);
4. deny overwrite for an existing release prefix; and
5. publish or update a separate small “current release” pointer only after every immutable object verifies.

The pointer update is intentionally outside this builder because it is mutable deployment state and requires object-store credentials, rollback policy, and environment-specific approval. Canvas production configuration should point at the immutable manifest URL or at a controlled current-release pointer, and should pin the matching Ed25519 public key. Public Overpass is not part of this release path.

## Scale and operational properties

- NDJSON input and tile compilation are streamed; all work-unit payloads are not retained in memory.
- Cross-tile existence, symmetry, duplicate-ID, and release-boundary checks use hash-partitioned temporary disk spools. `--topology-buckets` can be raised, up to 4,096, when a very large release needs smaller per-bucket working sets.
- Manifest entries remain in memory because the v1 signed manifest is one bounded object. The contract limit is 250,000 tiles per release.
- Canonical tile size, tile count, work-unit density, opportunity density, topology fan-out, geometry size, and protected-group limits come from the signed v1 contract.
- Tile bounds must stay inside release bounds, work-unit geometry must stay inside its tile bounds, source provenance must match signed release source metadata, and source timestamps cannot be later than release generation.

Before promoting a national release, run validation on the exact normalized input, build once with the production signer, upload from the generated allowlist, download a sample from each geographic partition plus all seam/error reports, verify hashes and signature in the analysis service, and retain the normalized input inventory and ETL version for rollback and audit.