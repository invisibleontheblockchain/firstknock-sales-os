# Stage 1 Adjudication — canonical polygon

**Adjudication** `ADJ-M2-002`. **Model 1 findings** `F-PRA-008`–`F-PRA-014`,
`F-PRA-055`, `F-PRA-056`.

| Aspect | Current | Model 1 | Model 2 reproduction | Final target | Change |
|---|---|---|---|---|---|
| Vertex conservation | verbatim | KEEP | confirmed | unchanged | none |
| Coordinate ranges | **unvalidated** | PROVEN_DEFECT | confirmed — `normalizeRoutePoint` validates 20 lines away | `-90..90` / `-180..180` | **CH-02** |
| Malformed vertex | silently dropped | PROVEN_DEFECT | confirmed | reported with its index | **CH-02** |
| lat/lng swap | undetected | PARITY_RISK | confirmed | rejected by the range check | **CH-02** |
| Hash | 6-dp, order- and closure-sensitive; all three functions agree | KEEP | confirmed | unchanged | none |
| Centroid | vertex mean | PROVEN_DEFECT (low) | confirmed | unchanged | **rejected for this PR** |
| Area / radius | shoelace; radius from the unrounded area | ACCEPTABLE | confirmed | unchanged | none |
| County resolver | third party, no timeout | OPTIMIZATION | confirmed | unchanged | not changed |

## Why the centroid change was rejected

Model 1's `PC-PRA-007` proposed an area centroid. It would change
`latitude`/`longitude` on new jobs and could change the resolved county for
edge-of-county areas — user-visible, with no demonstrated customer harm behind
it. `DOCUMENT` instead.

## Why hash semantics were left alone

`polygon_hash` identifies a *submission*, not an *area* (`F-PRA-010`). Changing
that breaks every resume, retry and exact-candidate lookup, and the intended
product meaning is unknown. `PRODUCT_DECISION_REQUIRED`.

## Guard against over-correction

`ADJ-M2-002` pins seven odd-but-legal shapes — closed rings, duplicate interior
points, reversed winding, string coordinates, self-intersection, and both
coordinate boundaries — as still accepted with every vertex preserved.
