# BatchData Escalation Packet — Last-Week Owner-Change Search Returning Zero

## Subject
Urgent: Polygon + `intel.lastSoldDate.minDate` returns zero recent-sale records while same polygon without date returns records

## Update — Cross-Reference With BatchData's June 23 Reply

BatchData's June 23 reply confirmed this example shape:

```json
{
  "searchCriteria": {
    "address": {
      "city": { "equals": "Anderson" },
      "state": { "equals": "SC" }
    },
    "intel": {
      "lastSoldDate": {
        "minDate": "2026-06-16"
      }
    }
  },
  "options": {
    "take": 10
  }
}
```

### What matches our current request
- We are using the same confirmed namespace/path: `searchCriteria.intel.lastSoldDate.minDate`.
- We are using the same date-only format: `YYYY-MM-DD`.
- We are using the same Search API endpoint style.
- We are keeping the request broad in production: no dataset scoping, no listing-status gate, no local sale-confirmation gate before ingestion.

### What differs from their example
- Their example scopes geography by `address.city.equals` + `address.state.equals`.
- Our production request scopes geography by `address.geoLocationPolygon.geoPoints`.
- Their example does not answer whether `intel.lastSoldDate.minDate` behaves identically when combined with polygon geometry.
- Their example does not answer whether `intel.lastSoldDate` means deed transfer, MLS closed sale, owner change, or a composite field.
- Their example does not answer how to require listing status/category `sold` at query time.

### Current diagnosis after cross-reference
This no longer looks like our app silently ignoring `intel.lastSoldDate.minDate` on the latest job. The latest no-write probe shows:

- Same polygon + `intel.lastSoldDate.minDate = "2026-06-24"`: `0` raw records.
- Same polygon with `intel.lastSoldDate` removed: `1` raw record returned, with `intel.lastSoldDate = 2024-05-24T00:00:00.000Z`.

That proves the polygon can return inventory and that the date filter is affecting the result. The unresolved question is now provider-side: whether BatchData has any records in that polygon with `intel.lastSoldDate >= 2026-06-24`, whether large polygon + intel filtering has limitations, and whether `intel.lastSoldDate` is the right field for confirmed recent sales versus historical owner-transfer data.

### Important product semantics
A Redfin/Zillow page showing `Off Market` does not always disprove that a sale/transfer happened. After a property closes, consumer portals often show the listing as off-market. If our product needs only MLS-confirmed closed-sale listings, not deed/owner-transfer history, then `intel.lastSoldDate` may be too broad by itself and we need BatchData's exact listing-status filter path.

## Revised Follow-Up Email Draft

Hi BatchData team,

Thank you for your June 23 reply confirming the `searchCriteria.intel.lastSoldDate.minDate` structure using a city/state example.

We implemented the same `intel.lastSoldDate.minDate` path, but our production geography is a drawn polygon rather than city/state. We need help confirming whether this same field is fully supported with `address.geoLocationPolygon.geoPoints`, and whether it represents deed transfer, MLS closed sale, owner change, or a composite value.

For the latest production test, we sent a large North Carolina polygon with `searchCriteria.intel.lastSoldDate.minDate = "2026-06-24"` for a selected last-week window. BatchData returned zero properties for both our broad exact-date request and a stricter residential/value version. When we send the same polygon request with the `intel.lastSoldDate` filter removed, BatchData returns properties, including a stale sample with `intel.lastSoldDate = "2024-05-24T00:00:00.000Z"`. That confirms the polygon can return inventory and the issue is specific to the recent-sale date constraint or provider coverage/lag.

Can you verify whether `intel.lastSoldDate.minDate` is expected to return any homes sold/transferred since 2026-06-24 in this polygon, whether large polygon + intel filtering has limitations, and whether there is a more precise query path for MLS-confirmed closed sales?

### What we expected
At least some owner-change / last-sold property records inside a 24,360.22 sq mi North Carolina polygon for the last-week window.

### What happened
- Exact broad request with only polygon + `intel.lastSoldDate.minDate`: `0` raw records.
- Exact strict request with polygon + `intel.lastSoldDate.minDate` + `general.standardizedLandUseCode = R2` + `valuation.estimatedValue.min = 100000`: `0` raw records.
- Same broad polygon with date filter removed: returned a property, but stale: `intel.lastSoldDate = 2024-05-24T00:00:00.000Z`.

This suggests the issue is specifically the recent-sale/intel date filter or BatchData's recent-sale coverage/lag for the selected area, not our local filtering.

