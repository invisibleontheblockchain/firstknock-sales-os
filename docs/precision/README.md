# Precision pipeline documentation

The Precision pipeline is split across two pull requests with a single handoff
boundary: the canonical FetchJob.

| | Owns | Stages | Checkpoints |
|---|---|---|---|
| **PR A** | exact user order → canonical FetchJob | 0–4 | C0 → C1 |
| **PR #66** | canonical FetchJob → routeable candidates | 5–11 | C1 → C8 |

```
C0 exact user intent
  → Stage 0  identity, workspace, entitlement, allowance
  → Stage 1  freehand polygon capture and normalization
  → Stage 2  order and criteria capture
  → Stage 3  preview and provider-interaction visibility
  → Stage 4  locked start, reservation, canonical FetchJob
C1 server-authoritative effective target
  → Stage 5  canonical FetchJob consumption          ┐
  → Stage 6  exact BatchData request                 │
  → Stage 7  provider-response evidence boundary     │ PR #66
  → Stage 8  parsing and classification              │
  → Stage 9  persistence and delivered usage         │
  → Stage 10 completion handoff containment          │
  → Stage 11 exact FetchJob candidate retrieval      ┘
```

## Where to read

| Path | Contents |
|---|---|
| [pr-a/](pr-a/) | **PR A implementation** — Model 2's adjudication, final contract, change ledger, PR #66 handoff |
| `pr-a-model-1/` *(on `audit/precision-order-control-model-1`)* | Model 1's read-only audit: 65 findings, 28 claims, evidence and characterization tests |

Model 1's audit branch is frozen at
`0c3fd666bfa0ba5b506503578d727d201c62fbdc` and is an **input** to PR A, not the
implementation record. PR A's decisions are in
[pr-a/MODEL_1_FINDING_ADJUDICATION.md](pr-a/MODEL_1_FINDING_ADJUDICATION.md).
