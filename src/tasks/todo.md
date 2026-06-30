# Plan

## Current Plan — Knock Callback Contact Prompt
- [x] Add a callback-specific prompt in the Knock property sheet when a rep taps Callback.
- [x] Require homeowner/contact name and phone before saving the Callback outcome.
- [x] Save the name, phone, optional time, and notes into the existing interaction log text so it appears automatically in History.
- [x] Keep all other outcome buttons and the freemium gate behavior unchanged.
- [x] Verify with production build and document the result.

### Review — Knock Callback Contact Prompt
Callback now opens a focused contact prompt inside the Knock property sheet instead of immediately saving. The rep must enter a name and phone number before Save Callback records the CALLBACK outcome. The saved interaction log includes the contact name, phone, optional callback time, and any existing note in `raw_input_text`, so it appears in the property History through the existing logging path. Other outcomes and the Knock limit gate remain unchanged. Production build passes.

## Previous Plan — Data Pull Progress + Route Generation Handoff
- [x] Keep the import overlay visible until route generation has actually started/finished its handoff, so users do not see a dead gap after data import completes.
- [x] Replace noisy long ETA math with conservative stage-based timing/counter text that cannot show inflated estimates like 12 minutes for normal Precision pulls.
- [x] Make the data counter emphasize records found/ready and only show expected totals when available.
- [x] Remove user-facing provider names from the pull panel, preview/start/success/error messages, and progress copy.
- [x] Verify with production build and document the result.

### Review — Data Pull Progress + Route Generation Handoff
Updated the Precision pull flow so completion moves straight into route building instead of closing the import overlay and waiting for a delayed auto-generate tick. The route builder now uses the completed job ID through a ref so fresh pulled records are available immediately for route generation. Replaced noisy percent-rate ETA estimates with safer stage text like “Usually under 2 minutes” and “Almost done,” and changed the counter to show records checked plus records ready for routes. Removed visible BatchData/provider wording from the pull panel, preview/start/success/error messages, Builder mode copy, and billing plan copy. Final provider-word scan for map/pages returned no visible matches, and production build passes.

## Previous Plan — Precision Max Available Pull Count
- [x] Add a count mode to Precision pulls: fixed amount or max available.
- [x] Add a Max Available button while keeping the normal editable property count.
- [x] Send the selected count mode with the BatchData pull request and store it in job metadata.
- [x] Ensure fixed input edits switch back to fixed-count mode.
- [x] Verify the app builds and document the result.

### Review — Precision Max Available Pull Count
Added Fixed Count / Max Available controls to the Precision Pull panel. Fixed Count keeps the normal editable property amount. Max Available sets the pull cap to the current plan limit and sends `count_mode: max_available` with the BatchData pull, while the backend stores that mode in the job metadata. Editing the property count switches back to fixed mode. Route generation already uses the actual homes found after the pull, so fewer-than-cap results still generate normally as long as at least one active home is returned. Production build passes.

## Previous Plan — Ghost Toggle Gate for Previous-Area Pulls
- [x] Add a local Ghost-visible state listener inside the Precision pull controller.
- [x] Clear previous-area selection when Ghost is turned off or a normal new area is drawn.
- [x] Treat previous-area repull settings as active only when Ghost is on and a ghost area is selected.
- [x] Keep standard Precision Builder pulls on the normal new-area payload.
- [x] Verify production build and document the result.

### Review — Ghost Toggle Gate for Previous-Area Pulls
Previous-area repull state is now gated behind the Ghost toggle. Turning Ghost off clears the selected previous area and resets repull/full-refresh/follow-up options. Normal draw and normal Precision Pull Data now clear stale ghost selection, and the submit payload only sends repull fields when Ghost is on and a ghost area is selected. Standard Builder Precision pulls now send `repull_mode: new_area`, no previous pull date, no unresolved-follow-up flag, and no forced full refresh. Production build passes.

## Previous Plan — Ghost Builder Pull Screen Fit + Repull Criteria
- [x] Fix the ghost-only Precision Pull screen so it is not clipped at the top and can scroll safely on mobile.
- [x] Make ghost mode visually/verbally unique from normal new-area pulls.
- [x] Remove the confusing Same Criteria option.
- [x] Keep Fill Gaps as a full refresh of the previous area and add a clear unresolved-follow-up checkbox for not-home/callback/non-final decisions.
- [x] Make Max Since Last send the real sold-date range from the previous pull date to today, not a 12-month-style pull.
- [x] Verify the BatchData request preview/dry-run behavior and production build.
- [x] Document results and update lessons for this correction.

