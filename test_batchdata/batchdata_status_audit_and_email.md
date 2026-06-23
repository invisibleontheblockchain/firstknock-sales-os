# Technical Audit Report: BatchData Listing Status & Route Data Gaps

This report analyzes the properties exported in [Precision-Route-1-route-export.csv](file:///C:/Users/avion/Downloads/Precision-Route-1-route-export.csv) and details a structured approach to troubleshoot listing status discrepancies with BatchData Support.

---

## 1. Analysis of the CSV Export Data Gaps

In the provided route export, all 10 properties have blank values for `Value`, `Beds`, `Baths`, `Sqft`, `Lot Size`, `Year Built`, and `Sold Date`:

* **Why this happened:** 
  1. The API request was previously configured with `searchCriteria.intel.lastSoldDate` which was silently ignored by BatchData's API. This resulted in BatchData returning *every* property in the selected 71 sq mi polygon area unfiltered.
  2. Because the filter was ignored, the API returned raw/incomplete property files (including raw land, commercial, or non-residential properties).
  3. In our code parser (`mapBatchDataProperty`), the date validation gate was checking `(hasValidSaleDate && saleDateMs < cutoffMs)`. Because the properties had no recent sale date in the response, `hasValidSaleDate` was `false`. As a result, the old gate evaluated to `not rejected`, allowing these skeleton records to insert into your database as `BATCHDATA_CONFIRMED`.

* **Our Immediate Code Correction:**
  We have updated the code rejection gate in `processFetchChunk/entry.ts` to strictly require a valid sale date:
  ```typescript
  const rejected = !hasValidSaleDate || saleDateMs < cutoffMs || landUseRejected || nonResidential || listingStatusLower === 'active' || listingStatusLower === 'for sale';
  ```
  This ensures that any property with a missing or invalid sale date is immediately rejected, protecting your route quality from blank/skeleton records.

---

## 2. Expected Sold vs. Off-Market Discrepancy

There is a distinct difference between "Sold Date Filtering" and "Current Status Filtering":
* **Sold Date Filter (`sale.lastSaleDate.minDate`):** Tells the API to return properties whose last transaction occurred after a specific date. However, a property could have sold 2 weeks ago and then immediately went back on the market, or is currently sitting off-market.
* **Listing Status Filter:** To target *only* currently sold properties (and completely suppress off-market properties), we must filter by listing status at the API level (e.g. enforcing that the property's listing status category is "Sold").

---

## 3. Draft Email to Jay and BatchData Support

Below is a highly professional, technically structured email draft to send to your BatchData contacts to resolve this issue.

***

**Subject:** Integration Support: Querying for Confirmed Sales Only & Suppressing Off-Market Listings in `/property/search`

Hi Jay & BatchData Support Team,

We are currently refining our integration with the BatchData Property Search API (`POST https://api.batchdata.com/api/v1/property/search`) on our Growth plan. 

Our core use case is querying recently sold residential properties within drawn polygon coordinates. We want to isolate properties that have **genuinely sold** within specific recent windows (e.g., last 1 week, 2 weeks, or 3 months) and ensure we are **only** pulling confirmed sales—suppressing properties that are currently off-market on Redfin/Zillow.

Right now, we are seeing a discrepancy where properties are being returned by the search endpoint, but when cross-referenced in the field (on Zillow/Redfin), they are actually **currently off-market** and not recent transactions.

To help us troubleshoot and query correctly, could you guide us on the following:

### 1. Filtering by Sold Date via `intel` vs. `sale` Namespace
* **Our Goal:** We want to query properties using a composite sold date ( deeds + MLS closed dates). 
* **The Issue:** We tried filtering on `searchCriteria.intel.lastSoldDate.minDate`, but the API returned a `200 OK` and silently ignored the key (returning all properties in the polygon unfiltered).
* **Question:** Does the Search API support filtering by sold date using the `intel` namespace inside `searchCriteria`? If so, what is the exact JSON structure? If not, is `searchCriteria.sale.lastSaleDate.minDate` the only supported path for sold date constraints?

### 2. Restricting Results to Confirmed Sold Status at the Query Level
To ensure we do not pull properties that had a historical sale date but are currently off-market, we need to enforce a status filter in our API request.
* **Question:** How do we filter for a "Sold" listing status at the query level? Does the API support filtering by `searchCriteria.listing.status` or `searchCriteria.listing.statusCategory`? 
* **Could you provide the exact JSON payload structure** required to filter out active and off-market listings, ensuring only confirmed sold properties are returned in the response?

### 3. Trial Period Constraints & Plan Access
We are currently in our demo/testing phase for this integration. Could you clarify:
* Does our trial/demo key have any restricted access to specific datasets (such as the `listing` or `deed` add-on datasets) that might explain the blank fields we are seeing?
* Are there any rate limits or usage caps unique to this trial period that we should be aware of while testing?

We appreciate your help in aligning our search parameters so we can isolate confirmed recent sales.

Best regards,  
[Your Name/Team]

***
