# Canvas D2D Territory Planning Flow

## Product contract

Canvas is an area-assignment system for open door-to-door territory. The manager-drawn territory is the source of truth. Canvas does not need an imported list of houses before it can create or deploy a campaign.

The canonical flow is:

1. A manager draws one global working area.
2. Canvas reads the street network inside that boundary.
3. The manager chooses the actual reps or enters the crew headcount; advanced users can instead choose a reusable street-workload size.
4. Canvas divides the area into connected, street-aligned territories.
5. Each rep receives only their assigned colored territory.
6. Reps tap houses on the map as they work and record outcomes.
7. Those pins and outcomes appear across the manager's shared campaign map.

Precision is a separate product. Precision imports specific lead records and creates ordered routes. Canvas divides open geography and records what happens in the field. Canvas must not consume Precision usage, create Precision routes, import Precision properties, or mutate Precision settings.

## Core decisions

- **One territory per selected rep** is the default workload mode.
- **Crew headcount** creates the same number of territories and requires one distinct rep per territory before sending.
- **Workload size (advanced)** derives the territory count from approximate class-weighted knockable street miles per territory, then allows one or more territories per rep while requiring every selected rep to receive work.
- Street workload, not a preloaded door count, is the canonical balancing input. The planner uses connected street length and atomic road topology.
- Optional building or address features may improve display, snapping, or workload estimates, but they are never required deployment inventory.
- Cul-de-sacs, terminal branches, and other protected street units remain whole even when doing so creates workload imbalance.
- Campaign deployment stores the global boundary, street snapshot/version, work-unit ownership, colored street segments, and TeamMember assignments.
- A house becomes persistent Canvas data only after a rep or manager pins it or records a decision.

## Manager journey

### 1. Enter Canvas

The manager selects **Canvas** instead of **Precision**. Canvas access and manager authority are checked before the planner opens. The UI is visibly labeled and colored as Canvas.

Initial state:

- no demo territory or demo team;
- no house-analysis prerequisite;
- no Precision pull or routing request;
- primary action: **Draw working area**.

### 2. Draw the global area

The manager draws one freehand polygon around the neighborhood or market the team will work. Canvas validates:

- at least three valid points;
- a simple, non-self-intersecting polygon;
- nonzero area;
- supported point and area limits.

Canvas then fetches the eligible road network for the boundary. If usable roads cannot be verified, planning and deployment fail closed with a retry action.

### 3. Choose workload

Canvas provides two primary ways to identify the crew and one advanced sizing mode:

1. **Selected reps**: select active linked reps; territory count equals rep count.
2. **Crew headcount**: enter how many people are going out; territory count equals headcount, then select exactly that many active linked reps.
3. **Standard-size work packs (advanced)**: choose approximate class-weighted street miles per territory; Canvas calculates the count after reading the road graph.

The manager creates the first preview explicitly. After that, changing crew headcount debounces for 600 ms and refreshes the colored map preview automatically. A newer headcount cancels any obsolete calculation, and failed previews do not retry until the manager changes an input. Planning runs in a module worker so a large calculation does not freeze the map. A 2,000-work-unit ceiling, 50,000-segment ceiling, and work-unit × territory budget of 180,000 reject an unsafe monolithic campaign and ask the manager to split the boundary.

Before generation the manager sees:

- selected reps or the requested workload size/count;
- calculated territory count after generation;
- shortest and longest weighted street workloads and maximum deviation;
- selected reps and any assignment gap.

The UI never presents an exact home count unless it is derived from an explicitly loaded optional source and clearly labeled as an estimate.

### 4. Generate street-intelligent territories

Canvas:

1. normalizes and clips the road graph to the drawn boundary;
2. excludes unsupported bridge/tunnel crossings and unusable roads;
3. creates atomic work units between real decision points;
4. contracts terminal branches from dead end or turning circle to throat;
5. computes connected street length for every work unit;
6. seeds and grows the requested number of connected zones deterministically;
7. assigns every eligible work unit to exactly one zone;
8. emits the authoritative colored street segments owned by each territory.

Planner states:

- `ready`: every hard topology rule passes;
- `degraded`: safe to deploy, but a protected unit causes workload imbalance;
- `infeasible`: the requested territory count cannot be produced without breaking a hard rule;
- `blocked`: boundary or usable road topology is missing.