### Review — Ghost Builder Pull Screen Fit + Repull Criteria
Updated the previous-area screen into a distinct Ghost Builder refresh panel with safe top/bottom spacing, a scrollable body, and a fixed action footer so it no longer clips under the app header. Removed Same Criteria. Fill Gaps now defaults for previous areas, keeps the prior criteria, sends the full-refresh flag, and includes a checkbox for unresolved follow-up doors. Max Since Last now bypasses the 12-month selector and sends a sold-date window from the last pull date to today; verified a June 17 previous pull produces BatchData `intel.lastSoldDate.minDate = 2026-06-17`. Verified the dry-run payload preserves `include_unresolved_followups: true` and production build passes.

## Previous Plan — Builder Previous-Area Ghosts + Repull Workflow
- [x] Review lessons before planning, especially route/polygon overlay visibility and repull/delta-pull rules.
- [x] Inspect current previous-area storage/rendering and confirm the bug: `PolygonHistory` currently hides history in Builder and can show it outside Builder, which is opposite of the requested behavior.
- [x] Add a Builder-only ghost toggle button to the map toolbar using a ghost-style icon/label; default off so previous areas do not clutter routes.
- [x] Make previous drawn areas render only when Builder mode is active, no active route is selected, no route panel is open, and the ghost toggle is on.
- [x] When a ghost area is tapped, restore that polygon as the active Builder area so Pull Data can run over the exact same drawn area.
- [x] Store lightweight pull metadata with polygon history entries when available: last pull date, criteria used, and job ID, so reused areas can show “last pulled” context.
- [x] Extend the Precision Pull panel for reused ghost areas with clear choices: Same Criteria, Fill Gaps / Full Refresh, and Max Since Last Pull.
- [x] Wire those choices to the existing BatchData pull path without changing normal new-area pulls: same criteria reuses the last criteria, fill gaps sends the existing full-refresh flag, and max-since-last-pull uses the current area plus last-pull context to request the freshest allowed homes.
- [x] Ensure ghost overlays never appear on active/completed route views or active selected route overlays.
- [x] Verify with a production build and at least one backend request-preview/dry-run path before marking complete.

### Review — Builder Previous-Area Ghosts + Repull Workflow
Added a Builder-only ghost toggle that reveals previous drawn areas only inside Builder, never while viewing active/completed routes or selected route overlays. Tapping a ghost area restores the exact polygon, opens Pull Data, and offers Same Criteria, Fill Gaps, or Max Since Last Pull. Pull history now stores criteria/job metadata, fill-gaps is passed through to the BatchData job, and max-since-last computes a fresh sold-date window from the previous pull date. Verified the processor request preview sends `intel.lastSoldDate.minDate` for an 18-day repull (`2026-06-12`), verified non-Pro direct short repull calls are rejected, and confirmed production build passes.

## Previous Plan — Precision 1-Day Range + Paywall Gate
- [x] Trace the Precision pull date-range UI and submitted payload.
- [x] Replace the 9-month option with a 1-day option.
- [x] Gate 1 day, 2 day, 1 week, 2 week, and 1 month in the UI for non-Pro users.
- [x] Add a backend guard so non-Pro users cannot bypass the UI and call short ranges directly.
- [x] Verify the BatchData request still uses `intel.lastSoldDate.minDate` for the selected day/week/month range.
- [x] Run backend request preview and production build verification.

### Review — Precision 1-Day Range + Paywall Gate
Replaced the old 9-month option with 1 day in the Precision pull selector. 1 day, 2 day, 1 week, 2 week, and 1 month are now locked for non-Pro users in the UI, and `startBatchDataPull` also rejects those ranges for non-Pro callers so the gate cannot be bypassed. Verified `processFetchChunk` sends BatchData `intel.lastSoldDate.minDate` for 1 day (`2026-06-29` on 2026-06-30), verified the backend free-user guard returns `upgrade_required`, and confirmed the production build passes.

## Previous Plan — Map Active/Completed Route Toggle
- [x] Trace the map toolbar toggle state and what it sends to the map layers.
- [x] Trace how saved routes are grouped/rendered as active vs completed on the map.
- [x] Fix the map filter so Active shows only non-completed routes and Completed shows completed routes.
- [x] Ensure completed routes remain findable from the map after finishing a route.
- [x] Verify with a production build and document results.

