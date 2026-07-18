# Canvas D2D Territory Planning Flow

## Outcome

Canvas turns one manager-drawn freehand boundary into exclusive, street-intelligent field territories. Every included home belongs to exactly one zone, every zone is connected, protected street units such as cul-de-sacs stay together, and the manager sees the quality checks before anything is sent to reps.

Canvas is a separate product path. It must not call, mutate, or change the defaults of Precision data pulls, Precision route generation, Precision usage, or Precision saved-route behavior.

## Product decisions

- The default split is **one zone per selected rep**. This maps directly to the team working the shift and avoids making the manager calculate a zone count.
- **Homes per area** is the alternate split. Canvas derives `ceil(included homes / target homes)` zones, then asks the manager to assign reps.
- Home count is a target, not permission to cut a protected street unit. A cul-de-sac or terminal branch may make one zone larger than the target and must produce an explicit workload warning.
- A home/building ID is the assignment source of truth. Geometry is presentation. A deployable plan cannot contain an unassigned home, a duplicate home, a disconnected zone, or a split protected street unit.
- If real opportunity points or usable road topology are unavailable, Canvas explains what is missing and blocks deployment. It never silently presents square, rectangle, or H3 fallback geometry as field-ready territory.
- Automated generation is deterministic. The same boundary, opportunity IDs, road topology, and settings produce the same ownership result.
- Deployment independently reloads the owned analysis, fetches road topology server-side, and reproduces the deterministic plan. Browser QA, geometry, work-unit ownership, and drop-point fields are never trusted as deployment authority.
- Draft and deployed plans are stored server-side and tenant-scoped. User-scoped browser storage may cache analysis display state, but it is never the handoff source of truth.

## Manager journey

### 1. Enter Canvas

The manager chooses **Canvas** instead of **Precision**. The app checks Canvas entitlement and manager authority before opening the planner. The mode is visibly purple and labeled “Canvas territory planner” so it cannot be confused with a paid Precision pull.

Initial state:

- No demo team or demo polygon.
- Existing Precision properties, routes, and pull settings remain untouched.
- Primary action: **Draw territory**.

### 2. Draw the working boundary

The manager freehand-draws the entire neighborhood or market area the team will work. The planner shows the boundary area and offers **Redraw** and **Clear**.

Before continuing, Canvas validates:

- at least three valid boundary points;
- no self-intersection or zero-area polygon;
- supported territory size and point count;
- real opportunity analysis completed;
- usable street topology loaded for the drawn boundary.

The manager sees progressive statuses: “Checking boundary,” “Finding knockable homes,” “Reading streets,” then either “Ready to split” or a specific recovery action.

### 3. Choose the workload

Canvas shows two split bases:

1. **Selected reps** (recommended): select the active team members working this campaign. Zone count equals selected-rep count.
2. **Homes per area**: enter a target number of homes. Canvas derives the zone count and shows how many reps are needed for one-zone-per-rep coverage.

The summary updates before generation:

- included homes;
- planned zones;
- target homes per zone;
- selected reps and any staffing gap.

Guardrails prevent zero reps, non-positive targets, excessive zone counts, and more zones than indivisible street work units.

### 4. Generate street-intelligent zones

Canvas creates atomic work units from the road graph and homes:

1. Normalize and validate stable home IDs inside the drawn boundary.
2. Snap each home to a knockable road segment. If two distinct work units are materially ambiguous and no explicit road/street identity resolves the choice, block the plan instead of guessing through a backyard or across a parallel road.
3. Break the road graph only at real decision points such as intersections and eligible connectors.
4. Contract every terminal branch from its dead end or turning circle back to its throat into one protected unit. Both sides of that branch stay together.
5. Pair opposing sides of ordinary street segments into the same work unit unless the road is a true barrier.
6. Seed zones deterministically and grow them through adjacent work units toward the requested workload.
7. Grow each connected area through adjacent whole units toward the requested workload; protected units are never split to make counts look prettier.
8. Build display polygons from the assigned work units and clip them to the manager’s drawn boundary.

The generator returns one of four states:

- `ready`: every hard quality rule passes;
- `degraded`: safe and deployable, but one or more workload targets cannot be met because an indivisible unit is oversized;
- `infeasible`: the requested zone count or workload cannot be produced without breaking a hard rule; settings must change;
- `blocked`: required homes, IDs, road topology, or analysis data are missing.

### 5. Review the plan

The map and zone list are two views of the same plan. Selecting either highlights both. Each zone card shows:

- assigned color and zone number;
- exact included-home count;
- selected rep or “Unassigned”;
- area center (not presented as an optimized route start);
- warnings tied to that zone.

The always-visible quality summary reports:

- homes assigned once: `assigned / included`;
- duplicate homes: `0` required;
- unassigned homes: `0` required;
- disconnected zones: `0` required;
- split cul-de-sacs/protected branches: `0` required;
- largest workload deviation;
- generation method and data readiness.

A workload warning does not masquerade as a topology failure. For example, “Zone 3 is 18 homes over target because Oak Court is one protected 42-home branch” tells the manager exactly why the variance is safe.

### 6. Assign and preview

With the selected-reps split, Canvas auto-assigns each zone to the corresponding TeamMember ID. With homes-per-area, the manager selects one active rep per zone or uses balanced auto-assignment. Names are display labels only; IDs are persisted.

