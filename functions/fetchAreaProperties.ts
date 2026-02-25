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
        const maxRadius = 20; // 40 miles across cap

        if (radius > maxRadius) {
            return Response.json({ 
                error: 'Area too large', 
                message: `The drawn area is too large (approx ${Math.round(radius * 2)} miles across). Please draw a smaller territory (max ${maxRadius * 2} miles across).` 
            }, { status: 400 });
        }

        const pullLimit = isPaid ? PAID_PULL_LIMIT : FREE_PULL_LIMIT;
        
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

        console.log(`[FetchArea] Fetching from RentCast for lat:${latitude}, lng:${longitude}, r:${radius}`);

        const allProperties = [];
        let offset = 0;
        const limit = 500;
        let requestCount = 0;
        let reportedTotal = 0;

        while (true) {
            const params = new URLSearchParams({
                latitude: String(latitude),
                longitude: String(longitude),
                radius: String(radius),
                limit: String(limit),
                offset: String(offset),
                includeTotalCount: 'true',
            });

            const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
            console.log(`[FetchArea] Request ${requestCount + 1}: offset=${offset}`);

            const response = await fetch(url, {
                headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY },
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[FetchArea] RentCast error ${response.status}: ${errText}`);
                if (response.status === 429) break;
                if (requestCount === 0) {
                    return Response.json({ error: `RentCast API error: ${response.status}` }, { status: 500 });
                }
                break;
            }

            const totalHeader = response.headers.get('X-Total-Count');
            if (totalHeader) {
                const n = parseInt(totalHeader, 10);
                if (!isNaN(n)) reportedTotal = n;
            }

            const data = await response.json();
            const batch = Array.isArray(data) ? data : [];
            console.log(`[FetchArea] Got ${batch.length} properties (total so far: ${allProperties.length + batch.length}${reportedTotal ? ` / ${reportedTotal}` : ''})`);

            allProperties.push(...batch);
            requestCount++;
            if (batch.length < limit) break;
            offset += limit;
            if (requestCount >= 20) { console.warn('[FetchArea] Reached safety page cap (20).'); break; }
        }

        // Increment usage
        try {
            await base44.auth.updateMe({ area_pulls_count: areaPulls + 1 });
        } catch (e) {
            console.error(`[FetchArea] Failed to update usage:`, e.message);
        }

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
                    const twoYearsAgo = new Date();
                    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
                    if (saleDate > twoYearsAgo) original_status = 'SOLD';
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

        // Bulk insert
        let successCount = 0;
        const CHUNK_SIZE = 50;
        for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
            const chunk = mapped.slice(i, i + CHUNK_SIZE);
            try {
                // If there's a unique constraint on address_hash, bulkCreate might fail the whole chunk if one exists.
                // We'll try bulk, if fails, do singles.
                await base44.entities.MasterProperty.bulkCreate(chunk);
                successCount += chunk.length;
            } catch (e) {
                console.error(`[FetchArea] Bulk failed, trying singles`);
                for (const prop of chunk) {
                    try { 
                        // Check if exists first to avoid errors spam
                        const exists = await base44.entities.MasterProperty.filter({ address_hash: prop.address_hash }, null, 1);
                        const existingArr = Array.isArray(exists) ? exists : (exists?.items || []);
                        if (existingArr.length === 0) {
                            await base44.entities.MasterProperty.create(prop); 
                            successCount++; 
                        }
                    } catch {}
                }
            }
        }

        console.log(`[FetchArea] Done! Imported ${successCount}/${mapped.length}`);

        // Update user's territory zip codes so the frontend loads them
        const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
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