### Review — Map Active/Completed Route Toggle
The map status toggle now returns the map to route-overview mode, clears any selected active route, re-enables route pins/lines, and switches between Active and Completed overlays. Completed routes no longer get removed by the saved-route date filter, so finished routes remain findable directly from the map. Production build passes.

## Previous Plan — Rerun Route Knock Tab Hydration
- [x] Trace how selected queued routes are stored before opening Knock mode.
- [x] Trace how RepHome loads a selected route and hydrates route homes.
- [x] Fix rerun route hydration so all selected rerun homes appear in Knock mode.
- [x] Verify with a production build and document results.

### Review — Rerun Route Knock Tab Hydration
Rerun routes now treat homes as fresh stops in Knock mode by ignoring visit outcomes that happened before the rerun was created. Knock mode also loads logs by the active route ID in addition to property hashes, so homes knocked on the rerun remain tracked even when legacy/canonical hashes differ. Production build passes.

## Previous Plan — Separate Rerun Route Category
- [x] Identify rerun-created routes using their rerun metadata/name marker.
- [x] Exclude rerun routes from the normal In Progress, Queued, Pending, and Completed sections.
- [x] Add a dedicated Reruns section that keeps the same Start/Split/Delete behavior.
- [x] Run a production build and document the result.

### Review — Separate Rerun Route Category
Rerun-created routes are now detected from rerun metadata or the rerun name marker, removed from the normal status sections, and shown in their own Reruns section in Route Command. The route cards keep the same Start, Split, Delete, and selection behavior. Production build passes.

## Previous Plan — Completed Route Rerun Map Glitch Fix
- [x] Confirm why Unsold Follow-Up can make the selected map route disappear.
- [x] Preserve hydrated route properties by matching selected rerun hashes against address, legacy, and id aliases.
- [x] Add stronger event suppression to rerun menu taps so Leaflet does not receive the touch/click.
- [x] Run a production build and document the result.

### Review — Completed Route Rerun Map Glitch Fix
Fixed the rerun glitch by preserving the selected route's hydrated properties when creating a rerun. Rerun selection now matches each selected hash against `address_hash`, `legacy_hash`, and `id`, so Unsold Follow-Up does not create a selected route with empty map pins. The same hydrated-property preservation was applied to route-card reruns. Rerun menu taps now also stop immediate pointer/click propagation so Leaflet does not receive the underlying tap. Production build passes.

## Previous Plan — Completed Routes Map Toggle + Rerun
- [x] Add a map-level route status view toggle beside the existing eye control: Active vs Completed.
- [x] Keep the existing eye button as visibility on/off, and make the new toggle control which saved-route status group is shown.
- [x] Filter map route overlays so Active shows PENDING/ACTIVE/IN_PROGRESS routes and Completed shows only COMPLETED routes.
- [x] When a completed route is selected on the map, keep its pins visible and color SOLD pins clearly green while keeping other outcomes visually distinct.
- [x] Add an easily accessible Rerun Route action directly in the selected completed-route toolbar/banner, reusing the same rerun-create behavior from completed route cards.
- [x] Ensure the new rerun creates a new ACTIVE route and leaves the completed historical route untouched.
- [x] Run a production build and document the result.

### Review — Completed Routes Map Toggle + Rerun
Added an Active/Done map toggle beside the existing route visibility eye. The eye still controls whether route overlays are shown, while the new toggle filters the map between active/in-progress/pending routes and completed routes. Selecting a completed route keeps it visible as the active route, with SOLD/qualified pins highlighted green and other outcomes differentiated. The selected completed-route banner now includes a Rerun action with the same All Doors, No Answer, Callbacks, and Unsold Follow-Up options used in route cards; reruns create a new ACTIVE route and leave the completed route untouched. Production build passes.

## Previous Plan — Completed Route Rerun
- [x] Inspect completed route card rendering and current Start Route behavior.
- [x] Add completed-route outcome stats using the latest logged decision per door.
- [x] Replace Start Route with Rerun for completed routes.
- [x] Add a simple rerun menu for all doors, no-answer doors, callbacks, and unsold follow-up doors.
- [x] Save a rerun as a new active SavedRoute and open it on the map/Knock flow.
- [x] Run a production build and document the result.

### Review — Completed Route Rerun
Completed route cards now show outcome stats for Sold, No Answer, Callback, and Not Interested based on the latest decision per door. Completed routes use a Rerun Route button instead of Start Route; tapping it opens simple choices for All Doors, No Answer, Callbacks, or Unsold Follow-Up. Choosing one creates a new active SavedRoute with the selected property hashes, opens it through the existing map/Knock route selection flow, and leaves the original completed route untouched. Production build passes.

