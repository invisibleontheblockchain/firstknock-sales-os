# PR #66 — Stage 0–14 Status

**PR:** [#66](https://github.com/invisibleontheblockchain/firstknock-sales-os/pull/66) ·
branch `codex/precision-phase1-containment` · head `1708f72d` · **draft, unmerged**

Two commit groups are in scope:

- **PR #66 baseline** (`85556d19 … 085c2b9f`) — Control-Plane containment.
- **`1708f72d`** — evidence-first BatchData contract hardening.

Ratings: `GREEN` proven · `YELLOW` partially proven · `RED` demonstrated defect ·
`GRAY` unverified · `BLOCKED` needs external evidence.

No stage is GREEN on a passing unit test alone. Provider-dependent stages cannot
be GREEN without real provider evidence.

---

## Summary table

| Stage | Name | Plane | Status |
|---|---|---|---|
| 0 | Identity, workspace, entitlement, allowance | B | **RED** |
| 1 | Freehand polygon | A | **YELLOW** |
| 2 | User order | A | **RED** |
| 3 | Preview | A/C | **GRAY** |
| 4 | Locked start decision | B | **RED** |
| 5 | Canonical FetchJob | B/G | **GREEN** (new jobs only) |
| 6 | Exact BatchData request | C | **YELLOW** |
| 7 | Actual BatchData response | C | **BLOCKED** |
| 8 | Parsing and classification | D | **YELLOW** |
| 9 | Persistence and usage settlement | E | **YELLOW** |
| 10 | Completion and browser polling | G | **RED** |
| 11 | Exact FetchJob candidates | B/F | **GREEN** (schema-v1 only) |
| 12 | Route filtering and optimization | F | **GRAY** |
| 13 | SavedRoute provenance | G | **RED** |
| 14 | Display and assignment | F | **GRAY** |

**Recovery plane:** Retry `RED` · Reload `RED` · History `YELLOW` ·
Multiple active jobs `RED` · Orchestrator delegation `BLOCKED`.

---

## Stage 0 — Identity, workspace, entitlement, allowance

- **Plane:** B (Control)
- **Purpose:** Determine actor, immutable usage subject, workspace, plan, Pro access, and remaining allowance — all server-derived.
- **Current code owners:** `startBatchDataPull/entry.ts`, `fetchAreaProperties/entry.ts`, `_shared/precisionActiveJobCriteria.js` (`precisionWorkspaceIdentity`, `findActivePrecisionJob`)
- **What PR #66 changes:** Server-derives candidate identity instead of trusting client-supplied email/workspace. Adds `precision_usage_user_id` as the immutable subject and `workspace_id` to canonical criteria. Rejects ownership mismatch with `fetch_job_owner_mismatch`.
- **What `1708f72d` changes:** Nothing in this stage.
- **Invariant currently enforced:** The browser cannot authorize itself by sending email, user ID, or workspace ID on the candidate path.
- **Evidence:** Code inspection + behavioral tests.
- **Tests:** `test/precision-legacy-and-identity.test.mjs`, `test/precision-retry-and-active-job.test.mjs`
- **Current status:** **RED**
- **Known gaps:**
  - **Two independent start paths.** `fetchAreaProperties` creates its own FetchJob (`entry.ts:665`) and reserves usage (`entry.ts:724`) using its **own** `resolvePrecisionEntitlement`, `getPrecisionAllowance`, `FREE_PROPERTY_CAP`/`PAID_PROPERTY_CAP`, and Pro gating — entirely separate from `startBatchDataPull`. Entitlement and allowance are duplicated business rules across two Control-Plane entrypoints. PR #66's "one shared locked start engine" goal is **not met**.
  - Delegated Orchestrator/admin access has no established delegation contract.
- **Next required test:** A parity suite asserting that both start paths produce identical `entitlement_kind`, `usage_limit`, `remaining_count`, and effective count for the same user and criteria — then collapse them onto one shared implementation.

---

## Stage 1 — Freehand polygon

- **Plane:** A (Order)
- **Purpose:** Capture the exact geographic boundary and normalize it deterministically.
- **Current code owners:** `closePolygon` and `isPointInPolygon` in `processFetchChunk`; `polygonHash` in `startBatchDataPull`, `fetchAreaProperties`, `previewBatchDataArea`, `getRouteCandidatesFromNeon`
- **What PR #66 changes:** Adds `polygon_hash` to canonical criteria and to exact-job comparison, so a retry or candidate request against a different polygon fails closed.
- **What `1708f72d` changes:** Adds golden tests proving the outbound polygon is explicitly closed, that `lat→latitude` / `lng→longitude` are not reversed, and that a coordinate swap cannot pass.
- **Invariant currently enforced:** Outbound polygon closure and coordinate orientation; out-of-polygon records are dropped before persistence.
- **Evidence:** `BD-E01` captured requests; `test/fixtures/batchdata/polygon/escalation-polygon-geopoints.json`
- **Tests:** `test/batchdata-contract-outbound-request.test.mjs` — *polygon is closed and lat/lng are not reversed*
- **Current status:** **YELLOW**
- **Known gaps:**
  - `polygonHash` exists in **four copies, two variants**. Hashes agree for well-formed numeric input, but the three writer copies call `p.lat.toFixed()` and throw on string coordinates, while the reader copy coerces via `Number()` and returns `null`. Not one normalization contract.
  - No visual overlay test proving the browser polygon and the outbound polygon coincide.
- **Next required test:** Move `polygonHash` to `_shared/`, then assert byte-identical hashes across all four call sites for valid, string-coordinate, duplicate-point, and reversed-order polygons.

---

## Stage 2 — User order

- **Plane:** A (Order)
- **Purpose:** Capture count mode, entered count, value range, sold-date window, repull mode, and route bounds as immutable user intent before any server capping.
- **Current code owners:** `src/components/map/PrecisionPullPanel.jsx`, `src/components/map/TerritoryPrompt.jsx`
- **What PR #66 changes:** Separates `entered_count` from `effective_count` in canonical criteria (`requested_properties_before_cap` vs `requested_properties`) and carries both through comparison and diagnostics.
- **What `1708f72d` changes:** Removes `include_mls` from the browser retry payload.
- **Invariant currently enforced:** `entered_count` and `effective_count` are distinct fields server-side.
- **Evidence:** Code inspection.
- **Tests:** `test/precision-frontend-containment.test.mjs`, `test/batchdata-contract-mls-removal.test.mjs`
- **Current status:** **RED**
- **Known gaps:**
  - **The browser pre-caps Fixed Count.** `PrecisionPullPanel.jsx:512` clamps `onChange` with `Math.min(Number(value), maxProperties)`, `:514` clamps again `onBlur`, and `:505` sets `max={maxProperties}` on the input. A user who wants 1,000 with an 839 allowance can only ever record 839. The Control Map requires the browser to preserve 1,000 as intent. **`entered_count` is therefore not the user's entered intent — it is already the capped value.**
  - Max Available synchronizes the visible count to the current allowance, so the browser snapshot and the locked server value can differ without a versioned contract.
- **Next required test:** Assert that entering a count above the displayed allowance transmits the **entered** value, and that the server — not the browser — produces `effective_count = min(entered, allowance, cap)`.

---

## Stage 3 — Preview

- **Plane:** A/C
- **Purpose:** Estimate polygon validity and provider availability without creating the paid FetchJob.
- **Current code owners:** `previewBatchDataArea/entry.ts`
- **What PR #66 changes:** Nothing.
- **What `1708f72d` changes:** Nothing.
- **Invariant currently enforced:** Preview does not create a production FetchJob or reserve allowance.
- **Evidence:** Code inspection only.
- **Tests:** None.
- **Current status:** **GRAY**
- **Known gaps:**
  - Preview calls the **live** BatchData property-search endpoint (`entry.ts:58`) and computes cost from `BATCHDATA_PLAN_COST / BATCHDATA_PLAN_RECORDS`. It is non-authoritative but **not free**, and its provider spend is not counted anywhere.
  - Preview has its own `polygonHash` copy; parity with the final request is unproven.
  - Preview still sends the pre-`1708f72d` request shape; it has not been checked against provider contract v1.
- **Next required test:** Assert preview and final request produce the same normalized polygon and the same criteria semantics, and record preview provider spend in the credit ledger.

---

## Stage 4 — Locked start decision

- **Plane:** B (Control)
- **Purpose:** Convert the order into an authoritative server decision inside a usage lock.
- **Current code owners:** `startBatchDataPull/entry.ts`, `_shared/precisionActiveJobCriteria.js`
- **What PR #66 changes:** Recalculates allowance inside the lock, inspects active jobs before starting, fails closed with `active_job_criteria_conflict` when a running job's criteria differ, and reserves usage before any provider call.
- **What `1708f72d` changes:** Nothing.
- **Invariant currently enforced:** No provider request begins before authentication, persisted criteria, in-lock allowance, and a reservation.
- **Evidence:** Behavioral tests.
- **Tests:** `test/precision-active-job-compatibility.test.mjs`, `test/precision-retry-and-active-job.test.mjs`
- **Current status:** **RED**
- **Known gaps:**
  - **Multiple active jobs are not explicitly detected.** `findActivePrecisionJob` collects every running/pending job into `jobsById`, sorts, and returns `[0]` — silently choosing the newest. The Control Map requires resolving to *zero, one, or explicitly-multiple*. PR #66's "explicit multiple-active-job detection" goal is **not met**.
  - `fetchAreaProperties` is a second start path with its own reservation logic (see Stage 0).
- **Next required test:** `findActivePrecisionJob` must return a count and refuse to auto-select when more than one active job exists; the caller must surface an explicit multiple-active decision to the user.

---

## Stage 5 — Canonical FetchJob

- **Plane:** B/G
- **Purpose:** Write the official order ticket before provider processing begins.
- **Current code owners:** `startBatchDataPull/entry.ts`, `_shared/precisionActiveJobCriteria.js`
- **What PR #66 changes:** Persists `dry_run_metadata.precision_criteria` with `criteria_schema_version: 1` and all material fields; adds `precisionCriteriaSource` so legacy jobs are judged under the legacy policy instead of schema-v1 rules.
- **What `1708f72d` changes:** Adds `dry_run_metadata.provider_contract_version: 1`, plus `precisionProviderContractVersion()` and `isSupportedPrecisionProviderContract()`. `null` is explicitly **not** an alias for v1.
- **Invariant currently enforced:** New jobs record both which criteria schema and which provider contract created them; the FetchJob is written before provider work.
- **Evidence:** Behavioral tests.
- **Tests:** `test/batchdata-contract-end-to-end-trace.test.mjs` — *unversioned legacy job is not reinterpreted*, *unknown provider contract fails closed*
- **Current status:** **GREEN** — for newly created jobs only.
- **Known gaps:** Attempt provenance (root job / attempt chain) is partial. Legacy jobs carry neither version and remain under the disclosed legacy policy.
- **Next required test:** Assert the full attempt chain (`root_fetch_job_id`, attempt index) survives a retry.

---

## Stage 6 — Exact BatchData request

- **Plane:** C (Provider)
- **Purpose:** Translate canonical criteria into the exact outbound BatchData JSON.
- **Current code owners:** `processFetchChunk/entry.ts` → `buildBatchDataRequest`
- **What PR #66 changes:** Nothing material to the request body.
- **What `1708f72d` changes:**
  - **Removes `options.datasets`** — the proven regression. Real A/B evidence `OBS-02` shows dataset scoping makes BatchData omit `intel`/`sale`, driving `active=0`. `origin/main` and PR #66's baseline both shipped `['basic','deed','owner']`; combined with the fail-closed `missing_recorded_sale_date` rule that delivers **zero** properties.
  - Enforces `take ≤ 100` (`OBS-03`).
  - Adds a path-subset test: every emitted JSON path must appear in a real captured request or in a 2-entry enumerated sibling list.
  - Proves count mode, repull mode, route bounds, and plan allowances never leak into provider criteria.
- **Invariant currently enforced:** No speculative outbound field; no MLS-era field; polygon closed and correctly oriented; both date bounds carried for custom ranges.
- **Evidence:** `BD-E01` (3 verbatim captured requests), `BD-E05` (provider-supplied example), `OBS-02`, `OBS-03`.
- **Tests:** `test/batchdata-contract-outbound-request.test.mjs` (13 tests)
- **Current status:** **YELLOW**
- **Known gaps:** `intel.lastSoldDate.maxDate` and `valuation.estimatedValue.max` are sibling-inferred, not literally captured. The request has not been exercised in an authorized provider environment with measured credit usage.
- **Next required test:** Authorized sandbox run capturing request, response, and provider usage delta for one small polygon.

---

## Stage 7 — Actual BatchData response

- **Plane:** C (Provider)
- **Purpose:** Receive and retain real provider responses as contract evidence.
- **Current code owners:** `processFetchChunk` → `fetchBatchDataRecordsForMode`
- **What PR #66 changes:** Nothing.
- **What `1708f72d` changes:** Creates `test/fixtures/batchdata/` with an honest source-type taxonomy and records every response-side fact that actually exists in `responses/observed-response-assertions.json` (`OBS-01`…`OBS-06`).
- **Invariant currently enforced:** Fixtures are classified; `reconstructed_response` and `synthetic_failure_safety` are never citable as contract evidence, enforced by test.
- **Evidence:** `OBS-01`…`OBS-06` (field-level facts). **No raw response body exists** in the repo, its git history, or the local environment.
- **Tests:** `test/batchdata-contract-response-replay.test.mjs` — *reconstructed fixtures are never labelled as raw provider captures*
- **Current status:** **BLOCKED**
- **Known gaps:** This stage cannot progress without an authorized capture. Unproven: coordinate nesting (`address.location.*` vs `address.*`), `totalRecordCount`, whether `sale` and `intel.lastSoldDate` can disagree, `maxDate` semantics, `general` nesting.
- **Next required test:** Authorized no-write sandbox capture via `validateBatchDataShape` with `take: 5` and no `options.datasets`; redact and promote to `real_provider_capture`.

---

## Stage 8 — Parsing and classification

- **Plane:** D (Interpretation)
- **Purpose:** Read each real provider object and decide eligibility with a named reason.
- **Current code owners:** `processFetchChunk` → `extractBatchDataRecords`, `normalizeBatchDataAddress`, `mapBatchDataProperty`
- **What PR #66 changes:** Adds the Precision delivery invariant with reasons `missing_recorded_sale_date`, `recorded_sale_outside_window`, `unprovable_minimum_value`, `unprovable_property_type`.
- **What `1708f72d` changes:**
  - Removes dead `listing.status`/`statusCategory` locals.
  - Removes `listing.soldDate` from the authoritative sale-date chain (MLS-to-deed gap of 30–60 days per `BD-E06`).
  - Removes `listing.price`/`listPrice` from the estimated-value chain.
  - Stops defaulting a missing property type to `Single Family`; Precision persists `null` and excludes as `unprovable_property_type`.
  - Fixes `extractBatchDataRecords`, which previously wrapped **any** unrecognised envelope object into one fabricated record. Unknown shapes now yield zero records observably.
- **Invariant currently enforced:** No missing provider field is replaced with a guessed value to make a row eligible.
- **Evidence:** `OBS-01`, `OBS-04`, `OBS-06`, `BD-E04` (`propertyTypeDetail` populated on 500/500 provider rows), `BD-E06`.
- **Tests:** `test/batchdata-contract-response-replay.test.mjs` (18), `test/batchdata-contract-mls-removal.test.mjs` (6)
- **Current status:** **YELLOW**
- **Known gaps:**
  - The full live response object has not been captured and replayed.
  - Classification is binary (`route_active` + reason), not the six-state taxonomy.
  - **Records dropped before classification carry no reason.** Missing street, missing ZIP, non-finite coordinates, and outside-polygon all return `null` silently — invisible `C2 → C3` loss.
- **Next required test:** Make the mapper return a classified rejection instead of `null`, then assert every raw record produces exactly one state and one reason.

---

## Stage 9 — Persistence and usage settlement

- **Plane:** E (Persistence)
- **Purpose:** Write accepted properties, associate them with the exact FetchJob, and settle delivered usage.
- **Current code owners:** `processFetchChunk` → `writePropertiesToNeon`, `countPersistedPrecisionProperties`
- **What PR #66 changes:** Aligns delivered usage with routeable candidates; persists `route_active`, `exclusion_reason`, and a minimized `raw_payload` audit snapshot including `precision_eligibility`.
- **What `1708f72d` changes:** Tightens which rows may be counted (a row with no provider property type is no longer billed).
- **Invariant currently enforced:** `delivered_count == FetchJob.precision_usage_count`, and every delivered row survives exact-job candidate retrieval.
- **Evidence:** Behavioral tests.
- **Tests:** `test/precision-delivered-routability.test.mjs`, `test/batchdata-contract-end-to-end-trace.test.mjs` — *a property counted as delivered always survives exact-job candidate retrieval*
- **Current status:** **YELLOW**
- **Known gaps:** The `C4 → C5 → C6 → C7` transitions are not individually instrumented. Deduplication (`C5`) and already-routed exclusion (`C6`) have no separate counters or reason buckets.
- **Next required test:** Emit per-transition counts and reason buckets from the processor and assert they reconcile.

---

## Stage 10 — Completion and browser polling

- **Plane:** G (Recovery & Audit)
- **Purpose:** Report completion to the browser without letting stale client state become authority.
- **Current code owners:** `fetchJobStatus/entry.ts`, `src/components/map/TerritoryPrompt.jsx`
- **What PR #66 changes:** Adds `processor_token` ownership checks and exact job-ID matching so a stale poll cannot adopt a different job.
- **What `1708f72d` changes:** Nothing.
- **Invariant currently enforced:** A poll response for a different job ID is ignored.
- **Evidence:** Code inspection + tests.
- **Tests:** `test/precision-frontend-containment.test.mjs`
- **Current status:** **RED**
- **Known gaps:**
  - **Reload recovery is client-discovered.** `TerritoryPrompt.jsx:547` runs `base44.entities.FetchJob.filter({ user_email: user.email, status: 'running' })` from the browser, then `:559` and `:570` repeat it for pending and failed jobs, and the client chooses. This is exactly the pattern the Control Map forbids: *"It must not query by email and choose the newest result itself."*
  - `fetchJobStatus` exposes `active_count` only — no drop-reason buckets.
- **Next required test:** A server endpoint answering zero/one/multiple active jobs for the authenticated subject, with the browser holding no selection logic.

---

## Stage 11 — Exact FetchJob candidates

- **Plane:** B/F
- **Purpose:** Return exactly the properties belonging to the exact completed FetchJob.
- **Current code owners:** `getRouteCandidatesFromNeon/entry.ts`
- **What PR #66 changes:** Requires the exact completed FetchJob, authenticated owner, workspace, polygon hash, criteria schema, exact criteria comparison, `workspace_properties` row association, route-active and non-rejected status, valid coordinates, and the exact sold window. Fails closed with `fetch_job_criteria_mismatch`, `fetch_job_owner_mismatch`, `fetch_job_criteria_unverifiable`, or `legacy_precision_criteria_unverifiable`.
- **What `1708f72d` changes:** Adds provider-contract-version validation — an unknown version returns `precision_provider_contract_unsupported` (409) and no candidates; the version is echoed in the response.
- **Invariant currently enforced:** No ZIP-wide, account-wide, frozen, or foreign-FetchJob substitution. Delivered ⇒ candidate holds for the fixture corpus.
- **Evidence:** Behavioral tests + end-to-end trace.
- **Tests:** `test/precision-route-candidate-integrity.test.mjs`, `test/precision-legacy-and-identity.test.mjs`, `test/batchdata-contract-end-to-end-trace.test.mjs`
- **Current status:** **GREEN** — under deterministic schema-v1 tests only.
- **Known gaps:** Legacy jobs route under a reconstructed, explicitly-disclosed criteria set (`LEGACY_UNVERIFIABLE_CRITERIA_FIELDS`). The upstream row set has never been produced from a real provider response.
- **Next required test:** Re-run the trace against a real captured response once Stage 7 unblocks.

---

## Stage 12 — Route filtering and optimization

- **Plane:** F (Route)
- **Purpose:** Reduce exact candidates to a working set and order them for real knocking.
- **Current code owners:** `generateRoutesBackend/entry.ts`, `src/components/logic/routeOptimizer.jsx`
- **What PR #66 changes:** Nothing material.
- **What `1708f72d` changes:** Nothing.
- **Invariant currently enforced:** None asserted for this stage.
- **Evidence:** Code inspection only. The optimizer computes `distanceMiles`, start/end legs, and route splitting.
- **Tests:** No Precision-specific conservation test.
- **Current status:** **GRAY**
- **Known gaps:** `C8 → C9 → C10` is entirely uninstrumented. No per-drop reason list. No route-quality metrics — large jumps, street switches, subdivision re-entry, path crossings, miles per door, Home Base legs, optimizer duration. No Route Bounce Score.
- **Next required test:** Assert `C8 → C9 → C10` with a named reason per dropped property, then add the route-quality metric set.

---

## Stage 13 — SavedRoute provenance

- **Plane:** G (Recovery & Audit)
- **Purpose:** Persist routes with provenance sufficient to reconstruct the original order.
- **Current code owners:** `src/pages/Home.jsx` (`SavedRoute.create`), `src/components/map/MapToolbar.jsx`, `ActiveRoutesTab.jsx`, `SplitRouteModal.jsx`, `CampaignWizard.jsx`
- **What PR #66 changes:** Carries more criteria through the job metadata that the browser reads when assembling the route payload.
- **What `1708f72d` changes:** Nothing.
- **Invariant currently enforced:** None server-side.
- **Evidence:** Code inspection.
- **Tests:** None for provenance completeness.
- **Current status:** **RED**
- **Known gaps:**
  - **SavedRoute is written by the browser.** `src/pages/Home.jsx:1035` calls `base44.entities.SavedRoute.create(routeData)` with a client-assembled payload, and on backend failure **falls back to a local-only route** (`storage.saveRoute`) while reporting success. There is no server-authoritative SavedRoute writer.
  - No SavedRoute currently carries `provider_contract_version`, `criteria_schema_version`, `delivered_count`, `candidate_count`, or `optimizer_input_count`.
  - Six distinct client call sites create SavedRoutes with different payload shapes.
- **Next required test:** A server-side SavedRoute writer that rejects any property hash not in the exact candidate set, plus an assertion that all required provenance fields are present.

---

## Stage 14 — Display and assignment

- **Plane:** F (Route)
- **Purpose:** Render every SavedRoute property correctly and assign it to a rep.
- **Current code owners:** `src/components/logic/routeHydration.jsx`, `routeHydrationCore.js`, `getRoutePropertiesByHashes/entry.ts`
- **What PR #66 changes:** Nothing.
- **What `1708f72d` changes:** Nothing.
- **Invariant currently enforced:** None asserted for Precision.
- **Evidence:** None.
- **Tests:** `test/precision-route-hydration-contract.test.mjs` exists on an unmerged branch, not here.
- **Current status:** **GRAY**
- **Known gaps:** No proof that every SavedRoute property appears after hydration, or that a rep assignment preserves the set. Needs a visual Test Lab run.
- **Next required test:** Assert `SavedRoute.property_hashes.length == hydrated properties rendered`.

---

## Recovery plane

| Piece | Status | Why |
|---|---|---|
| **Retry** | **RED** | Not server-authoritative. `retry_fetch_job_id` **does not exist anywhere in the codebase.** `TerritoryPrompt.jsx` reconstructs criteria in the browser from `dry_run_metadata` and resubmits them as a fresh request. `1708f72d` removed `include_mls` from that payload but did not move retry to the server. |
| **Reload** | **RED** | The browser queries `FetchJob.filter({ user_email, status })` and selects a job itself (`TerritoryPrompt.jsx:547`). |
| **History** | **YELLOW** | `PolygonHistory.jsx` prefers a canonical `precision_criteria` snapshot when present and falls back to per-field reconstruction for legacy jobs. Legacy entries are displayed but not marked verified. |
| **Multiple active jobs** | **RED** | `findActivePrecisionJob` silently returns the newest of N. No zero/one/multiple decision. |
| **Orchestrator delegation** | **BLOCKED** | No delegation contract exists; admin acting on another subject is undefined. |

---

## Where future sessions must work

| Reported problem | Start at |
|---|---|
| "Wrong count / my number changed" | Stage 2 (browser pre-cap), then Stage 4 |
| "BatchData returned nothing" | Stage 6 request, then Stage 7 evidence |
| "Homes came back but vanished" | Stage 8 parser, then Stage 9 persistence |
| "Delivered ≠ route" | Stage 11, then Stage 12 |
| "Route bounces around" | Stage 12 optimizer |
| "Route lost homes when saved" | Stage 13 |
| "Route looks wrong on the map" | Stage 14 hydration |
| "Retry started the wrong job" | Recovery — retry and multiple-active |
| "Reload lost my job" | Stage 10 / Recovery — reload |
| "We're spending too much" | Stage 3 preview spend, Stage 6 pagination, Ghost Mode |
