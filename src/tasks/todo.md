# Current Task: Add ingestion processor lock and batched job updates

## Plan
- [x] Create a `PipelineLock` entity with one logical lock per `FetchJob`.
- [x] Add a 90-second expiring lock at the start of `processFetchChunk`.
- [x] Release the lock before every self-invocation or terminal return.
- [x] Batch normal `FetchJob` progress writes to one write per chunk.
- [x] Keep `failed` and `completed` writes immediate.
- [x] Test duplicate invocation behavior with a safe stale expected-chunk payload.
- [x] Document before/after write-count impact.

## Review
Implemented `PipelineLock` and wrapped `processFetchChunk` so duplicate processors for the same `FetchJob` exit before doing work. Normal chunk progress remains one end-of-chunk `FetchJob` write, while completed/failed writes stay immediate. Added `docs/pipeline-lock-batching-diff.md` with the before/after behavior and write-count impact.