## Previous Plan — Rep Property Sheet Visibility Polish
- [x] Make the Add Details button label white and remove the helper text under it.
- [x] Keep notes, phone, callback, and photo proof available inside the expanded dropdown.
- [x] Lift the property sheet above the bottom navigation so both map buttons are visible.
- [x] Run a production build and document the result.

### Review — Rep Property Sheet Visibility Polish
Updated the property detail sheet so Add Details is white with no helper text underneath, while the notes, phone, callback, and photo proof inputs remain inside the expanded dropdown. Lifted the sheet above the bottom navigation so the View on FirstKnock Map and external map buttons are no longer covered. Production build passes.

## Previous Plan — Rep Property Add Details Visibility
- [x] Locate the Add Details control in the property detail sheet and identify why it is hard to see.
- [x] Move the Add Details control into the always-visible main sheet area without changing outcome logging behavior.
- [x] Make the collapsed Add Details button high-contrast and clearly tappable.
- [x] Keep the notes, phone, callback, and photo proof inputs connected to the existing log flow.
- [x] Run a production build and document the result.

### Review — Rep Property Add Details Visibility
The Add Details control was present but buried in the lower scrollable extras area with very low contrast. Moved it directly under Log Outcome in the main property sheet, restyled it as a high-contrast green action card, and kept the existing note, phone, callback time, and photo proof fields wired to the same outcome logging flow. Production build passes.

## Previous Plan — Map Toolbar Dropdown Polish
- [x] Inspect the selected active-route dropdown controls and keep behavior unchanged.
- [x] Replace the white/native-looking dropdown styling with dark FirstKnock glass styling.
- [x] Ensure opened menu options use dark backgrounds where browser styling allows.
- [x] Run a production build and document the result.

### Review — Map Toolbar Dropdown Polish
Polished the active-route Assign, Dates, and Price dropdowns with a darker FirstKnock glass look, stronger borders, green focus states, and dark option backgrounds/color-scheme so the opened menus no longer default to a stark white look where browser styling allows. Behavior is unchanged. Production build passes.

## Previous Plan — BatchData Intel Property Details
- [x] Confirm where BatchData records are mapped into stored properties.
- [x] Confirm where generated route candidates read stored property detail fields.
- [x] Expand the BatchData mapper to persist intel estimated value, building sqft, build year, and last sold date/price into the existing property fields used by route details.
- [x] Verify with a backend synthetic BatchData payload and production build.
- [x] Document the result.

### Review — BatchData Intel Property Details
Updated the BatchData property mapper so `property.intel` now feeds the existing route-detail fields: estimated value → `price`, building square footage → `sqft`, build year → `year_built`, last sold date → `sold_date`, and last sold price as sale evidence. Route candidates already return those fields to the map and detail screens, so no UI changes were needed. Verified with a synthetic BatchData payload containing only intel values; it mapped to an active property with `price: 425000`, `sqft: 2184`, `year_built: 2006`, and `sold_date: 2026-06-28`. Production build passes.

## Previous Plan — Area-Based Route Naming
- [x] Locate the stock route naming source in frontend generation, backend large-route generation, and save-time persistence.
- [x] Add area-aware naming that prefers county, then city, then ZIP, then street.
- [x] Replace repeated stock names like “Precision Route 1” before routes are saved.
- [x] Preserve manual/custom route names and existing route behavior.
- [x] Run build/backend verification and document the result.

### Review — Area-Based Route Naming
New route names now prefer county, then city, then ZIP, then street, producing names like “Oconee County Precision Route 1” instead of repeated “Precision Route 1.” The save path also renames any future stock-named generated route before persistence while preserving custom/manual names. Production build passes, and backend large-route generation returned area-based names in a sample test.

## Previous Plan — Route Command UI Polish
- [x] Inspect the existing Route Command panel and active route card workflow.
- [x] Replace the prominent per-route Split Route CTA with a primary Start Route CTA.
- [x] Keep Split Route available as a secondary route action instead of the main workflow.
- [x] Move/select Merge and Delete All into a polished top command bar.
- [x] Verify the changed JSX paths for active route selection, merge mode, split access, and delete-all access.
- [x] Apply the same Start Route/Split treatment to the By Rep route cards.

### Review — Route Command UI Polish
Route cards now lead with Start Route, while Split is still available as a secondary action in both Active and By Rep route lists. The active routes tab now has a cleaner command bar at the top with route count, select-to-merge/merge controls, and Delete All grouped in one polished action area. Production build passes.

