# PR A Final Report — Model 2

```
MODEL_2_PR_A_RESULT: DRAFT_PR_CREATED
PR_A_TO_PR66_HANDOFF: PASS
```

## Coordinates

| | |
|---|---|
| Repository | `invisibleontheblockchain/firstknock-sales-os` |
| Model 1 branch | `audit/precision-order-control-model-1` |
| Model 1 starting SHA | `03adf5cd59aba8c4b7f095d4a799085ecb9f7186` |
| Model 1 candidate SHA | `0c3fd666bfa0ba5b506503578d727d201c62fbdc` — **verified** |
| Model 2 branch | `hardening/precision-order-control-model-2` |
| Model 2 base SHA | `03adf5cd59aba8c4b7f095d4a799085ecb9f7186` |
| PR #66 audited head | `35396b50457e93fc3c5a1d838a23fae787c75fa6` |
| PR #66 current head | `35396b50457e93fc3c5a1d838a23fae787c75fa6` — unchanged |
| PR #66 state | OPEN, draft — **not modified** |

`origin/main` has not advanced since Model 1's base, so **no finding is stale**.

## Verdict summary

| | Count |
|---|---|
| `VERIFIED` | 24 |
| `PARTIALLY_VERIFIED` — observation accepted, remedy revised | 3 |
| Severity revised | 4 |
| `PRODUCT_DECISION_REQUIRED` | 5 |
| `EXTERNALLY_BLOCKED` | 1 |
| `EVIDENCE_GAP` upheld | 4 |
| Preserved deliberately | 11 |
| `UNSUPPORTED` / `CONTRADICTED` | **0** |
| `STALE` | 0 |
| **New Model 2 findings** | **3** |

## Stage summary

| Stage | Model 1 findings | Model 2 verdict | Changes | Unresolved |
|---|---|---|---|---|
| **0** identity / allowance | `F-PRA-001`–`007` | cross-subject attribution VERIFIED, upgraded to P0 | `CH-01`, `CH-06` | hard-coded email grant; shared-module refactor rejected |
| **1** polygon | `F-PRA-008`–`014` | VERIFIED; centroid sub-proposal rejected | `CH-02` | hash submission-vs-area identity |
| **2** order / criteria | `F-PRA-015`–`027` | VERIFIED; `''` handling revised | `CH-03`, `CH-04` | **Fixed Count contract**; `min_price` divergence |
| **3** Preview | `F-PRA-028`–`035` | VERIFIED; 3 proposals rejected/deferred | `CH-07` | sandbox-key billing (`EXTERNALLY_BLOCKED`) |
| **4** lock / FetchJob | `F-PRA-036`–`049` | VERIFIED; cancellation remedy narrowed | `CH-05`, `CH-06` | reservation release on cancel |

## New Model 2 findings

| ID | Finding | Resolution |
|---|---|---|
| `M2-NEW-01` | Publishing a schema-v1 snapshot on a blank-minimum order would flip a job PR #66 **accepts** into one it **rejects** — a regression disguised as an upgrade | snapshot gated on schema-v1 eligibility; `precision_criteria_withheld` records why |
| `M2-NEW-02` | Comparing a pre-PR-A job on the full criteria set would `409` **every in-flight job at deploy time** | `LEGACY_COMPARABLE_CRITERIA_FIELDS` |
| `M2-NEW-03` | The unresolved `min_price` divergence now surfaces as an explicit cross-path `409` instead of a silent wrong-criteria resume | documented; product decision untouched |

`M2-NEW-01` and `M2-NEW-02` were both caught *before* shipping, by testing
against PR #66's real validator and a realistic legacy fixture respectively.

## Validation

| Command | Baseline | Final |
|---|---|---|
| `npm test` | 518 pass, 0 fail | **723 pass, 0 fail** |
| `npm run typecheck` | PASS | PASS |
| `npm run lint` | **10 errors (inherited)** | 10 errors — byte-identical |
| `npm run build` | PASS | PASS |
| `npm run validate:backend` | PASS, 85 functions | PASS, 85 functions |
| `npm run validate:artifact` | PASS | PASS, 22 artifacts |
| `git diff --check` | clean | clean |
| `npm run test:precision` | `UNAVAILABLE_ON_BASELINE` | still undefined |

**Inherited failures: 1** (lint, 10 unused-import errors in map-attribution code,
unrelated to Precision). **New failures: 0.**

- **Test-first:** 26 of 32 hardening tests failed on unmodified `main`; the 6
  that passed are the deliberate "must not change" guards.
- **Mutation challenge:** 30 applied, **30 caught, 0 survived**.
- **Prospective merge** into `origin/main` in an isolated worktree: no conflicts,
  723/723, typecheck/build/backend/artifact all pass, lint unchanged. Merge
  aborted and the worktree removed.

## Performance

Measured, 25 samples per path per side. **+2 entity reads and ~2 ms per start** —
the cost of querying the active-job lookup on both keys so ownership can be
verified by immutable subject. Writes, entitlement resolutions, external HTTP
calls and processor invocations are all **unchanged**. No improvement is claimed.

## Regression containment

No file under `src/` was modified. No file owned by Stages 5–11 was modified.
`validate:backend` reports the same 85 functions. The 518 pre-existing tests all
still pass. BatchData parsing, classification, persistence, delivered-usage
settlement, candidate retrieval, route optimization, SavedRoute persistence,
hydration, assignment and Ghost Mode recovery are untouched.

## Unresolved

| Item | Class |
|---|---|
| Fixed Count — Contract A vs B | `PRODUCT_DECISION_REQUIRED` |
| `min_price` default divergence | `PRODUCT_DECISION_REQUIRED` — PR #66 owns it |
| Hard-coded email entitlement grant | `PRODUCT_DECISION_REQUIRED` — needs that account's immutable id |
| `polygon_hash` submission vs area identity | `PRODUCT_DECISION_REQUIRED` |
| What Preview promises | `PRODUCT_DECISION_REQUIRED` |
| Sandbox-key billing | `EXTERNALLY_BLOCKED` |
| Production row counts | `EXTERNALLY_BLOCKED` — query recorded, not executed |
| Rendered-component behaviour | `EVIDENCE_GAP` — no DOM tooling |
| Full PR #66 HTTP handler execution | `EVIDENCE_GAP` — needs a database |

## Unresolved risks

1. **Max Available now delivers more homes** when the allowance grew after the
   browser read it. Correct, but it spends more allowance — needs release-note
   disclosure.
2. **A client sending `requested_properties: 0`** previously got a max-available
   pull and now gets a `400`. A client audit is advisable before release.
3. **The `min_price` divergence is now visible** as a cross-path `409`. Safer
   than the silent wrong-criteria resume it replaces, but new behaviour.
4. **PR A and PR #66 both touch the two start paths.** They merge cleanly today;
   the two `_shared` modules should be unified when PR #66 lands.

## Safety confirmation

No paid or sandbox provider call was made. No provider response was fabricated.
No production database query was performed. No production FetchJob was mutated.
No production reservation was modified. No production billing rule was changed
without an adjudicated finding. Nothing was deployed. Nothing was merged. PR #66
was not modified. No force-push occurred. PR A remains a draft.