### Production job evidence
- App job ID: `6a445e6609cfa702e8a6c980`
- Created: `2026-07-01T00:25:10.103000Z`
- User/account: `baysecurity@gmail.com`
- Area: `24360.22` sq mi
- Resolved FIPS from center: `37151` / Randolph County, North Carolina
- Selected window: last week
- App value filter: minimum `$100,000`, maximum `null`
- Requested routeable properties: `2`
- Production result: `raw=0`, `mapped=0`, `active=0`
- Job status check: `total_fetched=0`, `total_inserted=0`, `active_count=0`, `total_batchdata_calls=1`
- Exact-job route-candidate query returned `0`, because no properties were stored for this fetch job.

### No-write probe results
1. `strict_exact_date`
   - `intel.lastSoldDate.minDate = "2026-06-24"`
   - Polygon: yes
   - Land-use filter: yes, `R2`
   - Valuation filter: yes, `estimatedValue.min = 100000`
   - Options: `{ "skip": 0, "take": 1 }`
   - Raw returned: `0`
   - Mapped active: `0`

2. `broad_exact_date`
   - `intel.lastSoldDate.minDate = "2026-06-24"`
   - Polygon: yes
   - Land-use filter: no
   - Valuation filter: no
   - Options: `{ "skip": 0, "take": 1 }`
   - Raw returned: `0`
   - Mapped active: `0`

3. `broad_no_sold_date`
   - Same polygon
   - No `intel.lastSoldDate` filter
   - Land-use filter: no
   - Valuation filter: no
   - Options: `{ "skip": 0, "take": 1 }`
   - Raw returned: `1`
   - Sample returned:
     - Address: `121 Red Oak Ln`
     - `intel.lastSoldDate`: `2024-05-24T00:00:00.000Z`
     - `intel.lastSoldPrice`: `93712`
     - `general.standardizedLandUseCode`: `R7`

### Exact broad request payload used by production
Production now uses the broad request shape below for recent Precision pulls. The strict version adds only `general.standardizedLandUseCode.equals = "R2"` and `valuation.estimatedValue.min = 100000`; production is no longer relying on strict mode.

```json
{
  "searchCriteria": {
    "address": {
      "geoLocationPolygon": {
        "geoPoints": [
          { "latitude": 36.3106987841827, "longitude": -80.91979980468751 },
          { "latitude": 36.3106987841827, "longitude": -80.92529296875 },
          { "latitude": 36.266421331439396, "longitude": -81.17248535156251 },
          { "latitude": 36.16448788632064, "longitude": -81.82617187500001 },
          { "latitude": 35.89795019335754, "longitude": -82.60620117187501 },
          { "latitude": 35.71529801212532, "longitude": -82.85339355468751 },
          { "latitude": 35.64836915737426, "longitude": -82.8753662109375 },
          { "latitude": 35.585851593232356, "longitude": -82.84790039062501 },
          { "latitude": 35.38904996691167, "longitude": -82.74353027343751 },
          { "latitude": 35.16931803601131, "longitude": -82.61169433593751 },
          { "latitude": 35.0659731379842, "longitude": -82.52380371093751 },
          { "latitude": 34.939985151560435, "longitude": -82.39196777343751 },
          { "latitude": 34.89944783005726, "longitude": -82.35351562500001 },
          { "latitude": 34.74161249883172, "longitude": -82.23266601562501 },
          { "latitude": 34.6241677899049, "longitude": -82.11730957031251 },
          { "latitude": 34.52466147177175, "longitude": -81.88110351562501 },
          { "latitude": 34.53371242139567, "longitude": -81.40319824218751 },
          { "latitude": 34.58799745550485, "longitude": -81.13403320312501 },
          { "latitude": 34.63320791137959, "longitude": -80.95825195312501 },
          { "latitude": 34.70097741472011, "longitude": -80.7550048828125 },
          { "latitude": 34.79576153473033, "longitude": -80.44738769531251 },
          { "latitude": 34.93097858831627, "longitude": -80.05737304687501 },
          { "latitude": 34.96699890670367, "longitude": -79.98596191406251 },
          { "latitude": 35.097439809364204, "longitude": -79.75524902343751 },
          { "latitude": 35.22318504970181, "longitude": -79.5465087890625 },
          { "latitude": 35.474091607730315, "longitude": -79.06860351562501 },
          { "latitude": 35.7688006602384, "longitude": -78.42590332031251 },
          { "latitude": 35.951329861522666, "longitude": -78.02490234375001 },
          { "latitude": 36.071302299422406, "longitude": -77.78869628906251 },
          { "latitude": 36.146746777814364, "longitude": -77.64038085937501 },
          { "latitude": 36.16448788632064, "longitude": -77.61291503906251 },
          { "latitude": 36.20439070158873, "longitude": -77.59094238281251 },
          { "latitude": 36.33725319397006, "longitude": -77.41516113281251 },
          { "latitude": 36.46105407505434, "longitude": -77.29431152343751 },
          { "latitude": 36.50522086338427, "longitude": -77.29431152343751 },
          { "latitude": 36.52288052805137, "longitude": -77.39318847656251 },
          { "latitude": 36.53170884914869, "longitude": -77.59643554687501 },
          { "latitude": 36.527294814546245, "longitude": -77.68432617187501 },
          { "latitude": 36.50963615733049, "longitude": -77.79968261718751 },
          { "latitude": 36.491973470593685, "longitude": -78.03039550781251 },
          { "latitude": 36.491973470593685, "longitude": -78.25012207031251 },
          { "latitude": 36.49638952000399, "longitude": -78.3160400390625 },
          { "latitude": 36.51405119943165, "longitude": -78.45886230468751 },
          { "latitude": 36.5184659896759, "longitude": -78.49731445312501 },
          { "latitude": 36.53170884914869, "longitude": -78.6346435546875 },
          { "latitude": 36.53612263184688, "longitude": -78.67858886718751 },
          { "latitude": 36.54936246839778, "longitude": -78.79394531250001 },
          { "latitude": 36.3106987841827, "longitude": -80.91979980468751 }
        ]
      }
    },
    "intel": {
      "lastSoldDate": {
        "minDate": "2026-06-24"
      }
    }
  },
  "options": {
    "skip": 0,
    "take": 100
  }
}
```

