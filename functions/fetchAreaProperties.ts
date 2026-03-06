import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { polygonToCells, latLngToCell } from 'npm:h3-js@4.1.0';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

// Ray-casting algorithm for point in polygon
function isPointInPolygon(point, vs) {
    if (!vs || vs.length < 3) return true;
    let x = point.lng, y = point.lat;
    const epsilon = 1e-9;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].lng, yi = vs[i].lat;
        let xj = vs[j].lng, yj = vs[j].lat;
        let intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi + epsilon);
        if (intersect) inside = !inside;
    }
    return inside;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { latitude, longitude, radius, polygon, force_sync = false } = body;

        if (!latitude || !longitude || !radius) {
            return Response.json({ error: 'Latitude, longitude, and radius are required' }, { status: 400 });
        }

        // Pre-compute H3 cells for the polygon
        let polygonH3Cells = new Set();
        let useH3Filter = false;
        if (polygon && polygon.length >= 3) {
            try {
                const h3Polygon = polygon.map(p => [p.lat, p.lng]);
                if (h3Polygon.length > 0 && (h3Polygon[0][0] !== h3Polygon[h3Polygon.length - 1][0] || h3Polygon[0][1] !== h3Polygon[h3Polygon.length - 1][1])) {
                    h3Polygon.push([...h3Polygon[0]]);
                }
                const cells = polygonToCells(h3Polygon, 9);
                polygonH3Cells = new Set(cells);
                useH3Filter = true;
                console.log(`[FetchArea] Pre-computed ${cells.length} H3 cells for polygon filtering`);
            } catch (e) {
                console.warn("[FetchArea] H3 polygonToCells failed, falling back to ray-casting only:", e.message);
            }
        }

        if (!RENTCAST_API_KEY) {
            return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
        }

        // Track pull count (no limit enforced for now)
        const areaPulls = user.area_pulls_count || 0;
        try {
            await base44.auth.updateMe({ area_pulls_count: areaPulls + 1 });
        } catch (e) {
            console.error(`[FetchArea] Failed to increment usage:`, e.message);
        }

        const areaSqMiles = Math.PI * radius * radius;
        console.log(`[FetchArea] === START === lat:${latitude}, lng:${longitude}, r:${radius} mi, area:${areaSqMiles.toFixed(1)} sq mi, polygon pts:${polygon ? polygon.length : 0}`);

        const startTime = Date.now();
        const MAX_EXECUTION_TIME = 50000; // 50s to leave room for final writes

        const LIMIT = 500; // RentCast max per request
        const MAX_PARALLEL = 5;
        const THROTTLE_DELAY_MS = 200;
        const PROPERTY_TYPES = 'Single Family,Townhouse,Condo,Multi-Family,Duplex,Triplex,Fourplex,Apartment,Mobile Home,Cooperative,Timeshare';

        let requestCount = 0;
        let reportedTotal = 0;
        let totalFound = 0;
        let inPolygonCount = 0;
        let mappedCount = 0;
        let recentSales12moCount = 0;
        let droppedNoAddressCount = 0;
        let newInsertCount = 0;
        let upsertUpdateCount = 0;

        const uniqueZips = new Set();
        // Cache: address_hash -> existing record id (for upserts)
        const existingHashToId = new Map();

        // Helper to process a batch of properties
        const processBatch = async (batch, defaultStatus = 'ELIGIBLE') => {
            if (!batch || batch.length === 0) return;
            totalFound += batch.length;

            let filteredProperties = batch;
            if (polygon && polygon.length >= 3) {
                filteredProperties = batch.filter(p => {
                    if (!p.latitude || !p.longitude) return false;
                    if (useH3Filter) {
                        try {
                            const cell = latLngToCell(p.latitude, p.longitude, 9);
                            if (!polygonH3Cells.has(cell)) return false;
                        } catch (e) {}
                    }
                    return isPointInPolygon({ lat: p.latitude, lng: p.longitude }, polygon);
                });
            }
            inPolygonCount += filteredProperties.length;

            const twelveMonthsAgo = new Date();
            twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
            recentSales12moCount += filteredProperties.reduce((acc, p) => {
                if (p.lastSaleDate) {
                    const d = new Date(p.lastSaleDate);
                    if (!isNaN(d) && d > twelveMonthsAgo) return acc + 1;
                }
                return acc;
            }, 0);

            droppedNoAddressCount += filteredProperties.filter(p => !(p.addressLine1 || p.formattedAddress) || !p.latitude || !p.longitude).length;

            const mapped = filteredProperties
                .filter(p => p.latitude && p.longitude && (p.addressLine1 || p.formattedAddress))
                .map(p => {
                    const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                    const addressMatch = (addressLine).match(/^(\d+)\s+(.*)$/);
                    const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                    const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                    // Determine status: if sold in last 12 months, mark SOLD; otherwise ELIGIBLE
                    let original_status = defaultStatus;
                    if (p.lastSaleDate) {
                        const saleDate = new Date(p.lastSaleDate);
                        if (!isNaN(saleDate) && saleDate > twelveMonthsAgo) {
                            original_status = 'SOLD';
                        }
                    }

                    const pZip = p.zipCode || '00000';
                    return {
                        address_hash: p.id || `${p.addressLine1}-${pZip}`,
                        house_number, street_name,
                        full_address: p.formattedAddress || p.addressLine1,
                        city: p.city || '', state: p.state || '', zip_code: pZip,
                        lat: p.latitude, lng: p.longitude, original_status,
                        beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                        sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
                        year_built: p.yearBuilt || 0, price: p.lastSalePrice || p.price || 0,
                        sold_date: p.lastSaleDate || null, sale_type: 'Market',
                        property_type: p.propertyType || 'Single Family',
                        mls_id: p.assessorID || null, url: null
                    };
                });

            mappedCount += mapped.length;
            if (mapped.length === 0) return;

            // Fetch existing records for dedup/upsert
            const batchZips = [...new Set(mapped.map(p => p.zip_code))];
            const newZipsToFetch = batchZips.filter(z => !uniqueZips.has(z));
            for (const zip of newZipsToFetch) {
                uniqueZips.add(zip);
                try {
                    const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, null, 5000);
                    const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
                    existingArr.forEach(p => existingHashToId.set(p.address_hash, p.id));
                } catch (e) {
                    console.warn(`[FetchArea] Failed to fetch existing for zip ${zip}:`, e.message);
                }
            }

            // Split into new records (insert) and existing records (upsert/update)
            const toInsert = [];
            const toUpdate = [];

            for (const p of mapped) {
                const existingId = existingHashToId.get(p.address_hash);
                if (existingId) {
                    // Upsert: update existing record with fresh data (especially status, price, sold_date)
                    toUpdate.push({ id: existingId, data: p });
                } else {
                    toInsert.push(p);
                    existingHashToId.set(p.address_hash, 'pending'); // prevent duplicates within batch
                }
            }

            // Bulk insert new records — sequential to avoid 429s
            if (toInsert.length > 0) {
                const CHUNK_SIZE = 500;
                for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
                    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
                    try {
                        await base44.entities.MasterProperty.bulkCreate(chunk);
                        newInsertCount += chunk.length;
                    } catch (e) {
                        // Retry in smaller chunks with delay
                        await sleep(1000);
                        const SMALL_CHUNK = 100;
                        for (let j = 0; j < chunk.length; j += SMALL_CHUNK) {
                            const small = chunk.slice(j, j + SMALL_CHUNK);
                            try {
                                await base44.entities.MasterProperty.bulkCreate(small);
                                newInsertCount += small.length;
                            } catch (e2) {
                                console.warn(`[FetchArea] Small chunk insert failed:`, e2.message);
                            }
                            await sleep(300);
                        }
                    }
                }
            }

            // Update existing records — only update SOLD status changes to avoid 429s
            if (toUpdate.length > 0) {
                const soldUpdates = toUpdate.filter(({ data }) => data.original_status === 'SOLD');
                if (soldUpdates.length > 0) {
                    for (let i = 0; i < soldUpdates.length; i++) {
                        const { id, data } = soldUpdates[i];
                        try {
                            await base44.entities.MasterProperty.update(id, {
                                original_status: 'SOLD',
                                sold_date: data.sold_date,
                                price: data.price
                            });
                            upsertUpdateCount++;
                        } catch (e) { /* silent */ }
                        if (i % 5 === 4) await sleep(200);
                    }
                }
                // Count the rest as "already existed"
                upsertUpdateCount += toUpdate.length - soldUpdates.length;
            }
        };

        // =====================================================================
        // PASS 1: FULL TERRITORY PULL — ALL properties (no saleDateRange filter)
        // This gets the complete universe of homes for door-knocking routes.
        // =====================================================================
        console.log(`[FetchArea] === PASS 1: /v1/properties (ALL properties, no date filter) ===`);

        const initialParams = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            radius: String(radius),
            limit: String(LIMIT),
            offset: '0',
            propertyType: PROPERTY_TYPES,
            includeTotalCount: 'true',
        });

        const initialUrl = `${RENTCAST_BASE}/properties?${initialParams.toString()}`;
        console.log(`[FetchArea] Pass1 Request #1: offset=0, limit=${LIMIT}, NO saleDateRange, includeTotalCount=true`);

        const initialResponse = await fetch(initialUrl, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
        requestCount++;

        if (!initialResponse.ok) {
            const errText = await initialResponse.text();
            console.error(`[FetchArea] RentCast error ${initialResponse.status}: ${errText}`);
            return Response.json({ error: `RentCast API error: ${initialResponse.status}`, details: errText }, { status: 500 });
        }

        const totalHeader = initialResponse.headers.get('X-Total-Count');
        if (totalHeader) reportedTotal = parseInt(totalHeader, 10);

        const initialData = await initialResponse.json();
        const initialBatch = Array.isArray(initialData) ? initialData : [];
        console.log(`[FetchArea] Pass1 Response #1: ${initialBatch.length} records, X-Total-Count=${reportedTotal}`);

        if (initialBatch.length > 0) {
            console.log(`[FetchArea] Sample: addr=${initialBatch[0].addressLine1}, lastSaleDate=${initialBatch[0].lastSaleDate}, lastSalePrice=${initialBatch[0].lastSalePrice}, propertyType=${initialBatch[0].propertyType}`);
        }

        await processBatch(initialBatch, 'ELIGIBLE');
        console.log(`[FetchArea] After batch #1: totalFound=${totalFound}, inPolygon=${inPolygonCount}, mapped=${mappedCount}, inserted=${newInsertCount}, updated=${upsertUpdateCount}`);

        // --- Dynamic pagination: exhaust X-Total-Count ---
        if (initialBatch.length >= LIMIT && reportedTotal > LIMIT) {
            const totalToFetch = Math.min(reportedTotal, 50000); // Higher cap for full pull
            const remainingPages = Math.ceil((totalToFetch - LIMIT) / LIMIT);
            console.log(`[FetchArea] ${remainingPages} more pages needed to exhaust ${totalToFetch} total records`);

            const fetchTasks = [];
            for (let page = 1; page <= remainingPages; page++) {
                const currentOffset = page * LIMIT;
                fetchTasks.push(async () => {
                    const params = new URLSearchParams({
                        latitude: String(latitude),
                        longitude: String(longitude),
                        radius: String(radius),
                        limit: String(LIMIT),
                        offset: String(currentOffset),
                        propertyType: PROPERTY_TYPES,
                    });
                    const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
                    try {
                        const res = await fetch(url, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
                        if (!res.ok) {
                            console.warn(`[FetchArea] Pass1 offset=${currentOffset} failed: ${res.status}`);
                            return [];
                        }
                        return await res.json();
                    } catch (err) {
                        console.warn(`[FetchArea] Pass1 offset=${currentOffset} error: ${err.message}`);
                        return [];
                    }
                });
            }

            console.log(`[FetchArea] Executing ${fetchTasks.length} pagination requests (chunks of ${MAX_PARALLEL}, ${THROTTLE_DELAY_MS}ms delay)...`);

            let chunkIndex = 0;
            for (let i = 0; i < fetchTasks.length; i += MAX_PARALLEL) {
                chunkIndex++;
                const chunkTasks = fetchTasks.slice(i, i + MAX_PARALLEL).map(task => task());
                const results = await Promise.all(chunkTasks);
                requestCount += results.length;

                let chunkRecords = 0;
                for (const data of results) {
                    const batch = Array.isArray(data) ? data : [];
                    chunkRecords += batch.length;
                    await processBatch(batch, 'ELIGIBLE');
                }
                console.log(`[FetchArea] Pass1 chunk ${chunkIndex}: ${chunkRecords} records, running: found=${totalFound}, polygon=${inPolygonCount}, inserted=${newInsertCount}, updated=${upsertUpdateCount}`);

                if (Date.now() - startTime > MAX_EXECUTION_TIME) {
                    console.warn(`[FetchArea] Time limit after ${((Date.now() - startTime) / 1000).toFixed(1)}s, stopping pagination.`);
                    break;
                }
                if (i + MAX_PARALLEL < fetchTasks.length) await sleep(THROTTLE_DELAY_MS);
            }
        } else if (initialBatch.length >= LIMIT && !reportedTotal) {
            console.log(`[FetchArea] X-Total-Count missing, sequential fallback...`);
            let offset = LIMIT;
            let keepGoing = true;
            while (keepGoing && requestCount < 100) {
                const params = new URLSearchParams({
                    latitude: String(latitude),
                    longitude: String(longitude),
                    radius: String(radius),
                    limit: String(LIMIT),
                    offset: String(offset),
                    propertyType: PROPERTY_TYPES,
                });
                const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
                try {
                    const res = await fetch(url, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
                    requestCount++;
                    if (!res.ok) break;
                    const data = await res.json();
                    const batch = Array.isArray(data) ? data : [];
                    console.log(`[FetchArea] Pass1 sequential offset=${offset}: ${batch.length} records`);
                    await processBatch(batch, 'ELIGIBLE');
                    if (batch.length < LIMIT) keepGoing = false;
                    else offset += LIMIT;
                } catch (err) {
                    console.warn(`[FetchArea] Sequential error at offset=${offset}:`, err.message);
                    break;
                }
                if (Date.now() - startTime > MAX_EXECUTION_TIME) break;
            }
        } else {
            console.log(`[FetchArea] Pass1 complete in single page (${initialBatch.length} records)`);
        }

        const pass1Elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[FetchArea] === PASS 1 COMPLETE (${pass1Elapsed}s) === requests=${requestCount}, found=${totalFound}, polygon=${inPolygonCount}, inserted=${newInsertCount}, updated=${upsertUpdateCount}`);

        // =====================================================================
        // PASS 2: MLS Listings (recently sold via /v1/listings/sale)
        // Catches MLS-sold homes not yet in county records
        // =====================================================================
        let listingsRequestCount = 0;
        let listingsTotalFound = 0;

        // Only do Pass 2 if we have time left
        if (Date.now() - startTime < MAX_EXECUTION_TIME - 10000) {
            console.log(`[FetchArea] === PASS 2: /v1/listings/sale (inactive, daysOld=0:365) ===`);
            let listingsOffset = 0;
            const MAX_LISTING_REQUESTS = 20;
            let keepFetchingListings = true;

            while (keepFetchingListings && listingsRequestCount < MAX_LISTING_REQUESTS) {
                const listingsParams = new URLSearchParams({
                    latitude: String(latitude),
                    longitude: String(longitude),
                    radius: String(radius),
                    limit: String(LIMIT),
                    offset: String(listingsOffset),
                    status: 'Inactive',
                    daysOld: '0:365',
                    propertyType: PROPERTY_TYPES,
                });
                const listingsUrl = `${RENTCAST_BASE}/listings/sale?${listingsParams.toString()}`;
                try {
                    const res = await fetch(listingsUrl, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
                    listingsRequestCount++;
                    if (!res.ok) {
                        console.warn(`[FetchArea] Pass2 failed: ${res.status}`);
                        break;
                    }
                    const data = await res.json();
                    const batch = Array.isArray(data) ? data : [];
                    listingsTotalFound += batch.length;
                    console.log(`[FetchArea] Pass2 offset=${listingsOffset}: ${batch.length} inactive listings`);

                    const mappedBatch = batch.map(l => ({
                        ...l,
                        id: l.propertyId || l.id,
                        lastSaleDate: l.removedDate || l.listedDate,
                        lastSalePrice: l.price,
                    }));
                    await processBatch(mappedBatch, 'SOLD');

                    if (batch.length < LIMIT) keepFetchingListings = false;
                    else listingsOffset += LIMIT;
                } catch (err) {
                    console.warn(`[FetchArea] Pass2 error:`, err.message);
                    break;
                }
                if (Date.now() - startTime > MAX_EXECUTION_TIME) {
                    console.warn(`[FetchArea] Time limit during Pass 2.`);
                    break;
                }
            }
        } else {
            console.log(`[FetchArea] Skipping Pass 2 — not enough time remaining.`);
        }

        const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const totalRequests = requestCount + listingsRequestCount;
        const totalImported = newInsertCount + upsertUpdateCount;

        console.log(`[FetchArea] ============ FINAL SUMMARY (${totalElapsed}s) ============`);
        console.log(`[FetchArea]   Strategy:              FULL TERRITORY (no date filter)`);
        console.log(`[FetchArea]   X-Total-Count (Pass1): ${reportedTotal}`);
        console.log(`[FetchArea]   API fetched:           ${totalFound} (Pass1) + ${listingsTotalFound} (Pass2)`);
        console.log(`[FetchArea]   In polygon:            ${inPolygonCount}`);
        console.log(`[FetchArea]   Mapped (valid addr):   ${mappedCount}`);
        console.log(`[FetchArea]   Dropped (no addr):     ${droppedNoAddressCount}`);
        console.log(`[FetchArea]   Recent sales (12mo):   ${recentSales12moCount}`);
        console.log(`[FetchArea]   NEW inserted to DB:    ${newInsertCount}`);
        console.log(`[FetchArea]   UPDATED (upserted):    ${upsertUpdateCount}`);
        console.log(`[FetchArea]   Total API requests:    ${totalRequests} (${requestCount} Pass1 + ${listingsRequestCount} Pass2)`);
        console.log(`[FetchArea] ==============================================`);

        // Update user data
        const uniqueZipsArray = Array.from(uniqueZips);
        const currentZips = user.territory_zip_codes || [];
        const newZips = uniqueZipsArray.length > 0 ? [...new Set([...uniqueZipsArray, ...currentZips])] : currentZips;
        try {
            await base44.auth.updateMe({
                territory_zip_codes: newZips,
                has_pulled_data: true,
                has_defined_market: true,
                territory_property_count: totalImported,
                last_data_pull: new Date().toISOString()
            });
        } catch (e) {
            console.error(`[FetchArea] Failed to update user data:`, e.message);
        }

        return Response.json({
            status: totalImported > 0 || inPolygonCount > 0 ? 'imported' : 'empty',
            count: newInsertCount,
            updated: upsertUpdateCount,
            total_found: totalFound,
            reported_total: reportedTotal,
            in_polygon_count: inPolygonCount,
            recent_sales_12mo: recentSales12moCount,
            mapped_count: mappedCount,
            dropped_no_address: droppedNoAddressCount,
            listings_found: listingsTotalFound,
            total_requests: totalRequests,
            elapsed_seconds: parseFloat(totalElapsed),
            message: totalImported > 0
                ? `Loaded ${newInsertCount} new + ${upsertUpdateCount} updated properties (${totalRequests} API calls).`
                : inPolygonCount > 0
                    ? `${inPolygonCount} properties found — all already in your database.`
                    : `No properties found in this area.`
        });

    } catch (error) {
        console.error('[FetchArea] Fatal error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});