# Data continuity — outcomes, houses, areas, routes

Every irreplaceable field record lives in the Base44 entity store. A customer's
knock history cannot be repurchased, re-derived, or reconstructed from anything
else. This system keeps a second, independent, append-only copy of it, verifies
that copy continuously, and can replay it back.

Nothing here modifies existing data. All new tables live in a dedicated
`continuity` schema; the replication worker is strictly read-only against the
live store; restore is additive and never deletes.

## What is protected

| Data | Entities | Tier |
|---|---|---|
| Outcomes | `InteractionLog`, `CanvasHouseEvent`, `DailyResult` | 1 — irreplaceable |
| Routes | `SavedRoute`, `RouteTemplate` | 1 / 3 |
| Canvas houses & areas | `CanvasHousePin`, `CanvasSession` | 2 |
| Areas | `TerritoryPlan` | 2 |
| Appointments | `Appointment` | 2 |
| Team | `TeamMember` | 3 |
| Houses | `MasterProperty` | 3 — repurchasable |

`User` is deliberately excluded. It is the auth and billing record, recoverable
from Base44 auth plus Stripe, and mirroring it would copy credentials and PII
into a second store for no recovery benefit.

## How a record reaches the mirror

1. **Realtime journal.** `recordKnockOutcome` appends to the ledger the moment a
   write commits — single outcomes, CSV history imports, workflow transitions,
   and sale edits. Bounded to 1.5s and failure-swallowed, so a mirror problem can
   never fail or slow a rep's knock.
2. **Sweep.** `replicateFieldData` walks each entity by `updated_date` from a
   stored cursor every minute. This backstops every write path that does not call
   the journal: offline replay, admin scripts, other functions.
3. **Reconcile.** A slower full-key pass detects records that vanished from the
   live store.

A version is appended only when the record's content hash changes, so an
untouched record does not accumulate copies. All three paths compute the same
hash — there is a test pinning that, because a drift there would silently
double-write and produce false health alarms.

**Canvas is covered by the sweep only, not the realtime journal.**
`canvasLogHouseDecision` is deliberately isolated from the Precision property
database, and `canvas-production-backend` asserts it never references
`DATABASE_URL`. Adding an inline journal there would breach that boundary, so
`CanvasHousePin` and `CanvasHouseEvent` are mirrored by the 60-second sweep like
every other entity. The practical difference is a recovery point of up to 60
seconds for Canvas taps versus near-zero for Precision outcomes. Closing that
gap means either relaxing the isolation rule or routing Canvas writes through a
separate journal function — a deliberate decision, not an oversight.

## The guarantees

**History cannot be erased.** `continuity.record_versions` carries a
`BEFORE UPDATE OR DELETE` trigger that raises on any mutation. Once a version
lands, no application bug, admin script, or restore run can rewrite it. Losing
it for good requires deliberately dropping the table.

**Deletions are tombstoned, never applied.** When reconcile finds a record gone
from the live store it sets `deleted_detected_at` on the projection. Every
version that record ever had stays in the ledger and stays restorable.

**A mass deletion is refused, not replicated.** If more than 2% of an entity's
mirrored records disappear at once (and at least 25 of them), reconcile files a
row in `continuity.deletion_alarms` and tombstones **nothing**. This is the
specific defence against the near-miss: a bulk delete in the live store does not
propagate into the mirror. Clearing it is a deliberate human act:

```bash
curl -X POST "$BASE/api/functions/replicateFieldData" -H "x-continuity-worker-secret: $S" -H 'content-type: application/json' -d '{"mode":"reconcile","entities":["InteractionLog"],"acknowledge_mass_deletion":true,"acknowledged_by":"you@example.com"}'
```

**Absence is never inferred from a partial read.** If reconcile cannot list an
entity completely within its scan cap, it reports `scan_incomplete` and
tombstones nothing rather than inventing deletions.

## Setup

### 1. Secrets

| Env var | Purpose |
|---|---|
| `CONTINUITY_MIGRATION_SECRET` | Gates the one-time schema migration |
| `CONTINUITY_WORKER_SECRET` | Scheduler auth for replication, snapshots, health |
| `CONTINUITY_RESTORE_SECRET` | Required on top of admin for a live restore |

Generate each as a distinct high-entropy value. Never place them in a URL, query
string, browser, or monitoring label.

### 2. Provision the schema

Deploy `setupContinuityTables`, then invoke it once as a Base44 admin:

```bash
curl -X POST "$BASE/api/functions/setupContinuityTables" -H "x-continuity-migration-secret: $CONTINUITY_MIGRATION_SECRET"
```

Confirm `append_only_guard_installed: true` in the response. If it is false, stop
and investigate — the ledger is mutable and the core guarantee is absent.

### 3. Schedule the workers

Add to the same scheduler that runs the FieldRoutes worker.

**Sweep — every 60 seconds**, timeout ≥ 120s:

```
POST /api/functions/replicateFieldData
x-continuity-worker-secret: <CONTINUITY_WORKER_SECRET>
{"mode":"sweep"}
```

**Reconcile — every 6 hours**, timeout ≥ 120s:

```
POST /api/functions/replicateFieldData
x-continuity-worker-secret: <CONTINUITY_WORKER_SECRET>
{"mode":"reconcile"}
```

**Snapshot — daily**, timeout ≥ 120s:

```
POST /api/functions/exportContinuitySnapshot
x-continuity-worker-secret: <CONTINUITY_WORKER_SECRET>
{}
```

The first sweeps backfill history. Each invocation covers up to 6000 rows per
entity and advances its cursor, so a large `MasterProperty` table takes several
runs to catch up. `continuityHealth` shows progress.

### 4. Off-site snapshots (optional, recommended)

Dormant until configured — the function reports `not_configured` and exits
without touching anything, so it is safe to schedule first.

