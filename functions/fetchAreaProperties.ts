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
        const isOwner = user.is_owner === true || user.email?.toLowerCase() === 'christian@nativapest.com' || user.email?.toLowerCase() === 'christian@nativapes.com';
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

        const allProperties = [];
        
        // OPTIMIZATION: Only fetch Golden Doors (Recent Sales in last 3 years)
        // This drastically cuts down RentCast API calls/costs while perfectly aligning 
        // with the FirstKnock Best algorithm thesis of targeting qualified new homebuyers.
        let requestCount = 0;
        let reportedTotal = 0;
        let offset = 0;
        const limit = 500;
        
        // Increase the cap since we are only pulling high-value targets now
        const maxItems = isOwner ? 50000 : 10000; 

        // First request to get total count
        const initialParams = new URLSearchParams({
            latitude: String(latitude),
            longitude: String(longitude),
            radius: String(radius),
            limit: String(limit),
            offset: String(offset),
            saleDateRange: '0:1095', // ONLY homes sold in the last 3 years (Golden Doors)
            propertyType: 'Single Family,Townhouse,Multi-Family', // Exclude land, commercial, etc.
            includeTotalCount: 'true',
        });

        const initialUrl = `${RENTCAST_BASE}/properties?${initialParams.toString()}`;
        console.log(`[FetchArea - Optimized Recent Sales] Initial Request: offset=${offset}`);

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
        allProperties.push(...initialBatch);
        requestCount++;
        offset += limit;

        const targetTotal = Math.min(reportedTotal || maxItems, maxItems);

        // Parallelize remaining requests to prevent timeouts on large areas
        if (initialBatch.length === limit && offset < targetTotal) {
            const fetchTasks = [];
            while (offset < targetTotal && requestCount < (isOwner ? 100 : 20)) {
                const currentOffset = offset;
                fetchTasks.push(async () => {
                    const params = new URLSearchParams({
                        latitude: String(latitude),
                        longitude: String(longitude),
                        radius: String(radius),
                        limit: String(limit),
                        offset: String(currentOffset),
                        saleDateRange: '0:1095',
                        propertyType: 'Single Family,Townhouse,Multi-Family',
                    });
                    const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
                    try {
                        const res = await fetch(url, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
                        return res.ok ? await res.json() : [];
                    } catch (err) {
                        console.error(`[FetchArea] Parallel fetch error:`, err.message);
                        return [];
                    }
                });
                
                offset += limit;
                requestCount++;
            }

            console.log(`[FetchArea] Firing ${fetchTasks.length} parallel requests in chunks...`);
            
            // Execute in chunks of 5 to avoid rate limits and memory spikes
            for (let i = 0; i < fetchTasks.length; i += 5) {
                const chunk = fetchTasks.slice(i, i + 5).map(task => task());
                const results = await Promise.all(chunk);
                for (const data of results) {
                    const batch = Array.isArray(data) ? data : [];
                    allProperties.push(...batch);
                }
                if (Date.now() - startTime > MAX_EXECUTION_TIME) {
                    console.warn('[FetchArea] Execution time limit approaching, breaking early.');
                    break;
                }
            }
        }

        console.log(`[FetchArea] Finished. Found ${allProperties.length} recently sold properties before polygon check.`);

        // Usage already pre-incremented before API calls (see above)

        if (allProperties.length === 0) {
            return Response.json({
                status: 'empty',
                count: 0,
                total_found: 0,
                total_returned_by_api: 0,
                in_polygon_count: 0,
                recent_sales_12mo: 0,
                mapped_count: 0,
                dropped_no_address: 0,
                message: `No properties found in this area.`
            });
        }

        // Filter by exact polygon if provided
        let filteredProperties = allProperties;
        if (polygon && polygon.length >= 3) {
            filteredProperties = allProperties.filter(p => {
                if (!p.latitude || !p.longitude) return false;
                return isPointInPolygon({ lat: p.latitude, lng: p.longitude }, polygon);
            });
            console.log(`[FetchArea] Filtered down to ${filteredProperties.length} properties inside the drawn polygon.`);
        }
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
        const recentSales12moCount = filteredProperties.reduce((acc, p) => {
            if (p.lastSaleDate) {
                const d = new Date(p.lastSaleDate);
                if (!isNaN(d) && d > twelveMonthsAgo) return acc + 1;
            }
            return acc;
        }, 0);
        const droppedNoAddressCount = filteredProperties.filter(p => !(p.addressLine1 || p.formattedAddress) || !p.latitude || !p.longitude).length;

        // We need to figure out which ones we already have. 
        // For an area, it's easier to fetch existing ones inside a bounding box, but for simplicity, we'll just try to insert and ignore duplicates.
        // Or we can get existing hashes. Since area can cross zip codes, we can just rely on the database's unique constraint (if any) or check one by one.
        // Base44 bulkCreate might fail if there's a unique constraint, but we can do chunks and fallback to singles.

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

        console.log(`[FetchArea] ${mapped.length} valid properties to import`);

        if (mapped.length === 0) {
            return Response.json({
                status: 'empty',
                count: 0,
                total_found: allProperties.length,
                total_returned_by_api: allProperties.length,
                in_polygon_count: filteredProperties.length,
                recent_sales_12mo: recentSales12moCount,
                mapped_count: 0,
                dropped_no_address: droppedNoAddressCount,
                message: `Properties found but none matched criteria inside polygon.`
            });
        }

        // Deduplicate against database
        const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
        const existingHashes = new Set();

        console.log(`[FetchArea] Checking existing data for ${uniqueZips.length} zips...`);
        // Fetch up to 5000 existing hashes per zip to be safe, parallelize to avoid timeouts on large areas
        for (let i = 0; i < uniqueZips.length; i += 5) {
            const batchZips = uniqueZips.slice(i, i + 5);
            await Promise.all(batchZips.map(async (zip) => {
                try {
                    const existing = await base44.entities.MasterProperty.filter({ zip_code: zip }, null, 5000);
                    const existingArr = Array.isArray(existing) ? existing : (existing?.items || []);
                    existingArr.forEach(p => existingHashes.add(p.address_hash));
                } catch (e) {
                    console.warn(`[FetchArea] Failed to fetch existing for zip ${zip}:`, e.message);
                }
            }));
            if (Date.now() - startTime > MAX_EXECUTION_TIME) {
                console.warn('[FetchArea] Execution time limit approaching during deduplication, breaking early.');
                break;
            }
        }

        const newMapped = mapped.filter(p => !existingHashes.has(p.address_hash));
        console.log(`[FetchArea] ${newMapped.length} NEW properties to import (out of ${mapped.length})`);

        // Bulk insert new properties
        let successCount = 0;
        if (newMapped.length > 0) {
            const CHUNK_SIZE = 500; // Increased chunk size for faster inserts
            for (let i = 0; i < newMapped.length; i += CHUNK_SIZE) {
                const chunk = newMapped.slice(i, i + CHUNK_SIZE);
                try {
                    await base44.entities.MasterProperty.bulkCreate(chunk);
                    successCount += chunk.length;
                } catch (e) {
                    console.error(`[FetchArea] Chunk import failed, trying small chunks:`, e.message);
                    // Minimal fallback: try chunks of 50
                    const SMALL_CHUNK = 50;
                    for (let j = 0; j < chunk.length; j += SMALL_CHUNK) {
                        const small = chunk.slice(j, j + SMALL_CHUNK);
                        try {
                            await base44.entities.MasterProperty.bulkCreate(small);
                            successCount += small.length;
                        } catch {
                            // If even small chunks fail, likely a true DB error or single bad record
                            console.warn(`[FetchArea] Small chunk failed, skipping`);
                        }
                    }
                }
                
                if (Date.now() - startTime > MAX_EXECUTION_TIME + 10000) {
                    console.warn('[FetchArea] Execution time limit approaching during DB inserts, breaking early.');
                    break;
                }
            }
        }

        console.log(`[FetchArea] Done! Imported ${successCount}/${newMapped.length} new properties.`);

        // Update user's territory zip codes so the frontend loads them
        if (uniqueZips.length > 0) {
            const currentZips = user.territory_zip_codes || [];
            const newZips = [...new Set([...currentZips, ...uniqueZips])];
            try {
                await base44.auth.updateMe({ territory_zip_codes: newZips });
            } catch (e) {
                console.error(`[FetchArea] Failed to update user zips:`, e.message);
            }
        }

        return Response.json({
            status: 'imported',
            count: successCount,
            total_found: allProperties.length,
            reported_total: reportedTotal,
            in_polygon_count: filteredProperties.length,
            recent_sales_12mo: recentSales12moCount,
            mapped_count: mapped.length,
            dropped_no_address: droppedNoAddressCount,
            message: `Imported ${successCount} new properties in area.`
        });

    } catch (error) {
        console.error('[FetchArea] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});