## Previous Plan — Knock Mode Freemium Gate + Setup CSV Import Fix
- [ ] Remove Import CSV from the main Builder bottom workflow so Builder only shows Draw/Pull Data controls.
- [ ] Trace the existing Setup import flow and identify why uploaded CSVs do not populate the map.
- [ ] Reuse the Redfin/CSV parser from the existing import work inside Setup’s Import Data flow instead of keeping CSV import in Builder.
- [ ] After Setup CSV import succeeds, save properties with `data_source = redfin_csv`/`csv_import`, create or activate the related SavedRoute, and open it on the map with the same Knock/Analytics compatibility as drawn/Builder routes.
- [ ] Add `outcomes_logged` to the User schema with default 0 and null-safe handling.
- [ ] Locate every Knock Mode outcome-save path and route all outcome logging through one guarded save helper.
- [ ] For free/null-plan users, atomically block the 51st lifetime outcome before any route/property state changes; increment only after a successful save for attempts 1–50.
- [ ] For Pro/upgraded users, bypass the gate entirely with no counter increment and no UI changes.
- [ ] Add the mobile bottom sheet upgrade prompt, post-dismiss disabled outcome state, and persistent Knock Mode upgrade banner.
- [ ] Re-check user plan and latest counter on every outcome tap so upgrades in another tab lift the gate on the next tap.
- [ ] Verify as much as possible with code-level tests/build, then keep the 12 manual QA checks open until they pass.

### Implementation Notes
- Existing UpgradeGate (25-house, log-count based) replaced by spec-compliant 50-outcome persisted gate.
- Setup CsvUploader already wires prepareRedfinCsvImport for Redfin files; the silent failure happens for non-Redfin CSVs and when the user is unauthenticated. Generic CSVs go through processPropertyImport but never create/open a route — fixing by routing the "create" flow to also build + open a route on the map.

### Review — Knock Mode Freemium Gate + Setup CSV Import Fix
Done & build-verified:
- Removed Import CSV from the Builder bottom toolbar (Builder now shows only Draw/Pull Data; Routes button already gated to non-Builder mode).
- Setup → Import Data: generic CSVs now build + open a route on the map (`?savedRoute=`), same as the Redfin path, so imported data flows into Knock & Analytics as another data source. Redfin auto-detection still works.
- Added `outcomes_logged` (default 0) to User; initialized all 52 existing users to 0.
- New `knockGate.js` is the single source of truth: 50-outcome free limit, null-safe counter + plan tier, Pro/owner/exempt bypass.
- RepHome routes all outcome logging through one guarded `handleLog`: re-fetches user each tap (mid-session upgrade lifts the gate), atomic re-entrancy guard, blocks the 51st attempt before any save, increments the persisted counter only after a successful create (Pro never increments/checks).
- Added `KnockLimitSheet` (mobile bottom sheet via createPortal: lock icon, heading, body, "Upgrade to Pro" → Billing, "Maybe later" / tap-outside dismiss) and `KnockLimitBanner` (persistent "Upgrade to log more outcomes" after dismissal). PropertyDetailSheet outcome buttons gray out + not-allowed when disabled and re-fire the sheet on tap.
- No free-facing usage counter anywhere. Removed obsolete UpgradeGate.

Remaining: the 12-point manual QA checklist should be run in-app via the Testing Agent (live free vs Pro accounts, BatchData vs CSV routes) before declaring fully complete.

## Previous Plan — Builder Toolbar Routes Button
- [x] Locate the Builder/Routes bottom toolbar rendering in MapToolbar.
- [x] Hide the bottom ROUTES button only while Builder mode is active.
- [x] Verify the app builds and document the result.

### Review — Builder Toolbar Routes Button
Removed the bottom ROUTES button from active Builder mode so Builder shows only Draw/Pull Data and Import CSV actions, while Routes mode still keeps the Routes button. Production build passes.

