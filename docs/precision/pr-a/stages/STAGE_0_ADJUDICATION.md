# Stage 0 Adjudication — identity, workspace, entitlement, allowance

**Adjudications** `ADJ-M2-001` (implemented), `ADJ-M2-007` (workspace).
**Model 1 findings** `F-PRA-001`–`F-PRA-007`, `F-PRA-052`–`F-PRA-054`.

| Aspect | Current behaviour | Model 1 | Model 2 reproduction | Final target | Change |
|---|---|---|---|---|---|
| Actor | `base44.auth.me()`, once; body ignored | KEEP | confirmed — body identity fields never persisted | unchanged | none |
| Usage subject | `user.id`, but allowance unions email rows | PROVEN_DEFECT | **confirmed from source** `:416-429` | immutable subject authoritative; email a fallback only | **CH-01** |
| Workspace | none anywhere | PROVEN_DEFECT | confirmed | `team_manager_id \|\| id`, scope only | **CH-06** |
| Entitlement | Stripe + id-keyed grants + **one email-keyed grant** | PROVEN_DEFECT | confirmed `:137` | id-keyed only | **not changed** — see below |
| Allowance | computed twice; correct inside the lock | OPTIMIZATION | confirmed, 2 resolutions | one shared module | **not changed** |
| Fail-closed gates | correct, re-checked under the lock | KEEP | confirmed | unchanged | none |

## Hard-coded email grant — `PRODUCT_DECISION_REQUIRED`

`startBatchDataPull:137` grants paid + Pro + a 1000-property limit to a literal
email string, short-circuiting Stripe entirely. Model 2 verified this directly.

The work order says not to preserve a hard-coded production bypass merely because
it exists, and Model 2 does not defend it. But removing it here would **revoke a
live entitlement** from a real account: the safe replacement
(`BETA_ACCESS_GRANTS`, already validated correctly and keyed on the immutable id)
needs that account's immutable id, which is not available to this work.

**Remediation, in order:** obtain the immutable id → add the grant to
`BETA_ACCESS_GRANTS` → delete the email branch → assert that the email alone
confers nothing.

## Duplicate entitlement/allowance resolution — not changed

Model 1's `PC-PRA-001` proposed one shared Stage 0 module. Model 2 **agrees with
the observation** — 2 Stripe resolutions and 4 FetchJob scans per start,
independently measured — but **rejects the change for this PR**: it is a refactor
with no adjudicated defect behind it, it carries the highest regression risk in
Model 1's register, and it collides with PR #66, which touches the same functions.

## Remaining uncertainty

- Production rows lacking `precision_usage_user_id` — `EXTERNALLY_BLOCKED`.
- `kind: 'unmetered'` has no producer — `EVIDENCE_GAP`, upheld.
- Whether a rep's usage should bill to their manager — `PRODUCT_DECISION_REQUIRED`.
  PR A records the workspace but does **not** move attribution.
