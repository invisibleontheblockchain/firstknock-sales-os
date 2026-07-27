# Precision order-control safety contract (Stages 0–4)

What the Precision start paths guarantee about **who** is ordering, **what** they
ordered, and **whether an existing job already covers it**.

Scope is deliberately narrow. This is not a full order→FetchJob contract; the
canonical criteria snapshot is deferred — see
[PR_A_DEFERRED_DECISIONS.md](PR_A_DEFERRED_DECISIONS.md).

Shared rules live in `base44/functions/_shared/precisionOrderSafety.js` and are
used identically by `startBatchDataPull` and `fetchAreaProperties`.

---

## 1. Usage ownership

| Rule | |
|---|---|
| A job with `precision_usage_user_id` | that immutable id decides ownership, full stop |
| A job without it (legacy row) | `user_email` may be used as a compatibility fallback |
| A matching email against a **different** immutable id | never overrides it |

Applied identically to **allowance calculation**, **active-job discovery** and
**reservation attribution**.

A job owned by a foreign immutable subject therefore cannot consume this user's
allowance, block their pull, or be offered for resume — even when it shares their
email address.

## 2. Precision-job identity

One predicate decides whether a FetchJob belongs to the Precision pipeline, and
it is used for both usage accounting and active-job discovery:

```
mode_tag present      → mode_tag === 'PRECISION_TARGET'
mode_tag absent       → provider is absent or 'batchdata'   (legacy rows)
```

Active statuses are `running` and `pending`. An unrelated ZIP or MLS import can
no longer enter Precision active-job resolution.

## 3. Polygon input

**Validated:** every vertex must be numeric and within `-90..90` /
`-180..180`; at least three usable points are required. An unusable vertex
rejects the **whole polygon** with `invalid_polygon_point` rather than being
dropped — dropping one silently produced a different ring with a different
identity.

**Unchanged, deliberately:** vertex order, winding, duplicate points, ring
closure, self-intersection tolerance, centroid, area and hash. Every polygon
accepted before is still accepted, byte-identically.

## 4. Property count

| Submitted | Result |
|---|---|
| absent — `undefined`, `null`, `''` | the plan maximum (established behaviour, unchanged) |
| a positive integer | honoured, then capped by the locked allowance as before |
| `0`, negative, fractional, non-numeric, boolean, object | `400 invalid_requested_properties` |

Invalid values are never reinterpreted as "max available", and a reservation is
always a whole number.

The **meaning** of a typed Fixed Count is unresolved and untouched — see
deferred decision §1.

## 5. Effective target

| `count_mode` | `effective_count` |
|---|---|
| `fixed` | `min(entered, remaining-inside-lock)`, capping disclosed — unchanged |
| `max_available` | the remaining allowance **observed inside the usage lock** |

> **Max Available means the allowance available when the server authorizes the
> job** — not the number the browser held when the button was pressed.

Behaviour change: when the allowance grew after the browser read it, the order is
no longer capped to the stale number. It is still bounded by the locked
allowance, so the plan cap can never be exceeded.

## 6. Active-job resolution

Exactly one outcome, always explicit:

| Outcome | Response | Creates | Mutates |
|---|---|---|---|
| `zero` | proceed | one job | — |
| `one_exact_match` | `200 already_running`, resume it | — | — |
| `one_conflict` | `409 active_job_criteria_conflict` + `mismatched_fields` | — | — |
| `one_unverifiable` | `409 legacy_active_job_unverifiable` + `unprovable_fields` | — | — |
| `multiple_active` | `409` + `active_job_count`, `active_job_ids` | — | — |

**Nothing except `zero` creates a job, and no outcome cancels, releases or
mutates anything.**

A job may be resumed only when the server can *prove* the order matches. Compared
fields:

```
polygon_hash · count_mode · effective_count · min_price · max_price
sold_months · ownership_range_mode · ownership_range_days
route_filters · route_bounds · repull_mode · previous_pull_date
```

`entered_count` is deliberately **not** compared — doing so would bake in one
reading of the unresolved Fixed Count contract. `effective_count` is compared
because it is what actually determines the pull.

If any compared field cannot be read from the persisted job, the outcome is
`one_unverifiable`. **Missing fields are never assumed to match**, and the
unverifiable job is not cancelled. A job with no stored `polygon_hash` has it
recomputed from its polygon rather than treated as unknown.

## 7. Cancellation authority

A client-supplied field — `force_full_refresh` or any other — is **not**
authority to cancel a server-owned job.

This PR adds no automatic cancellation of any kind. A stuck import is contained
by the existing 30-minute watchdog or by explicit user cancellation through
`cancelFetchJob`, which independently verifies ownership. Full lifecycle design
is deferred — see deferred decision §6.

## 8. Preview

A provider transport failure no longer destroys the Preview. The probe has an 8s
timeout; on failure the response carries `sandbox_probe: null` and
`sandbox_probe_error: 'provider_unreachable'`, and the county resolution, area
and allowance estimate are still returned.

`availability_measured: false` is always present: the probe queries the polygon's
**centroid as a text string** and measures nothing about the drawn area.

Request shape, centroid query, dataset selection, trigger and cache behaviour are
all unchanged.

## 9. Explicitly preserved

Reservation and FetchJob creation remain **one atomic write** · the per-subject
advisory lock is unchanged and both endpoints still contend on it · entitlement
and allowance are still re-derived inside the lock · the processor is still
invoked exactly once · quick and custom sold-date ranges, route filters, route
bounds and Pro gating are unchanged · the minimum-value default divergence is
unchanged · no criteria snapshot or schema-version claim is written, so every
job keeps the downstream classification it has today.
