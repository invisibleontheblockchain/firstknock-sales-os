# Canvas assignment package publication runbook

Canvas deployment and offline-package publication are intentionally separate commits. `canvasDeployCampaign` remains the authority that signs and activates the Base44 campaign. `canvasPublishAssignmentPackages` verifies that immutable lifecycle signature, normalizes the deployed campaign into the Canvas operational database, and publishes one independently signed offline package per assigned zone.

## Required server configuration

- `CANVAS_DATABASE_URL`: dedicated Canvas operational Postgres/PostGIS connection. Never point this at the Precision database.
- `CANVAS_OPERATIONAL_MIGRATION_SECRET`: independent high-entropy authorization secret for the one-time/additive operational-store setup function.
- `CANVAS_DEPLOYMENT_SIGNING_SECRET`: existing lifecycle HMAC secret used by `canvasDeployCampaign`.
- `CANVAS_PACKAGE_SIGNING_PRIVATE_KEY`: Ed25519 private key. PKCS#8 PEM or base64url PKCS#8 by default; JWK is supported when the format is `jwk`.
- `CANVAS_PACKAGE_SIGNING_PRIVATE_KEY_FORMAT`: `pkcs8` (default) or `jwk`.
- `CANVAS_PACKAGE_SIGNING_PUBLIC_KEY`: matching Ed25519 public key. Raw base64url, SPKI PEM/base64url, or JWK.
- `CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT`: `raw` (default), `spki`, or `jwk`.
- `CANVAS_PACKAGE_SIGNING_KEY_ID`: stable public identifier, such as `canvas-package-2026-08`. It is not a secret.

Generate a key pair with OpenSSL:

```text
openssl genpkey -algorithm Ed25519 -out canvas-package-private.pem
openssl pkey -in canvas-package-private.pem -pubout -out canvas-package-public.pem
```

Keep the private PEM only in Base44 server secrets. Compile the public PEM (or its DER encoding), format, and exact key ID independently into the web build as `VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY`, `VITE_CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT`, and `VITE_CANVAS_PACKAGE_SIGNING_KEY_ID`. The package endpoint may advertise the signer for diagnostics, but that sibling value is never a trust source.

Before publication, call `setupCanvasOperationalStore` as a Base44 admin and pass the exact migration secret in the `x-canvas-migration-secret` request header. The setup is additive and idempotent. Re-run it when deploying the lifecycle-handoff release so an existing store receives `closed_by_user_id`, `lifecycle_action`, `lifecycle_idempotency_key`, and `superseded_by_campaign_id` before the updated close or publication functions are enabled.

## Deployment-to-publication service contract

After `canvasDeployCampaign` returns an active deployment, invoke the manager-only function:

```json
{
  "campaign_id": "<CanvasSession id>",
  "publication_idempotency_key": "<new UUID or durable operation id>",
  "valid_for_hours": 168
}
```

Function: `canvasPublishAssignmentPackages`

- `valid_for_hours` is optional, defaults to seven days, and is bounded to 1–720 hours.
- Retry the same logical publication with the same idempotency key.
- Use a new idempotency key to intentionally refresh packages. Refresh produces a monotonically larger package version and revokes every older ready package for that assignment.
- Publication is all-or-nothing across the campaign. A 100-zone campaign either publishes all 100 packages or none.
- Overlap replacement is also all-or-nothing in this transaction. The replacement deployment remains `packaging` in PostGIS while every new package is built. Only after every package verifies does the same transaction mark the replacement `active`, revoke the predecessor assignments/packages named by the signed `superseded_session_ids`, and bind each predecessor tombstone to the exact successor campaign. A failed publication rolls back without stranding reps on the still-operational predecessor.
- The function reloads and verifies the active lifecycle signature, exact manager ownership, signed roster bindings, current TeamMember rows, linked user accounts, complete work-unit ownership, and the pinned plan/evidence identities. Browser-supplied geometry, assignee IDs, and evidence are not accepted.

The response contains a compact `packages` index, not artifact bytes:

```json
{
  "success": true,
  "idempotent": false,
  "campaign_id": "campaign-1",
  "package_count": 100,
  "assignment_index_version": 2,
  "publication_bytes": 1234567,
  "signing_key": {
    "algorithm": "Ed25519",
    "key_id": "canvas-package-2026-08",
    "format": "spki",
    "keyData": "-----BEGIN PUBLIC KEY-----..."
  },
  "packages": [
    {
      "package_id": "canvas_package_...",
      "assignment_id": "canvas_assignment_...",
      "zone_id": "canvas-residential-zone:1",
      "assignee_user_id": "user-id",
      "package_version": 1,
      "manifest_hash": "...",
      "artifact_count": 7,
      "total_bytes": 12345,
      "valid_until": "2026-08-21T12:00:00.000Z"
    }
  ]
}
```

Do not make publication success part of the already-committed Base44 deployment transaction. If publication fails, preserve the active campaign, show package delivery as pending, and retry publication with the same idempotency key.

Completing or recalling a residential campaign is intentionally different: `canvasCloseCampaign` first commits a Canvas-only Postgres lifecycle tombstone and atomically revokes every current assignment/package, then commits the signed Base44 close. A Base44 retry reuses the same close key and timestamp. This fail-closed order prevents an old offline package from continuing to sync if the cross-store close needs reconciliation. Legacy Canvas does not depend on this operational store.

## Rep package retrieval

