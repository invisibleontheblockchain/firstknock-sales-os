# PR A → PR #66 Handoff Report

```
PR_A_TO_PR66_HANDOFF: PASS
```

| | |
|---|---|
| PR #66 audited head | `35396b50457e93fc3c5a1d838a23fae787c75fa6` |
| PR #66 current head | `35396b50457e93fc3c5a1d838a23fae787c75fa6` — **unchanged** |
| PR #66 state | OPEN, draft, MERGEABLE, `CLEAN`, CI `verify` pass |
| Consequence | Stage 5 input expectations are unchanged since Model 1's audit; nothing needed re-deriving |

PR #66 was **not** modified, merged, pushed or checked out.

## Method — and why it is not the mistake Model 1 made

Model 1 initially reported `BLOCKED` after running `invalidLegacyCriteriaFields`
**in isolation**. PR #66's handler does not call it that way: at
`getRouteCandidatesFromNeon.entry.ts:457-466` it first derives a legacy job's
workspace from its immutable subject. Model 1 caught and corrected this itself.

PR A's handoff suite (`test/precision-order-pr66-handoff.test.mjs`) reproduces
PR #66's **handler sequence**, not just its validators:

1. `precisionCriteriaSource` selects the path
2. `buildExistingPrecisionCriteria` reconstructs the criteria
3. the legacy workspace derivation runs
4. the **matching** validator runs — `invalidPersistedCriteriaFields` for
   schema-v1, `invalidLegacyCriteriaFields` for legacy
5. owner and workspace are compared against the authenticated actor

`PR66-H-02` pins **each** of those steps to PR #66's own source text. If PR #66
changes any of them the suite fails, rather than silently invalidating the PASS.
That is the standing guard against repeating the context-loss error.

The validators are the real PR #66 source, vendored byte-exact and
checksum-verified on every run (`PR66-H-01`).

## Result per requirement

| Requirement | Result | Test |
|---|---|---|
| Schema-v1 accepted | ✅ for orders with a price floor | `PR66-H-06` |
| Provider-contract version supported | ✅ `1`, persisted and supported | `PR66-H-05` |
| Actor and subject accepted | ✅ | `PR66-H-03`, `PR66-H-09` |
| Workspace derivation accepted | ✅ **no longer needed** — persisted directly | `PR66-H-04` |
| Polygon hash identical | ✅ | `PR66-H-07` |
| Count mode preserved | ✅ | `PR66-H-07` |
| Entered-count meaning preserved | ✅ | `PR66-H-07` |
| Effective-count meaning preserved | ✅ and always integral | `PR66-H-07` |
| Value criteria preserved | ✅ | `PR66-H-07` |
| Date criteria preserved | ✅ including the full custom window | `PR66-H-07` |
| Route bounds preserved | ✅ | `PR66-H-07` |
| Repull semantics preserved | ✅ **persisted on both paths, never inferred** | `PR66-H-08` |
| Reservation identity valid | ✅ single write, integral | `AR-S4-02` |
| No browser reconstruction | ✅ | `PR66-H-09` |
| No email fallback as authority | ✅ | `PR66-H-09` |
| No guessed required field | ✅ zero rejections | `PR66-H-03` |

## The two acceptance paths, and why both are used

PR #66's schema-v1 validator requires `min_price > 0`. Its legacy validator
deliberately accepts `null` as "no price floor".

| Order | Path | Result |
|---|---|---|
| explicit minimum value (and every `fetchAreaProperties` order) | `schema_v1` | accepted, `invalid_fields: []` |
| blank minimum on `startBatchDataPull` | `legacy_reconstructed` | accepted, `invalid_fields: []` |

**Zero rejections on either path.** The snapshot is withheld rather than
published unsatisfiable — `M2-NEW-01` in
[MODEL_1_FINDING_ADJUDICATION.md](MODEL_1_FINDING_ADJUDICATION.md). Resolving the
`min_price` product decision would move every order onto the schema-v1 path;
PR A does not pre-empt that decision.

## What changed for PR #66

| | Before PR A | After PR A |
|---|---|---|
| Classification | always `legacy` | `schema_v1` when publishable, else `legacy` |
| Workspace | absent — derived by PR #66 from the subject | **persisted** |
| Provider contract version | absent (`null`) | `1` |
| `repull_mode` on `fetchAreaProperties` jobs | absent — **inferred** as `new_area` | persisted |
| Fractional counts | possible, and unroutable | impossible |
| Dependence on PR #66's derivation | total | none |

## Residual

- **Delegated access remains impossible** (`PR66-H-10`): a job is refused for any
  subject other than its owner. That is PR #66's deliberate design, not a PR A
  regression, and PR A does not change it.
- **Full end-to-end PR #66 handler execution needs a database**, so the outermost
  HTTP layer is not exercised. The decision logic that determines acceptance is.
  `EVIDENCE_GAP`.
