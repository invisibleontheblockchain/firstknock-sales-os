# Map (/Home) Performance Audit — trackpad zoom stagger + high-pin-count lag

Status: **steps 1, 2, 3, 4, 6, 7 + the deep-link index are implemented. Step 5
(splitting the `effectiveProperties` memo) is deferred — see §5.**
Scope: `src/pages/Home.jsx`, `src/components/map/ManagerMapLayers.jsx`,
`src/components/map/MapHelpers.jsx`, `src/components/map/useViewportMapProperties.jsx`,
`src/components/map/GpsTracker.jsx`, `src/components/map/densePinSize.js`.

Hard constraint honored throughout: **no clustering, no fidelity reduction, no
zoom-dependent hiding.** Every pin stays an individually mounted, individually
styled, individually clickable `L.circleMarker` at every zoom. Nothing below
changes a pixel of pin appearance.

---

## 0. Verification of the supplied research report

The external report was checked line by line against the current source.

**Confirmed correct (evidence re-verified):**

| Claim | Verified at |
| --- | --- |
| `preferCanvas` is on | `Home.jsx:2267` |
| Pins are imperative `L.circleMarker`, not React-Leaflet | `ManagerMapLayers.jsx:444-535` |
| Zoom-banded cap 5,000 / 8,000 / 12,000 | `ManagerMapLayers.jsx:366-369` |
| Bounds/zoom debounced on terminal events (120ms / 100ms) | `ManagerMapLayers.jsx:341-352`, `MapHelpers.jsx:148-166` |
| **RC#1** full teardown + synchronous rebuild, no diffing, 10-entry dep array | `ManagerMapLayers.jsx:444-535` |
| **RC#2** per-pin style derivation uncached inside the loop, array literal re-allocated per pin | `ManagerMapLayers.jsx:460-518` (`['ELIGIBLE','NO_ANSWER','OTHER']` at 465) |
| **RC#3** `effectiveProperties` mega-memo, O(n) + dedup pass, keyed on `logs` | `Home.jsx:1196-1271` |
| O(n·m) deep-link scan | `Home.jsx:1422-1424` |
| Heatmap / state clusters correctly gated | `Home.jsx:1461-1471` |
| Confidence ring suppressed above 1,200 pins | `ManagerMapLayers.jsx:456,491` |

**Corrections — the report is wrong or incomplete on these:**

1. **"Both wheel settings are already tuned" is false — they conflict, and the
   JSX values are dead.** `Home.jsx:2268-2269` sets
   `wheelPxPerZoomLevel={80} wheelDebounceTime={40}`, then
   `MapRefHandler` (`MapHelpers.jsx:123-133`) overwrites `map.options` after init
   with `wheelPxPerZoomLevel = 100; wheelDebounceTime = 80`. Leaflet reads
   `map.options` at wheel time, so the **effective** debounce is 80ms, not 40ms.
   Two files fight over one setting and the later one silently wins.
2. **The map data feed is not the 50,000-record path the report assumed.** The
   `limit: 50000` calls (`Home.jsx:1561,1593,1637,1659,2534`) are the *route
   generation* path. The map is fed by `useViewportMapProperties`:
   `BASE_LIMIT = 20000`, `VIEWPORT_LIMIT = 10000`. The report's "open item" here
   hides a real root cause — see **RC#6**.
3. **GpsTracker is far worse than "inline eventHandlers".** `useGpsTracker` is
   called twice (`GpsMapLayer:70` and `GpsHud:126`), so there are **two
   concurrent `watchPosition` watches**, and each one runs a `.map()` that
   allocates a spread copy of **every property in the account** on every GPS fix
   (`GpsTracker.jsx:54-64`). At 20k properties that is ~40,000 object
   allocations per position fix. The inline `eventHandlers` (line 112) is real
   but trivial next to this — only ≤15 markers.
4. Section 9's trade-offs are not needed. Agreed, and now provably so: every
   root cause below is redundant work, not a drawing limit.

---

## 1. Issue A — trackpad zoom staggers and snaps

**Two independent causes, and they interact.**

