# Saved route and decision resilience

## What is protected today

- `SavedRoute.property_hashes` in Base44 is the ordered route manifest and the
  source of truth for route membership and order.
- `InteractionLog` in Base44 is the source of truth for door decisions and
  outcomes.
- Neon `properties` contains canonical property/render data, while
  `workspace_properties` is the account-to-property link used by normal
  hydration.
- The browser keeps only transient hydration state and selected route IDs. It
  is not a backup.
- `backupData` is an on-demand, capped JSON response. It neither stores a copy
  nor provides a tested restore path, so it must not be counted as a backup.

The July route-pin incident was a broken relationship/read path: saved route
manifests still existed, but the workspace join no longer returned the
canonical property rows needed to draw pins. A failed hydration lookup must
never be interpreted as evidence that a route or door can be deleted.

## Additive second store

`setupRouteResilienceTables` creates append-only tables in Neon:

- `route_snapshot_versions`: versioned route metadata, ordered hash manifest,
  manifest checksum, and full snapshot checksum.
- `route_snapshot_stops`: one ordered row per door, including the address hash
  and the minimal property snapshot required to rebuild the map pin.
- `route_snapshot_heads`: the most recently reconciled complete version.
- `interaction_snapshot_versions`: append-only versions of decisions and
  outcomes.
- `interaction_snapshot_heads`: the most recently reconciled outcome version.
- `route_resilience_reconciliation_runs`: immutable reconciliation evidence.

Every snapshot row carries a stable tenant key. Snapshot tables are not exposed
to clients. A future recovery/read-repair endpoint must first authorize the
current Base44 route and verify its tenant key; it must never query snapshots by
an unscoped property hash.

`reconcileRouteResilience` is admin-only, paginated, idempotent, and dry-run by
default. Apply mode requires the exact confirmation phrase
`SNAPSHOT_ONLY_NO_SOURCE_MUTATIONS`. It reads Base44 and canonical property
data, writes a complete version transactionally, then advances the head. It
does not create, update, or delete any Base44 entity.

## Rollout

1. Deploy the route hydration fix and retire the destructive legacy
   `cleanupRoutes` endpoint.
2. Run `setupRouteResilienceTables` once with
   `confirmation=CREATE_ROUTE_RESILIENCE_TABLES`.
3. Run every reconciliation page with `apply=false`. Investigate every missing
   tenant and unresolved stop before enabling recovery reads.
4. Run the same pages with `apply=true` and the apply confirmation phrase.
5. Repeat until both `has_more` values are false, then rerun from skip `0`; the
   second pass should report no changed versions.
6. Schedule the reconciler at least every five minutes. Alert on failed runs,
   missing tenant keys, unresolved stops, route-count drift, checksum drift, or
   a head older than the recovery-point target.
7. Centralize all future SavedRoute create/update operations behind one
   server-side service. That service should mirror the committed route version
   immediately and enqueue an idempotent reconciliation item when the second
   write fails.
8. Mirror `recordKnockOutcome` writes immediately using the same idempotent
   pattern. The scheduled scan remains the repair path.

Until steps 7 and 8 are complete, the reconciliation interval is the maximum
possible data-loss window for a record that is created and then deleted between
scans. Cross-database writes cannot be made atomic, so reconciliation and an
outbox are required even after real-time mirroring exists.

## Recovery rules

- Never automatically delete or shorten a route because property hydration,
  date filtering, or a provider lookup returned fewer rows.
- Treat a mismatch as an incident: keep the route shell visible, retry the
  primary lookup, compare checksums, then use the snapshot only after route and
  tenant authorization.
- Preserve the original ordered manifest. Restore property/render details by
  ordinal and address hash.
- Preserve all interaction versions. A restore should select the latest
  checksum-verified head by default and retain older versions for audit.
- Restoration is an explicit admin operation with a dry-run diff. It must never
  overwrite a newer source record automatically.

## Independent disaster backup

Neon snapshots protect against an application/entity-provider failure, but
they do not protect against a Neon account or credential compromise. Enable
database point-in-time recovery and export encrypted daily snapshots to an
immutable object store in a separate provider/account. Retain daily, monthly,
and annual restore points according to the business retention policy, and run
a documented restore drill at least quarterly. A backup is not considered
valid until a restore drill verifies route counts, ordered manifest checksums,
pin coordinates, and interaction checksums per tenant.