### 5. Review and assign

The manager map and territory list are two views of the same plan. Each territory shows:

- color and number;
- assigned rep or **Unassigned**;
- street distance/workload;
- area center for orientation;
- protected-unit or balance warnings.

The quality panel requires:

- every eligible street work unit assigned once;
- no duplicate work-unit ownership;
- no missing work units;
- every territory connected;
- no split cul-de-sac or protected branch;
- valid owned TeamMember assignment for every territory;
- exact one-rep/one-territory assignment for selected-rep and crew-headcount plans;
- every selected rep represented in standard-size work-pack assignments;
- explicit manager acceptance when maximum weighted-workload deviation exceeds 25%;
- matching client/server street-data version.

**Finish later** saves without sending anything to reps. Saved drafts remain in the manager campaign index and can be reopened with the exact boundary, selected crew intent, work units, assignments, QA evidence, algorithm/data versions, and optimistic-lock version. **Send territories** is enabled only after all hard gates and assignments pass. Any accepted workload exception is authenticated by the save endpoint and included in the signed campaign evidence.

### 6. Manage the global campaign

The active manager map shows:

- the original global boundary;
- every rep's authoritative colored street ownership and assignment;
- pinned houses and their latest outcomes;
- per-territory knock, conversation, callback, appointment, sale, and do-not-knock counts;
- active, completed, recalled, and superseded campaign state.

An overlapping campaign must name every active conflict and require explicit confirmation before replacement. Superseded campaigns stop appearing as active to both managers and reps.

Managers can complete or recall a campaign. Both are signed, versioned, idempotent transitions, and open rep maps remove the territory on their next refresh.

The shared map intentionally bounds the general latest-pin window at 10,000 records and optional event history at 20,000 records per response. A visible truncation warning means ordinary older history may require the planned cursor-paging follow-up. Do-not-knock safety is handled separately: every visible latest `do_not_knock` pin is fetched and unioned into the map even when it falls outside the general window. If a campaign or rep assignment exceeds the documented 20,000 DNC safety-pin ceiling, the server returns `dnc_safety_limit_exceeded` and withholds the map rather than returning an incomplete suppression list. Split or archive the campaign before field work resumes.

After deployment, **Start another area** clears only the local Canvas draft and boundary. The deployed campaign stays active and visible in the campaign index while the manager draws a separate working area.

## Rep field experience

An authenticated rep receives only signed active zones assigned to their exact TeamMember ID. Assignment polling carries lifecycle, boundary, zone, and street ownership only; it does not duplicate house-pin payloads. The field view loads pins from the zone-scoped shared-map endpoint on its own refresh interval. The field map displays the global boundary for context, their thick colored owned street segments, area center, and existing Canvas house pins in that zone. The map fits to the rep's streets rather than the team's entire global area.

### Pin and log a house

The rep taps or long-presses a house location. When a building feature is available, Canvas may snap to it; otherwise the coordinate is used directly and an address may be reverse-geocoded.

The rep records one of the supported outcomes:

- no answer;
- not interested;
- callback;
- appointment;
- sale;
- do not knock.

Optional address, unit/apartment label, and notes may be attached. Navigation opens the user's selected Apple or Google maps app.

The server accepts the decision only when:

- the campaign is signed and active;
- the rep-to-TeamMember binding is still valid;
- the assigned zone belongs to that TeamMember;
- the pin falls inside the global boundary and within the allowed distance of the zone's nearest signed street work unit;
- a near-tie between different zones is rejected as ambiguous instead of guessed;
- the outcome is valid;
- the idempotency key is new or resolves to the same prior write.

An existing building ID, normalized address, nearby coordinate, and optional unit label help resolve repeat taps to one Canvas house pin. A successful write updates the shared campaign map; an offline write remains queued until the server acknowledges it. The device queue is scoped to the authenticated user and assigned TeamMember. Pending payloads are immutable under their original idempotency key; retryable conflicts remain queued, while terminal rejections require an explicit replace or discard action.

## Canvas persistence

Canvas persistence is isolated from Precision:

- `CanvasSession`: campaign boundary, zones, work-unit ownership, assignments, signed lifecycle.
- `CanvasHousePin`: one map-created house/location with latest Canvas state.
- `CanvasHouseEvent`: append-only decision history and audit evidence.

