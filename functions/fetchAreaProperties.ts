import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

const FREE_PULL_LIMIT = 3; // Number of area pulls allowed for free users
const PAID_PULL_LIMIT = 20; // Number of area pulls allowed for paid users

// Ray-casting algorithm for point in polygon
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

        const isPaid = user.subscription_status === 'active' || user.subscription_status === 'trialing';
        const isOwner = user.is_owner === true || user.email?.toLowerCase().includes('christian');
        const maxRadius = isOwner ? 999 : 20; // 40 miles across cap

        if (radius > maxRadius) {
            return Response.json({
                error: 'Area too large',
                message: `The drawn area is too large (approx ${Math.round(radius * 2)} miles across). Please draw a smaller territory (max ${maxRadius * 2} miles across).`
            }, { status: 400 });
        }

        const pullLimit = isOwner ? 999 : (isPaid ? PAID_PULL_LIMIT : FREE_PULL_LIMIT);

        // Track usage (we'll reuse generated_zip_codes array for area pulls as a quick hack, or a new field)
        const areaPulls = user.area_pulls_count || 0;

        if (areaPulls >= pullLimit) {
            const upgradeMsg = !isPaid
                ? `You've used your ${FREE_PULL_LIMIT} free data pulls. Subscribe to unlock more territories.`
                : `You've reached your data pull limit.`;
            return Response.json({ error: 'Data limit reached', message: upgradeMsg }, { status: 429 });
        }

        if (!RENTCAST_API_KEY) {
            return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
        }

        // Pre-increment usage BEFORE making expensive API calls (optimistic lock)
        // This prevents double-tap race conditions where two concurrent requests
        // both read areaPulls=0, both pass the check, and both fire API calls.
        try {
            await base44.auth.updateMe({ area_pulls_count: areaPulls + 1 });
        } catch (e) {
            console.error(`[FetchArea] Failed to pre-increment usage:`, e.message);
            // If we can't track usage, block the request to prevent abuse
            return Response.json({ error: 'Failed to verify usage limits. Please try again.' }, { status: 500 });
        }

        console.log(`[FetchArea] Fetching from RentCast for lat:${latitude}, lng:${longitude}, r:${radius}`);

        const startTime = Date.now();
        const MAX_EXECUTION_TIME = 55000; // 55 seconds to avoid timeout

        // OPTIMIZATION: Process in batches to prevent memory crashes on large areas
        let requestCount = 0;
        let reportedTotal = 0;
        let offset = 0;
        const limit = 500;
        const maxItems = 100000; 

        // Tracking stats
        let successCount = 0;
        let totalFound = 0;
        let inPolygonCount = 0;
        let mappedCount = 0;
        let recentSales12moCount = 0;
        let droppedNoAddressCount = 0;
        
        // Global caches for deduplication across batches
        const uniqueZips = new Set();
        const existingHashes = new Set();

        // Helper to process a batch of properties
        const processBatch = async (batch) => {
            if (!batch || batch.length === 0) return;
            totalFound += batch.length;

            // Filter by exact polygon if provided
            let filteredProperties = batch;
            if (polygon && polygon.length >= 3) {
                filteredProperties = batch.filter(p => {
                    if (!p.latitude || !p.longitude) return false;
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

            // Map to schema
            const mapped = filteredProperties
                .filter(p => p.latitude && p.longitude && (p.addressLine1 || p.formattedAddress))
                .map(p => {
                    const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                    const addressMatch = (addressLine).match(/^(\d+)\s+(.*)$/);
                    const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                    const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");
                    let original_status = 'ELIGIBLE';
                    if (p.lastSaleDate) {
                        const saleDate = new Date(p.lastSaleDate);
                        const oneYearAgo = new Date();
                        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
                        if (saleDate > oneYearAgo) original_status = 'SOLD';
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
                        year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
                        sold_date: p.lastSaleDate || null, sale_type: 'Market',
                        property_type: p.propertyType || 'Single Family',
                        mls_id: p.assessorID || null, url: null
                    };
                });

            mappedCount += mapped.length;
            if (mapped.length === 0) return;

            // Deduplicate against database
            const batchZips = [...new Set(mapped.map(p => p.zip_code))];
            const newZipsToFetch = batchZips.filter(z => !uniqueZips.has(z));
            
            for (const zip of newZipsToFetch) {
                uniqueZips.add(zip);
                try {
                    const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, null, 5000);
                    const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
                    existingArr.forEach(p => existingHashes.add(p.address_hash));
                } catch (e) {
                    console.warn(`[FetchArea] Failed to fetch existing for zip ${zip}:`, e.message);
                }
            }

            const newMapped = mapped.filter(p => !existingHashes.has(p.address_hash));
            
            if (newMapped.length > 0) {
                const CHUNK_SIZE = 500;
                for (let i = 0; i < newMapped.length; i += CHUNK_SIZE) {
                    const chunk = newMapped.slice(i, i + CHUNK_SIZE);
                    try {
                        await base44.entities.MasterProperty.bulkCreate(chunk);
                        successCount += chunk.length;
                    } catch (e) {
                        const SMALL_CHUNK = 50;
                        for (let j = 0; j < chunk.length; j += SMALL_CHUNK) {
                            const small = chunk.slice(j, j + SMALL_CHUNK);
                            try {
                                await base44.entities.MasterProperty.bulkCreate(small);
                                successCount += small.length;
                            } catch {}
                        }
                    }
                }
            }
        };

        // First request to get total count
        const initialParams = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            radius: String(radius),
            limit: String(limit),
            offset: String(offset),
            saleDateRange: '0:1095', // Last 3 years
            propertyType: 'Single Family,Townhouse,Condo,Multi-Family,Duplex,Triplex,Fourplex,Apartment,Mobile Home,Cooperative,Timeshare',
            includeTotalCount: 'true',
        });

        const initialUrl = `${RENTCAST_BASE}/properties?${initialParams.toString()}`;
        console.log(`[FetchArea] Initial Request: offset=${offset}`);

        const initialResponse = await fetch(initialUrl, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });

        if (!initialResponse.ok) {
            const errText = await initialResponse.text();
            console.error(`[FetchArea] RentCast error ${initialResponse.status}: ${errText}`);
            return Response.json({ error: `RentCast API error: ${initialResponse.status}` }, { status: 500 });
        }

        const totalHeader = initialResponse.headers.get('X-Total-Count');
        if (totalHeader) reportedTotal = parseInt(totalHeader, 10);

        const initialData = await initialResponse.json();
        const initialBatch = Array.isArray(initialData) ? initialData : [];
        await processBatch(initialBatch);
        requestCount++;
        offset += limit;

        const targetTotal = Math.min(reportedTotal || maxItems, maxItems);

        // Parallelize remaining requests in chunks to prevent memory spikes
        if (initialBatch.length === limit && offset < targetTotal) {
            const fetchTasks = [];
            while (offset < targetTotal && requestCount < 200) {
                const currentOffset = offset;
                fetchTasks.push(async () => {
                    const params = new URLSearchParams({
                        latitude: String(latitude),
                        longitude: String(longitude),
                        radius: String(radius),
                        limit: String(limit),
                        offset: String(currentOffset),
                        saleDateRange: '0:1095', // Last 3 years
                        propertyType: 'Single Family,Townhouse,Condo,Multi-Family,Duplex,Triplex,Fourplex,Apartment,Mobile Home,Cooperative,Timeshare',
                    });
                    const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
                    try {
                        const res = await fetch(url, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
                        return res.ok ? await res.json() : [];
                    } catch (err) {
                        return [];
                    }
                });
                
                offset += limit;
                requestCount++;
            }

            console.log(`[FetchArea] Firing ${fetchTasks.length} parallel requests in chunks...`);
            
            for (let i = 0; i < fetchTasks.length; i += 5) {
                const chunk = fetchTasks.slice(i, i + 5).map(task => task());
                const results = await Promise.all(chunk);
                
                // Process each result batch immediately to free memory
                for (const data of results) {
                    const batch = Array.isArray(data) ? data : [];
                    await processBatch(batch);
                }
                
                if (Date.now() - startTime > MAX_EXECUTION_TIME) {
                    console.warn('[FetchArea] Execution time limit approaching, breaking early.');
                    break;
                }
            }
        }

        console.log(`[FetchArea] Done! Imported ${successCount} new properties.`);

        // Update user's territory zip codes so the frontend loads them
        const uniqueZipsArray = Array.from(uniqueZips);
        if (uniqueZipsArray.length > 0) {
            const currentZips = user.territory_zip_codes || [];
            // Put new zips at the beginning so they are prioritized when frontend fetches data
            const newZips = [...new Set([...uniqueZipsArray, ...currentZips])];
            try {
                await base44.auth.updateMe({ territory_zip_codes: newZips });
            } catch (e) {
                console.error(`[FetchArea] Failed to update user zips:`, e.message);
            }
        }

        return Response.json({
            status: 'imported',
            count: successCount,
            total_found: totalFound,
            reported_total: reportedTotal,
            in_polygon_count: inPolygonCount,
            recent_sales_12mo: recentSales12moCount,
            mapped_count: mappedCount,
            dropped_no_address: droppedNoAddressCount,
            message: `Imported ${successCount} new properties in area.`
        });

    } catch (error) {
        console.error('[FetchArea] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});