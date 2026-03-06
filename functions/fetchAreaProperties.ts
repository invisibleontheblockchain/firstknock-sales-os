import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { polygonToCells, latLngToCell } from 'npm:h3-js@4.1.0';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

function isPointInPolygon(point, vs) {
    if (!vs || vs.length < 3) return true;
    let x = point.lng, y = point.lat;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].lng, yi = vs[i].lat;
        let xj = vs[j].lng, yj = vs[j].lat;
        let intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
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
        const { latitude, longitude, radius, polygon } = body;

        if (!latitude || !longitude || !radius) {
            return Response.json({ error: 'Latitude, longitude, and radius are required' }, { status: 400 });
        }

        if (!RENTCAST_API_KEY) {
            return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
        }

        // Pre-compute H3 cells for polygon filtering
        let polygonH3Cells = new Set();
        let useH3Filter = false;
        if (polygon && polygon.length >= 3) {
            try {
                const h3Polygon = polygon.map(p => [p.lat, p.lng]);
                if (h3Polygon[0][0] !== h3Polygon[h3Polygon.length - 1][0] || h3Polygon[0][1] !== h3Polygon[h3Polygon.length - 1][1]) {
                    h3Polygon.push([...h3Polygon[0]]);
                }
                const cells = polygonToCells(h3Polygon, 9);
                polygonH3Cells = new Set(cells);
                useH3Filter = cells.length > 0;
                console.log(`[FetchArea] Pre-computed ${cells.length} H3 cells for polygon`);
            } catch (e) {
                console.warn("[FetchArea] H3 failed, using ray-casting:", e.message);
            }
        }

        const startTime = Date.now();
        const LIMIT = 500;
        const MAX_PARALLEL = 5;
        const PROPERTY_TYPES = 'Single Family,Townhouse,Condo,Multi-Family,Duplex,Triplex,Fourplex,Apartment,Mobile Home,Cooperative,Timeshare';

        let requestCount = 0;
        let reportedTotal = 0;

        // =====================================================================
        // PHASE 1: FETCH ALL DATA FROM RENTCAST (spend max time here)
        // Collect everything in memory first, write to DB after.
        // =====================================================================
        const FETCH_TIME_BUDGET = 35000; // 35s for fetching
        const allRawRecords = [];

        console.log(`[FetchArea] === PHASE 1: FETCH from RentCast === lat:${latitude}, lng:${longitude}, r:${radius} mi`);

        // First request — get total count
        const initialParams = new URLSearchParams({
            latitude: String(latitude), longitude: String(longitude),
            radius: String(radius), limit: String(LIMIT), offset: '0',
            propertyType: PROPERTY_TYPES, includeTotalCount: 'true',
        });

        const initialResponse = await fetch(`${RENTCAST_BASE}/properties?${initialParams}`, {
            headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
        });
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
        allRawRecords.push(...initialBatch);
        console.log(`[FetchArea] Page 1: ${initialBatch.length} records, X-Total-Count=${reportedTotal}`);

        // Paginate remaining pages
        if (initialBatch.length >= LIMIT && reportedTotal > LIMIT) {
            const totalToFetch = Math.min(reportedTotal, 50000);
            const totalPages = Math.ceil(totalToFetch / LIMIT);
            console.log(`[FetchArea] Need ${totalPages - 1} more pages to get ${totalToFetch} records`);

            // Build all fetch tasks
            const fetchTasks = [];
            for (let page = 1; page < totalPages; page++) {
                fetchTasks.push(page * LIMIT);
            }

            // Execute in parallel chunks
            for (let i = 0; i < fetchTasks.length; i += MAX_PARALLEL) {
                if (Date.now() - startTime > FETCH_TIME_BUDGET) {
                    console.warn(`[FetchArea] Fetch time budget hit at offset ${fetchTasks[i]}, stopping. Got ${allRawRecords.length} so far.`);
                    break;
                }

                const offsets = fetchTasks.slice(i, i + MAX_PARALLEL);
                const promises = offsets.map(offset => {
                    const params = new URLSearchParams({
                        latitude: String(latitude), longitude: String(longitude),
                        radius: String(radius), limit: String(LIMIT), offset: String(offset),
                        propertyType: PROPERTY_TYPES,
                    });
                    return fetch(`${RENTCAST_BASE}/properties?${params}`, {
                        headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
                    }).then(async res => {
                        if (!res.ok) return [];
                        return await res.json();
                    }).catch(() => []);
                });

                const results = await Promise.all(promises);
                requestCount += results.length;

                let pageRecords = 0;
                for (const data of results) {
                    const batch = Array.isArray(data) ? data : [];
                    allRawRecords.push(...batch);
                    pageRecords += batch.length;
                }
                console.log(`[FetchArea] Chunk ${Math.floor(i / MAX_PARALLEL) + 2}: +${pageRecords} records (total raw: ${allRawRecords.length})`);

                if (pageRecords === 0) break; // No more data
                if (i + MAX_PARALLEL < fetchTasks.length) await sleep(150);
            }
        }

        const fetchElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[FetchArea] === FETCH COMPLETE (${fetchElapsed}s) === ${allRawRecords.length} raw records, ${requestCount} API calls`);

        // =====================================================================
        // PHASE 2: FILTER & MAP (in-memory, fast)
        // =====================================================================
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

        let inPolygonCount = 0;
        let droppedNoAddressCount = 0;
        let recentSales12moCount = 0;

        const mapped = [];
        const seenHashes = new Set();

        for (const p of allRawRecords) {
            // Polygon filter
            if (polygon && polygon.length >= 3) {
                if (!p.latitude || !p.longitude) continue;
                if (useH3Filter) {
                    try {
                        const cell = latLngToCell(p.latitude, p.longitude, 9);
                        if (!polygonH3Cells.has(cell)) continue;
                    } catch (e) { continue; }
                }
                if (!isPointInPolygon({ lat: p.latitude, lng: p.longitude }, polygon)) continue;
            }
            inPolygonCount++;

            // Must have valid address and coords
            if (!(p.addressLine1 || p.formattedAddress) || !p.latitude || !p.longitude) {
                droppedNoAddressCount++;
                continue;
            }

            // Recent sale tracking
            if (p.lastSaleDate) {
                const d = new Date(p.lastSaleDate);
                if (!isNaN(d) && d > twelveMonthsAgo) recentSales12moCount++;
            }

            const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
            const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
            const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
            const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

            let original_status = 'ELIGIBLE';
            if (p.lastSaleDate) {
                const saleDate = new Date(p.lastSaleDate);
                if (!isNaN(saleDate) && saleDate > twelveMonthsAgo) {
                    original_status = 'SOLD';
                }
            }

            const pZip = p.zipCode || '00000';
            const hash = p.id || `${p.addressLine1}-${pZip}`;

            // Deduplicate within this fetch
            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);

            mapped.push({
                address_hash: hash, house_number, street_name,
                full_address: p.formattedAddress || p.addressLine1,
                city: p.city || '', state: p.state || '', zip_code: pZip,
                lat: p.latitude, lng: p.longitude, original_status,
                beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
                year_built: p.yearBuilt || 0, price: p.lastSalePrice || p.price || 0,
                sold_date: p.lastSaleDate || null, sale_type: 'Market',
                property_type: p.propertyType || 'Single Family',
                mls_id: p.assessorID || null, url: null
            });
        }

        const mapElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[FetchArea] === MAP COMPLETE (${mapElapsed}s) === inPolygon=${inPolygonCount}, mapped=${mapped.length}, dropped=${droppedNoAddressCount}`);

        // =====================================================================
        // PHASE 3: WRITE TO DB (dedup against existing, then bulk insert)
        // =====================================================================
        let newInsertCount = 0;
        let existedCount = 0;
        let soldUpdateCount = 0;

        if (mapped.length > 0) {
            // Fetch existing hashes from DB for dedup
            const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
            const existingHashToId = new Map();

            console.log(`[FetchArea] Fetching existing records for ${uniqueZips.length} zip codes...`);
            // Fetch in parallel chunks of 5 zips
            for (let i = 0; i < uniqueZips.length; i += 5) {
                const zipChunk = uniqueZips.slice(i, i + 5);
                const promises = zipChunk.map(zip =>
                    base44.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                        .then(res => {
                            const arr = Array.isArray(res) ? res : (res?.items || []);
                            arr.forEach(p => existingHashToId.set(p.address_hash, { id: p.id, status: p.original_status }));
                        })
                        .catch(e => console.warn(`[FetchArea] Failed to fetch zip ${zip}:`, e.message))
                );
                await Promise.all(promises);
                if (i + 5 < uniqueZips.length) await sleep(100);
            }

            console.log(`[FetchArea] Found ${existingHashToId.size} existing records in DB`);

            // Split: new inserts vs already exists
            const toInsert = [];
            const soldStatusUpdates = [];

            for (const p of mapped) {
                const existing = existingHashToId.get(p.address_hash);
                if (existing) {
                    existedCount++;
                    // If property is now SOLD but was ELIGIBLE in DB, update it
                    if (p.original_status === 'SOLD' && existing.status !== 'SOLD') {
                        soldStatusUpdates.push({ id: existing.id, sold_date: p.sold_date, price: p.price });
                    }
                } else {
                    toInsert.push(p);
                }
            }

            console.log(`[FetchArea] To insert: ${toInsert.length}, already existed: ${existedCount}, sold updates: ${soldStatusUpdates.length}`);

            // Bulk insert new records
            const CHUNK_SIZE = 500;
            for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
                if (Date.now() - startTime > 55000) {
                    console.warn(`[FetchArea] Time limit during inserts, inserted ${newInsertCount}/${toInsert.length}`);
                    break;
                }
                const chunk = toInsert.slice(i, i + CHUNK_SIZE);
                try {
                    await base44.entities.MasterProperty.bulkCreate(chunk);
                    newInsertCount += chunk.length;
                } catch (e) {
                    console.warn(`[FetchArea] Bulk insert failed, retrying smaller:`, e.message);
                    await sleep(500);
                    for (let j = 0; j < chunk.length; j += 100) {
                        const small = chunk.slice(j, j + 100);
                        try {
                            await base44.entities.MasterProperty.bulkCreate(small);
                            newInsertCount += small.length;
                        } catch (e2) {
                            console.warn(`[FetchArea] Small chunk failed:`, e2.message);
                        }
                        await sleep(200);
                    }
                }
            }

            // Update sold status changes (sequential, limited)
            for (let i = 0; i < Math.min(soldStatusUpdates.length, 50); i++) {
                if (Date.now() - startTime > 57000) break;
                const { id, sold_date, price } = soldStatusUpdates[i];
                try {
                    await base44.entities.MasterProperty.update(id, { original_status: 'SOLD', sold_date, price });
                    soldUpdateCount++;
                } catch (e) { /* silent */ }
                if (i % 5 === 4) await sleep(100);
            }
        }

        // Update user metadata
        const uniqueZipsArray = [...new Set(mapped.map(p => p.zip_code))];
        const currentZips = user.territory_zip_codes || [];
        const mergedZips = [...new Set([...uniqueZipsArray, ...currentZips])];
        const totalImported = newInsertCount + existedCount + soldUpdateCount;

        try {
            await base44.auth.updateMe({
                territory_zip_codes: mergedZips,
                has_pulled_data: true,
                has_defined_market: true,
                territory_property_count: totalImported,
                last_data_pull: new Date().toISOString(),
                area_pulls_count: (user.area_pulls_count || 0) + 1
            });
        } catch (e) {
            console.error(`[FetchArea] Failed to update user:`, e.message);
        }

        const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[FetchArea] ============ FINAL SUMMARY (${totalElapsed}s) ============`);
        console.log(`[FetchArea]   X-Total-Count:     ${reportedTotal}`);
        console.log(`[FetchArea]   Raw fetched:       ${allRawRecords.length}`);
        console.log(`[FetchArea]   In polygon:        ${inPolygonCount}`);
        console.log(`[FetchArea]   Mapped (unique):   ${mapped.length}`);
        console.log(`[FetchArea]   NEW inserted:      ${newInsertCount}`);
        console.log(`[FetchArea]   Already existed:   ${existedCount}`);
        console.log(`[FetchArea]   Sold updates:      ${soldUpdateCount}`);
        console.log(`[FetchArea]   API requests:      ${requestCount}`);
        console.log(`[FetchArea] ==============================================`);

        return Response.json({
            status: (newInsertCount > 0 || existedCount > 0) ? 'imported' : 'empty',
            count: newInsertCount,
            updated: soldUpdateCount,
            already_existed: existedCount,
            total_found: allRawRecords.length,
            reported_total: reportedTotal,
            in_polygon_count: inPolygonCount,
            mapped_count: mapped.length,
            recent_sales_12mo: recentSales12moCount,
            dropped_no_address: droppedNoAddressCount,
            total_requests: requestCount,
            elapsed_seconds: parseFloat(totalElapsed),
            message: newInsertCount > 0
                ? `Loaded ${newInsertCount} new properties (${existedCount} already in DB). ${requestCount} API calls.`
                : existedCount > 0
                    ? `${existedCount} properties already in your database. ${soldUpdateCount} status updates.`
                    : `No properties found in this area.`
        });

    } catch (error) {
        console.error('[FetchArea] Fatal error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});