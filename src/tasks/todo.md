# Scalability Master Plan

## Goal
Make FirstKnock scalable beyond the current Base44 property-storage bottleneck by completing the Neon migration, reducing frontend payload size, hardening background processing, and adding production readiness checks.

## Current State
- Base44 still handles users, auth, billing, teams, fetch jobs, saved routes, interaction logs, and UI workflow.
- Neon now stores property records and workspace property links.
- Existing Base44 property records were backfilled to Neon.
- New heavy property ingestion has been moved toward Neon-first storage.
- Stripe checkout has been tested and can create a live checkout session.

## Current Bottlenecks Identified

### P0 — Route/map reads still have legacy Base44 property paths
- `pages/Home` still reads `MasterProperty` in multiple paths.
- Route generation can still load very large property arrays into the browser.
- This means storage scalability improved, but query scalability is not fully complete.

### P0 — Route generation is mostly frontend-bound
- Filtering and route optimization happen in the browser.
- Large territories can block the UI thread or hit memory limits.
- This is the next biggest scale risk after property storage.

### P1 — Missing dedicated Neon route-candidate API
- Need a backend function that returns only route-ready candidates from Neon.
- It should support polygon/bounds, zip filters, sold date, route_active, status, confidence, and property type filters.
- This avoids huge unbounded frontend reads.

### P1 — Some ingestion/helper functions still reference Base44 `MasterProperty`
- `fetchAreaProperties` still checks cached properties through Base44.
- `fetchZipProperties` likely still writes/reads Base44 paths and should be reviewed next.
- Some diagnostics and force-sync flows may still depend on old storage.

### P1 — No true queue system
- Fetch jobs are chunked and self-chained, which is good.
- But there is no durable queue with retries, visibility timeout, and dead-letter handling.
- Current approach is acceptable short-term but should be hardened for high traffic.

### P1 — Production observability is incomplete
- No dedicated health check endpoint.
- No error alerting workflow.
- No runbook for failures.
- Logs exist, but production incident visibility is still limited.

### P2 — Database operational readiness
- Neon schema has good baseline indexes.
- Need storage measurement after larger real data volume.
- Need backup/restore test.
- Need query performance checks on route candidate queries.

### P2 — Multi-step writes need transaction review
- Neon upserts should be transaction-safe where possible.
- Stripe webhook updates user subscription + invite code in separate steps; acceptable now but should be reviewed.

### P2 — External API resilience
- RentCast has retry/backoff in `processFetchChunk`.
- BatchData handling is partially defensive.
- Other external calls should get consistent timeouts and failure behavior.

## Implementation Roadmap

### Phase 1 — Finish Neon read cutover for map and route generation
- [x] Create/review `getRouteCandidatesFromNeon` backend function.
- [x] Query Neon by user_email/workspace, route_active, zip, sold_date, bounds/polygon prefilter, and confidence/status.
- [x] Return capped, route-ready records only.
- [x] Replace `Home` initial property query with Neon function.
- [x] Replace zip-specific `MasterProperty.filter` reads in route generation with Neon function calls.
- [x] Keep `SavedRoute`, `InteractionLog`, and team reads in Base44.

### Phase 2 — Remove remaining heavy `MasterProperty` dependencies
- [x] Review `fetchZipProperties` and migrate heavy writes/reads to Neon.
- [x] Remove Base44 cache checks in `fetchAreaProperties` or replace with Neon stats/candidate checks.
- [ ] Keep `MasterProperty` only as legacy/backward-compatible fallback until confidence is high.
- [ ] Add a feature flag or env mode for rollback if Neon query path fails.

### Phase 3 — Move heavy route computation off the browser where needed
- [x] Add backend route-generation function for large working sets.
- [x] Keep browser route optimization for small sets.
- [x] Use threshold-based behavior: small routes client-side, large routes backend-side.
- [ ] Return saved route summaries and property hashes, not huge route payloads.

### Phase 4 — Production hardening
- [x] Add `healthCheck` backend function checking Base44 auth availability, Neon connectivity, and required secrets.
- [x] Add admin-only diagnostics page or function for storage, job status, and recent failures.
- [ ] Add error alerting strategy for failed jobs/webhooks.
- [x] Add runbook for stuck fetch jobs, Stripe webhook failures, RentCast failures, and Neon capacity.