Team membership identity is security-sensitive. `TeamMember.email`, `user_id`, `role`, `status`, `manager_id`, and `invite_code` are writable only by the record's owning manager or the platform service/admin role. `User.team_manager_id` is service/admin-owned and is established only through trusted invite redemption or exact existing-membership claim. Invite-code identity and capacity fields are writable only for the authenticated manager's own tenant (or by platform service/admin); ordinary managers may create only rep codes, and `used_count` is service/admin-owned. Redemption rejects legacy manager/admin codes, so invite data cannot elevate an account. Reps may still edit safe profile fields such as name, phone, and profile image.

The initial implementation may use Base44 entities and authenticated functions for this data. Neon is not a Canvas deployment prerequisite. A separate analytical store can be introduced later if event volume or geospatial reporting requires it.

## Failure behavior

| Condition | Result | Recovery |
| --- | --- | --- |
| No boundary | Planning blocked | Draw the working area |
| Invalid boundary | Planning blocked with exact reason | Redraw one simple boundary |
| Road data unavailable | Deployment blocked | Retry street data or redraw |
| Too many requested territories | Explain safe maximum | Reduce territory count |
| Street-plan complexity exceeds the interactive budget | Planning stopped before save/deploy | Split the global boundary or reduce crew size |
| Oversized protected branch | Safe workload warning | Accept or change count |
| Missing/disconnected work unit | Deployment blocked | Regenerate |
| Inactive/foreign rep | Deployment blocked | Choose an active linked rep |
| Pin outside global boundary, too far from an owned street, or cross-zone ambiguous | Decision rejected | Review the pending pin and choose a corrected house location |
| Duplicate offline retry | Return the original result | No duplicate event |
| General map history exceeds its response window | Return newest general records, every DNC pin, and an explicit truncation flag | Use the current map; cursor paging remains a release follow-up |
| DNC safety pins exceed 20,000 | Map withheld with `dnc_safety_limit_exceeded` | Split or archive the campaign before field work resumes |
| Campaign completed/recalled/replaced | Rep area disappears | Manager creates a new campaign if needed |

## Precision isolation contract

- Canvas owns separate planning state, endpoints, entities, overlays, and outcome records.
- Entering, drawing, generating, saving, deploying, or logging a Canvas decision must not invoke a Precision endpoint.
- Switching back to Precision restores the prior Precision state unchanged.
- Canvas does not change Precision usage, FetchJobs, SavedRoutes, property records, or route optimizer inputs.
- Unauthorized or stale Canvas mode fails closed without changing Precision defaults.

## Release acceptance criteria

- The same boundary, OSM road snapshot, and settings produce the same work-unit ownership.
- Every eligible street work-unit ID appears in exactly one territory.
- Every territory is connected.
- Both sides of a cul-de-sac terminal-to-throat branch remain in one territory.
- Selected-reps mode produces one territory per selected rep.
- Crew-headcount mode produces one territory per person and cannot send repeated or omitted rep assignments.
- Workload-size mode derives a reviewable count from the requested weighted street miles.
- Changing crew headcount updates the colored preview after the debounce without freezing the main map UI.
- Draft Preview sends nothing to reps.
- Saved drafts reopen with the same plan, assignments, QA/version evidence, and expected server version.
- Every rep sees only their signed assigned zone and its Canvas pins.
- Assignment polling contains no embedded pin history; zone map polling owns pin refresh.
- General-history truncation is explicit, while every visible DNC pin is present or the map fails closed.
- A rep can tap a house near an owned colored street, record an outcome, and see the acknowledged pin.
- A rep cannot log outside their zone or into another manager's campaign.
- A manager sees all territories and acknowledged decisions for the campaign.
- Complete, recall, and supersession remove rep access within the polling window.
- Superseded predecessors are not labeled active in the manager campaign list.
- Existing Precision tests, usage, routes, settings, typecheck, lint, and production build remain unchanged.

## Deployment prerequisites

1. Configure one stable `CANVAS_DEPLOYMENT_SIGNING_SECRET` per Base44 environment with at least 32 high-entropy characters.
2. Confirm the Base44 runtime and supported browsers can reach the configured Overpass endpoints.
3. Seed authenticated manager and rep test accounts with exact TeamMember bindings.
4. Run the full territory, pin/outcome, lifecycle, overlap, authorization, offline retry, and Precision-isolation staging matrix before publishing.
