# Model 1 Finding Adjudication — PR A, Model 2

Model 1's audit is an **input**, not established truth. Every material finding
below was independently reproduced from `origin/main@03adf5cd` before any verdict
was recorded.

**Verdict summary across the 65 Model 1 findings**

| Verdict | Count |
|---|---|
| `VERIFIED` | 24 |
| `PARTIALLY_VERIFIED` (observation accepted, remedy revised) | 3 |
| `VERIFIED` with severity **revised** | 4 |
| `PRODUCT_DECISION_REQUIRED` | 5 |
| `EXTERNALLY_BLOCKED` | 1 |
| `EVIDENCE_GAP` upheld as unproven | 4 |
| `ACCEPTABLE_CURRENT_BEHAVIOR` — preserved deliberately | 11 |
| Documentation-only / not material to Stages 0–4 | 13 |
| **`UNSUPPORTED` or `CONTRADICTED`** | **0** |
| `STALE` | 0 — `origin/main` is unchanged since Model 1's base |

Model 1's suite was also **mutation-challenged**: 30 mutations of production
code, 30 caught, **0 survived**. No test gap was found.

---

## ADJ-M2-001 — Cross-subject allowance attribution

**Model 1 finding** `F-PRA-003` · **Claim** `CLAIM-PRA-0002` · **Stage** 0 · **Checkpoint** C0

**Model 1 conclusion.** `getPrecisionJobs` unions a query on
`precision_usage_user_id` with one on `user_email` and merges by job id, so a job
owned by a *different* immutable subject sharing an email is charged here.

**Independent reproduction.** Read `startBatchDataPull/entry.ts:416-429` and
`fetchAreaProperties/entry.ts:347-360` directly — the union and the id-keyed
merge are both plainly present with no ownership filter between them. Confirmed
behaviourally: a settled foreign-subject job of 45 left only 5 of 50 reservable.

**Model 2 verdict** `VERIFIED`.
**Final classification** `PROVEN_DEFECT` — **severity upgraded to P0.** Model 1
rated it "high"; it is a cross-tenant billing *and* availability defect, because
the same email-keyed pattern also governs the active-job lookup (`ADJ-M2-005`).
A second account could both consume this user's allowance and block their pulls.

**Final decision** `CHANGE_BEHAVIOR`.
**Implementation.** `precisionJobBelongsToSubject`: the immutable subject is
authoritative; email is a fallback **only** for rows that have no subject.
**Tests** `ADJ-M2-001` ×3.
**PR #66 impact.** Aligns with PR #66's `fetchJobBelongsToUser`, which already
applies the narrower rule downstream — before this, `main` and PR #66 disagreed
about who owns a job.
**Existing-job impact.** A user who previously lost allowance to a same-email row
regains it. The direction is toward *more* allowance, so it is not a billing
risk, but the affected population is unmeasured.
**Remaining uncertainty.** How many production rows lack
`precision_usage_user_id` — `EXTERNALLY_BLOCKED`; query recorded in
[EXISTING_JOB_COMPATIBILITY.md](EXISTING_JOB_COMPATIBILITY.md).

---

## ADJ-M2-002 — Polygon coordinate validation

**Model 1 findings** `F-PRA-008`, `F-PRA-009`, `F-PRA-012` · **Claim** `CLAIM-PRA-0007` · **Stage** 1

**Independent reproduction.** Confirmed. `normalizePolygon` filters on
`Number.isFinite` only, while `normalizeRoutePoint` — twenty lines away in the
same file — *does* enforce `-90..90` / `-180..180`. The inconsistency is within
one module, which argues against deliberate design.

**Model 2 verdict** `VERIFIED`. **Classification** `PROVEN_DEFECT`, severity as
Model 1 rated it (medium — no evidence any real client emits such input).
**Final decision** `CHANGE_BEHAVIOR`, scoped narrowly.