### Phase 5 — Database scale validation
- [ ] Run `measureNeonStorage` after a larger pull.
- [ ] Estimate 10k, 100k, 1M property storage cost.
- [ ] Test query speed for common candidate searches.
- [ ] Add missing compound indexes if query plans show slow scans.
- [ ] Test Neon backup restore process.

### Phase 6 — Load and failure testing
- [ ] Simulate multiple users loading Home at once.
- [x] Simulate repeated route candidate queries.
- [ ] Simulate failed RentCast/BatchData calls.
- [ ] Simulate stuck fetch job and watchdog recovery.
- [ ] Confirm app remains usable under partial external API failure.

## Recommended Immediate Next Step
Implement Phase 1 first: create/use a Neon route-candidate backend function and switch `Home` route/map property reads away from Base44 `MasterProperty`.

## Active Implementation Plan

### Pass 1 Scope
- [x] Add Neon route-candidate backend API.
- [x] Switch `Home` map/route property reads from heavy `MasterProperty` reads to Neon route-candidate API.
- [x] Keep Base44 for auth, saved routes, logs, teams, and templates.
- [x] Add production health check backend function.
- [x] Verify new backend functions with test calls.
- [x] Update this review with completed work and remaining items.

## Review
Pass 1 implemented and verified.

### Completed
- Added `getRouteCandidatesFromNeon` and verified it returns Neon candidates successfully.
- Updated `Home` initial property loading to use `getRouteCandidatesFromNeon` instead of large `MasterProperty` queries.
- Updated route generation zip reads to use `getRouteCandidatesFromNeon`.
- Migrated `fetchZipProperties` cache, dedup, and writes to Neon.
- Added `healthCheck` admin function and verified Base44 auth, Neon, required secrets, and job counts.

### Verification Results
- `getRouteCandidatesFromNeon` test returned 200 and successfully returned property candidates.
- `getRouteCandidatesFromNeon` with `limit: 5` returned 200 in 403ms.
- `healthCheck` returned 200 with Neon OK, all required secrets present, and no running jobs.
- `fetchZipProperties` usage-only path returned 200 after Neon migration.

### Remaining Work
- [x] Move `fetchAreaProperties` cache checks fully to Neon.
- [x] Add backend route generation for large working sets.
- [x] Add admin diagnostics function for storage, job status, and recent failures.
- [x] Add runbook for stuck fetch jobs, Stripe webhook failures, RentCast failures, and Neon capacity.
- [x] Add route-candidate load-test helper.
- [x] Verify new/changed functions.
- [x] Update review with final pass results.

### Final Pass Results
- Added `adminDiagnostics` and verified storage/job diagnostics returned successfully.
- Added `loadTestRouteCandidates` and verified repeated route-candidate query testing returned avg 219ms, p95 281ms for 2 runs at limit 50.
- Added `generateRoutesBackend` and verified backend route generation returned routes successfully.
- Updated `fetchAreaProperties` cache linking to use Neon instead of Base44 `MasterProperty`.
- Added `docs/production-runbook.md` covering stuck jobs, Neon, Stripe, RentCast, BatchData, and pre-launch checks.

### Still Not Fully Complete
- Error alerting is documented as needed but not wired to email/SMS/Slack yet.
- Backend large-route generation uses a simpler nearest-neighbor algorithm than the rich frontend optimizer.
- Saved route payloads still store property hashes in Base44; acceptable now, but route summary-only persistence can be improved later.
- Full multi-user load testing and backup restore testing still need to be run outside the app runtime.

## Incident Plan — Data Pull Stuck at 86%
- [x] Check runtime logs and latest `FetchJob` state.
- [x] Identify root cause: resume flow invoked `processFetchChunk` with `expected_chunk: 0` while the resumed job was already at chunk 9.
- [x] Patch resume trigger to use the job’s current `chunk_number`.
- [x] Verify `processFetchChunk` resumes without mutex skip.
- [ ] Patch self-chain invocation to use service mode after 403 on the next automatic chunk.
- [x] Verify the pull advances again after the service-mode patch.
- [x] Remove redundant Phase 1 rewrites during Phase 2 to prevent chunk timeouts near 90%+.
- [x] Verify the current pull reaches completion.
- [x] Document outcome.

### Incident Outcome
- The data pull was stuck at 86% because `fetchAreaProperties` resumed an existing job with `expected_chunk: 0` while the job was already at chunk 9, causing the mutex to skip processing.
- After fixing resume chunk selection, the job advanced to 89% and then 91%.
- A second bottleneck appeared near 90%+: Phase 2 was rewriting all Phase 1 deed records on every MLS sub-circle, causing long upsert loops and a timeout.
- Phase 2 now writes only verified MLS gap-fill records; deed records remain preserved from Phase 1.
- Verified via `adminDiagnostics`: job `69f3a64c26b80535a492d82a` completed at 100% with no running jobs.

