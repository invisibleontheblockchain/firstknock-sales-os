# Evidence Index — PR A

## Model 1 provenance (preserved, not restated as Model 2's own)

| | |
|---|---|
| Branch | `audit/precision-order-control-model-1` |
| Starting SHA | `03adf5cd59aba8c4b7f095d4a799085ecb9f7186` |
| Candidate SHA | `0c3fd666bfa0ba5b506503578d727d201c62fbdc` — **verified** |
| Manifest | `docs/precision/pr-a-model-1/MODEL_2_AUDIT_MANIFEST.json` at that SHA |
| Findings / claims | `F-PRA-001`…`F-PRA-065` / `CLAIM-PRA-0001`…`0028` — IDs referenced throughout |

Model 1's documents are **not** copied into PR A. They remain readable at their
frozen SHA via `git show audit/precision-order-control-model-1:<path>`, which
avoids duplicating a large evidence set and guarantees the copy cannot drift from
the original. Their IDs are cited in every adjudication and commit message.

## Artefacts imported into PR A, with provenance

| Artefact | Origin | Verified how |
|---|---|---|
| `test/helpers/precisionOrderHarness.mjs` | Model 1 | audited for mocked-away behaviour; 30/30 mutation catch rate |
| `test/helpers/precisionBrowserExpressions.mjs` | Model 1 | limits confirmed and restated (`ADJ-M2-009`) |
| `test/helpers/pr66Validators.mjs` | Model 1 | checksum-verified against PR #66 head on every run |
| `test/fixtures/precision/pr66-reference/` | PR #66 @ `35396b50`, byte-exact | sha256, LF-normalized, re-checked by `PR66-H-01` |
| `test/precision-order-stage*.test.mjs` | Model 1 | re-run, mutation-challenged, then updated where PR A changed behaviour |
| `scripts/precision-order-audit/generate-fixtures.mjs` | Model 1 | re-run to regenerate every fixture from PR A code |

## Model 2 evidence

| ID | Artefact | Proves |
|---|---|---|
| `M2-E01` | `test/precision-order-hardening.test.mjs` (33) | the hardened contract; failed 26/32 on unmodified `main` |
| `M2-E02` | `test/precision-order-pr66-handoff.test.mjs` (10) | PR #66 accepts every PR A FetchJob via its real caller chain |
| `M2-E03` | `test/fixtures/precision/order-to-fetchjob/` (46) | regenerated from PR A code, replay-verified |
| `M2-E04` | mutation record (30) | Model 1's suite has no test gap |
| `M2-E05` | performance measurement (25 samples × 2 paths × 2 sides) | +2 reads, ~2 ms, writes unchanged |

## Explicitly absent

| Missing | Classification |
|---|---|
| Real BatchData request/response | `EXTERNALLY_BLOCKED` — no provider call was made |
| Sandbox-key billing terms | `EXTERNALLY_BLOCKED` |
| Production row counts | `EXTERNALLY_BLOCKED` — query recorded, not executed |
| Rendered-component behaviour | `EVIDENCE_GAP` — no DOM tooling in this repository |
| Full PR #66 HTTP handler execution | `EVIDENCE_GAP` — needs a database |
| Real lock contention under load | `EVIDENCE_GAP` |
