# Canvas national-scale validation gates

This suite is the deterministic, service-free rollout gate for the first national Canvas launch. It uses generated street graphs, an in-memory browser cache, Ed25519 test keys, and static Base44/Postgres mocks. It does not call Overpass, a tile vendor, Base44, Neon, or any paid service.

Run it from the repository root:

```bash
npm run validate:canvas:scale
```

The command aggregates the focused national scenario with the existing residential planner, assignment-package, offline-runtime, operational API, and security-contract tests. Run it serially, as configured, so the planner timings are not distorted by another 20,000-unit fixture competing for the same CPU.

## Required thresholds

| Gate | Pass threshold | What it protects |
| --- | ---: | --- |
| Maximum planning fixture | 20,000 street work units into 250 areas | Published Canvas plan limit and connected/exclusive coverage |
| Planner wall time | under 30 seconds | Bounded manager preview on the deterministic CI fixture |
| Package-publication fixture | 100 reps owning all 20,000 units | Launch team size and exact assignment ownership |
| Base44 roster reads | exactly 2 | One 100-ID TeamMember read and one 100-ID User read; never one query per rep |
| Fresh publication SQL statements | at most 160 | Current worst case is 155: constant control-plane queries, 40 ownership batches of 500, and one atomic package insert per rep |
| Artifact bytes | at most 2,000,000 each | Server hard artifact limit |
| Package bytes | at most 24,000,000 each | Server hard offline-package limit |
| Publication bytes | at most 192,000,000 total | Server all-or-nothing transaction limit |
| Deterministic launch publication | at most 64,000,000 total | Early warning before the hard publication limit |
| Offline decision fixture | 100 decisions for each of 100 reps | 10,000 replay-safe field decisions after reconnection |
| Runtime decision batch | 25 decisions | Four bounded sync calls per rep for the fixture; the API hard cap remains 100 |
| Sync request body | at most 256,000 bytes | Server body limit; byte size takes precedence over item count |
| Cursor fixture | 501 changes per rep, pages of at most 500 | Two ordered delta calls per rep without full-map reloads |
| Catch-up request budget | at most 6 calls per rep / 600 calls for 100 reps | Four decision batches plus two cursor pages in the defined reconnect scenario |
| Idle recovery cadence | no faster than every 5 minutes | At most 20 background change requests per minute across 100 idle reps |
| Offline catch-up wall time | under 30 seconds | Deterministic local store and batching regression guard |

The wall-time checks are regression alarms on generated in-process fixtures, not production latency promises. Production acceptance must separately record p50/p95/p99 service latency and database load under a controlled staging load test.

## Query-count model

For the maximum 20,000-unit, 100-rep fresh publication fixture, the publisher executes:

- 15 constant transaction/control/baseline/version/index statements;
- 40 ownership inserts (`ceil(20,000 / 500)`);
- 100 atomic package inserts, one per rep.

That is 155 SQL statements. The gate allows five statements of implementation headroom but will fail if a new area-by-area lookup or work-unit N+1 query is introduced. The two Base44 roster reads are counted separately.

## Request-rate interpretation

The 600-call catch-up ceiling is for the defined backlog of 100 decisions and 501 changes per rep. Larger supported backlogs remain bounded by the field runtime's 20 decision batches and 20 change pages per sync cycle and then require another explicit/focus/recovery sync. Ordinary online saves can add an immediate decision request; they are not represented as idle recovery traffic. Provider and database load tests remain required before increasing these ceilings or shortening the five-minute recovery interval.