### A1 — `zoomSnap={1}` forces every zoom to land on an integer level
`Home.jsx:2268`: `zoomSnap={1} zoomDelta={1}`.
A trackpad emits a long stream of small wheel deltas. Leaflet's
`ScrollWheelZoom` accumulates them, waits `wheelDebounceTime`, converts the
accumulated pixels into a zoom delta via `wheelPxPerZoomLevel`, then **rounds
the result to `zoomSnap`**. With `zoomSnap = 1` the camera can only ever come to
rest on 15, 16, 17 — which is exactly the reported "it snaps to a specific
measurement". The 80ms effective debounce (correction #1) turns that into
discrete lurches rather than continuous motion.

### A2 — every settled zoom step is followed by a multi-thousand-marker rebuild
`MapController` (`MapHelpers.jsx:148-155`) pushes the **raw** zoom into
`setZoomLevel`. `zoomLevel` then feeds:
- `MAX_VISIBLE_PINS` (`ManagerMapLayers.jsx:366`),
- `dotSize = zoomAdjustedPinSize(pinSize, zoomLevel)` (line 458),
- the pin effect's dependency array (line 535).

So each zoom step destroys and recreates up to 12,000 markers **inside the same
frame budget the zoom animation needs**. That is the "stagger" half of the
symptom, and it is the same defect as RC#1 below.

**These are coupled: fixing A1 alone makes A2 worse.** Fractional zoom means
more distinct `zoomLevel` values, so more full rebuilds. A1 must not ship
without banding the zoom value handed to the layers.

### Proposed fix (visually identical)
1. **One source of truth for wheel options.** Delete the post-init override in
   `MapRefHandler` (`MapHelpers.jsx:123-133`) and keep the values on
   `MapContainer` only.
2. `Home.jsx:2268-2269` → `zoomSnap={0.25} zoomDelta={0.5}
   wheelPxPerZoomLevel={120} wheelDebounceTime={20}`. Smooth, continuous
   trackpad zoom; `zoomDelta` keeps +/- buttons and double-click at a sane step.
3. **Band the zoom the layers see.** Feed layers `Math.floor(zoom)` (or the
   existing `zoomStyleBand`) instead of the raw fractional value —
   `onZoomChange` in `MapController`, or a quantizing wrapper at
   `Home.jsx:2284`. Pin radius (`zoomAdjustedPinSize` bumps at 16/17/18/19) and
   the pin cap already change only at integer boundaries, so **banding produces
   byte-identical pin styling** while removing rebuilds at intermediate zooms.

Risk: low. Verify: `zoomAdjustedPinSize` output per integer band unchanged;
stop-number thresholds in `ActiveRouteLayer` (`zoomStyleBand`, line 36) already
band their own input and are unaffected.

---

## 2. Issue B — root causes of high-pin-count lag

### RC#1 (PRIMARY) — pin layer is rebuilt from scratch on every change
`ManagerMapLayers.jsx:444-535`. The effect removes the layer group, allocates a
new one, creates a fresh `L.circleMarker` per pin, attaches a fresh closure per
pin, and adds them one by one. Ten dependencies trigger it, including raw
`zoomLevel` and the whole `mapSettings` object. A settled pan usually changes a
small minority of the visible set; the code pays 100% of the mount cost.

**Fix:** persistent `Map<address_hash, { marker, ring, styleKey }>` in a ref.
Add only entered keys, remove only exited keys, and for survivors call
`setStyle()` / `setRadius()` only when a cheap `styleKey` string differs. Move
the group teardown into an unmount-only effect (today's cleanup on every dep
change is what makes reuse impossible). Replace 12,000 per-pin closures with one
shared handler reading `e.target.__p`. Identity key is safe: `address_hash` is
guaranteed at `Home.jsx:1232-1240`.

### RC#2 (COMPOUNDS #1) — per-pin styling recomputed on every rebuild
`ManagerMapLayers.jsx:460-518`: a `Date` allocation, an `Array.includes` over a
freshly allocated literal, status chains and dictionary lookups **per pin per
rebuild**, from inputs that never change during a pan.

**Fix:** precompute `_pinColor` / `_pinRadiusFactor` / `_pinConfRingColor` in the
projection that already exists at `Home.jsx:1231-1245`, using the identical
expressions. This also removes `highlightRecentlySold`, `oneMonthAgo` and
`STATUS_COLORS` from RC#1's trigger list. **Land this first** — it makes RC#1's
`styleKey` a string compare.

