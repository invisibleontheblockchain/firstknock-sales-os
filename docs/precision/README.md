# FirstKnock Precision — Canonical Documentation

Precision generation turns a freehand polygon plus a set of user criteria into an
optimized knocking route built from real BatchData property records.

**If you are an AI agent (Claude Code or Codex) about to touch anything in the
Precision path, read [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) first.** It is short and
mandatory.

---

## Which document do I need?

| I need to… | Read |
|---|---|
| Understand the product promise, the seven planes, and Stages 0–14 | [`PRECISION_CONTROL_MAP.md`](./PRECISION_CONTROL_MAP.md) |
| Run or design a real end-to-end test, or diagnose a live failure | [`PRECISION_TEST_LAB.md`](./PRECISION_TEST_LAB.md) |
| Know what is proven today and what is still broken | [`PR66_STAGE_STATUS.md`](./PR66_STAGE_STATUS.md) |
| Start a Precision task correctly and report it correctly | [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) |
| Know exactly what we send to and accept from BatchData, and why | [`../BATCHDATA_PRECISION_CONTRACT.md`](../BATCHDATA_PRECISION_CONTRACT.md) |

---

## The governing promise

> The exact route the user requests must remain the exact request sent to
> BatchData, the exact criteria used to accept properties, the exact FetchJob
> used to retrieve candidates, and the exact provenance stored with the
> finished route.

```
The user orders a pepperoni pizza
→ we record the exact order
→ we send that exact order to the supplier
→ we inspect the actual ingredients returned
→ we use only ingredients proven to match the order
→ we assemble from that exact ticket
→ we deliver a pepperoni pizza matching the original order
```

---

## Two truths, always kept separate

Every document here distinguishes:

- **Current implementation** — what the code actually does right now.
- **Target invariant** — what the hardened pipeline must eventually guarantee.

A target requirement is never written as though it is already implemented. A
passing unit test is never presented as proof of a live provider contract when
the raw response evidence is missing.

---

## Status at a glance

As of PR #66 head `1708f72d`:

| Rating | Stages |
|---|---|
| **GREEN** — proven | 5, 11 |
| **YELLOW** — partially proven | 1, 6, 8, 9, 12 |
| **RED** — demonstrated defect | 0, 2, 4, 10, 13 |
| **GRAY** — unverified | 3, 14 |
| **BLOCKED** — needs external evidence | 7 |

No stage is rated GREEN on a passing unit test alone. Provider-dependent stages
cannot be GREEN without real provider evidence, which does not yet exist for the
response side.

See [`PR66_STAGE_STATUS.md`](./PR66_STAGE_STATUS.md) for the full table with
evidence, tests, gaps, and the next required test per stage.
