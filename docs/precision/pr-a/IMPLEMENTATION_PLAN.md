# Implementation Plan — PR A

Written before any production change, per the final-contract gate. Recorded here
as executed.

## Order of work

| # | Step | Gate |
|---|---|---|
| 1 | Verify coordinates; confirm `origin/main` unchanged | done before anything else |
| 2 | Reconstruct Stages 0–4 from source, independently | before reading Model 1's conclusions |
| 3 | Mutation-challenge Model 1's suite | 30/30 caught before trusting it |
| 4 | Adjudicate every material finding | no change without an adjudication |
| 5 | Write failing tests | 26 of 32 failed on unmodified `main` |
| 6 | Implement, smallest first | shared module, then both paths |
| 7 | Update characterization tests that pinned changed behaviour | each marked with its adjudication |
| 8 | Regenerate fixtures from PR A code | replay-verified |
| 9 | Prove the PR #66 handoff via its real caller chain | `PR66-H-02` pins the chain |
| 10 | Full regression + prospective merge | inherited vs new failures separated |

## Sequencing rationale

The shared module came first because `ADJ-M2-001` and `ADJ-M2-005` both hinge on
one predicate — *does this job belong to this subject* — and implementing it
twice would have re-created the drift Model 1 documented.

`ADJ-M2-005` was implemented before `ADJ-M2-007` because the criteria comparison
determines what the snapshot must contain, not the other way round.

## Risks identified up front, and how each was handled

| Risk | Handling |
|---|---|
| Legacy in-flight jobs all conflict at deploy | `LEGACY_COMPARABLE_CRITERIA_FIELDS` — caught by testing against a legacy fixture |
| Publishing an unsatisfiable schema-v1 snapshot | `precisionCriteriaSatisfiesSchemaV1` gate — caught by probing PR #66's real validator |
| Removing the stale-job escape hatch strands users | scoped to conflicting jobs only |
| Validation too aggressive on odd polygons | explicit guard: seven odd-but-legal shapes still round-trip |
| Inventing the Fixed Count contract | not implemented; documented as unresolved |