**Model 2 rejected part of Model 1's proposal.** `PC-PRA-007` also proposed
replacing the vertex-mean centroid with an area centroid (`F-PRA-011`).
**Rejected for this PR:** it changes `latitude`/`longitude` on new jobs and can
change the resolved county for edge-of-county areas — a user-visible change with
no demonstrated customer harm behind it. Recorded as `DOCUMENT`.

**Implementation.** `normalizePrecisionPolygon` validates ranges and reports a
bad vertex with its index. Conservation, hashing, winding, duplicate and
self-intersection handling are **unchanged**; `ADJ-M2-002` includes an explicit
guard that seven odd-but-legal shapes still round-trip byte-identically.
**PR #66 impact.** None — `polygon_hash` semantics untouched.

---

## ADJ-M2-003 — Invalid and fractional counts

**Model 1 findings** `F-PRA-016`, `F-PRA-017` · **Claim** `CLAIM-PRA-0010` · **Stage** 2

**Independent reproduction.** Confirmed at `startBatchDataPull/entry.ts:532-533`:
`Number(body.requested_properties || maxProperties)` makes `0` falsy, and
`Math.max(1, …)` applies no integer coercion.

**Model 2 verdict** `VERIFIED`. **Classification** `PROVEN_DEFECT`.
**Final decision** `CHANGE_BEHAVIOR`, with one **revision to Model 1's proposal**:
`PC-PRA-010` would reject `''` alongside `0`. Model 2 keeps `''` meaning
"absent", because that is standard form semantics, it is what the code already
did, and rejecting it is a gratuitous behaviour change. Pinned by
`AR-S2-03 [blank-string-falls-back-to-max]`.

**PR #66 impact.** Removes the `Number.isInteger` rejection Model 1 proved at the
candidate boundary (`AR-C66-12`): a fractional job could be created but never
routed.

---

## ADJ-M2-004 — Max Available computed outside the lock

**Model 1 finding** `F-PRA-018` · **Claim** `CLAIM-PRA-0011` · **Stage** 2 · **Checkpoint** C1

**Independent reproduction.** Confirmed by grep: `count_mode` appears exactly once
in `startBatchDataPull`, at the persistence site. `reservedProperties` is
`min(requestedValue, lockedAllowance.remaining)` with no branch on mode.

**Model 2 verdict** `VERIFIED`. **Classification** `PROVEN_DEFECT`.
**Final decision** `CHANGE_BEHAVIOR`.

**Product-decision boundary.** Model 2 did not guess what Max Available means.
It is resolved from the allowance observed **inside the lock** because that is
the only reading under which the label is true, and because the browser value is
unauthenticated client state that Stage 0's own contract says may be *displayed*
but may not establish authority. The **Fixed Count** contract is a genuine
product decision and is left unresolved — see `ADJ-M2-009`.

**Customer impact.** Users receive *more* homes in the grow case, and therefore
spend more allowance. Bounded by the locked allowance, so the cap is never
exceeded. Requires release-note disclosure.

---

## ADJ-M2-005 — Criteria-blind active-job resume

**Model 1 findings** `F-PRA-036`, `F-PRA-037`, `F-PRA-038`, `F-PRA-041` ·
**Claims** `CLAIM-PRA-0019`, `CLAIM-PRA-0020` · **Stage** 4 · **Checkpoint** C1

**Independent reproduction.** Confirmed in full. Model 2 agrees this is the most
severe finding in the audit.

**Model 2 verdict** `VERIFIED`. **Classification** `PROVEN_DEFECT` (P0).
**Final decision** `CHANGE_BEHAVIOR`.

**Model 2 finding Model 1 did not identify.** Comparing a *legacy* job against
the full material criteria set would make **every in-flight job at deploy time**
look like a conflict, because such jobs predate `workspace_id` and `repull_mode`.
That is exactly the "silently reinterpreting old jobs under new semantics"
failure the work order prohibits — and it would have shipped had the change not
been tested against a realistic legacy fixture. Resolved with
`LEGACY_COMPARABLE_CRITERIA_FIELDS`: a job with no snapshot is compared only on
the fields it can actually prove.

