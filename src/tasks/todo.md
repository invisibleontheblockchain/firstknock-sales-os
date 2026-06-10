# Plan

## Current Plan — Phase 3: Real-Time Subscription Strategy
- [x] Research whether Base44 subscriptions support server-side filtering/RLS scoping (docs do not confirm it — treat subscription events as potentially global broadcasts).
- [x] Decide strategy: keep entity subscriptions only where real-time matters (chat delivery, double-knock prevention, route updates), with strict client-side tenant guards in every handler; no aggressive fixed-interval polling.
- [x] Inventory live patterns: RepHome SavedRoute + InteractionLog subscriptions, TeamChat TeamMessage subscription + 5s poll, query-client defaults.
- [x] RepHome: tenant-guard the SavedRoute 'create' handler so only this user/team's route creations trigger refetch (was: every tenant's route creation refetched every connected rep).
- [x] RepHome: InteractionLog handler already scoped to the active route's hashes — kept as-is (core double-knock feature).
- [x] TeamChat: reduce the redundant 5s message poll to a 30s safety net; the subscription handles real-time delivery.
- [x] query-client: add a 30s default staleTime to eliminate remount refetch churn app-wide; mutations keep explicit invalidation.
- [x] Verify no behavior regressions in the touched flows.

### Review — Phase 3: Real-Time Subscription Strategy
Final strategy: client-guarded subscriptions over polling. Subscriptions stay only for genuinely real-time flows — TeamMessage (chat), InteractionLog (double-knock prevention, already hash-scoped), and SavedRoute (route updates, now tenant-guarded so unrelated tenants' create events no longer trigger refetches). TeamChat's 5s poll was cut to a 30s fallback, and a global 30s staleTime now prevents remount refetch storms. At 15k users this removes the two biggest fan-out amplifiers (global create-invalidation and chat polling) without losing any real-time UX.

## Previous Plan — Phase 2: Full Entity RLS Rollout
- [x] Inventory remaining entities without RLS and classify by tenancy model.
- [x] Tenant-scoped RLS (manager_id/created_by/team/admin): CanvasSession, ChatGroup (incl. member_emails read), Appointment, DailyResult.
- [x] Creator-scoped RLS: FetchJob (created_by/user_email), RouteTemplate, TerritoryPlan, Referral (referrer/referred read, admin-only writes).
- [x] Backend-only RLS (admin-only; service role bypasses): PipelineLock, LeadScoringWeights (read stays open for client-side scoring).
- [x] TeamMessage: lock update/delete to sender/admin; read stays open pending a participant_emails redesign for group/DM channels.
- [x] Add manager_id tenant key to Appointment + DailyResult schemas.
- [x] Stamp manager_id on new appointments (manual form + Auto-Schedule).
- [x] Extend backfillRouteAssignments with an Appointment.manager_id pass and run it to completion.
- [x] Verify backfill via dry-run report and document deferred items.

### Review — Phase 2: Full Entity RLS Rollout
Eleven entities now enforce server-side RLS. Tenant entities (CanvasSession, ChatGroup, Appointment, DailyResult) use the same manager_id/created_by/team_manager_id/admin pattern as Phase 1; creator entities (FetchJob, RouteTemplate, TerritoryPlan, Referral) are scoped to their owner; backend-only entities (PipelineLock, LeadScoringWeights) are admin-locked since backend functions use the service role. New appointments are stamped with the team tenant key, and the throttled backfill stamped historical appointments. Deferred: MasterProperty RLS (shared dataset, migrating to Neon), TeamMessage read-scoping for group/DM channels (needs a participant_emails field + backfill), and the 15 legacy routes with unresolvable assignee names.

## Previous Plan — Canvas Opportunity Discovery Engine POC
- [x] Confirm Canvas-only scope: do not modify Precision mode, paid BatchData pull flow, Precision route generation, Billing, or existing field logging behavior.
- [x] Re-scope the POC around the core trust hypothesis: `Building Footprints - Excluded Land Use = Opportunities`; addresses are enrichment only, not a launch dependency.
- [x] Add Neon schema support for Canvas intelligence only: `building_footprints`, `land_use`, `canvas_analysis`, and `opportunities`; defer `addresses` to Phase 3 enrichment.
- [x] Create a Canvas-only setup/migration function that initializes those tables without changing existing property/territory tables.
- [x] Create `canvasAnalyzeTerritory` backend function: accept drawn polygon, query buildings inside polygon, query excluded land-use polygons, remove buildings inside excluded areas, save analysis, and return map-ready opportunity centroids plus excluded polygons.
- [x] Return explainable confidence buckets instead of one magic score: `high`, `medium`, `low`; for Phase 1 without addresses, discovered building opportunities are `low` or `medium` depending on land-use context.
- [x] Keep engineering coverage metrics in backend diagnostics only; primary manager UI shows Opportunities Found, Excluded Areas, confidence buckets, and visual map layers.
- [x] Create `canvasGetAnalysis` backend function for saved analysis retrieval by ID.
- [x] Create `canvasFeedback` backend function to store `looks_correct` / `looks_incorrect` feedback only; defer trust dashboard and analytics reporting.
- [x] Add a focused frontend Review Opportunities UI component that shows total opportunities, excluded breakdown, confidence buckets, and feedback buttons.
- [x] Add a Canvas opportunity heat/visibility layer: green dots for discovered opportunities and red overlays for excluded parks/schools/forests/water/commercial/industrial/golf areas.
- [x] Wire Canvas Builder workflow only: Draw Territory → Analyze Territory → Review Opportunities → existing Generate Zones → Assign Reps.
- [x] Feed discovered opportunity points into existing Canvas zone generation through the current `propertyPoints`/session bridge so H3/road cells with zero opportunities are dropped after analysis.
- [x] Preserve existing zone generation algorithms and only replace their input opportunity points for Canvas analyzed sessions; fallback estimates remain only when no analysis is available.
- [x] Verify backend functions with empty-data and sample-polygon tests, proving no Precision functions or tables are touched.
- [x] Verify frontend runtime for new import/build errors; logs show the pre-existing Home max-depth warning, not a new Canvas import/deploy error.
- [x] Document review results and known POC limitations before marking complete.

### Review — Canvas Opportunity Discovery Engine POC
Implemented the buildings-first Canvas trust layer without touching Precision: new Neon tables (`building_footprints`, `land_use`, `canvas_analysis`, `opportunities`), setup function, analysis retrieval, feedback, and territory analysis functions. The Canvas Builder now has a Review Opportunities step, stores manager feedback, renders green opportunity dots and red excluded-area overlays, and feeds analyzed building centroids into existing Canvas zone generation so analyzed cells with zero opportunities are removed instead of using density guesses. Backend verification passed for setup, self-tests, empty-data polygon analysis, saved analysis retrieval, and feedback; current limitation is that real opportunity counts require imported Microsoft Building Footprints and OSM land-use rows.

### Implementation boundaries
- Canvas-only: all new function names and UI components will use `canvas*` naming.
- No paid data providers, no Redis/cache infra, no microservices, no route sequencing, no Precision changes.
- Because `pages/Home` is oversized, avoid adding large logic there; integrate through existing focused Canvas components (`CanvasBuilderSettings`, `ManagerMapLayers`, `CanvasZoneLayers`) and new small components.
- Initial POC can support empty tables gracefully: it should return zero opportunities with a clear “building/land-use dataset not loaded” warning instead of failing.
- Addresses, trust dashboards, override analytics, rejected-analysis reporting, and KPI dashboards are deferred until after the buildings-first trust hypothesis is validated.

### Proposed build order
1. Buildings-first database foundation and setup function.
2. Canvas analysis/feedback backend functions using buildings + land-use exclusions only.
3. Review Opportunities UI plus green opportunity and red exclusion map layers.
4. Canvas Builder workflow gate before existing generation.
5. Phase 2 opportunity-point integration into existing Canvas zone generation.
6. Verification and review.

## Current Plan — Clean Builder Map While Preserving Saved Routes
- [x] Confirm scope: hide old saved route overlays only while Builder/draw mode is active; do not delete or modify SavedRoute records.
- [x] Keep route selection behavior intact: selecting an older route from the Routes panel still opens that route on the map.
- [x] Hide generated-route and previous-area overlays while Builder is active so the map feels blank for the new area.
- [x] Verify the overlay condition is limited to map rendering and document the result.

### Review — Clean Builder Map While Preserving Saved Routes
Builder mode now hides old saved-route overlays, generated route overview overlays, and previous drawn-area history overlays so drawing a new area starts from a visually clean map. SavedRoute records are not modified or deleted, and selecting an older route still displays that one route through the active route layer. Runtime review showed no new frontend build/import error; only unrelated websocket connection noise was present.

## Current Plan — Precision Pull Flow Simplification
- [x] Confirm scope: Precision Mode default pull flow should be simplified only; Canvas, route execution, BatchData caps, and backend ingestion logic stay unchanged.
- [x] Inspect current Precision area/pull controls and route builder filters to identify where home value range and sold-window controls already exist.
- [x] Design the default post-draw panel as: selected area summary, home value range, sold lookback, requested property count if still needed, and one primary Generate button.
- [x] Move less-common Precision options into an Advanced Settings section/drawer so the default flow feels simple for mail-style routes.
- [x] Wire Generate to the existing BatchData pull path using the selected area, sold lookback, and value filters without changing the 50/free and 1000/paid caps.
- [x] Verify the simplified UI renders without new errors and document the final behavior.

### Review — Precision Pull Flow Simplification
After drawing a Precision area, Pull Data now opens a simple Generate panel with only home value range and sold lookback as the default choices. Advanced settings are tucked away for max property count and clearing the area. Generate starts the existing BatchData pull with the same 50/free and 1000/paid caps, and the processor now rejects properties outside the selected value range before routing. Backend self-test and dry-run passed without spending BatchData credits; runtime logs showed no new frontend import/build error, only unrelated existing route-hydration rate-limit and PolygonHistory warnings.


## Current Plan — BatchData-Only Precision Cutover + Builder Draw Integration
- [x] Confirm cutover scope before implementation: Precision mode becomes BatchData-only; Canvas remains zero-BatchData door logging; RentCast is fully removed from active ingestion paths.
- [x] Freeze protected data first: run `batchDataMigrationAudit`, verify no active/pending FetchJobs, confirm Kevin/Reif protected routes and hashes, and create a backup/export function if the audit snapshot is not enough.
- [x] Replace `processFetchChunk` live behavior with a BatchData-only processor: no `RENTCAST_API_KEY`, no RentCast base URL, no `deed_records` or `listings_records` RentCast phases, no MLS gap-fill branch.
- [x] Keep the existing BatchData normalization and Neon write path, but make it the only path for `provider='batchdata'`, `phase='batchdata_precision'`, and any new Precision job.
- [x] Update `fetchAreaProperties` so any legacy Precision entry point creates a BatchData FetchJob from the drawn polygon instead of RentCast grid/sub-circles.
- [x] Keep `startBatchDataPull` as the primary new Builder draw flow; ensure it uses the freehand polygon, requested property cap, FIPS/county resolution, area caps, and immediately invokes the BatchData-only processor.
- [x] Update frontend Precision Builder copy/status only if needed so the user sees “Pull Data” with dynamic population from the drawn freehand area.
- [x] Verify with backend tests: sandbox preview, live BatchData job creation dry path, processor idle path, processor synthetic/dry-run completion, and audit safety gate.
- [x] Verify runtime logs after loading `/Home`; Home is over the edit limit, so fixed route hydration stability through the smaller helper and confirmed the BatchData processor self-test has `rentcast_active: false`.
- [x] Document final cutover results, remaining provider-account action items, and rollback notes in this plan review.

### Review — BatchData-Only Precision Cutover
Active Precision ingestion is now BatchData-only: `processFetchChunk` no longer uses RentCast phases/API paths, `fetchAreaProperties` creates BatchData polygon jobs, `startBatchDataPull` disables MLS/RentCast behavior, and the Precision draw flow still uses the same map/routing consumers through Neon-backed route candidates. Verification passed for processor self-test (`active_provider=batchdata`, `rentcast_active=false`), drawn-polygon dry run, BatchData preview, `startBatchDataPull` dry run, protected Kevin audit (`safe_to_migrate_now=true`, no active jobs, required routes intact), and a synthetic processor completion without spending credits or inserting fake houses. Legacy RentCast rows/secrets were not purged yet; cleanup should be a separate protected-data-safe pass after the first real BatchData account pull succeeds.

### Implementation notes
- Do not purge legacy RentCast rows yet during the switch; first cut active code paths, verify BatchData jobs populate Neon, then schedule cleanup separately with protected-route exclusions.
- Existing secrets already include `BATCH_DATA_API_KEY`, `BATCH_DATA_SANDBOX_KEY`, and `DATABASE_URL`, so no new secret is required unless BatchData issues new production credentials after contract signing.
- Biggest current code risk: `processFetchChunk` is still a large hybrid RentCast/BatchData function; the elegant cutover is to replace active behavior with a small BatchData-only path instead of trying to keep conditional legacy phases alive.

## Current Plan — Canvas Road-Aligned Generation Reimplementation
- [x] Start with runtime logs before code inspection because the feature is not working as expected.
- [x] Review lessons, current Canvas generator, builder flow, territory draw flow, and Home mounting path.
- [x] Identify root cause: road-aware generation is mostly local algorithm code, but the live Canvas flow has no reliable Overpass/OSM road fetch feeding `window.__fkCanvasRoadNetwork`, so it usually falls back to H3/grid.
- [x] Add a focused Overpass road-network helper module instead of expanding oversized `pages/Home`.
- [x] Fetch road geometry on confirmed drawn polygon / Canvas builder load, with timeout and safe fallback.
- [x] Pass road data into `generateCanvasZones()` through the existing session bridge without changing CanvasSession schema.
- [x] Repair the road face pipeline so it can produce usable zones from real OSM way/node JSON and fallback only when truly insufficient.
- [x] Add clear console/debug status for road-aligned vs fallback generation.
- [x] Verify Home loads and runtime logs show no new frontend errors.
- [x] Document the result in this plan review.

### Review — Canvas Road-Aligned Generation Reimplementation
Root cause was that Canvas had road-aware algorithm code, but the live builder flow was not reliably fetching Overpass/OSM road data into the existing session bridge before generating zones, so it kept falling back to density/H3 zones. Added a focused Overpass helper, wired Canvas Builder to fetch/cache road geometry for the active polygon, pass it into `generateCanvasZones()` without changing CanvasSession schema, exposed road-alignment status in the builder, and relaxed over-strict face validation that rejected usable real OSM graphs. `/Home` loads to the auth gate with no new frontend errors; remaining runtime logs are unrelated route hydration 429s.

## Current Plan — Canvas Source Zone Engine Replacement
- [x] Read the full request and current `components/logic/canvasZones` implementation before editing.
- [x] Preserve saved CanvasSession data and only change future generation behavior.
- [x] Replace road traversal with explicit half-edge clockwise-next planar face traversal.
- [x] Add density-weighted face door counting and region-growing assembly.
- [x] Add `runPostProcessing()` and call it on both road-aligned and fallback paths.
- [x] Keep zone output schema-identical by stripping private metadata before return.
- [x] Make only the existing CanvasBuilderSettings warning display support Pass C.
- [x] Verify `/Home` loads without new frontend errors and document results.

### Review — Canvas Source Zone Engine Replacement
Replaced future Canvas generation at the source with road-graph parsing, half-edge planar face traversal, density-weighted face counting, contiguous region-growing, shared post-processing, and safe fallback to the existing hex/H3 path. Runtime verification loaded `/Home` and logs showed no new frontend generator crash; remaining visible backend 429 logs are unrelated route hydration noise.

## Current Plan — Canvas Builder Map Constructor Crash
- [x] Verify runtime logs for the reported crash.
- [x] Identify root cause in `CanvasBuilderSettings`: the lucide `Map` icon import shadows the built-in JavaScript `Map` constructor.
- [x] Patch the icon import to `MapIcon` so assignment counting can safely use the built-in `new Map()` constructor.
- [x] Verify `/Home` loads after the patch; full Builder click verification is limited by the auth gate in preview, but the constructor shadow is removed at source.
- [x] Add a lesson to prevent icon/global name collisions.

### Review — Canvas Builder Map Constructor Crash
Fixed the crash by aliasing the lucide `Map` icon to `MapIcon`, which stops it from shadowing JavaScript’s built-in `Map` constructor in assignment warning and auto-assign logic.

## Current Plan — Canvas Permanent Operational Fixes
- [x] Enter plan mode and review `tasks/lessons.md` before coding.
- [x] Inspect `components/logic/canvasZones`, `components/map/CanvasBuilderSettings`, and current runtime logs.
- [x] Fix 1: add stricter road-aligned planar face generation with malformed OSM way skipping, face validation, door counting, contiguous region growth, and schema-identical output.
- [x] Fix 2: add local 8×8 density classification to dynamic H3 fallback while preserving the target doors-per-zone.
- [x] Fix 3: add post-generation clipped boundary zone merge/reindex behavior for zones under the 60% clip ratio.
- [x] Fix 4: snap drop points to nearest allowed OSM road node when road data exists, with geometric fallback when it does not.
- [x] Fix 5: prevent duplicate/overloaded rep auto-assignment and show inline amber roster warnings if validation detects overload.
- [x] Preserve CanvasSession schema, Deploy Campaign flow, rep-facing views, and existing fallback paths.
- [x] Verify `/Home` preview loads to the auth gate and runtime logs show no new frontend build/runtime error; only unrelated existing route-hydration 429 logs remain.

### Review — Canvas Permanent Operational Fixes
Implemented all five Canvas fixes in order across `canvasZones` and `CanvasBuilderSettings`: road-first generation with safe hex fallback, density-aware door estimates, clipped-zone cleanup, road-snapped drop points, and capped roster assignment with warnings. Full logged-in visual validation is still limited by the preview auth gate, but module load/runtime verification showed no new frontend errors.

## Current Plan — Canvas Mode Usability Refactor Changes 1–4
- [x] Confirm scope: deliver Changes 1–4 only; do not start Change 5 road-aligned generation without separate confirmation.
- [x] Change 1: update `components/map/CanvasZoneLayers` so labels show only for selected, 300ms-hovered, or sidebar-filtered zones; default map shows fills only.
- [x] Change 2: update `CanvasZoneLayers` + `CanvasBoundaryHandles` so adjustment handles render only for explicit edit-mode zone(s), separate from assignment selection.
- [x] Change 3: reduce zone fill semantics to one accent color for unassigned and desaturated gray for assigned; move rep differentiation to a small initials avatar dot.
- [x] Change 4: add a toolbar `Focus mode` toggle state/event and make Canvas overlays/sidebar respond with labels/handles hidden and sidebar collapsed to an icon rail.
- [x] Verify 79+ zone performance path with Home preview/logs and document modified files, state additions, dependencies, and before/after behavior.

## Previous Plan — Canvas Capacity, Drop Points, and Manual Boundary Adjustment
- [x] Confirm scope: fix Canvas-only zone math/rendering and add manual boundary adjustment without changing Precision routing/data pulls.
- [x] Recalibrate auto density so Anderson-sized suburban polygons do not default to Rural too early.
- [x] Make generated zones target `shift_hours × doors_per_hour × reps_per_zone` doors by sizing/grouping cells by capacity, not broad equal-area leftovers.
- [x] Keep displayed door counts near the target capacity per zone and expose any remainder only where geometry forces it.
- [x] Render one visible drop point pin per zone at that zone’s NW corner.
- [x] Add draggable white midpoint handles on shared zone boundaries.
- [x] On drag, snap the boundary to the nearest OSM road centerline within 100m, otherwise snap to the nearest 50m grid increment.
- [x] Move the shared boundary for the two adjacent zones together and update both door estimates live.
- [x] Verify Home desktop/mobile runtime, screenshots/logs, and document results.

## Previous Plan — Canvas Density Responsiveness + Canvas Nav Cleanup
- [x] Confirm scope: fix Canvas density behavior, Canvas-only bottom nav, door-count variation, and mobile builder layout without touching Precision data/routing flows.
- [x] Inspect current Canvas builder, zone algorithm, bottom map toolbar, runtime logs, and task history.
- [x] Change Canvas zone count from rep-count-only to capacity-based: estimated total doors ÷ target doors per zone, with rep count as the minimum.
- [x] Make density selector redraw zones immediately with visibly different zone counts/sizes and varied per-zone door estimates.
- [x] Replace Precision-style `Routes (count)` bottom action in Canvas mode with exactly `Canvas Builder | Live View | Deploy Campaign`.
- [x] Verify mobile Canvas builder behaves as a bottom sheet and does not crush the map at phone width.
- [x] Retry desktop preview capture, verify runtime logs, and document results.

## Previous Plan — Canvas Zone Coverage + Exact Count Fix
- [x] Confirm scope: fix Canvas subdivision coverage/count/labels without changing Precision or paid data flows.
- [x] Inspect current Canvas zone math, overlay rendering, task history, and runtime logs.
- [x] Replace aggressive edge-cell filtering with valid-clipped-polygon checks only.
- [x] Pad subdivision clip bounds by one full cell in every direction.
- [x] Recalculate every zone centroid from actual clipped vertices using the polygon centroid formula.
- [x] Guarantee exactly `ceil(repCount / repsPerZone)` zones by subdividing/merging generated clipped regions.
- [x] Fix Canvas zone rendering warnings and ensure labels/fills render for every clipped edge zone.
- [x] Verify runtime logs/preview and document results.

## Previous Plan — Canvas Sprint 1 Builder + Rep View Foundation
- [x] Confirm scope: responsive Canvas manager builder with capacity-based zones, assignment, local deploy/save, and rep-view foundation only.
- [x] Inspect existing Canvas builder, zone renderer, zone algorithm, Home integration, and RepHome route flow.
- [x] Replace pie-slice Canvas subdivision with density-aware rectangular grid zones clipped to the drawn polygon.
- [x] Update Canvas builder UI with campaign name, rep count, shift hours, doors/hour, reps/zone, density override, roster, assignment, save/load, deploy lock, and responsive layout.
- [x] Update Canvas map overlays to show zone labels, estimated doors, assigned reps/unassigned status, and drop-point pins.
- [x] Add localStorage-backed deployed Canvas campaign compatibility for the rep-side foundation without backend scope creep.
- [x] Re-plan around the oversized Home file by mounting Canvas zones through the smaller ManagerMapLayers component.
- [x] Add local rep-side Canvas field view: assigned zone boundary, tap-to-pin logging, and 7 outcomes saved locally.
- [x] Verify Home/Canvas runtime and document results.

## Previous Plan — Billing Card Order
- [x] Confirm the request: show Precision mode above Canvas mode on Billing.
- [x] Inspect the Billing card order.
- [x] Reorder only the visual card order; keep pricing and checkout behavior unchanged.
- [x] Verify the Billing page loads and document results.

## Previous Plan — Mobile Draw Checkmark Zoom Root Fix
- [x] Confirm from runtime logs that tapping the checkmark changes area state and re-renders map data.
- [x] Find all map camera fit/setView paths that can run after area confirmation.
- [x] Patch the shared Leaflet camera guard so draw confirmation suppresses fitBounds/setView/fly/pan camera changes.
- [x] Verify Home loads without new runtime errors and document results.

## Previous Plan — Mobile Draw Checkmark Zoom Fix
- [x] Confirm the issue path from runtime logs.
- [x] Inspect the draw confirm/checkmark and map fit suppression code.
- [x] Patch confirm so it stops touch/click propagation and suppresses all map fit/zoom behavior during confirmation.
- [x] Verify mobile /Home preview/runtime and document results.

## Previous Plan — Contact Mobile Scroll Fix
- [x] Identify why Contact cannot scroll inside the mobile app shell.
- [x] Change only the Contact page container so it owns vertical scrolling.
- [x] Verify /Contact on mobile and document results.

## Previous Plan — Combine Billing Mode Blocks
- [x] Combine the Canvas explanation card with the Canvas checkout card.
- [x] Combine the Precision explanation card with the Precision checkout card.
- [x] Keep pricing and checkout behavior unchanged.
- [x] Verify /Billing renders without new errors and document results.

## Previous Plan — Pricing + Property Input Fix
- [x] Update Billing to show Canvas at $19/rep/month.
- [x] Update Billing to show Precision at $99/user/month.
- [x] Make checkout use trusted backend pricing for Canvas and Precision instead of stale display-only prices.
- [x] Fix Custom Area Active property input so users can clear the field and type a new number.
- [x] Verify the touched screens/logs and document results.

## Previous Plan — BatchData Pull Button
- [x] Change the selected-area action from Sandbox Preview to Pull Data.
- [x] Wire Pull Data directly to the BatchData pull flow.
- [x] Remove the duplicate Start Paid Pull button from this control.

## Previous Plan — Mobile Selected Area Controls Polish
- [x] Convert the selected-area control from a cramped mobile pill into a readable mobile card.
- [x] Keep desktop selected-area controls unchanged.
- [x] Verify the mobile preview layout.

## Previous Plan — Mobile Draw Confirm/Pull Fix
- [x] Diagnose why mobile stays in Freehand draw mode after the area is visible.
- [x] Add a clear mobile-friendly checkmark/confirm action once enough points are drawn.
- [x] Make confirmed areas exit drawing mode and return to the data pull/preview controls.
- [x] Verify mobile preview/runtime and document the result.

## Previous Plan — Mobile/Tablet Freehand Drawing Fix
- [x] Confirm root cause without changing desktop drawing behavior.
- [x] Add a mobile/tablet-safe touch/pointer drawing path that converts finger position into map coordinates.
- [x] Disable map pan/zoom gestures only while drawing mode is active, then restore them cleanly.
- [x] Verify mobile preview/runtime and document the result.

## Previous Plan — Move Mode Toggle Into Map Settings
- [x] Remove Canvas/Precision, Eye, and filter/settings action buttons from the mobile top row so Routes/Builder stays clean.
- [x] Add Canvas/Precision mode control inside Map Settings near Overlays.
- [x] Keep desktop/tablet controls usable without changing map behavior.
- [x] Verify mobile preview/runtime after the change and document the result.

## Previous Plan — Mobile Mode Toggle Overlap Fix
- [x] Move the Canvas/Precision toggle out of the top mobile row so it cannot overlap Routes/Builder.
- [x] Keep tablet/desktop behavior clean with the toggle on the right side where there is enough room.
- [x] Preserve existing mode-switch behavior and active colors.
- [x] Verify mobile preview/runtime after the change and document the result.

## Previous Plan — Hide Canvas UI in Precision + Mobile/Tablet Toggle Fit
- [x] Hide Canvas map overlays while `routeMode === 'precision'`.
- [x] Keep Canvas UI visible only when Canvas mode is active; do not change Precision route/data-pull behavior.
- [x] Refactor the Canvas/Precision top-bar toggle into a compact responsive layout that fits mobile/tablet without overlapping Routes/Builder or right-side controls.
- [x] Use icon-only or short labels on narrow widths and full labels on desktop/tablet widths where safe.
- [x] Verify Home runtime logs after the UI change and document the result.

## Previous Plan — Move Canvas/Precision Toggle to Top Bar
- [x] Move the existing Canvas/Precision mode buttons into the main top toolbar on mobile and desktop.
- [x] Remove the separate second-row Canvas/Precision pill under Routes/Builder.
- [x] Keep existing mode-switch behavior, icons, and active-state colors unchanged; use compact CAN/PRE labels only on mobile to fit the top bar.
- [x] Verify the Home runtime does not show a new UI/build error after the move.

## Previous Plan — Canvas Zone Visual Split Bug
- [x] Diagnose why Canvas Deploy saves assignments but does not render split zones on the map.
- [x] Fix the render loop warning by using stable empty query defaults in the Canvas panel.
- [x] Generate simple zone polygon geometry client-side from the drawn territory and rep count.
- [x] Render the split zones directly in the map interface during Canvas planning/deploy via the existing map draw tool, avoiding further Home growth.
- [x] Persist zone geometry in CanvasSession so deployed territories can be reloaded visually.
- [ ] Verify in runtime logs that the render loop is gone and no new map errors appear.

## Previous Plan — Canvas Builder MVP
- [x] Replace the Canvas builder panel with a Canvas-only workflow: draw/redraw territory, session name, rep count, auto zones, assignment, auto-assign, deploy, and save territory.
- [x] Keep Precision builder controls exactly where they are and only show them in Precision Mode.
- [x] Avoid sold filters, data-pull controls, route-size controls, routing behavior, and templates in Canvas Mode.
- [x] Verify Canvas mode renders without build/runtime errors and document the result.
- Re-plan: Home is now over the safe edit limit, so saved-territory loading stores the polygon and refreshes the map instead of adding another Home listener.

## Previous Plan — Canvas Mode + Precision Pricing Split
- [x] Confirm pricing copy before implementation: Canvas Mode is priced per rep, while Precision Mode should show a remaining property-usage counter.
- [x] Add a clear app-level mode indicator on Home so users always know whether they are in Canvas or Precision.
  - Re-plan: direct Home edits are blocked by file size, so mode state/tagging was handled in smaller shared components/helpers via localStorage and route-generation helpers.
- [x] Add Canvas as a separate Builder mode while reusing the existing route-builder flow, route save flow, assignment flow, Route Command panel, Knock tab, and Checklist tab.
- [x] Keep Precision tied to paid BatchData property acquisition; keep Canvas optimized for high-volume door-knocking teams without requiring paid BatchData pulls.
- [x] Tag newly created Canvas routes distinctly so managers/reps can understand which mode produced them without breaking existing saved routes.
- [x] Make Knock and Checklist stay on the same route/order/status frequency by sharing the selected route ID, reacting to SavedRoute updates, and refreshing route/log data automatically when switching tabs.
  - Re-plan: 5-second polling caused rate-limit risk; kept SavedRoute/InteractionLog subscriptions plus focus refetch instead of constant polling.
- [x] Update Billing copy/cards to explain Canvas vs Precision, pricing intent, what each includes, and when a customer should choose each.
- [x] Verify with runtime logs/backend tests: Canvas mode backend route naming works, no new frontend compile error appeared in runtime logs, and aggressive polling was removed after detecting 429 risk.
- [x] Document final results in Review before marking complete.

## Current Plan — Freehand Save + Paid BatchData Pull
- [x] Diagnose why a fresh freehand drawing disappears instead of staying active.
- [x] Fix only stale restored polygon cleanup so newly drawn shapes are not cleared.
- [x] Confirm sandbox approval does not populate properties by design; it only validates/estimates.
- [x] Inspect the existing BatchData processor branch before wiring a paid pull button.
- [x] Add a clear paid-pull action after sandbox approval that creates a real FetchJob.
- [x] Verify backend and runtime behavior, then document results.

## Previous Plan — Queried Area History Cleanup
- [x] Stop saving drawn polygons as previous areas until a sandbox preview/query succeeds.
- [x] Keep unqueried draft/current shapes from appearing as ghost history on the map.
- [x] Add a trash control on previous areas so users can delete one saved area without clearing all history.
- [x] Re-plan around the Home file size limit by moving stale polygon cleanup into TerritoryPrompt.
- [x] Verify the touched map flow and document the result.

## Current Plan — Freehand BatchData Preview + RentCast Removal
- [x] Confirm scope before implementation: this phase should not spend paid BatchData credits; it should replace the old circle/square preset UI with freehand drawing plus a property-count/limit preview.
- [x] Define the UX: user taps Draw, freehands a polygon, then chooses requested property count after the area is drawn.
- [x] Remove the visible Circle/Square and 5/40/300 sq mi controls from the Builder draw prompt.
- [x] Add requested-property controls capped by account type: free users max 50, paid/admin users max 1000.
- [x] Enforce the same caps server-side, never trusting the frontend.
- [x] Add hard oversized-area protection before any BatchData call: reject massive polygons by area/bounding size and show a clear redraw message.
- [x] Update preview behavior to return safe metadata: area, max allowed properties, requested properties, eligibility/rejection reason, and estimated/property cap without charging BatchData.
- [x] Keep actual paid BatchData pulling disabled for now; do not wire live paid BatchData record retrieval until explicitly approved.
- [x] Verify with backend tests for free cap, paid cap, oversized area rejection, and no active RentCast processor usage.
- [x] Document results in this Review section before marking complete.

## Previous Plan — BatchData-Only Migration + Phase 1 Gate
- [x] Confirm no implementation starts until this plan is approved: Phase 1 BatchData Precision must be correct before Canvas/Phase 2 work begins.
- [x] Inventory every RentCast dependency: `processFetchChunk`, `fetchAreaProperties`, `routeFilterPipeline`, Neon schema, route generation, saved route hydration, analytics, diagnostics/test functions, docs, env vars, and UI labels.
- [ ] Freeze/preserve Kevin data first: export Kevin/Reif Environmental user, team member, saved routes, route hashes, interaction logs, workspace property links, and raw property records before any purge or migration.
  - Resolved: original safety audit used the plural typo `kevin@reifenvironmentals.com`; correct protected account is `kevin@reifenvironmental.com`.
  - Confirmed protected: Upper Mount P, Middle Mount P, and Lower Mount P are ACTIVE, assigned to Kevin Reif, and included in the migration audit must-keep list before any purge or cutover.
- [ ] Build a purge plan that removes false-positive legacy RentCast/MLS-derived records while protecting Kevin’s saved routes, knocked history, and any records still referenced by SavedRoute/InteractionLog.
- [ ] Define Phase 1 vs Phase 2 semantics in-app: Phase 1 = BatchData deed-confirmed Precision data pull; Phase 2 = Canvas Mode GPS door logging with zero BatchData dependency.
- [ ] Replace RentCast Phase 1 completely: BatchData county/FIPS-based property search, BatchData field normalization, `data_source='batchdata'`, listing/deed/owner mapping, active-listing suppression, owner-occupied filtering, corporate/investor filtering, SFR filtering, and sold-window filtering.
  - In progress: added a guarded `provider='batchdata'` / `phase='batchdata_precision'` processor branch with BatchData normalization and route-active rejection rules; not yet wired as the default live pull path.
- [ ] Remove old RentCast Phase 2 MLS gap-fill from the Precision pipeline; no MLS/listing-only route candidates should survive unless they come from BatchData fields and pass the same proof filters.
- [ ] Update `FetchJob` model for BatchData: keep polygon input for now only as the selected area boundary, add/confirm `fips_code`, `area_sq_mi`, `polygon_hash`, `provider`, `mode_tag`, estimated record count, estimated cost, and dry-run metadata.
- [ ] Replace radius/sub-circle mechanics with freehand-area mechanics: compute area, centroid, county/FIPS coverage, hash, and hard reject oversized areas instead of clipping or silently expanding.
- [x] Add a no-cost dry-run path for custom/freehand draws: user can draw, see square miles, counties/FIPS, estimated BatchData request size/cost, and allowed limits without creating a paid FetchJob or consuming records.
- [x] Solve “whole continental US” risk: server-side area caps, county-count caps, estimated-record caps, monthly credit caps, hard rejection before API calls, and clear user messaging.
- [x] Build the cost model: BatchData base plan, per-record/overage assumptions, deed/listing/owner add-on costs, dry-run vs paid pull behavior, gross margin at $99 Precision, and separate Canvas $19/rep zero-BatchData model.
- [x] Validate BatchData API response shape safely using sandbox/test calls first: capture representative raw payloads, map every field to existing app fields, and document fields that no longer exist or need fallback.
  - Verified: `setupNeonPropertyTables` added BatchData columns/indexes; `validateBatchDataShape` sandbox probe returned 3 records and mapped expected fields. Sandbox data is synthetic, but response shape is usable.
- [ ] Add migration verification: compare BatchData candidates against known-good Kevin/current routes, check route counts before/after, confirm no saved route hydrates to fewer houses, and prove false-positive RentCast records are excluded.
- [ ] Only after Phase 1 passes: begin Canvas design around mode switch, freehand draw, rep zones, GPS door logs, offline queue, and manager heatmap with no BatchData calls.
- [ ] Final cutover gate: disable RentCast env/use paths, remove RentCast UI/docs language, run runtime logs, run backend tests, confirm active jobs are idle, and document review before purging legacy data.

## Previous Plan — Builder Single Shape + Square Area Fix
- [x] Trace how Builder places circle/square territory polygons from map taps.
- [x] Ensure each new placement replaces the existing draft/confirmed territory instead of accumulating multiple circles.
- [x] Correct square dimensions so 40 and 300 square-mile selections create true area-sized squares.
- [x] Verify runtime logs and document the result.

## Previous Plan — Persist Incomplete Import Dismiss
- [x] Identify why the incomplete import prompt reappears after dismiss.
- [x] Remember dismissed failed import jobs locally by job ID.
- [x] Keep Retry behavior unchanged for users who choose to resume.

## Previous Plan — Compact Territory Drawing Prompt
- [x] Move the drawing prompt away from the center of the map.
- [x] Reformat controls into a smaller horizontal layout.
- [x] Reduce panel height/visual weight so the 300 sq mile circle remains visible.

## Previous Plan — Rep Map Close Button Responsiveness
- [x] Make the map close button respond immediately on press instead of waiting for click delay.
- [x] Stop map touch events from stealing the close button tap.
- [x] Slightly enlarge the button for easier mobile tapping.

## Previous Plan — Property Detail Close Button
- [x] Increase the close button tap target so it is easier to click on mobile.

## Previous Plan — Knock Tab Black Header Seam
- [x] Remove the faint divider line under the FirstKnock app header on the Knock tab.
- [x] Normalize the Knock tab top/background blacks so the screen reads as mostly black.
- [x] Verify with runtime logs and document the result.

## Previous Plan — Route Tab Account/Route Handoff
- [x] Persist the currently active manager route before the user opens the Knock/Route tab.
- [x] Prevent stale selected route IDs from another account from being accepted in RepHome.
- [ ] Stop Home route hydration from setting equivalent state repeatedly and triggering the maximum-update-depth loop after splitting Home.
- [x] Verify runtime logs and document the result.

### Re-plan note
- Direct Home edits are blocked because the page has grown past the safe edit limit, so the account/route handoff fix is being applied through smaller components first.

## Previous Plan — About Scroll + Contact Email
- [x] Fix the About page container so the full page can scroll inside the app shell.
- [x] Replace the Contact page support email with firstknockhelp@gmail.com in both the visible text and mail link.
- [x] Verify runtime logs and document the result.

## Previous Plan — Faster FirstKnock Map Zoom Range
- [x] Increase zoom step distance so each pinch/two-finger zoom changes more area.
- [x] Preserve the smoother zoom animation/tile behavior from the previous tuning.
- [x] Verify runtime logs and document the result.

## Previous Plan — Smooth FirstKnock Map Zoom
- [x] Tune only the Rep FirstKnock map zoom settings.
- [x] Smooth pinch/wheel zoom without changing pins, route order, GPS, or selection behavior.
- [x] Verify runtime logs and document the result.

## Previous Plan — FirstKnock Map Zoom Snap
- [x] Trace the View on FirstKnock Map handoff from property detail into the map overlay.
- [x] Identify which map effect is re-centering or refitting after user zoom.
- [x] Make the FirstKnock map support safe over-zooming instead of snapping back at the default tile limit.
- [x] Verify runtime logs and document the result.

## Previous Plan — Rep Performance Graph Overflow
- [x] Keep the performance trend chart inside its card on narrow/mobile app views.
- [x] Tighten chart margins and axis widths so Knocks and Conv % labels do not clip or overflow.
- [x] Keep chart data numeric and readable without changing the underlying metrics.
- [x] Verify runtime logs and document the result.

## Previous Plan — Builder Tap-to-Select Zoom Guard
- [x] Trace the tap-to-confirm/select area viewport behavior.
- [x] Prevent confirmed-area selection from fitting to oversized bounds or zooming out.
- [x] Keep the confirmed area visible without changing the user’s current zoom level.
- [x] Re-plan around Home file size limit by guarding Leaflet fit calls in a smaller map helper.
- [x] Verify runtime logs and document the result.

## Previous Plan — Builder Custom Area Active Bar
- [x] Make the Custom Area Active toolbar fit within mobile width without clipping.
- [x] Keep the data pull and fill-gaps actions readable/tappable on phones.
- [x] Stop Builder from re-entering area redraw/confirm mode when a confirmed area already exists.
- [x] Verify runtime logs and document the result.

## Previous Plan — Optimize Button Must Not Zoom Map
- [x] Trace the optimize button, re-optimize handler, and map fit controller.
- [x] Prevent mobile/tablet pointer/touch bubbling from reaching Leaflet map gestures.
- [x] Add a short no-fit guard around re-optimization so route-order updates cannot trigger map fit/zoom.
- [x] Verify runtime logs and document the result.

### Re-plan note
- Direct Home edits were blocked because the file is over the safe edit limit, so the fix was localized to the optimize button and shared map controller instead of expanding the oversized Home page.

## Previous Plan — Mobile FirstKnock Map Zoom/Tap Responsiveness
- [x] Remove the React Fragment warning that is spamming one warning per pin render.
- [x] Move dense route/pin/GPS vector drawing onto Leaflet canvas to reduce SVG DOM work during zoom.
- [x] Tune the mobile map and tile layer animation settings for smoother pinch zoom.
- [x] Make map buttons and invisible pin targets more responsive to thumb taps.
- [x] Verify runtime logs after the responsiveness changes and document the result.

## Previous Plan — Mobile FirstKnock Map Performance
- [x] Remove always-on house number labels from every pin and show the label only when a pin is tapped.
- [x] Decouple live GPS updates so the property pin layer does not redraw on every location heartbeat.
- [x] Use a single active tile layer instead of stacking satellite plus labels on mobile route view.
- [x] Add an invisible thumb-sized hit area around each pin while keeping the visible pin size unchanged.
- [x] Verify runtime logs after the map changes and document the result.

- [x] Inspect current map settings, data status/settings, checklist navigation, and knock tab navigation preference usage.
- [x] Identify why Apple/Google Maps preference is not consistently applied in both checklist and knock flows.
- [x] Remove the unwanted builder auto-build/generate behavior from map/settings controls.
- [x] Clean up data/map settings labels and controls with minimal UI changes.
- [x] Verify runtime logs show no new errors after changes.

## Current Plan — Cancel Active Data Import
- [x] Locate the data import progress UI and active FetchJob polling flow.
- [x] Add a backend cancel function that marks the current user's active job as cancelled and releases job locks.
- [x] Make the chunk processor respect cancelled jobs before writing/scheduling more work.
- [x] Add a Cancel button to the import overlay and stop polling locally after cancellation.
- [x] Verify status flow and document the result.

## Current Plan — Map/Builder + Mobile Route Command Bugs
- [x] Prevent the bottom Map tab from opening or leaving open Builder/Generate panels.
- [x] Keep the Route Command “New Routes” tab from auto-opening unless Builder mode is active.
- [x] Fix Route Command mobile width/overflow so cards and headers stay inside the screen.
- [x] Stop mobile close/X taps from bubbling into map gestures that trigger the zoom bug.
- [x] Verify touched UI paths and document the result.

## Current Plan — Merge Mode Mobile Polish
- [x] Keep the section arrow visible when Select to Merge is active on mobile.
- [x] Make merge checkboxes easier to see/tap on mobile.
- [x] Slightly reduce route card height across Route Command screens.
- [x] Verify runtime logs after the UI polish.

## Previous Plan — Route Command Mobile Optimization
- [x] Make the Route Command shell/header mobile-safe without changing route behavior.
- [x] Reflow the Active/Queued header actions so Delete All and merge controls stay visible on small screens.
- [x] Reflow Queued route cards so route count/status/actions stay inside the viewport.
- [x] Verify runtime logs after the layout changes and document the result.

## Current Plan — Knock/Checklist Decision Sync
- [x] Make Knock and Checklist use the same latest-decision status logic.
- [x] Fix No Answer so it counts as done immediately on mobile.
- [x] Add a Done decision filter beside the sale-date filter.
- [x] Add a clear-decision action from the property history so a home returns to Todo.
- [x] Persist the selected Knock route so reps with multiple routes stay on the same county/route context.
- [x] Verify the touched flow and document the result.

## Current Plan — Kevin Optimize Keeps Houses
- [x] Fix Optimize so it preserves the already-loaded optimized properties instead of rebuilding from possibly-empty Home territory data.
- [x] Keep saved `property_hashes`, metrics, active route properties, checklist, and map in one order after Optimize.
- [x] Verify Kevin’s selected route still loads all 64 houses; runtime still shows the separate Home render-loop warning to refactor next.

## Previous Plan — Kevin Route Alignment
- [x] Trace Kevin route rendering across map, checklist, knock, and optimize.
- [x] Identify why map first stop can differ from checklist/knock and why optimize can empty homes.
- [x] Patch the stale shared route hydration cache so refreshed saved route orders are not served stale.
- [x] Patch already-hydrated route ordering so map/checklist/optimize receive the same SavedRoute order.
- [x] Verify the selected Kevin route still loads all 64/64 properties; remaining runtime errors are Base44 rate-limit responses, not route-order code errors.

## Previous Plan — Checklist/Knock Route Order Sync
- [x] Document the suspected root cause and planned handling method.
- [x] Stop Knock from locally reordering a saved route after Checklist/Optimize has saved a new order.
- [x] Add route-update synchronization so Knock refetches when the selected SavedRoute changes.
- [x] Make Knock property hydration react to route order changes, not just route length.
- [x] Add Checklist-side latest SavedRoute order sync so it does not depend on stale Home activeRoute state.
- [x] Verify both sides preserve the same route order source of truth.
- [ ] Separately refactor the oversized Home page before patching the unrelated Home render-loop warning.

## Current Plan — Change 5 Road-Aligned Generation Implementation
- [x] Confirm implementation scope: prefetch Overpass in Home, defer/fallback in CanvasBuilderSettings, pure road-aligned branch in canvasZones; no schema changes.
- [ ] File 1 — `pages/Home`: blocked by file-size edit limit; re-plan required before implementation.
  - Re-plan: avoid touching oversized `pages/Home` by using the already-mounted smaller draw/Canvas components plus a session-only shared road-network cache module.
- [ ] File 2 — `components/map/CanvasBuilderSettings`: accept `roadNetworkRef`, add 3s road-ready defer with inline “Aligning to roads…” status, then fall back to grid.
- [ ] File 3 — `components/logic/canvasZones`: add optional `roadNetwork` parameter, road-loop zone attempt, and untouched grid fallback.
- [ ] Verify Home runtime/preview and document results.
- [ ] Keep CanvasSession schema and Deploy Campaign flow untouched.

## Current Plan — Dynamic Door-Aware Canvas Subdivision
- [x] Confirm problem: static square subdivisions are still visible and create undesirable/empty walking regions.
- [x] Analyze the attached technical decision matrix at a high level and extract the useful direction: door-aware dynamic regions, avoid empty cells, H3/density hybrid as the practical fallback, and road/block alignment as an enhancement rather than the only path.
- [x] Verify the current Canvas generation call path so we know whether road-aligned generation is failing, not receiving `roadNetwork`, or falling back to grid by design.
- [x] Inspect the current available property/door data source for Canvas mode: Home already has `effectiveProperties`, but direct Home edits are blocked by file size.
- [x] Re-plan around the oversized Home file by exposing current property points from `ManagerMapLayers` through a session-only window bridge consumed by `CanvasBuilderSettings`.
- [x] Design the smallest safe algorithm change in `components/logic/canvasZones`: replace the static square fallback with dynamic populated-region generation that clips to the drawn polygon and drops empty/no-door regions.
- [x] Prefer H3 hex cells when usable because `h3-js` is already installed; otherwise use the existing polygon clipping helpers without adding packages.
- [x] Group only populated cells/regions into zones by target door count and proximity so reps receive contiguous, walkable assignments instead of equal-area squares.
- [x] Preserve the current zone object schema exactly and keep CanvasSession / Deploy Campaign untouched.
- [x] Keep fallback behavior safe: if no property/door data exists, generate dynamic clipped regions from density estimates but do not show phantom regions outside the drawn polygon.
- [x] Verify runtime logs for new import/build errors; no new Canvas/H3 import error appeared. Visual preview was auth-gated at the sign-in screen, so full logged-in map verification still needs an authenticated preview pass.

### Review — Dynamic Door-Aware Canvas Subdivision
Implemented a dynamic H3-based Canvas fallback that replaces the old static rectangular subdivision before the legacy grid safety fallback. It clips generated cells to the drawn polygon, uses existing property points when available to drop empty/no-door cells, groups nearby populated cells toward the target door count, preserves the existing zone object schema, keeps CanvasSession and Deploy Campaign untouched, and routes property points through a session-only bridge from `ManagerMapLayers` because `pages/Home` is over the safe edit limit. Runtime logs showed no new Canvas/H3 import error; the available screenshot was auth-gated at sign-in, so visual logged-in verification remains the next check.

## Review
Canvas Mode usability Changes 1–4 are complete without touching schema, Deploy Campaign, rep-facing views, or road-generation logic. Labels now render only for selected/hovered/filtered zones, boundary handles render only in explicit zone edit mode, zone colors are reduced to unassigned accent vs assigned gray with rep initials dots, and toolbar Focus mode hides labels/handles while collapsing the builder sidebar to an icon rail; Home preview loaded and runtime logs showed no new frontend errors, only unrelated existing backend rate-limit/job noise.

Canvas capacity cleanup is complete: auto density now keeps Anderson-sized territories in Suburban instead of jumping to Rural, seed cells are smaller and grouped around the target shift capacity, every zone carries target/density metadata, every zone gets a visible NW drop pin, and shared-boundary midpoint handles can be dragged with OSM-road snapping or 50m grid fallback while adjacent zone door estimates update. Desktop and mobile Home previews loaded; runtime logs show only unrelated existing BatchData insufficient-balance processor noise.

Canvas density refinement is complete: zone count now uses capacity math from estimated doors ÷ doors-per-zone with rep count as the floor, so Urban/Suburban/Rural changes redraw the grid with different zone counts/sizes and varied door estimates. Canvas mode bottom nav now shows Canvas Builder, Live View, and Deploy Campaign only; desktop and mobile previews loaded, and runtime logs show only unrelated existing BatchData insufficient-balance processor noise.

Canvas zone subdivision now uses padded full-boundary clipping, keeps all valid edge overlaps, removes the old 20% discard threshold, groups clipped cells into exactly the requested zone count, and renders every zone part with a color plus centroid label/door estimate. Home preview loaded; remaining logs are unrelated existing BatchData/rate-limit noise.

Canvas Sprint 1 is now client-side and demo-ready: responsive manager builder, capacity/density-based grid zones, roster assignment, local save/deploy locking, map zone/drop-point overlays, and a local rep field view with tap-to-pin logging. Home preview loaded and runtime logs showed no new frontend errors.

Billing now renders Precision Mode before Canvas Mode while keeping all pricing and checkout behavior unchanged. Mobile Billing preview was captured; runtime logs showed only unrelated existing Home/import messages.

Root fix: mobile/tablet draw confirmation now suppresses all Leaflet camera methods (`fitBounds`, `setView`, fly/pan variants) for 8 seconds after draw/confirm, preventing state-driven re-renders from massively zooming the map out. Mobile Home preview loaded; runtime logs showed no new frontend errors, only unrelated existing rate-limit/BatchData balance messages.

Previous fix: mobile/tablet draw confirmation blocks map touch propagation and confirms on pointer release so tapping the green checkmark does not pass the tap through to the map.

Contact now uses a fixed-height touch scroll container with extra bottom padding, so the mobile /Contact page can scroll inside the app shell without the bottom navigation blocking content. Mobile preview loaded successfully; runtime logs showed only unrelated existing Home activity.

Billing now shows only two plan cards: one combined Canvas Mode card and one combined Precision Mode card, preserving the existing prices, trial/pay buttons, active-rep billing count, and precision usage meter. Desktop preview loaded successfully; runtime logs only showed unrelated existing Home route-hydration rate-limit noise.

Billing now displays Canvas at $19/rep/month and Precision at $99/user/month, checkout creates trusted Stripe monthly prices for those plans, and the Custom Area property input can be cleared before typing a new number. Backend checkout tests passed for Canvas and Precision; runtime logs only showed unrelated existing import/rate-limit noise.

The selected-area controls now render as a readable stacked mobile card with larger touch targets and inline helper text, while preserving the compact desktop pill layout; mobile preview loaded and existing runtime logs only show unrelated BatchData balance/rate-limit noise.

Mobile drawing now shows a green checkmark once the outline has enough points; tapping it confirms the area, exits draw mode, and reveals the Sandbox Preview / Start Paid Pull controls. Desktop still auto-confirms on mouse release, and mobile preview loaded without new frontend drawing errors; existing logs still show unrelated BatchData balance/rate-limit noise.

Mobile/tablet freehand drawing now uses direct pointer/touch listeners on the map container, converts finger position to Leaflet coordinates, and temporarily disables map pan/zoom gestures only while drawing; mobile and tablet previews loaded with no new frontend drawing errors, while logs still show unrelated BatchData balance/rate-limit noise.

The mobile top bar is now clean: Canvas/Precision moved into Map Settings under Overlays, and the Eye/filter action buttons are hidden on mobile so they no longer sit over Routes/Builder; mobile preview was captured and runtime showed only existing rate-limit noise.

Mobile overlap is fixed by moving the Canvas/Precision toggle to its own centered mobile row while keeping it in the right-side toolbar on larger screens; mobile preview was captured and runtime showed only the pre-existing Home render-loop warning.

Precision mode now hides Canvas zone overlays, the Canvas/Precision switch is extracted into a compact responsive control for mobile/tablet/desktop, and runtime logs showed no new frontend errors after the change.

Canvas/Precision mode buttons were moved into the existing top toolbar on mobile and desktop, the old second-row pill under Routes/Builder was removed, and runtime logs showed no new frontend errors after the change.

Canvas Builder now uses a dedicated Canvas-only panel: draw/redraw territory, optional session name, rep count, auto-created numbered zones, per-zone rep assignment, one-tap auto-assign, Save Territory, and Deploy. Precision-only controls are no longer shown in Canvas Mode; Precision keeps the existing sold/data/filter/route builder. Runtime logs after the change showed no new frontend import/build errors. Saved territory loading is handled through persisted polygon state because Home has exceeded the safe edit limit and should be split before adding more listeners.

Canvas/Precision split is now visible in the map toolbar, Canvas opens the existing route builder without requiring a paid data pull, Precision still routes users through area preview/paid pull, Canvas routes are visibly named as Canvas routes, Billing now explains Canvas per-rep pricing and Precision property-credit usage with a remaining-property counter, and Knock/Checklist sync keeps subscriptions/focus refresh without aggressive polling. Backend verification confirmed Canvas route naming in `generateRoutesBackend`; runtime review showed no new frontend compile errors, the detected 429 risk from polling was removed, and the actual `components/billing/PricingModeCard.jsx` file was created so Billing can resolve the component during build.

Freehand drawing now stays active after drawing because stale localStorage cleanup only clears actual restored stale polygons, not fresh in-memory drawings. Sandbox Preview is clarified as validation-only and does not populate properties; after approval, a new Start Paid Pull button creates a real BatchData FetchJob and starts polling. Backend verification passed for `previewBatchDataArea` and `startBatchDataPull` dry-run without spending paid credits.

Previous areas now only persist after a successful sandbox preview/query, old unqueried local history is filtered out, selecting prior queried areas still works, and each previous area now has its own red trash button for deletion. Verification caught and fixed one JSX typo; remaining runtime logs show unrelated Base44 rate-limit noise from route hydration, not this map-history change.

Freehand BatchData sandbox preview is wired: Builder draw now uses freehand drawing, the area toolbar accepts requested property count, free accounts are capped at 50, paid/admin at 1000, oversized areas are rejected server-side, paid pulls remain disabled, and sandbox probe returned 3 records with no app data changes. Backend verification passed for free cap, paid cap, continental-US rejection, sandbox key probe, and Kevin/Reif protected route audit.

BatchData migration continued safely: added a no-cost area/cost preview, migration audit, sandbox BatchData shape probe, BatchData Neon columns/indexes, and a guarded BatchData Precision processor branch. Verified `setupNeonPropertyTables`, `validateBatchDataShape`, `processFetchChunk` idle mode, and Kevin/Reif Environmental audit; Upper/Middle/Lower Mount P remain protected under `kevin@reifenvironmental.com`, and no destructive purge/cutover has run.

Builder drawing now keeps only one active territory shape at a time, hides previous territory history while drawing, and squares now use true 40/300 square-mile side lengths instead of the broken sizing.

Dismiss now remembers the specific incomplete import job, so that recovery popup will stay hidden after you dismiss it while Retry still works normally.

The territory drawing prompt is now a smaller top-left horizontal bar with compact controls, so it covers much less of the 300 sq mile circle while keeping the same actions available.

The Rep map close button now responds immediately on press, stops the tap from reaching the map underneath, and has a slightly larger mobile tap target for smoother closing after the map loads.

Knock tab visuals are now mostly black: the FirstKnock header uses a black background with no visible divider on RepHome, and the RepHome shell, filter bar, and list area now use black backgrounds to remove the mismatched dark hues.

The Route/Knock handoff now saves the active route from the map toolbar and RepHome rejects stale selected route IDs that do not belong to the current account, so tapping the route tab should no longer appear to switch/log out of the email. The remaining Home render-loop warning still needs the already-planned Home page split because direct Home edits are blocked by file size.

About now uses a full-height scroll container with extra bottom padding so content is not cut off behind the app shell, and Contact now shows and links to firstknockhelp@gmail.com.

FirstKnock map zoom now covers more distance per gesture by increasing zoom delta and making wheel/pinch input more responsive while keeping the smoother animation and tile buffering intact.

FirstKnock map zoom now feels smoother by using smaller zoom increments, faster wheel/pinch response, enabled zoom animation, and live tile updates with a larger tile buffer; no route, pin, GPS, or selection logic was changed.

FirstKnock map zoom snap is fixed by raising the RepMapView max zoom and allowing satellite tiles to over-zoom past their native limit, so pinching in after “View on FirstKnock Map” no longer gets forced back out by the tile zoom cap.

Rep Performance graph is now mobile-safe: the chart card clips overflow, uses tighter margins and fixed axis widths, shortens date labels, formats Conv % cleanly, and keeps lines readable without changing the underlying metrics.

Mobile ROUTES/BUILDER toggle is slightly larger with improved touch padding and a max-width guard so it stays centered without overlapping side icons.

Builder tap-to-select now preserves the current zoom: area confirmation activates the map-fit suppression guard before saving state, pans to the selected area center at the existing zoom, and a shared Leaflet fitBounds guard ignores any programmatic fit attempt during that tap-select window.

Builder custom-area UI is fixed for mobile: the active area bar wraps within the viewport, pull/fill actions remain tappable, the helper box no longer clips offscreen, and returning to Builder with an existing area points users to the active bar instead of forcing a redraw/tap-to-confirm flow.

Route banner close control now shows “X CLOSE” on mobile and has a larger touch target so users can clearly exit the active route view.

Optimize button zoom-out fix is localized: mobile/tablet pointer events now hard-stop before reaching the Leaflet map, the Optimize button is easier to tap, and the shared map-fit controller ignores fit requests briefly while route optimization starts so optimization cannot trigger a continental zoom-out. Runtime review still shows unrelated backend rate-limit/dedup log noise, not a new optimize-button error.

Mobile FirstKnock Map zoom/tap responsiveness was improved by removing the Fragment warning spam, drawing dense vector layers with Leaflet canvas, disabling expensive zoom/fade marker animations, delaying tile updates until zoom settles, increasing pin hit targets to 56px, and making map controls larger/touch-optimized. Runtime review still shows the unrelated Home render-loop warning, but the RepMapView Fragment warning was addressed.

Mobile FirstKnock Map performance was improved by removing permanent labels from every house pin, memoizing the pin layer, using only one tile layer, and adding invisible 48px touch targets around pins while preserving the visible pin size. Runtime review showed existing unrelated backend rate-limit noise, with no new RepMapView-specific error surfaced.

Checklist/Knock route order sync is fixed on both sides: Knock now treats SavedRoute.property_hashes as the source of truth and refetches when the selected saved route changes, while Checklist also refreshes the latest saved order directly so stale Home activeRoute state cannot leave the two views out of sync. I also found an unrelated Home maximum-update-depth warning, but Home is over the safe edit limit and should be split before patching that separately.

Knock and Checklist are now aligned around the same latest-decision status behavior: No Answer remains done, Done views can be filtered by every decision type, history has a Clear action that adds an ELIGIBLE reset entry to move the home back to Todo, and the selected Knock route is persisted so reps stay on the same route/county context.

Map settings are cleaner: Apple/Google navigation selection now lives in the Map tab and is saved/shared through localStorage plus an app event so both Route Checklist and Knock tab navigation buttons use the same preference. The unwanted Auto-build on Generate setting was removed, and changing the Sold Date Window no longer prompts or auto-generates routes. Navigation URLs now open directions to the selected property in the selected provider.

Cancel import is now wired end-to-end: the loading overlay has a Cancel Import button, `cancelFetchJob` marks the user's active job as cancelled and releases locks, polling stops locally, and `processFetchChunk` checks cancellation before additional writes, completions, or self-chaining.

Map/builder mobile fixes are in place: tapping the bottom Map tab now forces plain Routes/analyze mode and closes Builder/Route Command panels, Route Command only auto-opens New Routes while in Builder mode, mobile panel/card overflow is constrained, and mobile X/delete/optimize taps stop pointer bubbling to avoid map zoom side effects.

Route Command mobile optimization is complete: the panel shell uses full viewport containment, the tab bar no longer has fixed mobile widths, Delete All/merge actions stack into a mobile grid, and Queued route cards now wrap status/count/action content within the viewport. Runtime review showed no new Route Command-specific errors in the interaction path.

Merge mode polish is complete: the section arrow is now forced visible on mobile, merge checkboxes are larger/high-contrast, and route cards are slightly shorter across Route Command views. Runtime review showed no new Route Command-specific errors after the polish.

## Plan — Freehand Draw BatchData 1000/Month Readiness Verification
- [x] Confirm the frontend captures arbitrary freehand points, preserves the confirmed polygon, and sends that exact polygon to preview/pull functions.
- [x] Confirm paid BatchData pull creation enforces the 1000-property paid cap, 300 sq mi area cap, FIPS resolution, and BatchData job metadata.
- [x] Confirm the processor is BatchData-only and does not call RentCast.
- [x] Verify whether the live BatchData API request is truly polygon/dynamic scoped, not just county-level with post-filtering.
- [x] Run no-charge backend dry-run/self-test checks for representative freehand polygons.
- [x] Document go/no-go and any required fix before using the BatchData 1000/month plan.

### Review — Freehand Draw BatchData Readiness
Frontend verification: `MapDrawTool` captures arbitrary freehand coordinates and `TerritoryPrompt` sends the confirmed `drawnPolygon` directly to both `previewBatchDataArea` and `startBatchDataPull`. Backend verification: paid/admin cap is 1000 properties, area cap is 300 sq mi, FIPS resolves correctly, jobs are created as `provider=batchdata`, `phase=batchdata_precision`, and `include_mls=false`. Processor verification passed with `active_provider=batchdata`, `rentcast_active=false`, BatchData key present, and database URL present. I found and fixed the main readiness risk: the live processor was using a broad county/FIPS query plus unsupported `limit`; it now uses the drawn area centroid as the BatchData location query, documented `take` pagination up to 1000 records, and still applies the freehand polygon as the final precision filter before writing to Neon. No-charge tests passed for preview sandbox probe, paid dry run, and processor self-test.

## Plan — Precision Generate Panel Paywall + Range Cleanup
- [x] Remove default max home value so users can leave either value category blank.
- [x] Set minimum home value default to $100,000 and keep max blank.
- [x] Remove Advanced Settings UI completely and keep Clear Area as a simple secondary action.
- [x] Update the title to “Build your route”.
- [x] Add a Generate guard: if requested properties exceed 50, verify subscription status before allowing pull.
- [x] If not upgraded, show the existing paywall instead of starting generation.
- [x] Verify no-charge backend dry-run still accepts blank max price and document results.

### Review — Precision Generate Panel Paywall + Range Cleanup
The Precision Generate panel now says “Build your route,” shows property count first, removes Advanced Settings, defaults min home value to $100,000 with max blank, and still allows either value input to be cleared. Generate now checks the latest account status when the requested count is over 50; non-upgraded users see the existing paywall instead of starting the pull. No-charge backend dry-run passed with `min_price=100000` and `max_price=null`; runtime logs showed no new frontend error, only unrelated existing route hydration rate-limit noise.