# FirstKnock — agent instructions (Codex & Claude Code)

## Precision generation: read the brief first

If your task touches **anything** in the Precision path — the polygon, the
Precision order panel, `startBatchDataPull`, `fetchAreaProperties`,
`processFetchChunk`, `getRouteCandidatesFromNeon`, `generateRoutesBackend`,
FetchJobs, BatchData, route candidates, or SavedRoutes — you **must** read
[`docs/precision/AGENT_BRIEF.md`](docs/precision/AGENT_BRIEF.md) before writing
code. It is short and mandatory.

It requires you to open with a stage-based task header and close with a
stage-based final report.

Canonical documentation:

| Document | Use |
|---|---|
| [`docs/precision/README.md`](docs/precision/README.md) | Index — which document to use |
| [`docs/precision/AGENT_BRIEF.md`](docs/precision/AGENT_BRIEF.md) | **Mandatory task protocol** |
| [`docs/precision/PRECISION_CONTROL_MAP.md`](docs/precision/PRECISION_CONTROL_MAP.md) | Stages 0–14, planes, target invariants |
| [`docs/precision/PRECISION_TEST_LAB.md`](docs/precision/PRECISION_TEST_LAB.md) | C0–C11 ledger, test design, diagnosis rules |
| [`docs/precision/PR66_STAGE_STATUS.md`](docs/precision/PR66_STAGE_STATUS.md) | What is proven today, per stage |
| [`docs/BATCHDATA_PRECISION_CONTRACT.md`](docs/BATCHDATA_PRECISION_CONTRACT.md) | The provider contract and its evidence |

### The rules that matter most

1. **The exact user order must remain the exact provider request, the exact
   delivered property set, the exact candidate set, and the exact SavedRoute
   provenance.**
2. **No guessing.** A provider-dependent change needs real provider evidence,
   official BatchData documentation, or an explicitly labeled evidence gap.
   Synthetic fixtures test failure safety; they never define the contract.
3. **`options.datasets` is never sent to BatchData.** Real A/B evidence
   (`OBS-02`) proves scoping suppresses the `intel`/`sale` objects the pipeline
   depends on.
4. **Never make a live or paid BatchData call** without separate explicit
   authorization. `previewBatchDataArea` and `validateBatchDataShape` both hit
   the real provider.
5. **Stay in your stage.** Cross-stage changes require an explicit explanation of
   the affected handoffs.

---

## Testing

Test the **behavior**, not the source text. Several older tests assert regex
matches against source files and cannot catch logic errors. Load the real
production function — the existing suites use `vm.runInNewContext` — and assert
on its output.

Functions loaded into a `vm` realm return objects with a different `Object`
prototype, so `assert.deepStrictEqual` fails on otherwise-identical values.
Normalize with `JSON.parse(JSON.stringify(value))` before deep-comparing.

```bash
npm test && npm run test:batchdata-contract && npm run typecheck && npm run lint && npm run build && npm run validate:backend && npm run validate:artifact
```

CI runs the same set on every PR via `.github/workflows/pull-request.yml`. It
never deploys and never calls a paid provider.

---

## Environment

- Windows. The Bash tool is Git Bash (POSIX sh); PowerShell is also available.
  They take different syntax.
- Node ≥ 20. Backend functions are Deno entry files under `base44/functions/`.
- Commit or push only when asked.
