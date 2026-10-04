# Regional driving beta

This integration is default OFF. Publishing frontend code does not enable any workspace.
Open /RoutingBeta while signed in as the internal workspace owner to see provider prerequisites,
enable/disable that workspace, view comparison history, and restore an explicitly adopted saved-route order.
The owner can disable it immediately; ROAD_AWARE_ROUTING_BETA_DISABLED=true is the server kill switch.

## Current paths

The shared completion service runs after the existing membership/partitioning decisions:
Home generation/reorder and generated/filtered saves; saved Optimize (including personal and custom
bounds); Split Route; Campaign/Territory setup; ZIP generation/combine; generated and saved merges;
generated splits; completed reruns; CSV creation/append; backend generation; recent-sale automation;
and rep-base/private-anchor changes. CSV append retains the current-main combined-manifest behavior.
Assignments, source archival proofs, route sizes, and territorial partitioning retain main's rules.

For saved Home/rep Optimize, comparison generation records telemetry but does not update SavedRoute.
Current/Road-aware/Compare overlays use only verified road segments. Use New Route submits the exact
guarded manifest and geometry. Keep Current writes only the history decision. History restore refuses
to overwrite a changed order/version. These are version checks, not a transactional compare-and-swap:
the entity API does not provide an atomic route/history transaction. Do not concurrently edit a pilot
route from multiple devices. Failed history linkage after an otherwise successful creation is logged,
and history will show that comparison awaiting a route ID.
If a history decision write fails after apply/restore succeeds, the UI reports the successful route
write with a warning. The comparison snapshot survives, but its pending decision needs repair before
one-click history restore is available; the API does not claim that the route remained unchanged.

## Provider prerequisite

No public demo endpoint is used by the enabled beta. The existing production path remains unchanged
while OFF. Before enabling, deploy the new function/entities with the app's normal Base44 release
workflow and configure these server secrets:

- ROAD_AWARE_OSRM_BASE_URL: HTTPS URL for the private Charlotte driving graph, never a public demo.
- ROAD_AWARE_OSRM_GATEWAY_TOKEN: server-only bearer credential for the gateway.
- ROAD_AWARE_OSRM_BUILD_FINGERPRINT: immutable 64-character graph/profile build SHA256.
- ROAD_AWARE_OSRM_DATA_VERSION: the provider's exact reported data_version.
- ROAD_AWARE_ROUTING_BETA_WORKSPACE_IDS: comma-separated internal owner/workspace IDs. If absent,
  cohort eligibility uses the app's existing internal owner identity; the workspace still starts OFF.

Provider availability in settings means configuration is present. Validate connectivity and graph/profile
identity before enabling. Status never returns endpoint credentials. Authenticated proxies permit only
bounded car route/table/nearest requests inside [34.65,-81.35,35.48,-80.22], 100 m matching, unrestricted
approaches, the frozen reversal policy, and a 15-second/8 MB response budget. There is no inferred curb,
parking, pedestrian penalty, expanded driveway search or nationwide graph in this beta.

The previously benchmarked regional build is
51541289021925fde23303e1e8325770e681d0929f2cf301069cdc7595b79b81,
data version 2026-10-03T21:35:16Z, profile SHA256
48bbb716c2b68ce6803a11a4151fcac050c6ea8240295e7dde111f15f8bd3984.
No hosted provider has been supplied or deployed as part of this integration.

## Guard and measurements

One visible giant Home route contains bounded internal driving windows. Current-main's ordered
street/access splitter determines their boundaries. Unknown/outside-coverage stops stay at their exact
indices. Incoming/outgoing connectors and their neighboring unchanged legs are priced, and only a
strict decrease in modeled driving seconds with no increase in road miles is accepted. The three
measured guard/provider modules remain byte-for-byte frozen (normalizing platform line endings).
The current-main sweep supplies proposals; this integration does not reinstate the older checkout's
generation/partition logic. Therefore the old 8.38%/9.57% result is a preserved reference, not a claim
that the newer main sweep reproduces identical savings.

Telemetry includes workspace, actor, route ID when saved, entry point, both manifest fingerprints,
membership count, before/after modeled costs, deltas, guard, unresolved/fallback counts, graph identity,
and the selected geometry fingerprint. Personal anchor geometry stays in session memory. Partial totals
are explicitly labeled measurable legs only; no missing leg is assigned zero or sold as whole-route time.
The previous order is kept on the comparison snapshot for saved Optimize and in generated route
metadata for generation. A known-enabled beta outage cannot silently invoke an unguarded saved-route
optimizer. Unsupported geography or insufficient evidence preserves the supplied baseline.

## Regression reference and field validation

test/fixtures/giant-home-regression.json retains the exact export identity, graph/profile identity, result
hashes and modeled metrics from the original 6,965-stop run. Its private CSV, receipts, selected order and
source archive remain in the original checkout's ignored outputs/routing-regression-fixtures/charlotte-home-6965-v1.
Do not publish those addresses. Replays must use that export SHA256 and preserve all 44 unresolved stops,
membership and zero accepted regressions. Graph/profile/coverage changes and materially lower savings
require a written explanation; a changed graph need not reproduce the exact old percentages.

Local UI verification uses test/fixtures/road-aware-preview.html with synthetic coordinates and costs.
It invokes no production route API. That fixture is not a production entry point. Run the routing beta,
frozen engine, import, bounds, anchor, verification, generation-phase and main routing-parity tests;
then lint, typecheck, backend validation and production build. Existing failures in main remain release
blockers under this task's no-red-gate merge requirement; no existing tests have been weakened.

The field pilot starts with the prepared natural 102-stop window after provider/deployment prerequisites.
Capture observed mileage/time, backtracking, U-turns, approaches, navigation disagreements and rep preference.
Modeled savings are not realized technician savings. Keep this algorithm frozen during the pilot unless a
correctness problem appears, then use several internal routes and one opt-in workspace before expanding.
