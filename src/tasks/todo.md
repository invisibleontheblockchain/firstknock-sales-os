# Current Task: Audit and correct Christian ingestion eligibility/dedup loss

## Plan
- [x] Inspect the actual RentCast ingestion path and identify every active eligibility filter after raw fetch.
- [x] Inspect dedup keys and normalization logic used before storage.
- [x] Add read-only audit output that attributes dropped raw records to exact filter reasons and samples dropped/deduped records.
- [x] Run the audit once using the confirmed Christian job to identify the broken filter(s), without changing routes or route generation.
- [x] Patch only confirmed incorrect ingestion filters; do not delete/regenerate Christian routes and do not touch route generation/merge logic. No production filter was patched because the audit did not confirm a broken eligibility or dedup filter.
- [x] Re-run the diagnostic after patching and document whether candidate counts increase. Diagnostic was re-run after adding read-only audit attribution; counts did not change because no production ingestion filter was modified.

## Review
Audit completed without deleting/regenerating Christian's route and without modifying route generation or merge logic.

Active ingestion filter criteria found:
- Coordinates/geography: requires latitude and longitude; if a polygon exists, the point must be inside it. Missing coordinates are dropped; outside-polygon records are dropped.
- Sale date: requires `lastSaleDate`; invalid dates or dates outside the 12-month deed window are dropped.
- Price: missing sale price is kept. In disclosure states, explicit `lastSalePrice < 10000` is dropped, and `lastSalePrice < assessedValue * 0.15` is dropped only when `assessedValue` exists and is positive. In non-disclosure states, only explicit nominal sale prices under $1,000 are dropped.
- Property type: exact `Commercial`, `Industrial`, `Vacant Land`, and `Agricultural` are dropped. Missing property type is kept. Multi-family, mobile home, condo, townhouse, and general residential types are not actively excluded in deed ingestion.
- Optional fields: missing sqft, year built, lot size, beds/baths, assessed value, and property type do not drop a deed record.

Drop counts from the confirmed Christian job:
- Outside polygon: 739
- Missing coordinates: 0
- Missing last sale date: 0
- Sale price below $10,000: 4
- Sale price below 15% assessed value: 0
- Non-disclosure nominal sale price: 0
- Excluded property type: 0
- Invalid/outside sale-date window: 5
- Duplicate within sub-circle: 8

Dedup audit:
- Dedup key is normalized address line plus 5-digit ZIP.
- Matching is exact after normalization, not fuzzy: uppercase, punctuation removal, whitespace collapse, and street suffix abbreviation.
- The 128 global dedup removals are from overlapping sub-circles returning the same normalized address+ZIP, not fuzzy collapse of similar addresses.
- No evidence was found that dedup is removing valid distinct unit-level properties in this sample; however, unit designators can be lost if RentCast omits them from `addressLine1`/formatted street portion.

RentCast raw fetch gap:
- Territory fetch uses 16 radius-based sub-circles, not one large query.
- Each sub-circle uses `/v1/properties` with latitude, longitude, radius, limit 500, offset pagination, and saleDateRange for the deed window.
- No sub-circle API errors were found. One sub-circle returned zero raw records; several returned raw records entirely outside the polygon.
- No per-query cap was hit in this job; the processor can request up to 10 pages per chunk at 500 records each and logs cap warnings if reached.

Decision:
No production ingestion filter was changed because the audit shows the 756-property loss is overwhelmingly polygon clipping, not an accidental property-type/status/completeness filter. The only non-geographic eligibility loss is 9 records plus 8 within-cell duplicates. Patching polygon filtering without changing the user-defined territory would incorrectly include properties outside Christian's drawn area.