### App-side files and exact filters

1. `base44/functions/startBatchDataPull/entry.ts`
   - Normalizes drawn polygon.
   - Calculates area and center.
   - Resolves FIPS using FCC from polygon center.
   - For this job: FIPS `37151`, area `24360.22`, requested `2`, sold_months `0.25`, min_price `100000`.
   - No square-mile rejection is currently applied.

2. `base44/functions/processFetchChunk/entry.ts`
   - Builds BatchData request in `buildBatchDataRequest`.
   - Last-week maps to `soldWindowDays(0.25) = 7`, anchored to job time, producing `minDate = "2026-06-24"`.
   - Current production modes: `["broad_polygon"]` only.
   - Current production request includes polygon + `intel.lastSoldDate.minDate` only.
   - `options.take` is capped to `100`.
   - Dataset scoping is omitted so BatchData can return all sale/intel fields.
   - Mapping drops only:
     - missing street / zip / coordinates,
     - coordinates outside drawn polygon,
     - clearly non-residential property type matching commercial/industrial/vacant/agricultural/land.
   - In this failing job, there were `0` raw records, so no local mapping/filtering happened.

3. `base44/functions/getRouteCandidatesFromNeon/entry.ts`
   - Exact-job query uses `wp.fetch_job_id = job_id`.
   - For exact-job BatchData requests, it does not reapply rejected/confidence/sold-date filters.
   - Latest job returned `0` candidates because no rows were stored for that job.

4. `src/components/logic/routeFilterPipeline.jsx`
   - Final route filter lets BatchData candidates pass local sold-date, confidence, and hard single-family gates.
   - This did not affect the latest failure because the provider returned `0` raw records.

### Questions for BatchData
1. Is `searchCriteria.intel.lastSoldDate.minDate` the correct current API path for “properties sold/transferred since date X”?
2. Are date-only values like `"2026-06-24"` valid for this field, or should this be an ISO timestamp?
3. Does this endpoint support large multi-county polygons around 24,360 sq mi, or should we split by county/FIPS/tile?
4. Does `address.geoLocationPolygon.geoPoints` work across multiple counties/states without adding county-level criteria?
5. For recent sales, is `intel.lastSoldDate` populated from deed transfer, MLS sale, owner-change, or another source?
6. What is the expected lag for `intel.lastSoldDate` in NC/SC/VA territories?
7. Is there another recommended field for newly changed owners, e.g. a deed transfer date, recording date, sale date, owner transfer date, or add-on dataset field?
8. Does the API return `totalRecordCount = null` when zero results are found, or does null indicate a request/index issue?
9. Can BatchData reproduce the attached broad payload and confirm whether zero results are expected?
10. If zero is expected, what query/payload do you recommend for “new property owners in the last 7 days inside this drawn territory”?

Thanks — this is blocking our production Precision workflow, and we need to know whether to change the request structure, split geometry, use a different date field, or set product expectations around provider lag.