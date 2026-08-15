# Precision Generation — production freeze record (2026-08-15)

The initial Precision Generation route solver is **production-frozen**. Frozen
behavior, benchmark numbers and the barrier-repair telemetry contract live in
`src/tasks/route-decomposition-findings.md`; this file records the freeze steps and
the verification evidence.

## Frozen contract

up to 1,000 homes → ONE initial route → real-road ordering only → exact-once →
compact topology → barrier repair where justified → seam/hotspot refinement →
independent final road verification → **fail rather than guess**.

Future solver changes require a benchmarked regression or a newly demonstrated
failure class — not visual preference or speculative tuning.

## Freeze steps

| step | state |
|---|---|
| benchmark numbers committed | `src/tasks/route-decomposition-findings.md` (Route 1I, 1J, Salisbury, East Valley, Mesquite) |
| Route 1I frozen as permanent barrier regression | `test/fixtures/charlotte-route-1i-barrier-1000.json` — 1,000 real doors, unordered, checksummed, routing attributes only, with the barrier pair and the frozen candidate table |
| Route 1J and other real-route regressions retained | `test/fixtures/charlotte-route-1j-ashley-circle.json`, `test/fixtures/mesquite-route-58.json`, `test/fixtures/road-matrix-*.json` — untouched |
| barrier-repair telemetry documented | findings doc, "Barrier-repair telemetry (documented contract)" |
| freeze guarded in CI | `test/route-1i-barrier-freeze.test.mjs` (FREEZE-1I-01..05) — fixture integrity, no sensitive/solution data, barrier pair present, accepted-candidate record, portfolio still contains the frozen candidates with the baseline competing first |
| re-measurement path | `node scripts/route-barrier-freeze-benchmark.mjs` — live road re-measure, reports drift against the frozen numbers instead of asserting equality (OSM data moves) |
| algorithm behavior pinned without a network | `test/barrier-window-repair.test.mjs` (synthetic river fixture) |
| no further route-quality algorithm changes in this branch | none made — this freeze added a fixture, a guard test, a benchmark script and documentation only |

## Final regression run

`npm test` (node --test test/*.test.mjs), 2026-08-15:

```
# tests 911   # pass 885   # fail 26   # cancelled 0   # skipped 0   # todo 0
# duration_ms 85393
```

All 5 freeze-guard tests pass. All barrier/decomposition/geography tests pass.

## Pre-existing failures (recorded separately — not caused by this work)

None of the 26 failures touch decomposition, barrier repair, the road hierarchy,
or any file changed by this freeze; the added files are imported only by the
freeze guard and the benchmark script.

**In the CI baseline** (`scripts/verify-test-failure-baseline.mjs`,
`KNOWN_TEST_FAILURES`) — 12 of the 13 listed entries reproduced:

- Canvas keeps owner-scoped previews safe… (`canvas-production-ui`)
- the checklist logs outcomes optimistically…; an optimistic checklist row carries created_by… (`knock-outcome-feedback`)
- ANCHOR-09 ANCHORS sits beside Split Route, Optimize and Export (`route-anchors`)
- Precision route bounds are explicit, off by default… (`route-bounds-integration`)
- Home and RepHome interactive optimizers never depend on live road loading (`route-continuity-call-sites`)
- DEP-02 the guard is non-vacuous…; DEP-03 Home.jsx imports the distance helper… (`route-module-dependencies`)
- a geographically wide street remains one block…; initial, manager, and rep optimization keep whole streets contiguous (`route-street-sweep`)
- Analytics exposes an all-pages Sales Manager… (`sales-management`)
- Team keeps its heatmap while HQ redirects… (`user-activity-heatmap`)

`NEWBUILD-05 the window rolls with the calendar` (`new-construction`) is in the
baseline but now passes.

**Failing on main but NOT in the baseline list — the gate list is stale and should
be reconciled in its own change, not here:**

- webhook rejects $0 trial invoices…; renewal advances the paid usage period… (billing/precision usage)
- Canvas touch and pen drawing commits on release…; Canvas guards every visible unsaved-plan exit…; Canvas toolbar labels the planner handoff honestly… (canvas UI)
- globally optimizes 10,001 unique-street homes into exact index-only manifests (large-route worker)
- map views have attribution disabled as requested (map attribution)
- watchdog settles a stale running reservation…; watchdog keeps and promptly retries…; watchdog retries an unsettled user cancellation…; watchdog paginates terminal jobs… (precision cancellation/watchdog)
- TIER-09 a route with too many blocks refuses instead of mispricing (road-matrix tiers)
- MENU-01 the Optimize button no longer reoptimizes on click; MENU-09 Route Command omits the redundant Home Base shortcut (route optimize mode menu)

These were already known open issues before the freeze (TIER-09, street-sweep,
anchors, DEP-02/03, continuity call sites, large-route worker, watchdog
settlement, attribution). Reconciling `KNOWN_TEST_FAILURES` with main is tracked
as follow-up work outside the frozen solver.