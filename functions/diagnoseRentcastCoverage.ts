import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * RentCast Coverage Diagnostic Tool
 * 
 * Bypasses all app ingestion logic and queries RentCast directly
 * for each specified ZIP code with various filter combinations.
 * Reports raw counts to identify exactly where data gaps exist.
 * 
 * Tests:
 * 1. No filters (all properties in ZIP)
 * 2. With saleDateRange (recent sales only)
 * 3. By property type breakdown
 * 4. By lat/lng circle (matching how the app queries)
 */

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function queryRentCast(params, label) {
    const qs = new URLSearchParams(params);
    const url = `${RENTCAST_BASE}/properties?${qs}`;
    console.log(`[diag] ${label} → ${url}`);
    
    const res = await fetch(url, {
        headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
    });
    
    if (res.status === 429) {
        console.warn(`[diag] Rate limited on: ${label}`);
        return { status: 429, count: null, sample: null, url };
    }
    
    if (!res.ok) {
        const body = await res.text();
        console.warn(`[diag] Error ${res.status} on ${label}: ${body}`);
        return { status: res.status, count: null, sample: null, url, error: body };
    }
    
    const totalCount = res.headers.get('X-Total-Count');
    const data = await res.json();
    const records = Array.isArray(data) ? data : [];
    
    return {
        status: 200,
        count: totalCount ? parseInt(totalCount, 10) : records.length,
        returned: records.length,
        sample: records.slice(0, 3).map(r => ({
            address: r.formattedAddress,
            lastSaleDate: r.lastSaleDate,
            lastSalePrice: r.lastSalePrice,
            propertyType: r.propertyType,
            yearBuilt: r.yearBuilt
        })),
        url
    };
}

async function queryListings(params, label) {
    const qs = new URLSearchParams(params);
    const url = `${RENTCAST_BASE}/listings/sale?${qs}`;
    console.log(`[diag] ${label} → ${url}`);
    
    const res = await fetch(url, {
        headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
    });
    
    if (res.status === 429) {
        return { status: 429, count: null, url };
    }
    
    if (!res.ok) {
        const body = await res.text();
        return { status: res.status, count: null, url, error: body };
    }
    
    const data = await res.json();
    const records = Array.isArray(data) ? data : [];
    
    return {
        status: 200,
        count: records.length,
        sample: records.slice(0, 3).map(r => ({
            address: r.formattedAddress,
            price: r.price,
            status: r.status,
            listedDate: r.listedDate,
            propertyType: r.propertyType
        })),
        url
    };
}

