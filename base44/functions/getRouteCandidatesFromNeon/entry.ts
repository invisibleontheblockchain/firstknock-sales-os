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
        const soldAfter = soldMonths ? new Date(Date.now() - soldMonths * 30 * 24 * 60 * 60 * 1000).toISOString() : null;

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
                wp.assigned_route_id,
                p.created_at,
                p.updated_at
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
              AND wp.route_active = TRUE
              AND p.lat IS NOT NULL
              AND p.lng IS NOT NULL
              AND COALESCE(p.original_status, '') <> 'REJECTED'
              AND COALESCE(p.sale_confidence, '') <> 'REJECTED'
              AND (${zipCodes.length === 0} OR p.zip_code = ANY(${zipCodes}))
              AND (${soldAfter === null} OR p.sold_date IS NULL OR p.sold_date >= ${soldAfter})
              AND (${!bounds?.minLat} OR p.lat >= ${bounds?.minLat || 0})
              AND (${!bounds?.maxLat} OR p.lat <= ${bounds?.maxLat || 0})
              AND (${!bounds?.minLng} OR p.lng >= ${bounds?.minLng || 0})
              AND (${!bounds?.maxLng} OR p.lng <= ${bounds?.maxLng || 0})
            ORDER BY p.sold_date DESC NULLS LAST, p.updated_at DESC
            LIMIT ${limit}
        `;

        const properties = rows.map(row => ({
            ...row,
            id: String(row.id),
            address_hash: row.address_hash || String(row.id),
            created_date: row.created_at,
            updated_date: row.updated_at
        }));

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