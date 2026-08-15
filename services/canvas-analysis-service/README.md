# FirstKnock Canvas Analysis Service

This service is the production control plane and worker for signed, provider-neutral Canvas evidence. It never calls public Overpass and never reads or writes Precision-mode property storage.

The complete secret-generation, evidence-promotion, migration, staging, rotation, and rollback procedure is in [the Canvas production runbook](../../docs/CANVAS_PRODUCTION_RUNBOOK.md). `canvas-analysis.env.example` is a format reference, not a sourceable production secret file.

## Process model

- The authenticated API verifies the signed evidence manifest, selects candidate tile IDs from signed coverage bounds, and idempotently enqueues a content-addressed job.
- Workers transactionally claim queued or expired-lease jobs with PostgreSQL `FOR UPDATE SKIP LOCKED`.
- Each worker reloads and verifies the pinned manifest, downloads only intersecting signed tiles, enforces byte and SHA-256 checks, selects street units against the manager polygon, expands protected groups atomically, and stitches cross-tile neighbors globally.
- Completion writes the immutable result and terminal job update in one transaction. Results are capped at 5.5 MB and carry independent result and snapshot hashes.
- Cancellation invalidates an active lease. Failed or cancelled content-addressed jobs can be explicitly requeued with `retry_failed_job: true`.

The API paths exactly match the Base44 adapters:

```text
POST /v1/canvas/analyses
GET  /v1/canvas/analyses/:workerJobId/status
POST /v1/canvas/analyses/:workerJobId/cancel
GET  /v1/canvas/analyses/:workerJobId/result
GET  /healthz
```

Status and result GETs require `x-firstknock-job-id` and `x-firstknock-manager-id`. Every non-health request requires `Authorization: Bearer <CANVAS_ANALYSIS_SERVICE_TOKEN>`.

## Required configuration

```text
CANVAS_DATABASE_URL                  Durable Neon/PostgreSQL connection URL
CANVAS_ANALYSIS_SERVICE_TOKEN       Shared Base44-to-service bearer token, at least 32 characters
CANVAS_EVIDENCE_MANIFEST_URL        Immutable or version-addressed HTTPS manifest URL
CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY Ed25519 SPKI public key, PEM or base64 DER
CANVAS_EVIDENCE_MANIFEST_KEY_ID     Expected manifest signature key ID
```

Optional configuration:

```text
CANVAS_EVIDENCE_BEARER_TOKEN
CANVAS_SERVICE_MODE=api|worker|both
CANVAS_WORKER_CONCURRENCY=2
CANVAS_WORKER_POLL_MS=1000
CANVAS_WORKER_LEASE_MS=120000
CANVAS_DATABASE_MAX_CONNECTIONS=10
CANVAS_MAX_MANIFEST_BYTES=67108864
CANVAS_MANIFEST_CACHE_TTL_MS=300000
HOST=0.0.0.0
PORT=8080
```

`CANVAS_EVIDENCE_BEARER_TOKEN` is sent only to the manifest origin. Tile URIs must be signed, relative paths on that same origin. No credential is accepted from or returned to a browser.

Provider identity is read from the verified manifest's `sources[]` entries. There is no production `CANVAS_EVIDENCE_PROVIDER` setting and no live Overpass or Nominatim fallback.

## Local verification

From the repository root:

```sh
node --test services/canvas-analysis-service/test/service.test.mjs
npm run validate:canvas:production -- --component analysis --manifest-file ./promoted-manifest.json
```

The test starts a real local HTTP listener, uses a deterministic Ed25519-signed manifest and tile fixture, runs an in-memory durable-store substitute, executes one worker claim, and independently verifies the result-byte hash and the exact snapshot identity consumed by `canvasGetAnalysis`. It performs no external network requests.

To run the actual service locally, set the required variables and run:

```sh
node services/canvas-analysis-service/src/index.mjs
```

The service applies idempotent table/index migrations on startup. The checked-in production store uses the already-supported `@neondatabase/serverless` PostgreSQL client and `CANVAS_DATABASE_URL`; tests never need a database.

## Container build

Build from the repository root so the existing locked dependencies are available:

```sh
docker build -f services/canvas-analysis-service/Dockerfile -t firstknock-canvas-analysis .
docker run --rm -p 8080:8080 --env-file .env firstknock-canvas-analysis
```

For initial rollout, `CANVAS_SERVICE_MODE=both` is appropriate. At higher volume, run API replicas with `api` and separately autoscale worker replicas with `worker`; PostgreSQL locking prevents duplicate claims. Worker-only mode exposes just the authenticated-process-independent `/healthz` database health endpoint.

## Release immutability requirement

The manifest URL must continue serving the exact signed release pinned when a job starts. If a deployment advances to a new release, publish it at a new immutable URL before updating the environment. A queued job fails closed if the release ID, manifest hash, provider identity, tile scheme, or selected tile set changes.
