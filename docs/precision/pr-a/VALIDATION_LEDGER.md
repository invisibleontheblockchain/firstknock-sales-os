# Validation Ledger — PR A, Model 2

Environment: Windows 11, Node 23.11.0. Branch
`hardening/precision-order-control-model-2`, base `03adf5cd`.

## Baseline — independently re-measured, not inherited from Model 1

| Command | Exit | Result |
|---|---|---|
| `npm ci` | 0 | PASS |
| `npm test` | 0 | **518 tests, 518 pass, 0 fail** |
| `npm run typecheck` | 0 | PASS |
| `npm run lint` | **1** | **FAIL — 10 inherited errors** |
| `npm run build` | 0 | PASS |
| `npm run validate:backend` | 0 | PASS — 85 functions, 4 JSON configs |
| `npm run validate:artifact` | 0 | PASS |
| `git diff --check` | 0 | PASS |
| `npm run test:precision` | — | **`UNAVAILABLE_ON_BASELINE`** — not defined in `package.json`; introduced by PR #66. Not substituted. |

Model 1's three baseline claims **independently verified** against `origin/main`:
`docs/precision/` absent, `base44/functions/_shared/` absent, `test:precision`
undefined. Also confirmed: no `CLAUDE.md`, no `AGENTS.md`.

The 10 lint errors are `unused-imports/no-unused-imports` in
`CanvasFieldView.jsx`, `RepMapView.jsx`, `Home.jsx`, `ZipCodeExplorer.jsx` —
**inherited**, unrelated to Precision, and unchanged by PR A. Not fixed: the work
order forbids unrelated lint cleanup without separate authorization.

## After PR A

| Command | Exit | Result | Delta |
|---|---|---|---|
| `npm test` | 0 | **723 pass, 0 fail** | 518 → 723 (+205) |
| `npm run typecheck` | 0 | PASS | unchanged |
| `npm run lint` | 1 | 10 errors | **byte-identical to baseline** |
| `npm run build` | 0 | PASS | unchanged |
| `npm run validate:backend` | 0 | PASS — 85 functions | unchanged |
| `npm run validate:artifact` | 0 | PASS — 22 artifacts | unchanged |
| `git diff --check` | 0 | clean | — |

**Inherited failures: 1** (lint, 10 errors). **New failures: 0.**

## Test-first record

`test/precision-order-hardening.test.mjs` was run against **unmodified**
`origin/main@03adf5cd` before any production change:

```
tests 32   pass 6   fail 26
```

The 6 that passed are the deliberate "must not change" guards — legacy email
attribution, odd-but-valid polygons, omitted counts, integral counts, fixed-mode
capping, and the max_available allowance ceiling. Every accepted defect had a
failing test first.

## Mutation and negative validation

30 mutations applied to production source, suite run, source restored. The
production tree was verified clean after every mutation.

| Result | Count |
|---|---|
| **Caught** | **30** |
| **Survived (test gap)** | **0** |

Covered: wrong actor, subject from body, dropped immutable query, unauthorized
paid grant, beta-grant symmetry, lat/lng swap, dropped polygon point, hash
precision, centroid shift, count flooring, max-available inside the lock,
min-price floor, custom-window minimum dropped, sold-months from minimum, route
bounds dropped, route filters widened, double reservation, double processor
invocation, create outside the lock, sorted active-job lookup, subject-keyed
lookup, auto-cancel removed, client-flag cancel removed, reservation released on
cancel, schema version added, workspace added, preview polygon sent, preview
retry added, preview entity write, dry-run job creation.

Three initially reported anchor misses were **my regex errors, not test
weaknesses** — the working tree is CRLF and my multi-line anchors used `\n`.
Re-run with single-line anchors: all three caught.

**Conclusion: no test gap found in Model 1's suite.**

## Test-quality audit

| Check | Finding |
|---|---|
| Runs real production logic | ✅ transpiles and executes the real `entry.ts`, registers the real `Deno.serve` handler |
| Reimplements production functions | ✅ none — grep for `resolvePrecisionEntitlement`/`getPrecisionAllowance`/`normalizePolygon` in the harness returns 0 |
| Mocks away the behaviour under test | ✅ no — only dependencies (entity store, Stripe, Neon, `fetch`, clock) are stubbed |
| Locking mocked away | ✅ no — concurrency uses a **real serializing** advisory lock over a shared store |
| Expected values from the same function | ✅ no — the polygon hash is independently reproduced in-test |
| Source-text-only assertions | ⚠️ 3 (`AR-S3-08`, `AR-EJ-06`, and the browser-expression helper). Model 1 disclosed all three; they are the weakest evidence in the package. |
| **Validator run without its caller** | ⚠️ **found and closed.** Model 1 corrected one such error itself. Its residual `AR-C66-05b` still modelled PR #66's derivation *in the test*. PR A replaces this with `PR66-H-02`, which pins each modelled preprocessing step to PR #66's source text. |

## Suites

| Suite | Tests |
|---|---|
| `precision-order-stage0-authority` | 19 |
| `precision-order-stage1-polygon` | 22 |
| `precision-order-stage2-intent` | 67 |
| `precision-order-stage3-preview` | 18 |
| `precision-order-stage4-lock` | 17 |
| `precision-order-hardening` (Model 2) | 33 |
| `precision-order-pr66-handoff` (Model 2) | 10 |
| `precision-order-pr66-compatibility` | 9 |
| `precision-order-fixture-replay` | 8 |
| **Total Stage 0–4** | **203** |
| Full repository | **723** |

24 Model 1 characterization tests pinned behaviour PR A deliberately changed.
16 were updated in place with a `UPDATED BY PR A` marker naming the adjudication;
16 that existed only to document a now-fixed defect were removed with a
supersession block naming the hardening test that replaces each. Model 1's
originals remain intact on the frozen audit branch.

## Prospective merge check

See [PR_A_FINAL_REPORT.md](PR_A_FINAL_REPORT.md).

## Not run

| Command | Why |
|---|---|
| any BatchData call, paid or sandbox | not authorized |
| live Preview | not authorized |
| any production database query | not authorized — see [EXISTING_JOB_COMPATIBILITY.md](EXISTING_JOB_COMPATIBILITY.md) |
| `npm run validate:dependencies` | `npm audit` needs the registry and is unrelated to Stages 0–4 |
| deploy / canary | out of scope |