### RC#3 (PRIMARY, upstream) — `effectiveProperties` has no incremental path
`Home.jsx:1196-1271`, keyed on `logs`. Any log write re-derives
`determineEffectiveStatus` for the entire loaded set, then re-runs the dedup
pass, then fans out to `availableProperties` (1305), `hydratedSavedRoutes`
(1310, which builds its own full Map and re-derives every route door),
`savedRouteOverviewPoints` (1371), `heatmapData`, `stateClusters`,
`BoundaryOverlays` (2360), `GpsTrackerMapLayers` (2373), `HomeUnifiedSearch`
(2615). The codebase already documents this cost twice (comments at
`Home.jsx:1097-1102` and `1148-1151`) and works around it with an optimistic
write path and a deferred invalidation — the workaround only covers the
checklist-open case.

**Fix:** split into a geometry/territory stage keyed on
`[properties, territoryZips, zipCodeFilter, drawnPolygon, assignedHashes]` and a
status stage keyed on `[stage1, logs]` that reuses the previous projected object
by identity when a property's log bucket reference is unchanged. Preserving
object identity is what lets the downstream memos bail out cheaply.

### RC#4 (NEW — missed by the report) — `effectiveProperties` retriggers async route hydration
`Home.jsx:1273-1285`: the hydration effect depends on `effectiveProperties`, so
every recompute re-runs `hydrateRoutesForMap`, which sets
`serverHydratedSavedRoutes`, which recomputes `hydratedSavedRoutes`, which
rebuilds the entire `SavedRoutesLayer` (`ManagerMapLayers.jsx:608-772`, budget
40,000 pins). One log write can therefore cost a network round trip plus two
full layer rebuilds. Fix: key the effect on a stable route manifest signature
(the existing `savedRouteOverviewKey` pattern at 1383) rather than the property array.

### RC#5 (NEW — missed by the report) — GpsTracker does O(n) work per GPS fix, twice
`GpsTracker.jsx:54-64,70,126`. Two `watchPosition` watches; each fix spreads
every property in the account into a new object before filtering to 500ft.
**Fix:** hoist `useGpsTracker` to one instance shared by `GpsMapLayer` and
`GpsHud`; pre-filter by a cheap lat/lng bounding box before the haversine map;
memoize the click handlers (line 112).

### RC#6 (NEW — the report deferred this) — viewport merge grows unbounded and reallocates the whole array
`useViewportMapProperties.jsx:73-76`: every viewport fetch merges into
`mergedRef` (never evicted) and calls
`setViewportProperties(Array.from(mergedRef.current.values()))` — a brand-new
array containing **everything accumulated this session**. That new identity
invalidates `properties` → `effectiveProperties` → the entire fan-out above,
while the manager pans. Fix: skip the state write when the fetch adds no new
keys, and cap/evict the merge set (e.g. by distance from the current view).

### SECONDARY / monitor
Confidence rings below 1,200 pins allocate a second marker per pin
(`ManagerMapLayers.jsx:492-503`) — fold into RC#1's store as an optional second
entry per key. `MapDrawTool` index keys: cleanup, not a contributor.

---

## 3. Proposed landing order

