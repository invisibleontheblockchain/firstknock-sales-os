# BatchData-Only Phase 1 Migration Execution Plan

Last updated: 2026-05-31

## Current Status

We started the migration safely without touching live ingestion or purging any data.

Completed foundation:
- Added `previewBatchDataArea` dry-run backend function.
- Added `batchDataMigrationAudit` safety audit backend function.
- Expanded `FetchJob` schema for BatchData/Precision metadata.
- Verified both new backend functions deploy and return successfully.

Critical blocker:
- The Kevin/Reif Environmental protection audit returned **0 saved routes and 0 protected hashes** for `kevin@reifenvironmentals.com`.
- Because the user explicitly said Kevin’s data must not be lost, **no purge should happen** until the correct Kevin identity/route ownership mapping is confirmed.

## Verified Results

### Dry-run draw/cost preview
Test payload: small Anderson County polygon.

Result:
- No BatchData call was made.
- Area: `2.71 sq mi`
- FIPS: `45007` / Anderson County, SC
- Estimated record cap: `1,000`
- Estimated max BatchData cost at current plan math: `$10`
- Eligible for Phase 1 Precision pull.

### Migration audit
Result:
- Active/pending FetchJobs: `0`
- Global Neon property count: `7,164`
- RentCast rows: `1,761`
- BatchData rows: `0`
- Rejected rows: `128`
- Kevin protected rows found: `0`

Interpretation:
- System is idle enough for planning/migration work.
- There is legacy RentCast data to remove or replace.
- Kevin protection logic must be fixed before any destructive action.

## Phase Definitions

### Phase 1 — Precision Mode
BatchData-only data pull for deed-confirmed / owner-verified property targeting.

Rules:
- Provider: BatchData only.
- Data source: `batchdata`.
- Input: freehand selected area, converted to area + centroid + county/FIPS.
- Output: route candidates that pass filters.
- No RentCast.
- No MLS-only candidate path.
- No purge until backup/protection passes.

### Phase 2 — Canvas Mode
GPS-only door logging and territory management.

Rules:
- No BatchData dependency.
- No enrichment endpoint.
- Reuses existing outcome logging concepts.
- Uses territory/session/zone/door-log data.
- Must start only after Phase 1 BatchData Precision is verified.

## Required BatchData Field Mapping

Current app fields that must be preserved:
- `address_hash`
- `full_address`
- `house_number`
- `street_name`
- `city`
- `state`
- `zip_code`
- `lat`
- `lng`
- `owner_full_name`
- `beds`
- `baths`
- `sqft`
- `lot_size`
- `year_built`
- `price`
- `sold_date`
- `sale_type`
- `property_type`
- `listing_status`
- `data_source`
- `sale_confidence`
- `original_status`
- `route_active`
- `raw_payload`

BatchData expected source fields from handoff:
- Owner name: `owner.fullName` or `owner.names[0]`
- Owner occupied: `owner.ownerOccupied`
- Address: `address.street`, `address.city`, `address.state`, `address.zip`, `address.latitude`, `address.longitude`
- County FIPS: `address.countyFipsCode` or `ids.fipsCode`
- Bedrooms/bathrooms/sqft/year: `building.*`
- Sale date/price: `sale.lastSale.recordingDate`, `sale.lastSale.saleDate`, `sale.lastSale.price`
- Listing status: `listing.status` or `listing.statusCategory`
- Corporate owner: `quickLists.corporateOwned`
- Recently sold: `quickLists.recentlySold`
- Stable ID: `ids.addressHash`

## Cost Model v1

Current assumption from strategy docs:
- BatchData plan: `$1,000/month`
- Included records: `100,000/month`
- Effective cost per record: `$0.01`
- Hard cap per Phase 1 pull: `1,000 records`
- Max direct cost per full pull: `$10`
- Precision price: `$99/user/month`

Break-even math:
- 1 Precision user at 1 full pull/month costs about `$10`, leaving about `$89 gross margin` before infrastructure.
- 100 Precision users at 1 pull/month consume `100,000 records`, matching the $1,000 plan.
- Break-even vs the BatchData plan is about `11 Precision users` at $99/user/month.

Canvas Mode:
- BatchData cost: `$0`
- Data model: GPS door logs only
- Price target: `$19/rep/month`
- Main costs: app/database/infrastructure, not property records.

## Usage Cap Model

For no-cost draw preview:
- Compute polygon area.
- Resolve centroid to county/FIPS.
- Estimate county count and record cap.
- Show estimated max cost.
- Do not create FetchJob.
- Do not call BatchData.

For paid Phase 1 pull:
- Free user cap: `40 sq mi`
- Paid user cap: `300 sq mi`
- County cap: start with `1 county/FIPS per pull`
- Record cap: `1,000 records per pull`
- Hard reject oversized areas.
- Never auto-clip the user’s area silently.

Whole-US protection:
- Server-side area cap.
- County count cap.
- Estimated record count cap.
- Monthly pull/record caps.
- Dry-run preview before paid pull.
- Clear error message instead of expensive API call.

## Safe Migration Order

1. Confirm Kevin identity and protected route ownership mapping.
2. Backup Kevin/Reif Environmental saved routes, logs, and property hashes.
3. Add Neon schema columns for BatchData fields.
4. Add BatchData mapper and validator in a small shared module/function.
5. Add BatchData sandbox/API sample tester.
6. Update `fetchAreaProperties` from radius/sub-circles to dry-run/FIPS/polygon metadata.
7. Update `processFetchChunk` to BatchData-only Phase 1.
8. Update `routeFilterPipeline` to trust `data_source='batchdata'` and remove RentCast/MLS gates.
9. Run comparison against known-good Kevin/current routes.
10. Only then purge/deactivate legacy RentCast rows that are not protected or referenced.

## Do Not Do Yet

- Do not purge RentCast records.
- Do not disable Kevin routes.
- Do not start Canvas Mode implementation.
- Do not remove legacy fields until reads are confirmed migrated.
- Do not call paid BatchData endpoints for area testing until dry-run and sandbox validation are complete.