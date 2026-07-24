import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const LEGACY_CANONICAL_RECOVERY_CUTOFF = Date.parse('2026-07-24T01:52:18.000Z');

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

function hasExactHashManifest(route, requestedHashes) {
    const routeHashes = Array.isArray(route?.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    if (routeHashes.length !== requestedHashes.length) return false;

    const requestedCounts = new Map();
    requestedHashes.forEach(hash => requestedCounts.set(hash, (requestedCounts.get(hash) || 0) + 1));
    for (const hash of routeHashes) {
        const remaining = requestedCounts.get(hash) || 0;
        if (remaining === 0) return false;
        requestedCounts.set(hash, remaining - 1);
    }
    return true;
}

function isLegacyCanonicalRecoveryRoute(route) {
    const createdAt = Date.parse(String(route?.created_date || ''));
    return Number.isFinite(createdAt) && createdAt <= LEGACY_CANONICAL_RECOVERY_CUTOFF;
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
        } else if (body.user_email) {
            // Compatibility for web/native clients released before route_id was
            // added to this request. RLS still limits the search to routes that
            // this caller may see, and the entire ordered manifest must match;
            // a partial or arbitrary hash request is never promoted to a route.
            const requestedOwner = String(body.user_email).trim();
            let visibleOwnerRoutes;
            try {
                visibleOwnerRoutes = asArray(await base44.entities.SavedRoute.filter({
                    created_by: requestedOwner,
                    property_hashes: { $all: [...new Set(hashes)] }
                }, '-updated_date', 100));
            } catch {
                // Older entity runtimes may not support $all on array fields.
                // Keep a bounded RLS-scoped fallback for already-installed apps.
                visibleOwnerRoutes = asArray(await base44.entities.SavedRoute.filter(
                    { created_by: requestedOwner },
                    '-updated_date',
                    5000
                ));
            }
            authorizedRoute = visibleOwnerRoutes.find(route => hasExactHashManifest(route, hashes)) || null;
            if (authorizedRoute) {
                targetEmail = String(authorizedRoute.created_by || '').trim();
                if (!targetEmail) {
                    throw new HttpError(409, 'route_owner_missing', 'This legacy route has no verifiable workspace owner.');
                }
            } else if (normalized(user.role) === 'admin') {
                targetEmail = requestedOwner;
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

        const missingWorkspaceHashes = hashes.filter(hash => !byHash.has(hash));
        const allowedOwnersByHash = new Map();
        if (authorizedRoute) {
            const ownerEmail = normalized(targetEmail);
            missingWorkspaceHashes.forEach(hash => allowedOwnersByHash.set(hash, new Set([ownerEmail])));
        } else if (missingWorkspaceHashes.length > 0) {
            // Callback/appointment lookups do not carry a route. A caller-visible
            // interaction is the durable tenant-scoped proof for those hashes.
            const visibleLogs = asArray(await base44.entities.InteractionLog.filter({
                address_hash: missingWorkspaceHashes
            }, '-created_date', Math.min(5000, Math.max(missingWorkspaceHashes.length * 5, 100))));
            for (const log of visibleLogs) {
                const hash = String(log?.address_hash || '');
                const ownerEmail = normalized(log?.created_by);
                if (!missingWorkspaceHashes.includes(hash) || !ownerEmail) continue;
                if (!allowedOwnersByHash.has(hash)) allowedOwnersByHash.set(hash, new Set());
                allowedOwnersByHash.get(hash).add(ownerEmail);
            }
        }

        // Historical routes can outlive their workspace_properties link. Only
        // hashes on a caller-visible route created before the hardened link
        // contract, or hashes proven by caller-visible interaction history, may
        // use the canonical recovery copy. New client-created route manifests
        // cannot authorize global property reads.
        const routeMayRecoverCanonical = authorizedRoute && isLegacyCanonicalRecoveryRoute(authorizedRoute);
        const canonicalAuthorizedHashes = missingWorkspaceHashes.filter(hash =>
            routeMayRecoverCanonical
                ? allowedOwnersByHash.has(hash)
                : !authorizedRoute && allowedOwnersByHash.has(hash)
        );
        if (canonicalAuthorizedHashes.length > 0) {
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
                  AND (p.address_hash = ANY(${canonicalAuthorizedHashes}) OR p.legacy_hash = ANY(${canonicalAuthorizedHashes}))
                LIMIT ${Math.min(limit, canonicalAuthorizedHashes.length)}
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

            // Read-repair the missing tenant links after successful legacy
            // recovery. This is additive and preserves any existing status.
            if (routeMayRecoverCanonical && routeRows.length > 0) {
                await sql`
                    INSERT INTO workspace_properties (
                        property_id,
                        user_email,
                        route_active,
                        status,
                        assigned_route_id,
                        updated_at
                    )
                    SELECT
                        p.id,
                        ${targetEmail},
                        TRUE,
                        COALESCE(p.original_status, 'ELIGIBLE'),
                        ${String(authorizedRoute.id)},
                        NOW()
                    FROM properties p
                    WHERE p.address_hash = ANY(${canonicalAuthorizedHashes})
                       OR p.legacy_hash = ANY(${canonicalAuthorizedHashes})
                    ON CONFLICT (property_id, user_email) DO NOTHING
                `.catch(error => console.warn('Legacy route link read-repair skipped:', error.message));
            }
        }

        // CSV-imported properties may exist only in Base44. Their fallback is
        // allowed only when a caller-visible route or interaction proves both
        // the requested hash and the original creator/workspace owner.
        const missingHashes = hashes.filter(hash => !byHash.has(hash));
        if (missingHashes.length > 0) {
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
