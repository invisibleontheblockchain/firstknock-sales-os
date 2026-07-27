# Stage 2 Adjudication — order and criteria

**Adjudications** `ADJ-M2-003`, `ADJ-M2-004`, `ADJ-M2-009` (unresolved).
**Model 1 findings** `F-PRA-015`–`F-PRA-027`, `F-PRA-057`–`F-PRA-059`.

| Aspect | Current | Model 1 | Model 2 | Final target | Change |
|---|---|---|---|---|---|
| Typed Fixed Count | browser-clamped twice | PRODUCT_DECISION + DEFECT | **unresolved, not implemented** | to be decided | **none** |
| Invalid counts | silently → max available | PROVEN_DEFECT | confirmed | explicit `400` | **CH-03** |
| Fractional counts | reserved as-is | PROVEN_DEFECT | confirmed | rejected | **CH-03** |
| `''` | → max available | proposed reject | **revised: keep as absent** | absent | none |
| Max Available | browser-side | PROVEN_DEFECT | confirmed | inside the lock | **CH-04** |
| `min_price` default | `null` vs `100000` | PROVEN_DEFECT | confirmed | one contract | **none — PR #66 owns it** |
| Price range | `max < min` accepted | PROVEN_DEFECT | confirmed | validated | **not changed** — bundled with the min_price decision |
| Custom window minimum | metadata only | PARITY_RISK | confirmed | first-class in the snapshot | **CH-06** |
| Route filters | server-forced | KEEP | confirmed | unchanged | none |
| Route bounds | coordinates only, address stripped | KEEP | confirmed | unchanged | none |
| Repull fields | discarded by one path | PROVEN_DEFECT | confirmed | both paths | **CH-06** |

## Fixed Count — deliberately unresolved

The work order forbids assuming Contract A or B. Model 1 recommended A "if
forced"; Model 2 declines to force it. Model 1's own evidence is *medium*
confidence because it rests on extracted browser expressions rather than a
rendered component, and this repository has no DOM tooling to settle it.

PR A's count path assumes neither contract: `entered_count` carries whatever the
client sent for `fixed`, and equals the locked allowance for `max_available`,
where the two readings do not differ. Whichever is chosen, the server already
implements it.

**Question for the product owner:** does "Fixed Count" mean *exactly the number I
typed*, or *at most my displayed allowance*? PR #66's retry mapper assumes A.

## `min_price` — a new visible consequence

Because criteria are now actually compared, the unresolved divergence surfaces as
an explicit cross-path `409` (`ADJ-M2-005b`) instead of a silent resume with the
wrong criteria. Strictly safer, but visible — and it does not resolve the
decision.
