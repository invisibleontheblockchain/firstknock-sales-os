# Stage 3 Adjudication — Preview

**Adjudication** `ADJ-M2-008`. **Model 1 findings** `F-PRA-028`–`F-PRA-035`,
`F-PRA-060`, `F-PRA-061`.

**No live provider call was made at any point.**

| Aspect | Current | Model 1 | Model 2 | Final target | Change |
|---|---|---|---|---|---|
| Trigger | manual; UI always sends `sandbox_probe: true` | PROVEN | confirmed | opt-in | **not changed** — needs the billing answer |
| Request | centroid as a **text query**; polygon never sent | PROVEN_DEFECT | confirmed | use the real builder, or stop implying validation | **disclosed, not changed** |
| Criteria subset | none — no prices, window or bounds | PRODUCT_DECISION | confirmed | to be decided | none |
| Cache / dedupe | none | PROVEN_DEFECT | confirmed | dedupe | **not changed** |
| Timeout | none | PROVEN_DEFECT | confirmed | bounded | **CH-07** — 8s |
| Failure containment | 500, whole Preview lost | PROVEN_DEFECT | confirmed | degrade | **CH-07** |
| Zero-result messaging | still reports eligibility | PROVEN_DEFECT | confirmed | never claim unmeasured availability | **CH-07** — disclosed |
| Usage writes | `getPrecisionUsage` writes `User` | PROVEN_DEFECT | confirmed from source | read-only | **not changed** |
| Fails closed on allowance | yes | KEEP | confirmed | unchanged | none |

## Preview's role, as characterized

An **allowance-and-cost estimator with a provider reachability probe**. It is not
geometry validation (the polygon is never sent), not an availability estimate,
and not a property preview. `CH-07` makes the response say so, rather than
changing what Preview *is* — that is a product decision.

## Deliberately not changed, and why

- **Sending the polygon** (`PC-PRA-018`): changing what reaches a provider is a
  Stage 6 concern and could alter cost in an unmeasured direction.
- **Splitting `getPrecisionUsage`** (`PC-PRA-021`): correct, but reconciliation
  currently rides on every usage read; making it explicit means scheduling it or
  legacy jobs stop settling. Disproportionate to this PR.
- **Making the probe opt-in** (`PC-PRA-017`): needs the billing answer first.

## `EXTERNALLY_BLOCKED`

Whether `BATCH_DATA_SANDBOX_KEY` consumes billable credits. Requires BatchData's
written statement. **No claim about cost is made in this PR**, and no provider
call was made to find out.
