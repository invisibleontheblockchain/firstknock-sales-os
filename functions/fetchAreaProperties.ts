import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

const FREE_PULL_LIMIT = 1; // Number of area pulls allowed for free users
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
        const pullLimit = isPaid ? PAID_PULL_LIMIT : FREE_PULL_LIMIT;
        
        // Track usage (we'll reuse generated_zip_codes array for area pulls as a quick hack, or a new field)
        const areaPulls = user.area_pulls_count || 0;
        
        if (areaPulls >= pullLimit) {
            const upgradeMsg = !isPaid
                ? `You've used your free data pull. Subscribe to unlock more territories.`
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
        let hasMore = true;
        let requestCount = 0;
        const maxRequests = 10; // Up to 5000 properties

        while (hasMore && requestCount < maxRequests) {
            const params = new URLSearchParams({
                latitude: String(latitude),
                longitude: String(longitude),
                radius: String(radius), // in miles
                propertyType: 'Single Family',
                limit: String(limit),
                offset: String(offset),
            });

            const url = `${RENTCAST_BASE}/properties?${params.toString()}`;
            console.log(`[FetchArea] Request ${requestCount + 1}: offset=${offset}`);

            const response = await fetch(url, {
                headers: { 'accept': 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
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

            const data = await response.json();
            const batch = Array.isArray(data) ? data : [];
            console.log(`[FetchArea] Got ${batch.length} properties`);

            allProperties.push(...batch);
            requestCount++;

            if (batch.length < limit) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }

        // Increment usage
        try {
            await base44.auth.updateMe({ area_pulls_count: areaPulls + 1 });
        } catch (e) {
            console.error(`[FetchArea] Failed to update usage:`, e.message);
        }

        if (allProperties.length === 0) {
            return Response.json({
                status: 'empty', count: 0,
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

        // We need to figure out which ones we already have. 
        // For an area, it's easier to fetch existing ones inside a bounding box, but for simplicity, we'll just try to insert and ignore duplicates.
        // Or we can get existing hashes. Since area can cross zip codes, we can just rely on the database's unique constraint (if any) or check one by one.
        // Base44 bulkCreate might fail if there's a unique constraint, but we can do chunks and fallback to singles.

        // Map to schema
        const mapped = filteredProperties
            .filter(p => p.latitude && p.longitude && p.addressLine1)
            .map(p => {
                const addressMatch = (p.addressLine1 || "").match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (p.addressLine1 || "Unknown");
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
                status: 'empty', count: 0,
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

        return Response.json({
            status: 'imported',
            count: successCount,
            total_found: allProperties.length,
            message: `Imported ${successCount} new properties in area.`
        });

    } catch (error) {
        console.error('[FetchArea] Error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});