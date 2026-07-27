# Canonical FetchJob Contract (C1)

Every field a PR A FetchJob carries, and what PR #66 may rely on. No field has an
ambiguous meaning; where one is unresolved it is marked so explicitly.

| Field | Type | Req | Authority | Meaning | Default | Normalization / Validation | Persistence | Failure | PR #66 consumer |
|---|---|---|---|---|---|---|---|---|---|
| actor identity | string | ✔ | session (`base44.auth.me`) | who submitted the order | — | never read from the body | `user_email` | `401` | ownership check |
| immutable usage subject | string | ✔ | session | who the usage is billed to | — | `String(user.id)` | `precision_usage_user_id` | `401` | `fetchJobBelongsToUser` |
| workspace | string | ✔ | session (`team_manager_id \|\| id`) | authorization scope — **not** billing | actor id | trimmed, non-empty, never from body | `metadata.workspace_id` + snapshot | — | `getFetchJobWorkspaceId` |
| criteria schema version | int | ✔ | server | snapshot format | `1` | `=== 1` | `metadata.criteria_schema_version` | — | `precisionCriteriaSource` |
| provider contract version | int | ✔ | server | provider interpretation | `1` | in supported set | `metadata.provider_contract_version` | — | `precisionProviderContractVersion` |
| normalized polygon | `{lat,lng}[]` | ✔ | client | the drawn search area | — | numeric coercion, order preserved, ≥3 points, `-90..90`/`-180..180` | `polygon` | `400 invalid_polygon_point` | Stage 6 request |
| polygon hash | string(16) | ✔ | server | **submission** identity, not area identity | — | 6-dp, submitted order, SHA-256, first 16 hex | `polygon_hash` | — | criteria comparison |
| count mode | `fixed`\|`max_available` | ✔ | client | how the target was expressed | `fixed` | enum | `metadata.count_mode` | — | criteria comparison |
| entered count | int ≥1 | ✔ | client / server | the count expressed. **Meaning unresolved for `fixed`** — see `ADJ-M2-009` | plan max when absent | positive integer; `''` = absent | `requested_properties_before_cap` | `400 invalid_requested_properties` | retry mapper |
| effective count | int ≥1 | ✔ | server | the authorized target under the lock | — | `min(entered, remaining)`; **= remaining** for `max_available` | `requested_properties`, `precision_usage_reserved`, `total_expected` | — | Stage 6 take |
| minimum value | number>0 \| null | ✔ | client | price floor; `null` = **no floor (legacy meaning)** | `null` on `startBatchDataPull`, `100000` on `fetchAreaProperties` — **divergent, unresolved** | positive-or-null | `metadata.filters.min_price` | — | candidate query |
| maximum value | number>0 \| null | ✔ | client | price ceiling | `null` | positive-or-null | `metadata.filters.max_price` | — | candidate query |
| sold-date mode | `quick`\|`custom` | ✔ | client | window kind | `quick` | enum | `metadata.ownership_range_mode` | `400 invalid_ownership_range` | window math |
| custom ownership range | `{min,max}` \| null | ✔ | client | the **full** window | `null` | integers, `1 ≤ min < max ≤ 365` | `metadata.ownership_range_days` + snapshot | `400` | window math |
| sold months | number>0 | ✔ | derived | lossy legacy projection of the window | `12` | `max===365 ? 12 : max/30` | `sold_months` | — | legacy validator |
| route filters | object | ✔ | server | property-type contract | Single Family | server-forced, unwidenable | `metadata.route_filters` | — | classification |
| route bounds | object | ✔ | client | routing only — **never** provider selection | `{enabled:false}` | coordinates only, address stripped, in range | `metadata.route_bounds` | `400 invalid_route_bounds` | optimizer |
| repull mode | string | ✔ | client | `new_area`\|`fill_gaps`\|`max_since_last` | `new_area` | trimmed | `metadata.repull_mode` — **both paths** | — | Stage 5 |
| previous-pull date | ISO \| null | ✔ | client | refresh anchor | `null` | ISO or null | `metadata.previous_pull_date` | — | Stage 6 window |
| reservation identity | int ≥1 | ✔ | server | allowance held | — | equals the effective count | `precision_usage_reserved` | — | settlement |
| attempt identity | uuid | ✔ | server | processor authorization | — | `crypto.randomUUID()` | `metadata.processor_token` | — | `processFetchChunk` |
| created timestamp | ISO | ✔ | server | when the order was authorized | — | ISO | `metadata.paid_pull_started_at` / `batchdata_only_started_at` | — | staleness |

## The criteria snapshot

`dry_run_metadata.precision_criteria` is written in PR #66's own schema-v1 shape,
so `precisionCriteriaSource` returns `schema_v1` and no reconstruction happens.

It is **published only when it satisfies PR #66's schema-v1 rules.** Today the
only reason to withhold it is `min_price: null`, which schema-v1 rejects but the
legacy path deliberately accepts as "no floor". When withheld,
`precision_criteria_withheld: ['min_price']` records exactly why, and the record
stays on the legacy path carrying strictly more evidence than before PR A.

## What a consumer never has to do

| Must not | Enforced by |
|---|---|
| reconstruct identity from `user_email` | `precision_usage_user_id` always present; ownership verified by subject |
| infer a workspace | `metadata.workspace_id` always persisted |
| infer `repull_mode` from `pull_mode` | persisted on **both** start paths |
| reconstruct a custom window from `sold_months` | `ownership_range_days` persisted |
| guess whether `min_price: null` means "no floor" | the legacy path preserves the meaning; the snapshot is withheld rather than misrepresenting it |
| read browser local storage to identify the active job | the start response names the outcome and the job |
| tolerate a fractional count | rejected at Stage 2 |

## Response envelope

Both start paths return `active_job_outcome` ∈
`zero | one_exact_match | one_conflict | multiple_active`, plus
`criteria_schema_version`, `provider_contract_version`, `count_mode`,
`requested_properties`, `requested_properties_before_cap` and a `criteria`
diagnostic. A conflict additionally returns `mismatched_fields`; a
`multiple_active` outcome returns `active_job_count` and `active_job_ids`.