Before handoff, selecting a zone previews its clipped street corridors, exact home count, area center, and assignee on the manager map. The server handoff contains only that rep’s assigned stable home IDs.

The final call to action reflects state:

- **Draft Preview** saves a non-deployed revision to the server.
- **Deploy to reps** remains disabled while a hard check or assignment is missing.
- **Deploy to reps** is enabled only when the plan is server-valid, every zone has an owned active rep, and every hard quality check passes.

After a successful send, the confirmation is concrete: “8 zones · 642 homes · 8 reps.” Stable homes and atomic work units are exclusive within the campaign. If a new campaign overlaps an active deployment, Canvas names the conflict and requires explicit confirmation before the signed replacement supersedes the old campaign for reps.

The manager can mark the campaign **Complete** after the shift or **Recall** it immediately. Both are signed, versioned, idempotent server transitions. The active-campaign index remains available after reopening Canvas so a manager can stop a prior campaign without keeping the original planner tab open.

### 7. Rep handoff

An authenticated rep sees only deployed zones assigned to their TeamMember ID within their manager’s tenant. The app never matches by a display name and never reads another manager’s Canvas session. While the Canvas field map is open, assignments refresh every 15 seconds and on window focus. A completed, recalled, or superseded area disappears from the open map and the rep receives an explicit notice.

## Failure and recovery behavior

| Condition | User-facing result | Allowed action |
| --- | --- | --- |
| No drawn area | “Draw the territory your team will work.” | Draw |
| No analyzed homes | “Find homes before splitting this area.” | Analyze area |
| Road data unavailable | “Street layout could not be verified.” | Retry or redraw; deployment blocked |
| Ambiguous home-to-road snap | Identify the home and two competing work units | Improve source linkage or redraw; deployment blocked |
| Requested zones exceed work units | Explain maximum safe zone count | Reduce reps/zones |
| Oversized cul-de-sac | Name the protected unit and variance | Accept degraded balance or change target |
| Duplicate/unassigned home | Identify affected zone(s) | Regenerate; deployment blocked |
| Disconnected zone | Identify affected zone | Regenerate; deployment blocked |
| Inactive/foreign rep | Identify invalid assignment | Select an active team member |
| Save/send network error | Preserve the current unsent draft in memory | Retry; never claim success |
| Server road version changed | Invalidate the short-lived browser road cache | Reload streets, regenerate, then deploy |
| Campaign finished or unsafe | Signed lifecycle transition | Complete or recall; reps lose the area on refresh |

## Precision isolation contract

Canvas may share only neutral map primitives and authenticated team data. It owns separate planning state, storage keys, server functions, entities, overlays, and generation logic. Precision remains the default mode and its pull panels, usage accounting, BatchData requests, route optimizer, filters, and saved routes are not imported into the Canvas planner.

Required regression checks:

- entering, drawing, generating, saving, or deploying Canvas does not invoke a Precision endpoint;
- switching back to Precision restores the prior Precision state unchanged;
- Canvas zones render once, not through duplicate map overlays;
- unauthorized/stale Canvas mode fails closed to Precision without changing Precision settings;
- Canvas tests import only Canvas-specific planning modules.

## Release acceptance criteria

- A cul-de-sac fixture containing homes on both sides assigns the full terminal-to-throat branch to one zone.
- Every fixture home ID appears in exactly one zone.
- Every generated zone is connected through its work-unit adjacency graph.
- Reordering equivalent input arrays does not change home-to-zone ownership.
- Selected-reps and homes-per-area controls produce the documented zone-count behavior.
- Deployment is rejected for missing IDs, duplicates, unassigned homes, disconnected zones, protected-unit splits, stale versions, or foreign/inactive reps.
- Manager and rep reads are tenant-scoped and ID-based.
- Complete/recall transitions remove assignments from an already-open rep screen within the polling window.
- Existing Precision regression tests, typecheck, lint, and production build pass unchanged.

## Boundary-handoff scope and operational limits

- This release covers safe territory creation, assignment, deployment, navigation, replacement, completion, and recall. Door outcome logging and manager progress reporting remain disabled until a trusted Canvas outcome-sync endpoint exists; the app does not fabricate a local-only result.
- Managers can list and close active server campaigns after reopening Canvas, but full map hydration and editable draft resumption are a follow-up history/audit surface.
- Public Overpass availability and replication latency remain operational dependencies. Reads are time-bounded and deployment fails closed. A managed, pinned OSM snapshot is the longer-term production hardening path.
- Same-session deploy/close writes use guarded state/version/hash/signature predicates. Final deployment revalidation, overlap scanning, and commit are serialized per manager with a PostgreSQL advisory transaction lock. Staging should still stress lock contention and failure recovery before general availability.
- This checkout has no linked Base44 staging app or authenticated deployment runtime, so the function package and authenticated end-to-end flow still require staging verification before merge.

## Deployment prerequisite

Before rolling out these endpoints:

1. Run the updated `setupCanvasOpportunityTables` admin migration to add, backfill, and index `opportunities.stable_door_id`.
2. Configure `CANVAS_DEPLOYMENT_SIGNING_SECRET` in the Base44 function environment with at least 32 high-entropy characters. Deploy fails closed without it, and rep handoff rejects unsigned or post-deployment-tampered Canvas sessions.
3. Confirm the production environment can reach the configured Overpass endpoints for road topology.
4. Confirm `DATABASE_URL` is available to the deploy function and its PostgreSQL role can acquire advisory transaction locks.
