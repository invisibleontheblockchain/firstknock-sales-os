import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

function normalizeZipList(body) {
    if (Array.isArray(body.zip_codes)) return body.zip_codes.map(String).map(z => z.trim().slice(0, 5)).filter(Boolean);
    if (body.zip_code_filter) return String(body.zip_code_filter).split(',').map(z => z.trim().slice(0, 5)).filter(Boolean);
    return [];
}

function getBoundsFromPolygon(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const lats = polygon.map(p => Number(p.lat)).filter(Number.isFinite);
    const lngs = polygon.map(p => Number(p.lng)).filter(Number.isFinite);
    if (lats.length === 0 || lngs.length === 0) return null;
    return {
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
        minLng: Math.min(...lngs),
        maxLng: Math.max(...lngs)
    };
}

function requestedSoldWindowDays(soldMonths) {
    const months = Number(soldMonths || 1);
    if (Math.abs(months - (1 / 30)) < 0.0001) return 1;
    if (Math.abs(months - (2 / 30)) < 0.0001) return 2;
    if (months === 0.25) return 7;
    if (months === 0.5) return 14;
    if (months === 1) return 30;
    if (months === 3) return 90;
    if (months === 6) return 180;
    if (months === 9) return 270;
    if (months === 12) return 365;
    return Math.max(1, Math.round(months * 30));
}

function routeCandidateSoldWindowDays(soldMonths) {
    return requestedSoldWindowDays(soldMonths);
}

