# Precision Agent Brief — mandatory for Claude Code and Codex

Read this before touching any file in the Precision path. It is short on purpose.

---

## 1. Governing promise

```
The exact user order must remain the exact provider request,
the exact delivered property set, the exact candidate set,
and the exact SavedRoute provenance.
```

No stage may silently change the order, apply an undisclosed default, substitute
an older job, mix in properties from another request, count properties that
cannot be routed, drop properties without a named reason, guess what a BatchData
field means, or treat browser state as server authority.

---

## 2. Mandatory task header

Declare this **before writing code**. If you cannot fill a line, say `unknown`
and go find out — do not guess.

```
Precision stage:
Operating plane:
Problem being investigated:
Input:
Expected output:
Authority:
Criteria affected:
C-checkpoints affected:
Real evidence available:
Files expected to change:
Stages that must remain unchanged:
Validation required:
```

Stage numbers and plane letters come from
[`PRECISION_CONTROL_MAP.md`](./PRECISION_CONTROL_MAP.md).
C-checkpoints come from the ledger in
[`PRECISION_TEST_LAB.md`](./PRECISION_TEST_LAB.md).

---

## 3. Mandatory final report

```
Stage changed:
Invariant before:
Invariant after:
First failing C-transition:
Criteria changes:
Property-count changes:
Evidence used:
Tests added:
Adjacent stages retested:
Full pipeline tests:
Unresolved gaps:
```

---

## 4. The no-guessing rule

A provider-dependent change requires one of:

1. Real provider evidence — a captured request, a captured response, or a cited
   observed-response assertion in
   `test/fixtures/batchdata/responses/observed-response-assertions.json`.
2. Official BatchData documentation describing that exact endpoint and field.
3. An **explicitly labeled evidence gap** recorded in the manifest and the
   contract doc.

Synthetic fixtures may test failure safety. **They may not define the provider
contract.** A fixture whose `source_type` is `synthetic_failure_safety` or
`reconstructed_response` is never contract evidence.

Never:
- default a missing property type to Single Family;
- replace a missing sale date with an unrelated listing field;
- treat sale amount as estimated value without an explicit product rule;
- add an alias because it sounds plausible;
- accept an unknown response envelope silently.

---

## 5. Scope rule

An agent assigned to one stage must not casually rewrite another. In particular,
a Stage 8 (parsing) task must not rewrite Stage 0 allowance, Stage 4 reservation
behavior, Stage 12 optimization, or Stage 13 SavedRoute persistence.

If a change genuinely spans stages, state the affected handoffs explicitly in the
task header and explain why the cross-stage change is required.

---

## 6. Evidence-first workflow

1. Reproduce or locate the real failure. Do not ship a fix for a bug you have not
   observed.
2. Find the **first failing C-transition**. Fix there, not downstream.
3. Write a failing behavioral test first. Use a real fixture if the change is
   provider-dependent.
4. State the invariant the test protects.
5. Make the minimum safe code change.
6. Re-run the whole chain, not just your unit test.

---

## 7. Test the behavior, not the source text

Several older tests in this repo assert against regex matches on source files.
Those cannot catch logic errors. Load the real production function — the existing
suites do this with `vm.runInNewContext` — and assert on its actual output.

Note: functions loaded into a `vm` realm return objects with a different `Object`
prototype, so `assert.deepStrictEqual` fails on otherwise-identical values.
Normalize with `JSON.parse(JSON.stringify(value))` before deep-comparing.

---

## 8. Required validation

```bash
npm test && npm run test:batchdata-contract && npm run typecheck && npm run lint && npm run build && npm run validate:backend && npm run validate:artifact
```

CI runs the same set on every pull request via `.github/workflows/pull-request.yml`.
It never deploys and never calls a paid provider.

---

## 9. Hard prohibitions

- **Never make a live or paid BatchData call** during development or testing
  without separate, explicit authorization. `previewBatchDataArea` and
  `validateBatchDataShape` both hit the real provider.
- Never fabricate a provider response and label it a capture.
- Never present a target invariant as though it is implemented.
- Never mark a provider-dependent stage GREEN without real provider evidence.
