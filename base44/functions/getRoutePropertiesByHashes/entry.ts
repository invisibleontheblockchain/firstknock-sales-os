import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function asArray(value) {
    return Array.isArray(value) ? value : (value?.items || []);
}

function normalized(value) {
    return String(value || '').trim().toLowerCase();
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
        if (hashes.length > 5000 || hashes.some(hash => hash.length > 256)) {
            throw new HttpError(400, 'invalid_property_lookup', 'Property lookup accepts at most 5,000 valid address hashes.');
        }

        if (hashes.length === 0) {
            return Response.json({ success: true, count: 0, properties: [] });
        }

        const sql = neon(databaseUrl);
        let targetEmail = String(user.email || '').trim();
        const limit = Math.min(Math.max(Number(body.limit || hashes.length), 1), 5000);
        const routeId = body.route_id ? String(body.route_id).trim() : null;
        let authorizedRoute = null;
        if (routeId) {
            authorizedRoute = await base44.entities.SavedRoute.get(routeId).catch(() => null);
            if (!authorizedRoute) {
                throw new HttpError(403, 'route_access_denied', 'This route is not visible to the authenticated account.');
            }
            const routeHashes = new Set((authorizedRoute.property_hashes || []).map(String));
            if (hashes.some(hash => !routeHashes.has(hash))) {
                throw new HttpError(403, 'route_hash_mismatch', 'The request contains a property that is not on this route.');
            }
            targetEmail = String(authorizedRoute.created_by || '').trim();
            if (!targetEmail) {
                throw new HttpError(409, 'route_owner_missing', 'This legacy route has no verifiable workspace owner.');
            }
        } else if (normalized(user.role) === 'admin' && body.user_email) {
            targetEmail = String(body.user_email).trim();
        }
        if (!targetEmail) {
            throw new HttpError(403, 'workspace_owner_missing', 'No verifiable workspace owner is available for this lookup.');
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
                NULLIF(to_jsonb(p) ->> 'owner_occupied', '')::BOOLEAN AS owner_occupied,
                NULLIF(to_jsonb(p) ->> 'corporate_owned', '')::BOOLEAN AS corporate_owned,
                NULLIF(to_jsonb(p) ->> 'investor_owned', '')::BOOLEAN AS investor_owned,
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

        // Historical routes can outlive their workspace_properties link. Once
        // SavedRoute RLS has proved that this caller can see the route and the
        // hash-membership check above has proved every requested hash belongs
        // to it, hydrating those exact hashes from the canonical property table
        // is tenant-safe. Never run this fallback for an arbitrary hash lookup.
        const missingWorkspaceHashes = hashes.filter(hash => !byHash.has(hash));
        if (authorizedRoute && missingWorkspaceHashes.length > 0) {
            const routeRows = await sql`
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
                    NULLIF(to_jsonb(p) ->> 'owner_occupied', '')::BOOLEAN AS owner_occupied,
                    NULLIF(to_jsonb(p) ->> 'corporate_owned', '')::BOOLEAN AS corporate_owned,
                    NULLIF(to_jsonb(p) ->> 'investor_owned', '')::BOOLEAN AS investor_owned,
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
                  AND (p.address_hash = ANY(${missingWorkspaceHashes}) OR p.legacy_hash = ANY(${missingWorkspaceHashes}))
                LIMIT ${Math.min(limit, missingWorkspaceHashes.length)}
            `;

            for (const row of routeRows) {
                const property = {
                    ...row,
                    id: String(row.id),
                    address_hash: row.address_hash || String(row.id),
                    created_date: row.created_at,
                    updated_date: row.updated_at
                };
                if (property.address_hash) byHash.set(property.address_hash, property);
                if (property.legacy_hash) byHash.set(property.legacy_hash, property);
            }
        }

        // CSV-imported properties may exist only in Base44. Their fallback is
        // allowed only when a caller-visible route or interaction proves both
        // the requested hash and the original creator/workspace owner.
        const missingHashes = hashes.filter(hash => !byHash.has(hash));
        if (missingHashes.length > 0) {
            const allowedOwnersByHash = new Map();
            if (authorizedRoute) {
                const ownerEmail = normalized(targetEmail);
                missingHashes.forEach(hash => allowedOwnersByHash.set(hash, new Set([ownerEmail])));
            } else {
                const visibleLogs = asArray(await base44.entities.InteractionLog.filter({
                    address_hash: missingHashes
                }, '-created_date', Math.min(5000, Math.max(missingHashes.length * 5, 100))));
                for (const log of visibleLogs) {
                    const hash = String(log?.address_hash || '');
                    const ownerEmail = normalized(log?.created_by);
                    if (!missingHashes.includes(hash) || !ownerEmail) continue;
                    if (!allowedOwnersByHash.has(hash)) allowedOwnersByHash.set(hash, new Set());
                    allowedOwnersByHash.get(hash).add(ownerEmail);
                }
            }

            const authorizedHashes = missingHashes.filter(hash => allowedOwnersByHash.has(hash));
            const BATCH = 100;
            for (let i = 0; i < authorizedHashes.length; i += BATCH) {
                const slice = authorizedHashes.slice(i, i + BATCH);
                const [primaryResult, legacyResult] = await Promise.all([
                    base44.asServiceRole.entities.MasterProperty.filter({ address_hash: slice }, null, slice.length),
                    base44.asServiceRole.entities.MasterProperty.filter({ legacy_hash: slice }, null, slice.length)
                ]);
                for (const property of [...asArray(primaryResult), ...asArray(legacyResult)]) {
                    if (!property?.lat || !property?.lng) continue;
                    const requestedHash = slice.find(hash =>
                        hash === String(property.address_hash || '')
                        || hash === String(property.legacy_hash || '')
                    );
                    if (!requestedHash) continue;
                    const allowedOwners = allowedOwnersByHash.get(requestedHash);
                    if (!allowedOwners?.has(normalized(property.created_by))) continue;
                    byHash.set(requestedHash, property);
                }
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
        return Response.json({
            error: error.message,
            code: error.code || 'route_property_lookup_failed'
        }, { status: Number(error.status || 500) });
    }
});