## Previous Plan — Redfin CSV Import-to-Route Workflow
- [x] Inspect current Setup CSV uploader, map builder entry points, route storage, hydration, and route optimization behavior.
- [x] Add Redfin CSV auto-detection using fuzzy header matching for ADDRESS, CITY, STATE OR PROVINCE, ZIP OR POSTAL CODE, LATITUDE, and LONGITUDE.
- [x] Add a focused Redfin CSV parser/cleaner that skips disclaimer rows, filters unplottable rows, deduplicates by ADDRESS + ZIP, cleans ZIP strings, parses Month-DD-YYYY sold dates, converts NaN/missing numeric values to null, and preserves unmapped fields in raw metadata.
- [x] Add a summary screen before saving with ready/skipped/duplicate counts plus Create Route and Cancel actions.
- [x] On Create Route, save valid properties and a SavedRoute named from the filename with source metadata, immediately set/open it on the map, and preserve existing route behavior by using the same SavedRoute/property_hash pattern.
- [x] Use CSV coordinates directly and geocode only rows that have an address but missing coordinates.
- [x] Add an Import CSV button in Builder Mode beside the existing Draw/Builder controls that opens the same upload flow.
- [x] Keep non-Redfin CSV and JSON behavior unchanged.
- [ ] Verify all 12 requested tests, including build verification, before marking complete.

### Review — Redfin CSV Import-to-Route Workflow
Implementation is in place. Code-level verification passed for Redfin detection on all three attached files, disclaimer-row skipping, route-name cleanup, ZIP cleanup, Month-DD-YYYY sale-date parsing, raw metadata preservation, non-Redfin fallback, >1,000-row rejection, mocked route-save metadata/source payload, and production build. Full in-app click-through tests remain open and should be run in the preview/Testing Agent before marking this task complete.

## Previous Plan — Precision Short Date Range Pro Gate
- [x] Use the existing User subscription fields as the plan source of truth: `subscription_tier` plus subscription status; unknown/null remains free.
- [x] Persist `subscription_tier` from checkout/webhook metadata for new Precision subscriptions.
- [x] Gate only the Precision Pull Panel short ranges: 1 wk, 2 wk, and 1 mo.
- [x] Show locked free-state styling with a lock/Pro badge while leaving 3, 6, 9, and 12 months unchanged.
- [x] Add desktop hover upgrade prompt and mobile bottom sheet, both linking to `/Billing?plan=precision`.
- [x] Fallback legacy free selections to 3 months with the required toast.
- [x] Verify plan detection, locked-option behavior, upgrade navigation target, and production build.

### Review — Precision Short Date Range Pro Gate
Implemented Pro gating only inside the Precision Pull Panel date range selector. The source of truth is `User.subscription_tier` plus active/trialing subscription status; null/unknown values behave as free. Free users see 1 wk, 2 wk, and 1 mo grayed out with lock/Pro indicators, desktop hover shows the upgrade prompt, mobile tap opens the upgrade bottom sheet, and both CTAs route to `/Billing?plan=precision`. 3, 6, 9, and 12 months remain selectable. Legacy free selections fall back to 3 months with the required toast. Checkout/webhook now persist `subscription_tier` for new subscriptions. Verified plan logic for free, null, Pro, and trial Pro states, and confirmed the production build passes.

## Previous Plan — Split Route Saved Batch Workflow
- [x] Explain current status: Split Route existed only as a limited generated-route splitter, not on saved/active routes.
- [x] Add SavedRoute child-route metadata fields while preserving existing route access rules.
- [x] Create a reusable split-route modal with stops/day, optional start date, all/per-batch rep assignment, preview, and confirm.
- [x] Add Split Route access to the selected active-route toolbar with mobile-friendly overflow for secondary actions.
- [x] Add Split Route access from manager saved-route cards, including Active and By Rep views.
- [x] Save child routes as independent SavedRoute records without modifying the original route.
- [x] Verify split math, route payload shape, and production build.
- [x] Document the result.

### Review — Split Route Saved Batch Workflow
Split Route previously only existed as a limited generated-route splitter in the New Routes tab, so it was not available on saved/active routes. Added a saved-route Split Route workflow with child-route metadata, a reusable modal for stops/day, optional dates, all/per-batch rep assignment, preview, and confirmation. Added a clear SPLIT ROUTE button to the selected route toolbar with mobile overflow for secondary actions, plus SPLIT ROUTE actions on manager saved-route cards in Active and By Rep views. Confirm creates independent child SavedRoute records and leaves the original route intact. Verified 53 stops at 25/day splits into 25/25/3, verified child route payload shape, and confirmed the production build passes.

## Previous Plan — Active Route CSV Export
- [x] Add a focused CSV export helper for route property lists.
- [x] Add an EXPORT button to the selected/active route toolbar.
- [x] Export the full active route list, not only filtered/visible properties.
- [x] Verify with a sample route payload and production build.
- [x] Document the result.

