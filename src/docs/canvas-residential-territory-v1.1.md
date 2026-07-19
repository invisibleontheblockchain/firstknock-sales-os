# Canvas Residential Territory v1.1

## Production contract

Canvas is a territory system, not a lead-import system. The manager-drawn boundary and its pinned residential street evidence are the source of truth. Precision remains the separate imported-property and route-optimization workflow.

Canvas owns short, stable street work-unit IDs. Territory polygons are display context only. A rep owns the `knock` work-unit IDs assigned to their area; `transit_only`, `excluded`, and `uncertain` units are never rep-owned work.

## What happens after a manager draws

1. The browser validates one simple freehand boundary of 1,000 square miles or less. This is the geographic envelope, not a promise that every dense 1,000-square-mile market fits into one trusted campaign record.
2. An authenticated server analysis reads OSM road, building, address, unit, entrance, land-use, mixed-use, commercial, amenity, barrier, and pedestrian-access evidence.
3. Areas of 50 square miles or less analyze directly. Areas over 50 through 1,000 square miles create a resumable tiled job. The browser persists the tenant-scoped boundary and job ID, restores the planner after a full reload, and offers an explicit server-side cancel action. The UI never previews partial tiles.
4. During a resumable job, raw tile evidence is content-addressed and immutable. After every tile verifies, the server commits one immutable final snapshot containing deployment-grade classified street units plus the tile hash/provenance manifest, then service-compacts bulky raw tile payloads and intermediate classified results. The server returns the final snapshot's `evidence_id` and `snapshot_hash`.
5. The map shows four evidence roles before ownership colors:
   - `knock`: positive residential opportunity plus permitted pedestrian access;
   - `transit_only`: shared connection or orientation with zero workload;
   - `excluded`: affirmative non-residential, open-land, or restricted-access evidence;
   - `uncertain`: missing or conflicting evidence, with zero workload until reviewed.
6. The manager enters only the number of areas. No reps are selected in the builder.
7. The deterministic background planner partitions only `knock` units, balances expected residential opportunity, keeps every area connected through permitted shared transit, and never splits a protected cul-de-sac unit. An executable scale regression exercises 20,000 units and 200 areas; the interactive product gate described below still limits the accepted unit-by-area combination.
8. The manager can change the count after the first preview; the colored preview recalculates after a 600 ms debounce.
9. The manager saves the plan unassigned. Saving pins the exact evidence snapshot, classification revision, work units, ownership, and QA result.
10. In **Areas & Assignments**, the manager can reopen the plan, resolve amber units with a required reason and explicit home count for residential overrides, and assign zero, some, or all areas.
11. Lifecycle advances from `saved_unassigned` to `partially_assigned` to `ready_to_send`. Activation is blocked until every area is assigned, every amber unit is resolved, QA passes, and production evidence is pinned.
12. Sending signs the campaign and activates each rep's exclusive street ownership. Reps tap houses as they work; Canvas stores only those decisions and shows them on the shared manager map.

## Production sizing limits

The geographic envelope is 1,000 square miles. A single immutable evidence snapshot is also capped at 7.5 MB, and a saved/deployed campaign is capped at 20,000 classified street units, 50,000 stored segments, a 2,000,000 street-unit × area interactive budget, and roughly 8 MB. For example, 200 areas can contain at most 10,000 classified units under the interactive budget. Sparse and rural large boundaries can fit; a dense metro boundary may reach the evidence or lifecycle limit at a much smaller land area. Canvas rejects unsupported complexity before starting the partition worker, fails closed with a split-the-boundary message, and never turns a partial tile set into a plan. Supporting denser single campaigns later requires chunked snapshot storage and chunked lifecycle replay rather than raising only the area limit.

## Evidence rules

Large tiled analysis additionally caps each running job before persistence at 64 MB of raw evidence, 32 MB of intermediate classified results, and 80 MB combined. With at most three active tiled jobs per manager, intermediate payload storage is bounded at 240 MB per manager plus bounded entity/index overhead. Complete jobs compact tile rows and raw tile payloads only after the final snapshot verifies; failed and cancelled jobs compact immediately and restart by rebuilding their bounded tile tasks.

- Residential opportunity and legal pedestrian access are classified independently, then combined into the Canvas role.
- Deduplicated address/unit evidence and explicit unit-count tags are preferred over entrances and residential footprints.
- An apartment footprint without reliable unit evidence receives a broad, low-confidence range; footprint size is never used to invent a unit count.
- `building=yes` alone is uncertain. Address-only evidence can establish an opportunity only when it is unambiguous and not contradicted by affirmative non-residential evidence.
- Mixed-use evidence can retain residential opportunity even when shops or amenities are present.
- Commercial, industrial, retail, warehouse, and open-land evidence is excluded only when positive residential evidence does not conflict.
- A gate or generic `access=*` tag does not automatically prohibit walking. An explicit `foot=*` value takes precedence; ambiguous or conditional access stays uncertain.
- Harmless degree-two curve nodes are coalesced into block-face ownership units; real intersections, endpoints, access changes, and protected terminal branches remain boundaries.
- Driveways, parking aisles, drive-throughs, and emergency-access service ways provide context but never become rep-owned streets or nearest-road targets.
- Associated-street and address-street evidence come first, followed by entrance/driveway and side-of-street evidence. A bounded nearest-road match is fallback only, and ambiguous parallel-road matches remain unassociated instead of being guessed.

## Hard guarantees

