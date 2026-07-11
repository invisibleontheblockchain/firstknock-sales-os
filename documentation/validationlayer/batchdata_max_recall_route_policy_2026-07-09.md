# BatchData maximum-recall route policy

Date: 2026-07-09
Branch: `codex/optimize-batchdata-recent-sale-payloads`

## Decision

Property `intel` and `sale` are independent date predicates on the same Property Search endpoint. Neither proves single-family residence, home value, or current listing disposition. Production discovery therefore runs two separately paginated searches and de-duplicates the record-level union:

1. `searchCriteria.intel.lastSoldDate`
2. `searchCriteria.sale.lastSaleDate`

Every production request also applies the independent, documented route-quality predicates:

- `general.standardizedLandUseCode.equals = "R2"`
- `valuation.estimatedValue.min = 100000` (or the higher user-selected minimum)
- `listing.statusCategory.notInList = ["Active", "Pending"]`

The exact freehand polygon is sent to both searches and is rechecked locally with the same boundary tolerance before persistence and again before route generation.

Date windows use completed America/Phoenix calendar days: on July 9, a 1-day pull is July 8 only and a 14-day pull is June 25 through July 8. Both `minDate` and `maxDate` are sent, preventing an inclusive-range off-by-one or incomplete same-day records from entering a route.

## Why provider-filter provenance is required

The corrected live capability probe proved that the current API token accepts the three search predicates with `options.datasets=["basic"]`, but rejects `core`, `listing`, `deed`, and `valuation` with `dataset_not_allowed`. Basic Search returned complete address and coordinates in all three final samples, yet returned none of the exact date fields accepted by the mapper.

Consequently, a valid Search match was formerly discarded merely because the lean response did not repeat the hidden field used to match it. The pipeline now records the exact sent predicates as `_firstknock.search_evidence`. It may rely on that evidence only when all of the following are true:

- the SFR predicate was exactly R2;
- the estimated-value predicate proves the effective route range;
- Active and Pending listing categories were excluded;
- the Intel or Sale predicate proves the same or a narrower date window than the route being generated.

No sale date or home value is fabricated. If an exact returned value contradicts predicate provenance, the exact value wins and the property is rejected. A broader prior date predicate cannot satisfy a narrower later route filter.

## Recall and density observations

Four corrected 25-square-mile polygons produced the following 14-day counts:

| Market | Intel | Sale | Qualified Intel | Qualified Sale |
|---|---:|---:|---:|---:|
| Phoenix | 5 | 5 | 5 | 5 |
| Charlotte | 1 | 1 | 1 | 1 |
| Dallas | 1 | 1 | 1 | 1 |
| Seattle | 31 | 25 | 11 | 7 |

These are predicate counts, not de-duplicated unions. In Seattle, R2 caused the entire observed reduction; the $100,000 and listing exclusions caused no additional reduction in the control run. That is why Intel-only, Sale-only, union, R2-rejected/unresolved, value-rejected, listing-rejected, polygon-rejected, duplicate, already-routed, and final-routed counts must remain separate in job diagnostics.

The system cannot honestly prove that it found all 24 true qualifying homes without an independent recorder/MLS record-level truth set. It can now prove where a BatchData-discovered record was lost inside FirstKnock, and it no longer loses Intel-only or Sale-only records by design.

## Data-structure map

| Layer | What it is allowed to prove | Current behavior |
|---|---|---|
| Search geography | Candidate is inside the submitted freehand polygon | The exact polygon is sent to both streams, checked locally before persistence, stored on the FetchJob, returned by job status, and reused at final routing instead of mutable canvas state. |
| `intel.lastSoldDate` | Candidate matched BatchData's Intel recency index | Pulled as one independent stream. Intel-only matches are retained at medium confidence. |
| `sale.lastSaleDate` | Candidate matched BatchData's Sale recency index | Pulled as a second independent stream. A match here, or an exact high-confidence returned sale event, provides the stronger sale lane. |
| `general.standardizedLandUseCode = R2` | Provider classified the property under its documented single-family code | Applied independently to both recency streams. Explicit returned condo/unit/non-SFR contradictions still reject. Generic `Residential` is never guessed into SFR. |
| `valuation.estimatedValue` | Provider matched the estimated-home-value range | The floor is always at least $100,000. Sale consideration and listing price cannot satisfy this gate. A contradictory returned estimate wins over predicate provenance. |
| `listing.statusCategory` | Provider excluded Active and Pending categories at request time | Required on both streams. Explicit returned for-sale/coming-soon/contingent/pending statuses still reject. |
| `options.datasets = ["basic"]` | Lean identity/address/coordinate response entitled for this token | Complete address and coordinates were present in the corrected mapper supplement; hidden matched fields were not repeated. |
| Job-scoped `_firstknock` evidence | Which exact predicates caused this exact FetchJob candidate to be admitted | Persisted separately in `property_sources` using the FetchJob id, so a newer pull cannot silently reuse another job's predicate proof. |
| Lookup all-attributes | Enrichment of a known address, not polygon discovery | Correct basic requests work. Rich `core`, `listing`, `deed`, and `valuation` requests are blocked by the current token's entitlements. |

## Internal gatekeeping audit

