# Model 2 Independent Audit

Performed **before** reading Model 1's conclusions, per the anti-bias review order.

## Coordinate verification

| Coordinate | Expected | Actual | Status |
|---|---|---|---|
| Model 1 candidate SHA | `0c3fd666…` | `0c3fd666bfa0ba5b506503578d727d201c62fbdc` | ✅ exact |
| Model 1 branch on `origin` | present | **absent** | ⚠️ see below |
| `origin/main` | `03adf5cd…` | `03adf5cd…` | ✅ unchanged — no finding is stale |
| PR #66 head | `35396b50…` | `35396b50…` | ✅ unchanged |

**Input-gate deviation.** `origin/audit/precision-order-control-model-1` does not
exist, because Model 1 was explicitly forbidden to push. The frozen candidate is
present locally at the exact expected SHA, so the gate's substance — an
immutable, verifiable audit input — is satisfied. Returning `BLOCKED` for a
condition Model 1 was *required* to create would deliver nothing. Recorded here
rather than silently ignored.

**Recommendation:** push the audit branch read-only so a future verifier can
satisfy the gate as literally written.

## Model 1 baseline claims — independently verified

| Claim | Verified against `origin/main` |
|---|---|
| `docs/precision/` absent | ✅ `git ls-tree` returns nothing |
| `base44/functions/_shared/` absent | ✅ |
| `npm run test:precision` undefined | ✅ `UNAVAILABLE_ON_BASELINE` — not substituted |
| (additionally) no `CLAUDE.md`, no `AGENTS.md` | ✅ |

`origin/main` has advanced by **zero** commits since Model 1's base, so no Model 1
finding is stale and no workflow needed reproducing for that reason.

## Independent reproduction of the highest-severity claims

Each was reproduced **from source first**, deliberately not by re-running
Model 1's tests.

| Claim | Source evidence | Verdict |
|---|---|---|
| Cross-subject email attribution | `startBatchDataPull:416-429` — union of two queries merged by job id, no ownership filter between them | VERIFIED |
| Hard-coded email grant | `startBatchDataPull:137` — `user?.email?.toLowerCase() === 'baysecurity@gmail.com'` returns paid + Pro + 1000 before any Stripe call | VERIFIED |
| Max Available browser-side | `count_mode` appears exactly once, at the persistence site; `reservedProperties` has no branch on it | VERIFIED |
| Invalid / fractional counts | `Number(body.requested_properties \|\| maxProperties)` makes `0` falsy; `Math.max(1, …)` applies no integer coercion | VERIFIED |
| Criteria-blind resume | quick mode compares nothing and the response returns the old job's criteria | VERIFIED |
| Preview probe | body is the centroid as a text query; the polygon is never sent | VERIFIED |
| Polygon range validation | `normalizePolygon` checks only `Number.isFinite`, while `normalizeRoutePoint` twenty lines away enforces bounds | VERIFIED |

## Test-quality audit of Model 1's suite

Screened for every weakness class named in the work order.

| Weakness | Found? |
|---|---|
| Source-text-only assertions | ⚠️ 3, all self-disclosed by Model 1 |
| Asserts only that a symbol exists | no |
| Duplicates production logic | no — the harness reimplements nothing |
| Expected and actual from the same function | no — the polygon hash is independently reproduced in-test |
| Mocks away identity authority | no |
| Mocks away locking or concurrency | no — a **real serializing** advisory lock is used |
| Never invokes the handler | no — the real `Deno.serve` handler is executed |
| Handwritten JSON treated as a workflow | no — fixtures are generated and replay-verified |
| Reconstructed data treated as provider evidence | no — explicitly labelled |
| **Validator run without its caller** | ⚠️ **yes, residually** |

**The one real weakness.** Model 1 corrected its own context-loss error, but its
replacement (`AR-C66-05b`) still modelled PR #66's workspace derivation *inside
the test*. PR A replaces it with `PR66-H-02`, which pins every modelled
preprocessing step to PR #66's source text so drift fails loudly instead of
quietly invalidating a PASS.

## Mutation challenge

30 mutations of production code, suite run after each, source restored.

**30 caught, 0 survived.** Model 1's suite is genuinely strong; no test gap was
found. Detail in [VALIDATION_LEDGER.md](VALIDATION_LEDGER.md).
