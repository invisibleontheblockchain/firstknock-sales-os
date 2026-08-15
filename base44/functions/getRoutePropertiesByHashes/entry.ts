import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
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

function normalizedHashes(value) {
    return (Array.isArray(value) ? value : [])
        .map(hash => String(hash || '').trim())
        .filter(Boolean);
}

function hasExactHashManifest(route, requestedHashes) {
    const routeHashes = normalizedHashes(route?.property_hashes);
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

function hasFrozenLegacyManifest(route) {
    if (!isLegacyCanonicalRecoveryRoute(route)) return false;
    const updatedAt = Date.parse(String(route?.updated_date || route?.created_date || ''));
    return Number.isFinite(updatedAt) && updatedAt <= LEGACY_CANONICAL_RECOVERY_CUTOFF;
}

function pinSafeCanonicalProperty(property) {
    return {
        id: property.id,
        address_hash: property.address_hash,
        legacy_hash: property.legacy_hash,
        full_address: property.full_address,
        house_number: property.house_number,
        street_name: property.street_name,
        city: property.city,
        state: property.state,
        zip_code: property.zip_code,
        lat: property.lat,
        lng: property.lng,
        h3_index: property.h3_index,
        original_status: property.original_status,
        created_at: property.created_at,
        updated_at: property.updated_at,
        recovery_limited: true
    };
}

function hasCoordinates(property) {
    if (
        property?.lat === null
        || property?.lat === undefined
        || property?.lat === ''
        || property?.lng === null
        || property?.lng === undefined
        || property?.lng === ''
    ) {
        return false;
    }
    const latitude = Number(property?.lat);
    const longitude = Number(property?.lng);
    return Number.isFinite(latitude)
        && latitude >= -90
        && latitude <= 90
        && Number.isFinite(longitude)
        && longitude >= -180
        && longitude <= 180
        && !(Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001);
}

function chooseExactVisibleRoute(rows, hashes, requestedOwner = '') {
    const exactRoutes = rows.filter(route => hasExactHashManifest(route, hashes));
    if (exactRoutes.length === 0) return null;

    const frozenLegacyRoutes = exactRoutes.filter(hasFrozenLegacyManifest);
    const legacyRoutes = exactRoutes.filter(isLegacyCanonicalRecoveryRoute);
    const candidates = frozenLegacyRoutes.length > 0
        ? frozenLegacyRoutes
        : (legacyRoutes.length > 0 ? legacyRoutes : exactRoutes);
    const ownerEmail = normalized(requestedOwner);
    return candidates.find(route => (
        ownerEmail && normalized(route?.created_by) === ownerEmail
    )) || candidates[0];
}

async function findExactVisibleRoute(entity, query, hashes, requestedOwner = '') {
    const rows = asArray(await entity.filter(query, '-updated_date', 5000));
    return chooseExactVisibleRoute(rows, hashes, requestedOwner);
}

async function findLegacyVisibleRoute(base44, user, requestedOwner, hashes) {
    const routes = base44.entities.SavedRoute;

    // Keep the indexed array query as a fast path, but never assume an empty
    // result means there is no route. Older Base44 runtimes can silently ignore
    // or return no rows for $all instead of throwing.
    if (requestedOwner) {
        try {
            const fastRows = asArray(await routes.filter({
                created_by: requestedOwner,
                property_hashes: { $all: [...new Set(hashes)] }
            }, '-updated_date', 100));
            const exact = chooseExactVisibleRoute(fastRows, hashes, requestedOwner);
            if (exact) return exact;
        } catch {
            // Continue into RLS-scoped exact-manifest scans below.
        }
    }

    const scopedQueries = [];
    const seenQueries = new Set();
    const rememberQuery = (query) => {
        const key = JSON.stringify(query);
        if (seenQueries.has(key)) return;
        seenQueries.add(key);
        scopedQueries.push(query);
    };

    if (user?.id) rememberQuery({ manager_id: String(user.id) });
    const teamManagerId = user?.data?.team_manager_id || user?.team_manager_id;
    if (teamManagerId) {
        rememberQuery({ manager_id: String(teamManagerId) });
    }
    if (requestedOwner) rememberQuery({ created_by: requestedOwner });

    for (const query of scopedQueries) {
        try {
            const fastRows = asArray(await routes.filter({
                ...query,
                property_hashes: { $all: [...new Set(hashes)] }
            }, '-updated_date', 100));
            const fastExact = chooseExactVisibleRoute(
                fastRows,
                hashes,
                requestedOwner
            );
            if (fastExact) return fastExact;
        } catch {
            // Continue to the bounded exact-manifest scan for runtimes without
            // reliable array-operator support.
        }
        try {
            const exact = await findExactVisibleRoute(
                routes,
                query,
                hashes,
                requestedOwner
            );
            if (exact) return exact;
        } catch {
            // A narrower legacy index may not exist. Continue with the other
            // tenant-scoped queries; never fall back to an unbounded scan.
        }
    }
    return null;
}

async function resolveRouteTenantEmail(base44, user, route) {
    const userEmail = String(user?.email || '').trim();
    const userId = String(user?.id || '').trim();
    const teamManagerId = String(
        user?.data?.team_manager_id || user?.team_manager_id || ''
    ).trim();
    const managerId = String(route?.manager_id || '').trim();
    const creatorEmail = String(route?.created_by || '').trim();
    if (
        normalized(user?.role) === 'admin'
        && managerId !== userId
        && managerId !== teamManagerId
        && normalized(managerId) !== normalized(userEmail)
        && normalized(creatorEmail) !== normalized(userEmail)
    ) {
        throw new HttpError(
            403,
            'route_access_denied',
            'Administrative visibility is not delegated authority for another route tenant.'
        );
    }

    // manager_id is the SavedRoute tenant key. created_by is audit metadata
    // and may name a rep, importer, old email, or service account.
    if (
        managerId
        && userEmail
        && (managerId === userId || normalized(managerId) === normalized(userEmail))
    ) {
        return { email: userEmail, repairEmail: userEmail };
    }

    if (managerId && managerId === teamManagerId) {
        const managerEntity = base44.asServiceRole?.entities?.User;
        const manager = managerEntity?.get
            ? await managerEntity.get(managerId).catch(() => null)
            : null;
        if (manager?.email) {
            const managerEmail = String(manager.email).trim();
            return { email: managerEmail, repairEmail: managerEmail };
        }
    }

    if (creatorEmail && normalized(creatorEmail) === normalized(userEmail)) {
        return {
            email: userEmail,
            repairEmail: userEmail
        };
    }

    throw new HttpError(
        403,
        'route_access_denied',
        'This route is not owned by the authenticated user or their verified manager workspace.'
    );
}

async function filterMasterProperties(entity, field, hashes) {
    const collected = [];
    const seen = new Set();
    const collect = (result) => {
        for (const property of asArray(result)) {
            const id = String(property?.id || `${property?.address_hash || ''}:${property?.legacy_hash || ''}`);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            collected.push(property);
        }
    };

    try {
        collect(await entity.filter({ [field]: hashes }, null, hashes.length));
    } catch {
        // Retry with the explicit operator below.
    }
    try {
        collect(await entity.filter({ [field]: { $in: hashes } }, null, hashes.length));
    } catch {
        // The caller will continue with the other canonical source.
    }
    return collected;
}

async function loadVisibleInteractionOwners(base44, hashes) {
    const requestedHashes = new Set(hashes);
    const ownersByHash = new Map();
    let visibleLogs;
    try {
        visibleLogs = asArray(await base44.entities.InteractionLog.filter({
            address_hash: hashes
        }, '-created_date', Math.min(5000, Math.max(hashes.length * 5, 100))));
    } catch (error) {
        // Route/workspace hydration must remain available during an independent
        // interaction-log outage. No interaction-based authority is granted.
        console.warn('Interaction route hydration unavailable:', error.message);
        return ownersByHash;
    }
    for (const log of visibleLogs) {
        const hash = String(log?.address_hash || '');
        const ownerEmail = normalized(log?.created_by);
        if (!requestedHashes.has(hash) || !ownerEmail) continue;
        if (!ownersByHash.has(hash)) ownersByHash.set(hash, new Set());
        ownersByHash.get(hash).add(ownerEmail);
    }
    return ownersByHash;
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
        let repairEmail = null;
        let interactionOwnersByHash = new Map();
        if (routeId) {
            authorizedRoute = await base44.entities.SavedRoute.get(routeId).catch(() => null);
            if (!authorizedRoute) {
                throw new HttpError(403, 'route_access_denied', 'This route is not visible to the authenticated account.');
            }
            const routeHashes = new Set(normalizedHashes(authorizedRoute.property_hashes));
            if (hashes.some(hash => !routeHashes.has(hash))) {
                throw new HttpError(403, 'route_hash_mismatch', 'The request contains a property that is not on this route.');
            }
            const tenant = await resolveRouteTenantEmail(
                base44,
                user,
                authorizedRoute
            );
            targetEmail = tenant.email;
            repairEmail = tenant.repairEmail;
        } else {
            // Compatibility for web/native clients released before route_id was
            // added to this request. RLS still limits the search to routes that
            // this caller may see, and the entire ordered manifest must match;
            // a partial or arbitrary hash request is never promoted to a route.
            // Manager-scoped discovery also covers old rep clients whose
            // service-created route has no created_by email to send.
            const requestedOwner = String(body.user_email || '').trim();
            authorizedRoute = await findLegacyVisibleRoute(
                base44,
                user,
                requestedOwner,
                hashes
            );
            if (authorizedRoute) {
                const tenant = await resolveRouteTenantEmail(
                    base44,
                    user,
                    authorizedRoute
                );
                targetEmail = tenant.email;
                repairEmail = tenant.repairEmail;
            } else if (
                requestedOwner
                && normalized(requestedOwner) !== normalized(user.email)
            ) {
                throw new HttpError(
                    403,
                    'precision_delegation_not_authorized',
                    'A bare user_email cannot authorize cross-account property access.'
                );
            }
        }
        if (!routeId && !body.user_email) {
            if (!authorizedRoute && normalized(user.role) === 'admin') {
                throw new HttpError(
                    403,
                    'route_access_denied',
                    'Administrative interaction visibility is not delegated workspace authority. Provide an authorized route.'
                );
            }
            // Appointments/callbacks intentionally carry no route identity.
            // Interaction visibility can augment an already caller-authorized
            // route or a non-admin RLS scope, but never grants an admin a
            // foreign workspace merely because admin RLS can see the log.
            interactionOwnersByHash = await loadVisibleInteractionOwners(base44, hashes);
            const missingProofHashes = hashes.filter(hash => (
                !interactionOwnersByHash.has(hash)
            ));
            if (
                interactionOwnersByHash.size > 0
                && missingProofHashes.length > 0
            ) {
                const additionalOwners = await loadVisibleInteractionOwners(
                    base44,
                    missingProofHashes
                );
                for (const [hash, owners] of additionalOwners) {
                    if (!interactionOwnersByHash.has(hash)) {
                        interactionOwnersByHash.set(hash, new Set());
                    }
                    owners.forEach(owner => interactionOwnersByHash.get(hash).add(owner));
                }
            }
        }
        if (!targetEmail) {
            throw new HttpError(403, 'workspace_owner_missing', 'No verifiable workspace owner is available for this lookup.');
        }

        const interactionWorkspaceEmails = [];
        for (const owners of interactionOwnersByHash.values()) {
            interactionWorkspaceEmails.push(...owners);
        }
        const workspaceEmails = [...new Set([
            targetEmail,
            authorizedRoute?.created_by,
            user.email,
            ...interactionWorkspaceEmails
        ].map(value => String(value || '').trim()).filter(Boolean))];
        const rowsById = new Map();
        for (const workspaceEmail of workspaceEmails) {
            try {
                const workspaceRows = await sql`
                SELECT DISTINCT ON (p.id)
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
                WHERE wp.user_email = ${workspaceEmail}
                  AND p.lat IS NOT NULL
                  AND p.lng IS NOT NULL
                  AND (p.address_hash = ANY(${hashes}) OR p.legacy_hash = ANY(${hashes}))
                ORDER BY p.id, wp.updated_at DESC
                LIMIT ${limit}
            `;
                for (const row of workspaceRows) {
                    rowsById.set(String(row.id), row);
                }
                const coveredHashes = new Set();
                for (const row of rowsById.values()) {
                    if (row.address_hash) coveredHashes.add(String(row.address_hash));
                    if (row.legacy_hash) coveredHashes.add(String(row.legacy_hash));
                }
                if (hashes.every(hash => coveredHashes.has(hash))) break;
            } catch (error) {
                // A missing or lagging workspace link table must not prevent a
                // caller-visible historical route from using its recovery copies.
                console.warn('Workspace route hydration unavailable:', error.message);
                break;
            }
        }
        const rows = [...rowsById.values()];

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
            const ownerEmails = [
                targetEmail,
                authorizedRoute.created_by,
                user.email
            ].map(normalized).filter(Boolean);
            missingWorkspaceHashes.forEach(hash => (
                allowedOwnersByHash.set(hash, new Set(ownerEmails))
            ));
        }
        const hashesMissingInteractionProof = missingWorkspaceHashes.filter(hash => (
            !interactionOwnersByHash.has(hash)
        ));
        if (hashesMissingInteractionProof.length > 0 && !authorizedRoute) {
            // Compatibility clients that supply an owner hint can still be
            // callback lookups when no exact visible route exists. Query only
            // proof gaps so a skewed capped first page cannot hide a callback.
            const additionalOwners = await loadVisibleInteractionOwners(
                base44,
                hashesMissingInteractionProof
            );
            for (const [hash, owners] of additionalOwners) {
                if (!interactionOwnersByHash.has(hash)) {
                    interactionOwnersByHash.set(hash, new Set());
                }
                owners.forEach(owner => interactionOwnersByHash.get(hash).add(owner));
            }
        }
        const missingWorkspaceHashSet = new Set(missingWorkspaceHashes);
        for (const [hash, owners] of interactionOwnersByHash) {
            if (!missingWorkspaceHashSet.has(hash)) continue;
            if (!allowedOwnersByHash.has(hash)) allowedOwnersByHash.set(hash, new Set());
            owners.forEach(owner => allowedOwnersByHash.get(hash).add(owner));
        }

        // Historical routes can outlive their workspace_properties link. Only
        // hashes on an exact caller-visible route created before the hardened
        // link contract may use the global canonical recovery copy. Interaction
        // hashes are client-selectable and therefore never grant canonical
        // access; they remain useful only for scoped workspace and creator-owned
        // Base44 recovery below.
        const routeMayRecoverCanonical = authorizedRoute && isLegacyCanonicalRecoveryRoute(authorizedRoute);
        const canonicalAuthorizedHashes = missingWorkspaceHashes.filter(hash =>
            routeMayRecoverCanonical && allowedOwnersByHash.has(hash)
        );
        if (canonicalAuthorizedHashes.length > 0) {
            let routeRows = [];
            try {
                routeRows = await sql`
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
            } catch (error) {
                // Base44 MasterProperty remains a tenant-checked recovery copy
                // when the canonical Neon schema is unavailable or mid-migration.
                console.warn('Canonical route hydration unavailable:', error.message);
            }

            for (const row of routeRows) {
                const recoveredRow = authorizedRoute && !hasFrozenLegacyManifest(authorizedRoute)
                    ? pinSafeCanonicalProperty(row)
                    : row;
                const property = {
                    ...recoveredRow,
                    id: String(recoveredRow.id),
                    address_hash: recoveredRow.address_hash || String(recoveredRow.id),
                    created_date: recoveredRow.created_at,
                    updated_date: recoveredRow.updated_at
                };
                if (property.address_hash) byHash.set(property.address_hash, property);
                if (property.legacy_hash) byHash.set(property.legacy_hash, property);
            }

            // Read-repair the missing tenant links after successful legacy
            // recovery. This is additive and preserves any existing status.
            if (
                hasFrozenLegacyManifest(authorizedRoute)
                && routeRows.length > 0
                && repairEmail
            ) {
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
                        ${repairEmail},
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
                    filterMasterProperties(
                        base44.asServiceRole.entities.MasterProperty,
                        'address_hash',
                        slice
                    ),
                    filterMasterProperties(
                        base44.asServiceRole.entities.MasterProperty,
                        'legacy_hash',
                        slice
                    )
                ]);
                for (const property of [...asArray(primaryResult), ...asArray(legacyResult)]) {
                    if (!hasCoordinates(property)) continue;
                    const requestedMatches = slice.filter(hash =>
                        hash === String(property.address_hash || '')
                        || hash === String(property.legacy_hash || '')
                    );
                    for (const requestedHash of requestedMatches) {
                        const allowedOwners = allowedOwnersByHash.get(requestedHash);
                        if (!allowedOwners?.has(normalized(property.created_by))) continue;
                        byHash.set(requestedHash, property);
                    }
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
        if (error instanceof HttpError) {
            return Response.json({
                error: error.code,
                message: error.message
            }, { status: error.status });
        }
        const referenceId = crypto.randomUUID();
        console.error(`[getRoutePropertiesByHashes] Unexpected ${referenceId}:`, error?.message || error);
        return Response.json({
            error: 'Route property lookup could not be completed safely.',
            code: 'route_property_lookup_failed',
            reference_id: referenceId
        }, { status: 500 });
    }
});