- The server-authorized capped request count, not the user's pre-cap intent, controls route size and shortfall messaging.
- The eligible Intel/Sale union is formed before the final plan cap. Records corroborated by both streams rank first, then Sale-only, then Intel-only.
- Saved-route and interaction history are event-aware. A timestamped knock that is provably before the current sale boundary no longer suppresses the new owner. Reopening is property-specific; neighbors, same-day/newer/undated logs, and CSV cooldowns remain protected.
- Owner observations are job-scoped. When the current lean response omits an owner, the route returns no owner instead of leaking a prior owner's canonical name. When a name is present, the UI and CSV label it as a current BatchData observation, not a sale-deed-verified buyer.
- Incomplete identities cannot collapse into a shared `0||ZIP` key. Polygon boundaries use the same small tolerance in ingestion, retrieval, and client routing.
- Route splitting and distance guards conserve admitted stops; focused tests cover 23-stop, 501-stop, and max-distance cases without loss or duplication.
- The Neon persistence path writes in 100-property JSONB chunks and keeps job evidence separate. This replaces thousands of serial per-property round trips on a 1,000-home pull while retaining the prior non-destructive event/classification merge rules.

Two proposed changes from the earlier review were deliberately rejected. The $100,000 floor was not removed because it is an explicit business requirement. A two-page "zero confirmed SFR" short-circuit was not added because the corrected live contract proved provider-side R2 filtering works with `basic`; stopping early would create the exact penetration hole this audit is intended to prevent.

## Cost behavior

`take: 100` remains the live-account page size. The raw review ceiling per predicate is `min(5000, max(100, requestedStops * 50))`; this is a ceiling, not a routine spend. A 50-stop request can therefore make at most 25 record pages per predicate in the pathological low-yield case, while a request of 100 or more is capped at 50 pages per predicate. Each stream stops as soon as it fills its target or exhausts. Requests above 100 also make one count probe per predicate before record paging. Preview counts are lower/upper bounds because count-only calls cannot measure cross-predicate identity overlap; the paid record pull computes the exact union.

API calls, returned record units, and billable credits are not interchangeable. The code exposes actual HTTP attempts and reviewed records, but the BatchData dashboard remains authoritative for the charge applied to count requests, errors, retries, and returned rows.

Cursor pagination is preferred by the general documentation and the opaque cursor is never logged. In the corrected live probe, cursor page one succeeded but the verbatim page-two cursor returned HTTP 500. Production therefore defaults this token to bounded offset paging; cursor mode is capability-flagged and, if enabled later, its failure path restarts offset at zero and identity-de-duplicates replayed rows so ordering differences cannot create a recall hole. Max Available is marked truncated whenever a provider stream is not exhausted under the account/output budget.

## Remaining external blocker

Enable the `core`, `listing`, `deed`, and `valuation` datasets for this BatchData token, then rerun the corrected three-address identity and field-population probe. Rich data would let FirstKnock independently re-evaluate predicate results, display exact sale dates and estimated values, and place unresolved broad-discovery candidates into an enrichment queue. Until then, the route lane is limited to provider-asserted R2/value/not-active matches; broad unclassified rows are not silently guessed into SFR routes.

Two independent validations still remain outside this branch:

1. Match the exact candidate union against a recorder/MLS sold-SFR truth set to calculate real recall and determine how many of the Seattle R2 exclusions are false negatives rather than legitimate non-SFR removals.
2. Repeat the persistence smoke against a real staging Neon database created by `setupNeonPropertyTables`. The only locally configured Neon target is over its storage limit and has an unrelated legacy UUID schema, so it was intentionally not mutated. A disposable PostgreSQL 17.5-compatible database with the intended BIGINT schema did pass the exact bulk insert/update, `xmin` optimistic-lock, assigned-route preservation, cross-job evidence, same-job reconciliation, workspace-pointer, and metrics statements.

Finally, stop selection is now lossless and street-grouped, but map polylines still do not constitute road-network navigation. Highest-quality walking/driving routes require a directions or route-matrix provider that understands legal roads, turns, crossings, gates, and waypoint limits.

## Verification

- 125 focused tests pass across recent-sale selection, SFR/type conflicts, value/listing gates, dual-predicate preview completeness, exact-job polling and route-mode ownership, exact job membership and authorization, owner provenance, same- and different-criteria active-job election, pipeline-lock election, live-runner safety, polygon identity, history/cooldown resets, merge concurrency policy, and stop conservation.
- Six Python validator safety/contract tests pass, and all live validation runners default to a zero-network plan until `--confirm-live` is supplied.
- The intended Neon persistence SQL passes a disposable PostgreSQL 17.5-compatible execution smoke; a real staging Neon target was not available.
- The production frontend build passes.
- Targeted ESLint passes for every modified backend/pipeline/UI module outside the repository's known pre-existing full-file lint debt in `Home.jsx` and `RouteCommandPanel.jsx`.
- `processFetchChunk`, `startBatchDataPull`, `previewBatchDataArea`, `fetchJobStatus`, and `getRouteCandidatesFromNeon` all bundle successfully.
- `git diff --check` reports no whitespace errors; only the repository's Windows LF-to-CRLF notices remain.