Deno.serve(async (req) => {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!RENTCAST_API_KEY) {
        return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    
    // Accept either specific ZIPs or a lat/lng/radius
    const { 
        zip_codes = ['88001', '88005', '88012'],
        latitude,
        longitude,
        radius,
        sold_months = 3
    } = body;

    const results = {
        timestamp: new Date().toISOString(),
        config: { zip_codes, latitude, longitude, radius, sold_months },
        api_calls_used: 0,
        tests: {}
    };

    const saleDays = sold_months * 30;

    // ===== TEST 1: ZIP-based queries (property records) =====
    for (const zip of zip_codes) {
        const zipResults = {};
        
        // 1a. All properties in ZIP (no sale date filter)
        const allProps = await queryRentCast({
            zipCode: zip,
            limit: '1',
            includeTotalCount: 'true'
        }, `ZIP ${zip} — ALL properties`);
        results.api_calls_used++;
        zipResults.all_properties = { count: allProps.count, status: allProps.status };
        await sleep(250);

        // 1b. Recently sold (matching app's saleDateRange)
        const recentSold = await queryRentCast({
            zipCode: zip,
            saleDateRange: `1:${saleDays}`,
            limit: '1',
            includeTotalCount: 'true'
        }, `ZIP ${zip} — sold last ${sold_months}mo`);
        results.api_calls_used++;
        zipResults.recently_sold = { count: recentSold.count, status: recentSold.status };
        await sleep(250);

        // 1c. Sold last 12 months (broader window)
        const sold12mo = await queryRentCast({
            zipCode: zip,
            saleDateRange: '1:365',
            limit: '1',
            includeTotalCount: 'true'
        }, `ZIP ${zip} — sold last 12mo`);
        results.api_calls_used++;
        zipResults.sold_12mo = { count: sold12mo.count, status: sold12mo.status };
        await sleep(250);

        // 1d. Sold last 14 months (matching app's 420 day range)
        const sold14mo = await queryRentCast({
            zipCode: zip,
            saleDateRange: '1:420',
            limit: '5',
            includeTotalCount: 'true'
        }, `ZIP ${zip} — sold last 14mo (app default)`);
        results.api_calls_used++;
        zipResults.sold_14mo = { 
            count: sold14mo.count, 
            status: sold14mo.status,
            sample: sold14mo.sample 
        };
        await sleep(250);

        // 1e. Property type breakdown for sold properties
        const propertyTypes = ['Single Family', 'Condo', 'Townhouse', 'Manufactured', 'Multi-Family'];
        zipResults.by_property_type = {};
        
        for (const pt of propertyTypes) {
            const ptResult = await queryRentCast({
                zipCode: zip,
                saleDateRange: `1:${saleDays}`,
                propertyType: pt,
                limit: '1',
                includeTotalCount: 'true'
            }, `ZIP ${zip} — ${pt} sold ${sold_months}mo`);
            results.api_calls_used++;
            zipResults.by_property_type[pt] = { count: ptResult.count, status: ptResult.status };
            await sleep(200);
            
            if (ptResult.status === 429) {
                console.warn('[diag] Rate limited — stopping property type breakdown');
                break;
            }
        }

        results.tests[zip] = zipResults;
    }

    // ===== TEST 2: Lat/Lng circle query (if provided) =====
    if (latitude && longitude && radius) {
        const circleResults = {};
        
        // 2a. All properties in circle
        const circleAll = await queryRentCast({
            latitude: String(latitude),
            longitude: String(longitude),
            radius: String(radius),
            limit: '1',
            includeTotalCount: 'true'
        }, `Circle ALL (${latitude},${longitude} r=${radius}mi)`);
        results.api_calls_used++;
        circleResults.all_properties = { count: circleAll.count, status: circleAll.status };
        await sleep(250);

        // 2b. Circle with sale date filter matching app
        const circleSold = await queryRentCast({
            latitude: String(latitude),
            longitude: String(longitude),
            radius: String(radius),
            saleDateRange: '1:420',
            limit: '5',
            includeTotalCount: 'true'
        }, `Circle SOLD 14mo (${latitude},${longitude} r=${radius}mi)`);
        results.api_calls_used++;
        circleResults.sold_14mo = { 
            count: circleSold.count, 
            status: circleSold.status,
            sample: circleSold.sample
        };
        await sleep(250);

        // 2c. Circle with 3 month filter
        const circle3mo = await queryRentCast({
            latitude: String(latitude),
            longitude: String(longitude),
            radius: String(radius),
            saleDateRange: `1:${saleDays}`,
            limit: '1',
            includeTotalCount: 'true'
        }, `Circle SOLD ${sold_months}mo`);
        results.api_calls_used++;
        circleResults[`sold_${sold_months}mo`] = { count: circle3mo.count, status: circle3mo.status };

        results.tests['circle_query'] = circleResults;
    }

    // ===== TEST 3: Sale Listings endpoint (MLS data) =====
    for (const zip of zip_codes.slice(0, 2)) { // Only test 2 ZIPs to conserve calls
        const listingResult = await queryListings({
            zipCode: zip,
            status: 'Sold',
            limit: '5'
        }, `Listings ZIP ${zip} — Sold`);
        results.api_calls_used++;
        
        results.tests[zip] = results.tests[zip] || {};
        results.tests[zip].mls_sold_listings = {
            count: listingResult.count,
            status: listingResult.status,
            sample: listingResult.sample
        };
        await sleep(250);

        const activeListings = await queryListings({
            zipCode: zip,
            status: 'Active',
            limit: '1'
        }, `Listings ZIP ${zip} — Active`);
        results.api_calls_used++;
        
        results.tests[zip].mls_active_listings = {
            count: activeListings.count,
            status: activeListings.status
        };
        await sleep(250);
    }

    // ===== TEST 4: Compare with our local data =====
    const localCounts = {};
    for (const zip of zip_codes) {
        const localProps = await base44.asServiceRole.entities.MasterProperty.filter(
            { zip_code: zip }, null, 5000
        );
        const arr = Array.isArray(localProps) ? localProps : (localProps?.items || []);
        localCounts[zip] = arr.length;
    }
    results.local_counts = localCounts;

    // ===== SUMMARY =====
    const summary = [];
    for (const zip of zip_codes) {
        const t = results.tests[zip] || {};
        summary.push({
            zip,
            rentcast_all: t.all_properties?.count || 0,
            rentcast_sold_3mo: t.recently_sold?.count || 0,
            rentcast_sold_12mo: t.sold_12mo?.count || 0,
            rentcast_sold_14mo: t.sold_14mo?.count || 0,
            local_count: localCounts[zip] || 0,
            gap_pct: t.sold_14mo?.count > 0 
                ? Math.round((1 - (localCounts[zip] || 0) / t.sold_14mo.count) * 100)
                : 'N/A'
        });
    }
    results.summary = summary;

    console.log('[diag] === DIAGNOSTIC COMPLETE ===');
    console.log('[diag] API calls used:', results.api_calls_used);
    console.log('[diag] Summary:', JSON.stringify(summary, null, 2));

    return Response.json(results);
});