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