Cloudflare R2 is the intended destination: **zero egress fees**, so pulling the
archive back during an incident is free, versus roughly $0.09/GB on S3. Storage
is $0.015/GB-month with 10 GB free. Any S3-compatible provider works.

| Env var | Example |
|---|---|
| `CONTINUITY_SNAPSHOT_BUCKET` | `firstknock-continuity` |
| `CONTINUITY_SNAPSHOT_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` |
| `CONTINUITY_SNAPSHOT_ACCESS_KEY` | R2 access key id |
| `CONTINUITY_SNAPSHOT_SECRET_KEY` | R2 secret access key |
| `CONTINUITY_SNAPSHOT_REGION` | `auto` (default, correct for R2) |
| `CONTINUITY_SNAPSHOT_PREFIX` | `firstknock` (default) |

Give the token **Object Read & Write on one bucket only**, and enable the
bucket's own retention or object-lock policy so a leaked key cannot erase the
archive. Output is gzipped NDJSON at
`<prefix>/YYYY/MM/DD/continuity-<timestamp>.ndjson.gz`, with a header line
carrying row counts and a `content_sha256` recorded in
`continuity.snapshot_exports`.

## Monitoring

**HQ → Operations → Data continuity** shows status, records mirrored, versions
retained, append-only guard state, snapshot age, and a per-entity table.

The column that matters is **Newest verified**. It samples the most recently
updated live records and confirms each is in the mirror with a matching content
hash. Below 100% means recent writes are not replicated. A row count would hide
exactly this failure, which is why the check probes recall instead.

For an uptime monitor, poll with the worker secret:

```bash
curl "$BASE/api/functions/continuityHealth" -H "x-continuity-worker-secret: $CONTINUITY_WORKER_SECRET"
```

Alert on `status` of `degraded` or `critical`. Pass `?probe=false` for a cheap
check that skips the live-store sampling.

| Signal | Meaning |
|---|---|
| `append_only_guard: false` | **Critical.** History is mutable. Re-run the migration. |
| Tier-1 recall < 100% | Recent outcomes are not mirrored. Check sweep errors. |
| Sweep lag > 1h | The scheduler is not calling the worker. |
| `consecutive_failures ≥ 3` | An entity is failing repeatedly; read `last_error`. |
| Open deletion alarm | A bulk disappearance was refused. **Investigate before acknowledging.** |

## Recovery

> Run the drill below on a staging tenant before you need it. An untested
> restore is a hypothesis.

### Step 1 — Establish what is missing

Open HQ → Operations, or query directly:

```sql
SELECT entity, COUNT(*) FILTER (WHERE deleted_detected_at IS NOT NULL) AS tombstoned,
       COUNT(*) AS mirrored
FROM continuity.record_current GROUP BY entity;
```

### Step 2 — Preview the restore

Dry run is the default; omitting `dry_run` cannot trigger a write. No restore
secret is needed to preview.

```bash
curl -X POST "$BASE/api/functions/restoreFieldData" -H 'content-type: application/json' -d '{"entity":"InteractionLog","manager_id":"<manager>","limit":200}'
```

Read `would_create`, `would_update`, `already_present`, and the samples. Records
that still exist are counted as `already_present` and left alone unless you pass
`overwrite_existing`.

### Step 3 — Apply

```bash
curl -X POST "$BASE/api/functions/restoreFieldData" -H "x-continuity-restore-secret: $CONTINUITY_RESTORE_SECRET" -H 'content-type: application/json' -d '{"entity":"InteractionLog","manager_id":"<manager>","dry_run":false,"limit":200}'
```

Note the returned `restore_id`. Pass it back on every subsequent call to work
through the backlog — it carries the id map forward and prevents recreating a
record twice.

**Restore whole tenants in dependency order**, not entity by entity, by omitting
`entity` entirely. Recreated records get new ids, and the run rewrites
`route_id`, `pin_id`, `campaign_id`, `assigned_to`, and `rep_id` through the id
map so restored data comes back linked. Outcome-to-house links travel on
`address_hash`, which is content-derived and survives unchanged.

If the owning `User` was itself recreated with a new id, pass
`manager_id_remap: {"<old-id>":"<new-id>"}` or every restored row lands under a
tenant key nobody holds.

### Step 4 — Verify

Re-run `continuityHealth` and confirm tier-1 recall is back to 100%, then spot
check in the app that outcomes appear on the expected routes.

### Restoring from an off-site snapshot

Only needed if Neon is also gone. Download the newest object, verify its SHA-256
against `continuity.snapshot_exports`, `gunzip`, and load the NDJSON into a fresh
`continuity.record_current` — the first line is a header, every subsequent line
is one record. Then follow steps 2–4 as normal.

## Cost

The mirror stores JSON text and compresses well. A team logging 1,000 outcomes a
day accumulates roughly 200 MB of ledger per year — inside Neon's existing
footprint, and inside R2's free tier for snapshots. `MasterProperty` dominates
volume; drop it from the sweep via the `entities` parameter if storage becomes a
concern, since it is the one tier-3 dataset that can be repurchased.

## Tests

```bash
node --test test/continuity-replication.test.mjs test/continuity-restore.test.mjs test/continuity-journal-safety.test.mjs
```

They cover: the worker is read-only against live data; the cursor advances so a
large backfill completes; mass deletions are refused and acknowledgement is
honoured; the journal, sweep, and health probe compute identical hashes; a
database outage, hang, or missing config cannot fail a knock; Canvas stays
isolated from the property database; restore defaults to dry run, demands a
secret to write, never deletes, and rewrites foreign keys.

The suite also has a pre-existing unrelated failure in
`test/beta-access-grants.test.mjs` covering expired beta grants, which is not
part of this work.