function isoDateDaysAgo(days, referenceMs = Date.now()) {
    const date = new Date(referenceMs - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const sql = neon(databaseUrl);
        const targetEmail = user.role === 'admin' && body.user_email ? body.user_email : user.email;
        const zipCodes = normalizeZipList(body);
        const polygonBounds = getBoundsFromPolygon(body.polygon);
        const bounds = body.bounds || polygonBounds;
        const limit = Math.min(Math.max(Number(body.limit || 50000), 1), 100000);
        const soldMonths = body.sold_months === 'all' || body.sold_months === null ? null : Number(body.sold_months || 12);
        const fetchJobId = body.fetch_job_id ? String(body.fetch_job_id) : null;
        let referenceMs = Date.now();
        if (fetchJobId) {
            const fetchJob = await base44.asServiceRole.entities.FetchJob.get(fetchJobId).catch(() => null);
            const fetchJobTime = fetchJob?.created_date || fetchJob?.started_at;
            const parsed = fetchJobTime ? new Date(fetchJobTime).getTime() : NaN;
            if (Number.isFinite(parsed)) referenceMs = parsed;
        }
        const soldAfter = soldMonths ? `${isoDateDaysAgo(routeCandidateSoldWindowDays(soldMonths), referenceMs)}T00:00:00.000Z` : null;

        if (body.debug_job === true && fetchJobId) {
            const debugRows = await sql`
                SELECT
                    p.full_address,
                    p.sold_date,
                    p.sale_confidence,
                    p.original_status,
                    p.property_type,
                    p.data_source,
                    p.raw_payload,
                    wp.route_active,
                    wp.status,
                    wp.fetch_job_id
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                WHERE wp.user_email = ${targetEmail}
                  AND wp.fetch_job_id = ${fetchJobId}
                ORDER BY p.updated_at DESC
                LIMIT ${limit}
            `;
            const properties = debugRows.map(row => {
                let raw = {};
                try { raw = row.raw_payload ? JSON.parse(row.raw_payload) : {}; } catch { raw = {}; }
                const listingStatus = String(raw?.listing?.status || raw?.listing?.statusCategory || '').toLowerCase();
                const landUseCode = raw?.general?.standardizedLandUseCode || raw?.standardizedLandUseCode || null;
                const reason = row.route_active === true && row.status !== 'REJECTED' && row.original_status !== 'REJECTED' && row.sale_confidence !== 'REJECTED'
                    ? 'active'
                    : !row.sold_date
                        ? 'missing_or_unmapped_sold_date'
                        : (landUseCode && landUseCode !== 'R2')
                            ? `land_use_${landUseCode}`
                            : (listingStatus === 'active' || listingStatus === 'for sale' || listingStatus === 'off market' || listingStatus === 'pending' || listingStatus === 'withdrawn')
                                ? `listing_${listingStatus}`
                                : 'rejected_by_local_eligibility';
                const rawShape = {
                    top_level: Object.keys(raw || {}).slice(0, 30),
                    intel_keys: Object.keys(raw?.intel || {}).slice(0, 30),
                    sale_keys: Object.keys(raw?.sale || {}).slice(0, 30),
                    last_sale_keys: Object.keys(raw?.lastSale || {}).slice(0, 30),
                    deed_keys: Object.keys(raw?.deed || {}).slice(0, 30),
                    listing_keys: Object.keys(raw?.listing || {}).slice(0, 30)
                };
                const { raw_payload, ...safeRow } = row;
                return { ...safeRow, rejection_reason: reason, batchdata_land_use_code: landUseCode, batchdata_listing_status: listingStatus || null, raw_shape: rawShape };
            });
            const breakdown = properties.reduce((acc, row) => {
                const key = row.rejection_reason || 'unknown';
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {});
            return Response.json({ success: true, user_email: targetEmail, fetch_job_id: fetchJobId, count: properties.length, breakdown, properties });
        }

        const rows = await sql`
            SELECT
                p.id,
                p.address_hash,
                p.legacy_hash,
                p.full_address,
                p.house_number,
                p.street_name,
                p.city,
                p.state,
                p.zip_code,
                p.lat,
                p.lng,
                p.h3_index,
                p.owner_full_name,
                p.beds,
                p.baths,
                p.sqft,
                p.lot_size,
                p.year_built,
                p.price,
                p.sold_date,
                p.sale_type,
                p.property_type,
                p.mls_id,
                p.url,
                p.data_source,
                p.sale_confidence,
                p.original_status,
                wp.route_active,
                wp.status,
                wp.fetch_job_id,
                wp.assigned_route_id,
                p.created_at,
                p.updated_at
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
              AND (${fetchJobId === null} OR wp.fetch_job_id = ${fetchJobId})
              AND (${fetchJobId !== null} OR wp.route_active = TRUE)
              AND p.lat IS NOT NULL
              AND p.lng IS NOT NULL
              AND (${fetchJobId !== null} OR COALESCE(wp.status, '') <> 'REJECTED')
              AND (${fetchJobId !== null} OR COALESCE(p.original_status, '') <> 'REJECTED')
              AND (${fetchJobId !== null} OR COALESCE(p.sale_confidence, '') <> 'REJECTED')
              AND (${zipCodes.length === 0} OR p.zip_code = ANY(${zipCodes}))
              AND (${fetchJobId !== null || soldAfter === null} OR p.sold_date IS NULL OR p.sold_date >= ${soldAfter})
              AND (${!bounds?.minLat} OR p.lat >= ${bounds?.minLat || 0})
              AND (${!bounds?.maxLat} OR p.lat <= ${bounds?.maxLat || 0})
              AND (${!bounds?.minLng} OR p.lng >= ${bounds?.minLng || 0})
              AND (${!bounds?.maxLng} OR p.lng <= ${bounds?.maxLng || 0})
            ORDER BY p.sold_date DESC NULLS LAST, p.updated_at DESC
            LIMIT ${limit}
        `;

        let properties = rows.map(row => ({
            ...row,
            id: String(row.id),
            address_hash: row.address_hash || String(row.id),
            created_date: row.created_at,
            updated_date: row.updated_at
        }));

        // Payload reduction: fields='map' returns only what the map pipeline needs
        // (pins, status colors, sold/price/phase filters, dedupe, detail sheet basics).
        // Cuts response size roughly in half vs. the full record.
        if (body.fields === 'map') {
            const MAP_FIELDS = [
                'id', 'address_hash', 'legacy_hash', 'full_address', 'house_number', 'street_name',
                'city', 'state', 'zip_code', 'lat', 'lng', 'owner_full_name', 'beds', 'baths', 'sqft',
                'lot_size', 'year_built', 'price', 'sold_date', 'sale_type', 'property_type', 'mls_id',
                'data_source', 'sale_confidence', 'original_status', 'route_active', 'status'
            ];
            properties = properties.map(p => {
                const slim = {};
                for (const f of MAP_FIELDS) {
                    if (p[f] !== undefined && p[f] !== null) slim[f] = p[f];
                }
                return slim;
            });
        }

        return Response.json({
            success: true,
            user_email: targetEmail,
            count: properties.length,
            capped: properties.length >= limit,
            limit,
            properties
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});