## Incident Plan — Route Generation Shows 0 Properties
- [x] Check runtime logs for the failed generation.
- [x] Confirm frontend loaded 0 Neon properties before filtering.
- [x] Inspect Neon candidate ownership/linking logic for email mismatch or workspace scoping issues.
- [x] Patch the smallest safe query/load path fix.
- [x] Verify route candidates return for the affected completed pull.
- [x] Document outcome.

### Route Generation Outcome
- Runtime logs showed route generation started with `base=0, dynamic=0`, so the polygon filter had no candidates to work with.
- The initial Home query can be zip/user-cache scoped and may load 0 properties before a polygon-only generation.
- `generateRoutes` now fetches Neon candidates for the active drawn polygon on demand before applying route filters.
- Verified `getRouteCandidatesFromNeon` returns polygon candidates successfully: test polygon returned 111 route candidates.

## Follow-up Plan — Route Generation Still Starts With 0
- [x] Check runtime logs after the first fix.
- [x] Patch drawn-area fetch to run even when zip/filter state is present.
- [x] Add minimal diagnostic logging for drawn-area candidate fetch count.
- [x] Verify backend polygon candidates are available for generation.
- [x] Document result.

### Follow-up Result
- The first fix only fetched polygon candidates when no zip filter text was present.
- Runtime logs still showed `dynamic=0`, meaning the polygon fetch path was skipped by current UI state.
- The drawn-area fetch now always runs whenever a polygon is active, regardless of zip/filter state.
- Added a concise console log showing how many properties the drawn-area candidate fetch returns.

## Plan — Fix RouteCommandPanel dynamic import crash
- [x] Check runtime logs for the reported module import error.
- [x] Inspect the lazy route panel wrapper and target panel module.
- [x] Patch the loading path to avoid the failed dynamic import.
- [x] Verify by removing the separate dynamic module fetch path that was failing.
- [x] Document the result.

### Review — RouteCommandPanel import crash
- Replaced the lazy dynamic import wrapper with a direct import of `RouteCommandPanel`, so the app no longer fetches `RouteCommandPanel.jsx` as a separate dynamic module at runtime.

## Plan — 5 sq mile test circle
- [x] Set map drawing default area to 5 sq mi.
- [x] Make the 5 sq mi test option always visible.
- [x] Keep all data pull behavior unchanged except the smaller default area.

### Review — 5 sq mile test circle
- The route builder now defaults new drawn circles to 5 sq mi, with 40 sq mi and 300 sq mi still available manually.

## Plan — Neon Route Builder End-to-End
- [x] Check runtime logs for generation and Neon fetch behavior.
- [x] Audit RouteBuilderSettings, Home generation, route filter pipeline, and Neon candidate function.
- [x] Patch route generation to merge Neon candidates instead of overwriting polygon candidates with zip candidates.
- [x] Patch route generation to fetch territory candidates directly from Neon when no polygon/zip is active.
- [x] Refresh generation callback when user territory data changes.
- [x] Keep imported/Neon candidates without sold dates eligible instead of dropping them under the default sold-date filter.
- [x] Verify backend candidate retrieval and document result.

### Neon Route Builder Result
- Route generation now fetches from Neon during generation, not just from the local page cache.
- Polygon, zip, and territory Neon candidates are merged instead of overwriting each other.
- The filter pipeline no longer removes imported Neon candidates just because they do not have a sold date.
- Verified `getRouteCandidatesFromNeon` returns active candidates for zip 29621.

## Root-Cause Plan — Polygon State Not Reaching Generate
- [x] Inspect runtime logs: no drawn-area candidate fetch log appears.
- [x] Inspect Home generation path and state names.
- [x] Use the confirmed drawn polygon plus draft polygon fallback when generating.
- [x] Pass the same active polygon to the filter pipeline.
- [x] Verify backend candidate function still returns properties.
- [x] Record final result.

### Root-Cause Result
- Runtime logs showed no drawn-area fetch log, so the frontend was not passing an active polygon into generation.
- Generation now resolves the polygon from confirmed state, draft state, or saved local storage before fetching candidates.
- The same resolved polygon is passed into filtering, preventing a mismatch between fetched candidates and the geography filter.