**Implementation.** Four explicit outcomes; only `one_exact_match` resumes.
**Tests** `ADJ-M2-005` ×6, `ADJ-M2-005b`.
**PR #66 impact.** PR #66 implements this for `fetchAreaProperties` only.
`startBatchDataPull` — the path the production UI uses for new pulls — is
untouched by PR #66, so without PR A this defect stays live even after PR #66
merges.

---

## ADJ-M2-006 — Automatic job destruction

**Model 1 findings** `F-PRA-039`, `F-PRA-040` · **Claim** `CLAIM-PRA-0021` · **Stage** 4

**Model 2 verdict** `PARTIALLY_VERIFIED` — the observation is right, the proposed
remedy is **rejected in part**.

`PC-PRA-024` proposed removing **both** cancellation paths. Model 2 removes only
the client-flag path, because:

- an unverified client flag destroying server-owned work is indefensible on any
  reading, whereas
- the age-based path is the *only* in-app escape hatch from a genuinely stuck
  import. Removing it without the remedy UI leaves users blocked for up to 30
  minutes (`watchdogStaleJobs`' threshold) — trading one user-visible failure for
  another with no evidence about which is worse.

**Model 2 narrowed it instead**: age-based cancellation now applies only to a
**conflicting** job. An identical job is resumed rather than destroyed, which is
where the real data loss was.

**Deliberately not fixed.** Reservation release on cancellation (`F-PRA-040`) —
settlement is the processor's responsibility, and introducing a second writable
truth to close a 10-minute accounting window is not justified by the evidence.
`DOCUMENT`.

---

## ADJ-M2-007 — Missing workspace, versions and criteria snapshot

**Model 1 findings** `F-PRA-004`, `F-PRA-026`, `F-PRA-046`, `F-PRA-047`, `F-PRA-049` ·
**Claims** `CLAIM-PRA-0004`, `CLAIM-PRA-0023`, `CLAIM-PRA-0024` · **Stage** 4 · **Checkpoint** C1

**Model 2 verdict** `VERIFIED`. **Final decision** `CHANGE_BEHAVIOR`.

**Product-decision boundary.** Adopting `team_manager_id || id` is **not**
deciding whether manager usage is individual or workspace-based. Usage
attribution is untouched — it still follows `precision_usage_user_id`, and
`ADJ-M2-007` asserts exactly that for a rep under a manager. What is recorded is
an *authorization scope*, matching PR #66's `precisionWorkspaceIdentity` so the
two agree. Whether that key is the right product boundary remains
`PRODUCT_DECISION_REQUIRED`.

**NEW MODEL 2 FINDING — `M2-NEW-01`.** PR #66's schema-v1 validator requires
`min_price > 0`; its legacy validator deliberately accepts `null` as "no floor".
Publishing a criteria snapshot on a blank-minimum order would tag it `schema_v1`
and flip it from **accepted to rejected** downstream. Model 1 could not have
surfaced this, because pre-PR-A jobs never reached the schema-v1 path at all.
**This was a regression PR A was about to ship.** Resolved by publishing the
snapshot only when it satisfies the v1 rules, recording
`precision_criteria_withheld: ['min_price']` otherwise.
**Tests** `PR66-H-06`, `ADJ-M2-007`.

---

## ADJ-M2-008 — Preview containment and misleading availability

**Model 1 findings** `F-PRA-028` … `F-PRA-034` · **Claims** `CLAIM-PRA-0016`, `CLAIM-PRA-0018` · **Stage** 3

**Independent reproduction.** Confirmed without any provider call: the probe body
is `{searchCriteria:{query:"<lat>,<lng>"},options:{datasets:['basic'],limit:5}}`,
the polygon is never sent, and a zero-record probe still yields "eligible to pull
up to 40".

**Model 2 verdict** `VERIFIED` for observable behaviour; `EXTERNALLY_BLOCKED` for
cost. **Decision** `CHANGE_BEHAVIOR`, narrowly scoped.

**Model 2 rejected or deferred three Preview proposals:**

| Model 1 proposal | Model 2 | Reason |
|---|---|---|
| `PC-PRA-018` send the polygon, or drop the probe | **rejected** | changing what is sent to a provider is a Stage 6 concern and could alter cost in an unmeasured direction |
| `PC-PRA-021` split `getPrecisionUsage` read/reconcile | **deferred** | correct, but reconciliation happens opportunistically on every usage read; making it explicit means scheduling it or legacy jobs stop settling |
| `PC-PRA-017` make `sandbox_probe` opt-in | **deferred** | needs the billing answer first — instrument, then decide |

**Implemented**: an 8s timeout and failure containment (`F-PRA-031`), plus
`availability_measured: false` and `sandbox_probe_meaning` so a consumer cannot
read the allowance echo as a market count (`F-PRA-033`).

---

## ADJ-M2-009 — Fixed Count semantics — **UNRESOLVED**

**Model 1 finding** `F-PRA-015` · **Claim** `CLAIM-PRA-0009` · **Stage** 2 · **Checkpoint** C0

**Model 2 verdict** `PRODUCT_DECISION_REQUIRED`. **No change made.**

Model 1 rates this claim *medium* confidence because it rests on **extracted
browser expressions, not a rendered component** — this repository has no DOM test
tooling. Model 2 confirms that limitation and did not resolve it: choosing
Contract A or B would be inventing a product rule to make implementation easier,
which the work order prohibits.

**What PR A does instead.** Nothing in Stage 2's count path assumes either
contract. `entered_count` carries whatever the client sent for `fixed`, and
equals the locked allowance for `max_available`, where the two contracts do not
differ.

**Blocking question.** Does "Fixed Count" mean *exactly the number I typed*, or
*at most my displayed allowance*? PR #66's retry mapper is built on Contract A.

---

## Preserved deliberately (`KEEP`)

Model 2 independently confirmed each and **rejects any change** in this PR:

| Finding | Behaviour | Why preserved |
|---|---|---|
| `F-PRA-044` | reservation + FetchJob in one write | makes double reservation structurally impossible |
| `F-PRA-045` | one advisory lock key shared by both endpoints | verified against a real serializing lock; no over-reservation in any concurrency scenario |
| `F-PRA-062` | entitlement/allowance re-derived inside the lock | correct critical-section boundary |
| `F-PRA-053` | gates fail closed, re-checked under the lock | billing safety |
| `F-PRA-054` | actor→subject binding is untrusted-input-proof | security |
| `F-PRA-055`/`056` | vertex conservation and hash agreement | changing the hash would break every resume and retry |
| `F-PRA-058` | server-forced route filters | security |
| `F-PRA-059` | route bounds carry coordinates only | privacy |
| `F-PRA-057` | quick-range Pro gating | correct on both paths |
| `F-PRA-061` | Preview fails closed on unavailable allowance | billing safety |
| `F-PRA-035` | unlimited draw area | deliberate documented product change |

## Upheld as unresolved

| Finding | Model 2 verdict |
|---|---|
| `F-PRA-002` hard-coded email grant | `VERIFIED`, `PRODUCT_DECISION_REQUIRED` |
| `F-PRA-020` `min_price` default divergence | `VERIFIED`, `PRODUCT_DECISION_REQUIRED`, owned by PR #66 |
| `F-PRA-010` `polygon_hash` submission-vs-area identity | `VERIFIED`, `PRODUCT_DECISION_REQUIRED` |
| `F-PRA-032` what Preview promises | `PRODUCT_DECISION_REQUIRED` |
| `F-PRA-060` sandbox-key billing | `EXTERNALLY_BLOCKED` |
| `F-PRA-064` Base44 unsorted-filter ordering | `EVIDENCE_GAP` — now moot, PR A sorts explicitly |
| `F-PRA-063` lock and entity write not one transaction | `EVIDENCE_GAP` upheld; fails safe |
| `F-PRA-052` no producer for `kind: 'unmetered'` | `EVIDENCE_GAP` upheld |