Residential assignment discovery uses the bounded operational `canvasGetAssignmentIndex` endpoint described in [canvas-operational-assignment-index.md](./canvas-operational-assignment-index.md). Fetch cursor-ordered pages at up to 100 rows per page and stop at the checked 100-page client ceiling. Only after every page succeeds may the device replace its cached index and tombstone assignments absent from that complete result. Legacy Canvas assignment discovery remains a separately throttled compatibility read on `canvasGetMyAssignments`; it is never part of the residential recovery poll.

Each v2 index row authorizes one exact `assignment_id`, `package_id`, positive `package_version`, SHA-256 `manifest_hash`, `valid_until`, campaign, and zone. UI names stay neutral until verified package content is loaded. Retrieve the exact indexed package version; verify the manifest with the independently compiled app key; then require its package ID/version and canonical manifest digest to equal the index before requesting any artifact.

Function: `canvasGetAssignmentPackage`

Manifest request:

```json
{
  "campaign_id": "campaign-1",
  "zone_id": "canvas-residential-zone:1"
}
```

Residential v2 always supplies the exact indexed `assignment_id` and `package_version`; a stale value deliberately returns `package_version_mismatch` and must never be retried as whatever version the server currently has. Campaign/zone lookup remains only for bounded legacy compatibility.

Manifest response:

```json
{
  "success": true,
  "package": {
    "manifest": { "schema": "firstknock.canvas-field-package", "schema_version": 1 },
    "signing_key": {
      "algorithm": "Ed25519",
      "key_id": "canvas-package-2026-08",
      "format": "raw",
      "keyData": "<base64url public key>"
    },
    "artifact_retrieval": {
      "function": "canvasGetAssignmentPackage",
      "one_artifact_per_request": true,
      "assignment_id": "canvas_assignment_...",
      "package_version": 1
    }
  }
}
```

The returned `signing_key` is diagnostic metadata only. A rep device must ignore it for authorization and call `verifyCanvasPackageManifest` with the independently pinned `VITE_CANVAS_PACKAGE_SIGNING_*` trust anchor. This prevents a compromised response from replacing both a package and its alleged verification key.

Artifact request:

```json
{
  "assignment_id": "canvas_assignment_...",
  "package_version": 1,
  "artifact_id": "context_streets:0"
}
```

Artifact response:

```json
{
  "success": true,
  "package_id": "canvas_package_...",
  "package_version": 1,
  "artifact": {
    "descriptor": {
      "artifact_id": "context_streets:0",
      "artifact_kind": "context_streets",
      "artifact_ordinal": 0,
      "required": true,
      "content_type": "application/json; charset=utf-8",
      "byte_size": 1234,
      "sha256": "..."
    },
    "encoding": "base64url",
    "bytes": "..."
  }
}
```

Only one artifact is returned per request, and every artifact is bounded to 2,000,000 decoded bytes.

## Offline import order

1. Retrieve the exact assignment/version manifest named by the complete operational index.
2. Load the Ed25519 public key and key ID compiled into the app via `VITE_CANVAS_PACKAGE_SIGNING_*`. Call `verifyCanvasPackageManifest` with that pinned key, pinned key ID, and the expected user/campaign/zone identity. Never verify with the response's sibling `signing_key`.
3. Require `package_id`, `package_version`, canonical manifest SHA-256, and index validity to match the operational index. Retrieve every required artifact descriptor individually only when that exact version is not already in the verified local cache; decode base64url and call `verifyCanvasPackageArtifact`.
4. Cache each verified artifact with `canvasOfflineStore.putArtifact`.
5. Reassemble the `pins` shards and cache them with `putPins`.
6. Read the required `dnc_manifest` artifact, verify that all listed `dnc_shard` artifacts are present, reassemble every suppression, then call `putDncSnapshot` with `complete: true`, `verified: true`, the package version, manifest root hash, and high-water cursor.
7. Cache the verified package with `putPackage` and initialize the delta cursor from `manifest.baseline_cursor`.
8. Enable decision queueing only after `readCachedWorkspace().ready` is true.

The package includes exclusive zone-owned knock units, only the shared transit components relevant to that zone, display-only zone geometry, pinned evidence/release/revision identities, current pins, and a complete spatially relevant tenant-wide DNC baseline. Territory ownership remains the street-work-unit set; display polygons are never authoritative.

## Fail-closed states

- Recalled deployment: `campaign_recalled`
- Revoked/replaced assignment: `assignment_revoked`
- Old cached package: `package_version_mismatch`
- Revoked package: `package_revoked`
- Package refreshed/revoked during artifact download: `package_no_longer_current`
- Expired package: `package_expired`
- Wrong rep, TeamMember, manager, campaign, or zone: `canvas_assignment_forbidden`
- Manifest or artifact tamper: `canvas_package_integrity_failed` or `canvas_artifact_integrity_failed`

Do not reuse an old package after any of these responses. Preserve unsent decisions locally, retrieve the newly assigned package, and require an explicit reassignment/reconciliation path for decisions tied to revoked street ownership. An outbox row permanently retains the package version under which it was recorded. On refresh, mismatched unsent rows become `CANVAS_PACKAGE_VERSION_REQUIRES_REVIEW`; they are never submitted under the new version and their original payload remains available for explicit replace-or-discard review.

## DNC concurrency invariant

Package publication and `do_not_knock` decision writes share the tenant advisory-lock namespace `canvas:dnc:<manager_id>`. Any future DNC revocation function must take the same transaction-scoped lock before allocating a change cursor. This makes the package DNC high-water cursor and complete baseline one atomic cut. Once a house has an active tenant suppression, the sync API rejects every ordinary outcome with `dnc_house_protected`; field and manager maps render the DNC protection above ordinary campaign pins. Only a separate audited manager revocation workflow may remove it.