### Review — Active Route CSV Export
Added a focused route CSV export helper and an EXPORT button in the selected/active route toolbar. The export uses the full active route property list and includes stop number, address, owner, value, beds/baths, sqft, lot size, year built, sold date, sale type, property type, coordinates, and address hash. Verified CSV formatting with a sample route payload and confirmed the production build passes.

## Previous Plan — Initial Route Metadata Population
- [x] Trace initial route-build data flow from BatchData/property storage through route generation and hydration.
- [x] Identify why route cards only show owner names and miss property metadata.
- [x] Populate core property metadata during the initial build/hydration path without changing route behavior.
- [x] Verify route card data fields and run a production build.
- [x] Document the result.

### Review — Initial Route Metadata Population
Expanded the initial BatchData mapper to capture AVM value, beds, baths, sqft, lot size, year built, sale date, owner, city, and state from more provider field shapes. Added city/state/metadata to the slim map payload so hydrated routes keep full address context, and updated rep route cards/checklist cards to show owner, value, sqft, and build year when available. Verified with a synthetic BatchData mapper test and a production build.

## Previous Plan — Home Screen App Icon
- [x] Find every place the app/home-screen icon is defined for Safari, PWA manifest, and login display.
- [x] Replace the old FirstKnock icon with the newly provided square logo image.
- [x] Keep app name/routing/auth behavior unchanged.
- [x] Verify icon references and run a production build.
- [x] Document the result.

### Review — Home Screen App Icon
Updated the static HTML favicon/apple-touch-icon/precomposed icon, the runtime login/app metadata icon in Layout.jsx, and the PWA manifest icons to use the newly provided square FirstKnock logo. Verified the old URL is gone from those files and the production build passes.

## Previous Plan — RepHome FirstKnock Map Exit
- [x] Locate the RepHome “View on FirstKnock map” overlay and close control.
- [x] Make the exit/X control always visible above top navigation and safe areas on desktop and mobile.
- [x] Preserve existing map/property behavior and only change the exit affordance/layout.
- [x] Verify the code and run a production build.
- [x] Document the result.

### Review — RepHome FirstKnock Map Exit
RepMapView now renders through a body-level portal with z-[9999], so it sits above the app shell instead of under the top/bottom nav. The close/X control is positioned with safe-area top spacing, remains visible on mobile and desktop, and the production build passes.

## Previous Plan — Precision Time Range Paywall
- [x] Locate the Precision Generate 1 wk / 2 wk / 1 month controls and account-active signal.
- [x] Gate those time range options visually and functionally until the account is confirmed active.
- [x] Keep the default/free option usable and avoid changing backend pull logic beyond UI selection rules.
- [x] Verify the UI code and run a production build.
- [x] Document the result.

### Review — Precision Time Range Paywall
The Precision Generate panel now greys out and locks 1 wk, 2 wk, and 1 mo unless the account is confirmed active, while 3+ month ranges remain selectable. Stale locked selections reset to 3 months, submit is guarded, and the production build passes.

## Previous Plan — RepHome Messages Overlay Fix
- [x] Locate why the message thread is still rendering behind the app header and bottom nav.
- [x] Make the messages panel a true fullscreen overlay on mobile and a safe modal/panel on desktop.
- [x] Ensure the close/back controls and composer are always visible above safe areas and nav bars.
- [x] Verify the changed code and run a production build.
- [x] Document the result.

### Review — RepHome Messages Overlay Fix
Moved TeamChat into a body-level portal with a higher isolated z-index so it can no longer be trapped under RepHome/Layout headers or bottom navigation. Confirmed the mobile/thread close controls and safe-area composer are present, and the production build passes.

## Previous Plan — Messages Escape + Roster Photos
- [x] Fix the Messages overlay so it sits above the app top/bottom navigation and uses safe-area spacing.
- [x] Add an always-visible close button when viewing a message thread so users cannot get stuck.
- [x] Add a profile photo field to team members.
- [x] Add image upload/change support directly on roster cards in Command Center > Roster.
- [x] Verify changed files and run a production build.
- [x] Document results.

### Review — Messages Escape + Roster Photos
Messages now open above both nav bars with safe-area headers and an always-visible close button in message threads. Roster cards now support uploading/changing rep profile photos, stored on TeamMember.profile_image_url. Verified the code changes and the production build passes.

## Previous Plan — Mobile Compatibility Enhancements
- [x] Add rubber-band prevention to root/body containers in index.css.
- [x] Add non-selectable touch behavior to interactive UI while preserving selectable text content.
- [x] Replace native selects in RouteCommandPanel and CanvasBuilderSettings with styled Select components.
- [x] Add pull-to-refresh to the My Route list and Appointments list.
- [x] Standardize deep detail overlays with a clear left-aligned back header.
- [x] Verify behavior and document results.

