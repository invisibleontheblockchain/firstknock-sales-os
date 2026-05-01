import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

function extractZipFromHash(hash) {
    const piped = String(hash || '').match(/\|(\d{5})(?:-\d{4})?$/);
    if (piped) return piped[1];
    const trailing = String(hash || '').match(/(?:-|,|\s)(\d{5})(?:-\d{4})?$/);
    return trailing ? trailing[1] : null;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const hashes = Array.isArray(body.address_hashes)
            ? body.address_hashes.map(String).map(h => h.trim()).filter(Boolean)
            : [];

        if (hashes.length === 0) {
            return Response.json({ success: true, count: 0, properties: [] });
        }

        const sql = neon(databaseUrl);
        const targetEmail = user.role === 'admin' && body.user_email ? body.user_email : user.email;
        const limit = Math.min(Math.max(Number(body.limit || hashes.length), 1), 5000);

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
              AND p.lat IS NOT NULL
              AND p.lng IS NOT NULL
              AND (p.address_hash = ANY(${hashes}) OR p.legacy_hash = ANY(${hashes}))
            LIMIT ${limit}
        `;

        const byHash = new Map();
        rows.forEach(row => {
            const property = {
                ...row,
                id: String(row.id),
                address_hash: row.address_hash || String(row.id),
                created_date: row.created_at,
                updated_date: row.updated_at
            };
            byHash.set(property.address_hash, property);
            if (property.legacy_hash) byHash.set(property.legacy_hash, property);
        });

        const missingAfterWorkspace = hashes.filter(hash => !byHash.has(hash));
        if (missingAfterWorkspace.length > 0) {
            const directRows = await sql`
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
                    p.created_at,
                    p.updated_at
                FROM properties p
                WHERE p.lat IS NOT NULL
                  AND p.lng IS NOT NULL
                  AND (p.address_hash = ANY(${missingAfterWorkspace}) OR p.legacy_hash = ANY(${missingAfterWorkspace}))
                LIMIT ${limit}
            `;

            directRows.forEach(row => {
                const property = {
                    ...row,
                    id: String(row.id),
                    address_hash: row.address_hash || String(row.id),
                    created_date: row.created_at,
                    updated_date: row.updated_at
                };
                byHash.set(property.address_hash, property);
                if (property.legacy_hash) byHash.set(property.legacy_hash, property);
            });
        }

        const missingHashes = hashes.filter(hash => !byHash.has(hash));
        if (missingHashes.length > 0) {
            try {
                const missingSet = new Set(missingHashes);
                const zipCodes = [...new Set(missingHashes.map(extractZipFromHash).filter(Boolean))];
                const addressMatches = [];

                for (const zip of zipCodes) {
                    const zipRows = await base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000);
                    const zipArr = Array.isArray(zipRows) ? zipRows : (zipRows?.items || []);
                    zipArr.forEach(property => {
                        if (missingSet.has(property.address_hash) || (property.legacy_hash && missingSet.has(property.legacy_hash))) {
                            addressMatches.push(property);
                        }
                    });
                }

                const stillMissing = missingHashes.filter(hash => !addressMatches.some(p => p.address_hash === hash || p.legacy_hash === hash));
                const legacyMatches = stillMissing.length > 0
                    ? await base44.asServiceRole.entities.MasterProperty.filter({ legacy_hash: stillMissing }, null, limit)
                    : [];

                [...addressMatches, ...legacyMatches].forEach(property => {
                    if (property?.lat && property?.lng) {
                        byHash.set(property.address_hash, property);
                        if (property.legacy_hash) byHash.set(property.legacy_hash, property);
                    }
                });
            } catch (fallbackError) {
                console.warn('MasterProperty fallback skipped:', fallbackError.message);
            }
        }

        const properties = hashes.map(hash => byHash.get(hash)).filter(Boolean);

        return Response.json({
            success: true,
            user_email: targetEmail,
            requested_count: hashes.length,
            count: properties.length,
            properties
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});