| # | Change | Files | Impact | Risk |
| --- | --- | --- | --- | --- |
| 1 | Precompute pin styling upstream (RC#2) | `Home.jsx`, `ManagerMapLayers.jsx` | Removes 3 rebuild triggers, makes #2 cheap | Low |
| 2 | Diffed keyed marker store (RC#1) | `ManagerMapLayers.jsx` | Largest single win on pan/zoom | Medium |
| 3 | Zoom: one config source + `zoomSnap 0.25` + banded `zoomLevel` (A1+A2) | `Home.jsx`, `MapHelpers.jsx` | Fixes the trackpad symptom | Low |
| 4 | Viewport merge no-op guard + eviction (RC#6) | `useViewportMapProperties.jsx` | Stops pan-time full recomputes | Low |
| 5 | Split the status memo + hash-Map deep link (RC#3) | `Home.jsx` | Log writes stop touching 20k records | Medium |
| 6 | Hydration effect keyed on route signature (RC#4) | `Home.jsx` | Removes hidden rebuild amplifier | Low |
| 7 | Single GPS watch + bbox prefilter (RC#5) | `GpsTracker.jsx` | Fixes lag while tracking | Low |

## 4. Verification plan per step

- Pixel check: same territory, same color scheme, before/after screenshots at
  zoom 13 / 15 / 17 — pin color, radius, border width, confidence rings identical.
- Long-task profile: settled pan at zoom ≥ 16 in a 12,000-pin view must no longer
  show a single multi-thousand-marker synchronous task.
- Interactivity: click one pin of each class (ELIGIBLE, NO_ANSWER, CALLBACK,
  SOLD, recently-sold magenta, high/verified confidence) and confirm
  `setSelectedProperty` still receives the right property.
- Benchmark all three pin bands separately (5k / 8k / 12k) — regressions hide in
  the top band only.
- Log an outcome with the checklist closed and confirm no map stall.

**Not yet measured:** these are code-path conclusions, not profiler traces. A
Performance recording of one settled pan at 12,000 pins before step 2 would give
us a hard baseline number to hold the fix to.

---

## 5. What landed

| Step | Change | Files |
| --- | --- | --- |
| 1 | Pin styling extracted + cached per property, invalidated by a style-context key | **new** `components/map/pinStyle.js`, `ManagerMapLayers.jsx` |
| 2 | Diffed keyed marker store (add/remove/restyle), one shared click handler, unmount-only teardown | `ManagerMapLayers.jsx` |
| 3 | `zoomSnap 0.25` / `zoomDelta 0.5` / `wheelPxPerZoomLevel 120` / `wheelDebounceTime 20`; dead `map.options` override deleted; layer zoom banded with `Math.floor` | `Home.jsx`, `MapHelpers.jsx` |
| 4 | Viewport merge: no state write when a fetch adds nothing; 30k cap with refetchable eviction | `useViewportMapProperties.jsx` |
| 6 | Route hydration keyed on `effectiveProperties.length` + a ref, not identity | `Home.jsx` |
| 7 | One shared geolocation watch; bounding-box prefilter before haversine | `GpsTracker.jsx` |
| — | Deep-link route load uses a hash→property Map | `Home.jsx` |

The pin effect's dependency array went from 10 entries to 4
(`fastPinsMap, visiblePins, styleContext, handlePinClick`); `highlightRecentlySold`,
`oneMonthAgo`, `STATUS_COLORS`, raw `pinSize`/`zoomLevel`, the whole `mapSettings`
object and the unused `mode` are no longer rebuild triggers.

### Deferred: step 5 (`effectiveProperties` memo split)

Not attempted, deliberately. The reuse condition the report proposes (compare the
cached `logsByAddress` array reference) cannot work as written — `logsByAddress`
is rebuilt inside the memo, so every reference is new and nothing would ever be
reused. Doing it correctly needs a content-based per-property log signature, which
changes how `determineEffectiveStatus` is fed and carries real
wrong-status-on-a-door risk. Step 6 removes the most expensive consequence of the
churn (the network round trip + saved-route rebuild per log write), so this should
be re-measured before being attempted.

### Also worth noting

`Home.jsx` is 2,841 lines and is now at the platform's hard edit ceiling —
edits that add lines are rejected. The three changes above had to be written
line-neutral-or-shorter. It needs an extraction pass (the `onPullComplete`
handler and `generateRoutes` are the obvious candidates) before further work
lands there.

## 6. Verification actually performed

- Reviewed the resulting pin-layer region line by line; the legacy rebuild loop is
  fully removed with no dangling dependency array.
- Confirmed `leafletPatches` only sets `L.Canvas` `tolerance: 12` and does not
  re-dispatch events, so `e.target.__property` on the shared handler resolves to
  the clicked marker — clicks keep working.
- Loaded /Home in the preview: the app boots and the map renders a dense
  multi-thousand-pin territory without errors.

**Not verified — needs a human pass:**
- Pixel diff of the territory pin layer before/after (the screenshot above is
  Routes mode, which uses `SavedRoutesLayer`, not the changed layer). Switch to
  Builder/pins mode with a color scheme + confidence rings visible and compare.
- Trackpad feel, and that fractional zoom does not change pin size mid-band.
- Clicking each pin class to confirm the correct property opens.
- Profiler numbers at the 5k / 8k / 12k bands.