### Review — Mobile Compatibility Enhancements
Added mobile overscroll protection, safer touch selection behavior, styled Canvas selects, pull-to-refresh on My Route and Appointments lists, and iOS-style back headers on detail overlays. Verified there are no remaining native selects in RouteCommandPanel or CanvasBuilderSettings and the production build passes.

## Previous Plan — Tone Down Routes Button
- [x] Make the selected Routes button black.
- [x] Reduce the visual intensity of its border, text, shadow, and count badge.
- [x] Verify the button behavior remains unchanged.

### Review — Tone Down Routes Button
The Routes button now uses a quieter black style with subtle white text, border, shadow, and badge while keeping the same click behavior.

## Previous Plan — Conditional White Reset Filters Button
- [x] Make the active-route RESET FILTERS button white.
- [x] Show it only after the date or price filter is changed.
- [x] Verify it still clears both filters safely.

### Review — Conditional White Reset Filters Button
The RESET FILTERS button is now white, appears only when the date or price filter is changed, and still clears both filters without crashing.

## Previous Plan — Fix Reset Filters Error
- [x] Make the MapToolbar reset handler safe when called without an event.
- [x] Verify RESET FILTERS still clears date and price filters.
- [x] Document the result.

### Review — Fix Reset Filters Error
The reset handler now safely handles missing click events, so RESET FILTERS no longer crashes and still clears both date and price filters.

## Previous Plan — MapToolbar Reset Filters
- [x] Add a visible reset filters button directly in the selected MapToolbar active-route filter area.
- [x] Verify it clears active route date and price filters.
- [x] Document the result.

### Review — MapToolbar Reset Filters
The active route toolbar now always shows a green RESET FILTERS button next to the date and price filters, and it calls the existing reset handler to clear both filters.

## Previous Plan — Filter Reset + Home Screen Dimensions
- [x] Locate the actual filter tab/panel UI and add a visible reset button there.
- [x] Verify the active route toolbar reset remains intact.
- [x] Inspect app install/home-screen metadata and icon sizing.
- [x] Update PWA/mobile metadata so Add to Home Screen uses the correct standalone dimensions and icon.
- [x] Verify filter reset and PWA metadata changes.

### Review — Filter Reset + Home Screen Dimensions
The Data/filter tab now has a visible Reset All Filters button that clears status, sold date, and display filters live, and the app now has proper FirstKnock PWA metadata, standalone display mode, portrait orientation, mobile viewport settings, theme color, and install icons.

## Previous Plan — Active Route Toolbar Cleanup
- [x] Make the active route name standard white in view and edit states.
- [x] Add a reset control that clears active route date and price filters.
- [x] Verify the toolbar still preserves route assignment, save filtered route, optimize, and close behavior.

### Review — Active Route Toolbar Cleanup
The active route name is now standard white, the edit input matches that style, and a Reset button clears date and price filters while preserving existing save, assign, optimize, and close actions.

## Previous Plan — Route Outcome Dot Colors
- [x] Identify where route-line property dots are rendered.
- [x] Add one shared outcome color helper for property dots.
- [x] Apply green/red outcome colors to route map dots and nearby HUD dots.
- [x] Verify the map uses green for positive/follow-up outcomes, red for negative outcomes, and neutral for unworked doors.

### Review — Route Outcome Dot Colors
Route dots now use one outcome color rule: green for sold/callback/qualified-style outcomes, red for hard-no/no-answer/not-moved-in/not-home/do-not-knock outcomes, and neutral gray for untouched doors.

## Previous Plan — Private Account Messaging + Mobile Input Fix
- [x] Identify the current message read/write path and mobile chat layout.
- [x] Add account/team ownership fields to TeamMessage and replace global read access with account-scoped RLS.
- [x] Stamp all newly sent messages with manager/team ownership and explicit participant emails.
- [x] Scope the old General channel per account instead of globally.
- [x] Add mobile bottom-nav-safe spacing so the message input remains visible.
- [x] Verify message privacy rules and mobile layout-sensitive classes.

### Review — Private Account Messaging + Mobile Input Fix
Team messages are now scoped by manager/account ID and participant emails at the entity rule level, new messages are stamped with that account ownership, General is now account-specific, and the mobile chat overlay/input reserves space above the bottom nav and safe area.