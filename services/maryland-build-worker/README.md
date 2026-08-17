# Maryland durable build worker

This is a Railway background-worker image for the R2-authoritative Maryland evidence build. It is intentionally separate from the Canvas analysis API so API deploys and Base44 sessions do not own its lifecycle.

The worker validates all journal-referenced chunks, fully re-reads the last retained chunk, resumes `ed4q-f8tm` at the first missing offset, and commits each verified chunk through an immutable collision-safe state revision.

## Exact Railway service contract

Create a new empty service in the existing Railway project. Do not change or redeploy the Canvas analysis service.

- Service name: `maryland-build-worker`
- Source repository: this repository
- Branch: `main`
- Root/working directory: repository root (`/`)
- Builder: Dockerfile
- Dockerfile path: `services/maryland-build-worker/Dockerfile`
- Start command: `node scripts/canvas-evidence/statewide/maryland-build-worker.mjs`
- Restart policy: `On Failure`, maximum 10 restarts
- Public domain/port: none; this is a background process
- Required variables: `CANVAS_R2_ACCOUNT_ID`, `CANVAS_R2_ACCESS_KEY_ID`, `CANVAS_R2_SECRET_ACCESS_KEY`, `CANVAS_R2_BUCKET`

Do not copy signing, database, analysis-service, Stripe, BatchData, or RentCast secrets into this service. Phase 04 needs only the four R2 variables above.

Expected startup records are:

```json
{"event":"worker_starting","phase":"04_homedata","dataset":"ed4q-f8tm","expected_rows":2440779,"state_authority":"r2"}
{"event":"checkpoint_verified","revision":311,"homedata_rows":1310000,"expected_rows":2440779,"retained_chunks":262,"next_missing_offset":1310000,"completed_tiles":0,"expected_tiles":2144,"failures":0}
```

The first acceptance checkpoint is a `checkpoint_advanced` record with `homedata_rows` greater than `1310000`, a revision greater than `311`, and a newly uploaded chunk that passes the worker's read-after-write SHA-256 verification. With the current 5,000-row chunk contract, the expected first values are `homedata_rows: 1315000` and `revision: 312`.

Read-only status:

```sh
node scripts/canvas-evidence/statewide/maryland-build-worker.mjs --status
```

One-chunk acceptance run:

```sh
node scripts/canvas-evidence/statewide/maryland-build-worker.mjs --once
```

The current image completes phase 04 only. It fails closed after HomeData rather than guessing the lost statewide partition orchestration; the frozen compiler is not modified.