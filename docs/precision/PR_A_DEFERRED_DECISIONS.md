# PR A — Deferred Decisions

Things the Precision order-control audit surfaced that this PR deliberately does
**not** resolve in code, because resolving them requires a product decision or
evidence that does not exist yet.

Each entry says what is unresolved, what the code does in the meantime, and what
would unblock it.

Full evidence lives on the audit branches, not here:

| Where | What |
|---|---|
| `audit/precision-order-control-model-1` @ `0c3fd666` | read-only audit: 65 findings, 28 claims, characterization tests, fixtures |
| `hardening/precision-order-control-model-2` @ `4ca3078f` (PR #73) | full integration laboratory: adjudication, PR #66 handoff experiment, mutation record |

---

## 1. Fixed Count contract

**Unresolved.** What a typed "Fixed Count" means.

> **Contract A** — the exact typed number is the order. The server caps it to the
> allowance and discloses the cap.
>
> **Contract B** — the currently selectable (already clamped) value *is* the
> official order, and the larger typed number was never part of it.

**Why it matters.** The browser clamps the typed count twice before the request
is built — once per keystroke against the displayed allowance, once again
against a freshly fetched allowance. So `requested_properties_before_cap` cannot
mean "as typed"; it can only mean "before the *server* cap".

**What this PR does.** Nothing that assumes either reading. Count validation
rejects unusable values but does not reinterpret valid ones, and the frontend
clamping is untouched. Active-job comparison deliberately compares
`effective_count` (the authorized target) and **not** `entered_count`, precisely
so it does not bake in one contract.

**To unblock:** a product ruling. Note that PR #66's retry mapper is built on
Contract A.

**Do not** change `PrecisionPullPanel.jsx` or `TerritoryPrompt.jsx` count
handling until this is decided.

---

## 2. Blank minimum property value

**Unresolved.** What a blank minimum means.

> `$100,000` default — or — no minimum at all.

**Current behaviour, unchanged by this PR:**

| Start path | Blank minimum becomes |
|---|---|
| `startBatchDataPull` | `null` — no price floor |
| `fetchAreaProperties` | `100000` |

**Visible consequence of this PR.** Because active jobs are now actually
compared, a job started on one path and resubmitted through the other reports an
explicit `409` naming `min_price`, instead of silently resuming with the wrong
criteria. That is strictly safer, but it is new and visible behaviour. It does
**not** resolve the decision.

**To unblock:** a product ruling on which default is correct, applied to both
paths together.

**Do not** normalize either path to the other without that ruling, and do not
claim a complete PR A → PR #66 criteria handoff while they disagree.

---

## 3. Role of `fetchAreaProperties`

**Unresolved.** Whether it is an equal public start endpoint, a retry-only
endpoint, or a legacy endpoint to retire.

**Current callers, verified:**

| Caller | Purpose |
|---|---|
| `src/components/map/TerritoryPrompt.jsx:757` | `retryRecoverableJob` — retry of a failed import |
| `src/pages/FetchTest.jsx:87` | internal test page |

`startBatchDataPull` is what the production pull button uses
(`TerritoryPrompt.jsx:1003` preflight and `:1029` start).

**What this PR does.** Applies the *shared safety protections* to both endpoints,
because both can create a reservation and a FetchJob. It does not otherwise
change their relationship, and it does not converge their remaining behavioural
differences.

**To unblock:** decide the endpoint's role, then either converge it with the
primary path or retire it.

---

## 4. Hard-coded entitlement grant

**Unresolved, and a standing security risk.**

`base44/functions/startBatchDataPull/entry.ts` grants paid access, Pro access and
a 1,000-property limit to a hard-coded email address, short-circuiting Stripe
verification entirely:

```js
if (user?.email?.toLowerCase() === 'baysecurity@gmail.com') { … }
```

**Risk.** Entitlement is keyed on a *mutable* attribute. Anyone who comes to
control that address gets a paid entitlement with no billing evidence. It also
exists on only one of the two start paths, so the same account is treated as free
on the other.

**Why it was not removed here.** The safe replacement — `BETA_ACCESS_GRANTS`,
which already exists, is already validated, and is keyed on the **immutable user
id** — requires that account's immutable id. Removing the email branch without it
would revoke a live entitlement from a real account.

**To unblock, in order:**

1. Confirm the intended account and entitlement with the product owner.
2. Obtain that account's immutable Base44 user id.
3. Add a `BETA_ACCESS_GRANTS` entry keyed on that id.
4. Delete the email branch.
5. Add a test asserting the email alone confers nothing.

---

## 5. Preview product promise and provider cost

**Unresolved.** What Preview is promising, and whether its provider probe costs
money.

**What the probe actually does.** It POSTs the polygon's **centroid as a text
query** to BatchData with `limit: 5`. It never sends the polygon. It therefore
validates no geometry and counts no properties in the drawn area.

**What this PR does.** Adds a bounded timeout and contains transport failure, so
a provider outage no longer destroys a Preview whose county resolution, area and
allowance estimate are all still valid. It also sets `availability_measured:
false` so no consumer can read the allowance echo as a measured inventory.

**Explicitly not claimed:** that the sandbox call is free, or that it is
billable. No provider call was made to find out.

**Explicitly not changed:** request shape, centroid query, dataset selection,
trigger behaviour, cache behaviour.

**To unblock:** BatchData's written statement on sandbox-key billing, plus a
product decision on what Preview should promise.

---

## 6. Cancellation and reservation lifecycle

**Deferred as a unit**, because these interact and must be designed and tested
together:

- stale-job cancellation
- reservation release when a job is cancelled or abandoned
- processor-start failure handling
- watchdog recovery
- operator remediation for a stuck import

**What this PR does.** Removes the *client-authorized* cancellation path only —
a client-supplied `force_full_refresh` can no longer destroy a healthy
server-owned job. It adds **no** automatic cancellation of its own: a conflicting
or unverifiable active job returns `409` and nothing is cancelled, released or
replaced.

**Known consequence.** A genuinely stuck import now blocks new pulls until the
existing 30-minute `watchdogStaleJobs` threshold, or until the user cancels it
explicitly. This is deliberate: destroying paid in-flight work on a 120-second
timer was worse, and the correct remedy is an explicit user-facing one that
belongs with the lifecycle work.

**To unblock:** design the lifecycle as one piece — remedy UI, reservation
settlement ownership, and watchdog behaviour together.

---

## 7. Canonical criteria snapshot for PR #66

**Deferred** until §1 and §2 are resolved.

PR #66 consumes a criteria snapshot and classifies a job as `schema_v1` or
`legacy`. Its schema-v1 validator requires `min_price > 0`, while its legacy
validator deliberately accepts `null` as "no floor". Writing a snapshot before
the minimum-value contract is settled would either misrepresent the order or
force a withholding workaround that creates a second source of truth.

**What this PR does.** Writes no snapshot and makes no schema-version claim, so
every job keeps exactly the downstream classification it has today.

**To unblock:** resolve §1 and §2, then introduce **one** authoritative criteria
module shared by PR A and PR #66 rather than two implementations of the same
contract.