- No square or rectangular grid fallback.
- No partial large-area analysis can become a preview or campaign.
- Buffered tiles emit only core-owned geometry, then rebuild neighbors and protected terminal groups globally; a tile seam cannot invent a cul-de-sac or downgrade uncertain access to permitted.
- Every `knock` work unit is owned exactly once; context units are owned zero times.
- Every area is connected.
- Protected cul-de-sac and terminal units stay atomic.
- The work-unit set submitted by the client must exactly match the pinned server evidence and classification revision.
- Analysis jobs, final snapshots, revision heads, and revisions use a short tenant-scoped compare-and-set identity lease on the manager's service-only User fields. Provider fetches and planner computation never hold that lease; the 60-second ownership window covers only bounded identity persistence and is released by exact token.
- A manager may resolve up to 250 amber street units in one audited, content-addressed revision only when the shared decision is `transit_only` or `excluded`. Every target becomes visible through one compare-and-set head advance, so a conflict cannot expose a partially applied target set; residential/`knock` overrides remain single-unit because each requires its own explicit home count.
- Deployment replays the pinned evidence; it does not query public Overpass or silently refresh classifications.
- Public-development fallback evidence may be reviewed and saved as a draft, but it is marked untrusted, cannot become `ready_to_send`, and cannot activate. Only evidence produced by the configured private HTTPS provider is production-trusted.
- A rep decision must be inside the campaign and snap to a `knock` unit owned by that rep's signed area.
- Deployment prepares and verifies one signed campaign decision gate plus one signed durable lease state per area before the lifecycle compare-and-set can make the campaign active, then verifies them again after commit. A retry repairs a partial preparation or a valid committed deployment with missing decision rows without depending on a browser's previous idempotency key. Independent areas can accept decisions concurrently; same-area pin/event writes remain compare-and-set and idempotency protected.
- Complete, recall, and overlap replacement first drain the signed campaign gate, wait admitted area leases, and only then commit the lifecycle transition. A reloaded same-action close adopts the already-signed drain key; a different action still conflicts. Replacement keys are successor-bound, persisted inside signed deployment QA per predecessor, and replayed exactly after any post-commit retry. Supersession is a direct tenant-scoped signed marker, so a field decision never scans campaign history.
- Canvas does not read or mutate Precision properties, usage, FetchJobs, SavedRoutes, or route settings.
- Neon is not required. Base44 stores campaign control data, immutable evidence metadata, classification revisions, assignments, and house decisions.

## Production deployment checklist

Publish the following Base44 entities before enabling the UI:

- `CanvasAnalysisSnapshot`
- `CanvasClassificationRevision`
- `CanvasClassificationRevisionHead`
- `CanvasAnalysisJob`
- `CanvasAnalysisTile`
- `CanvasAnalysisTileEvidence`
- `CanvasDecisionCampaignState`
- `CanvasDecisionZoneState`
- the updated `User` schema with the service-only Canvas analysis identity lease fields
- the updated `CanvasSession`, `CanvasHousePin`, and `CanvasHouseEvent` schemas

The two decision-state entities must exist before publishing the updated `canvasDeployCampaign`, `canvasLogHouseDecision`, `canvasCloseCampaign`, and `canvasGetCampaignMap` functions. Newly deployed campaigns initialize their signed decision gate and area states automatically before activation. A valid signed active campaign with missing decision rows can be repaired by an authenticated manager retry of `canvasDeployCampaign`; the server uses the deployment's stored signed key, regardless of the new client key. Until that recovery succeeds, field writes and close remain fail-closed. Invalid, duplicate, cross-tenant, or mismatched rows are never overwritten as recovery. Drafts can reconcile only a cryptographically valid stale preparation while the same tenant-owned session is still the exact draft.

Publish these Canvas functions together so their contracts cannot drift:

- `canvasStartAnalysis`
- `canvasGetAnalysisStatus`
- `canvasCancelAnalysis`
- `canvasGetAnalysis`
- `canvasApplyClassificationOverride`
- `canvasSaveDraft`
- `canvasAssignTerritories`
- `canvasDeployCampaign`
- `canvasListCampaigns`
- `canvasGetCampaignMap`
- `canvasGetMyAssignments`
- `canvasLogHouseDecision`
- `canvasCloseCampaign`
- `canvasQuarantineInvalidCampaigns`

Configure server secrets/environment:

- `CANVAS_DEPLOYMENT_SIGNING_SECRET`: one stable environment-specific secret with at least 32 high-entropy characters. Rotating it without a multi-key verification migration hides previously signed campaigns.
- `CANVAS_OVERPASS_URL`: contracted or self-hosted HTTPS OSM/Overpass endpoint for direct analysis.
- `CANVAS_OVERPASS_LARGE_AREA_URL`: contracted or self-hosted HTTPS endpoint for tiled 50–1,000 square-mile analysis; it may equal the direct endpoint if capacity is sufficient.
- `CANVAS_OVERPASS_AUTH_TOKEN`: optional bearer token for the configured large-area provider.
- `CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK=false` in production. Public Overpass is an explicit development fallback only. Save derives untrusted evidence QA from that immutable snapshot, and deploy independently requires both trusted QA and the contracted/self-hosted snapshot provider, so a forged client flag cannot activate it.
- `CANVAS_ANALYSIS_CACHE_TTL_MS`: optional 1-hour through 7-day cache epoch; defaults to 24 hours. It refreshes request identities and does not extend intermediate retention, because terminal intermediates are compacted immediately.
- `CANVAS_EXTRACTION_VERSION` and `CANVAS_CLASSIFIER_VERSION`: stable release identifiers; change them when extraction or classification semantics change.

Staging acceptance requires authenticated manager and rep accounts with exact active `TeamMember.user_id` bindings. Exercise direct and tiled analysis, an amber override, save-unassigned, partial assignment, full assignment, send, rep pin, manager-map synchronization, recall, overlap replacement, and Precision isolation. A production rollout is incomplete if signing or the configured OSM provider is absent; the application intentionally fails closed in those states.
