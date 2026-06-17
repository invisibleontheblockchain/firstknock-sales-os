# Plan

## Current Plan — Knock Mode Freemium Gate + Setup CSV Import Fix
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
In progress.

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