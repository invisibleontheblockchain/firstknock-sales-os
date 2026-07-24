import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';

const APPLY_CONFIRMATION = 'SNAPSHOT_ONLY_NO_SOURCE_MUTATIONS';
const MAX_ROUTE_PAGE = 100;
const MAX_INTERACTION_PAGE = 2000;
const MAX_ROUTE_STOPS_PER_PAGE = 10_000;
const PROPERTY_QUERY_CHUNK = 1000;
const BASE44_QUERY_CHUNK = 100;
const STOP_WRITE_CHUNK = 1000;

const ROUTE_FIELDS = [
    'id',
    'name',
    'description',
    'route_mode',
    'status',
    'assigned_to',
    'assigned_to_name',
    'priority',
    'property_hashes',
    'metrics',
    'start_location',
    'end_location',
    'route_origin_mode',
    'manager_id',
    'metadata',
    'parent_route_id',
    'batch_number',
    'batch_total',
    'batch_date',
    'created_by',
    'created_date',
    'updated_date'
];

const PROPERTY_FIELDS = [
    'id',
    'address_hash',
    'legacy_hash',
    'full_address',
    'house_number',
    'street_name',
    'city',
    'state',
    'zip_code',
    'lat',
    'lng',
    'h3_index',
    'owner_full_name',
    'owner_occupied',
    'corporate_owned',
    'investor_owned',
    'beds',
    'baths',
    'sqft',
    'lot_size',
    'year_built',
    'price',
    'sold_date',
    'sale_type',
    'property_type',
    'mls_id',
    'url',
    'data_source',
    'sale_confidence',
    'original_status',
    'created_date',
    'updated_date'
];

const INTERACTION_FIELDS = [
    'id',
    'address_hash',
    'manager_id',
    'logged_by_user_id',
    'idempotency_key',
    'request_hash',
    'outcome_sequence',
    'counts_toward_free_limit',
    'source',
    'raw_input_text',
    'parsed_status',
    'sale_amount',
    'sale_date',
    'property_address',
    'homeowner_name',
    'rep_id',
    'rep_name',
    'route_name',
    'route_id',
    'gps_proof_lat',
    'gps_proof_lng',
    'gps_accuracy',
    'image_url',
    'next_eligible_date',
    'description',
    'counts_as_knock',
    'workflow_action',
    'workflow_bucket',
    'created_by',
    'created_date',
    'updated_date'
];

class HttpError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function asArray(value: any) {
    return Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : []);
}

function normalized(value: any) {
    return String(value || '').trim().toLowerCase();
}

function trimmed(value: any) {
    const result = String(value || '').trim();
    return result || null;
}

function boundedInteger(value: any, fallback: number, minimum: number, maximum: number) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, minimum), maximum);
}

function isoOrNull(value: any) {
    if (!value) return null;
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function jsonSafe(value: any) {
    return JSON.parse(JSON.stringify(value));
}

function pick(record: any, fields: string[]) {
    const result: Record<string, any> = {};
    for (const field of fields) {
        if (record?.[field] !== undefined) result[field] = record[field];
    }
    return jsonSafe(result);
}

function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
}

async function sha256(value: any) {
    const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function tenantIdentity(record: any) {
    const managerId = trimmed(record?.manager_id);
    const ownerEmail = normalized(record?.created_by) || null;
    const tenantKey = managerId
        ? `manager:${managerId}`
        : (ownerEmail ? `owner:${ownerEmail}` : null);
    return { tenantKey, managerId, ownerEmail };
}

function coordinate(value: any, minimum: number, maximum: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : null;
}

function propertySnapshot(property: any) {
    if (!property) return null;
    const snapshot = pick(property, PROPERTY_FIELDS);
    if (snapshot.id !== undefined && snapshot.id !== null) snapshot.id = String(snapshot.id);
    if (!snapshot.created_date && property.created_at) snapshot.created_date = property.created_at;
    if (!snapshot.updated_date && property.updated_at) snapshot.updated_date = property.updated_at;
    return snapshot;
}

async function loadPropertiesByHash(client: Client, service: any, hashes: string[]) {
    const byHash = new Map<string, { property: any; source: string }>();
    for (let index = 0; index < hashes.length; index += PROPERTY_QUERY_CHUNK) {
        const slice = hashes.slice(index, index + PROPERTY_QUERY_CHUNK);
        const result = await client.query(`
            SELECT
                id,
                address_hash,
                legacy_hash,
                full_address,
                house_number,
                street_name,
                city,
                state,
                zip_code,
                lat,
                lng,
                h3_index,
                owner_full_name,
                owner_occupied,
                corporate_owned,
                investor_owned,
                beds,
                baths,
                sqft,
                lot_size,
                year_built,
                price,
                sold_date,
                sale_type,
                property_type,
                mls_id,
                url,
                data_source,
                sale_confidence,
                original_status,
                created_at,
                updated_at
            FROM properties
            WHERE address_hash = ANY($1::text[]) OR legacy_hash = ANY($1::text[])
        `, [slice]);
        for (const property of result.rows || []) {
            if (property.address_hash) {
                byHash.set(String(property.address_hash), { property, source: 'neon_properties' });
            }
            if (property.legacy_hash) {
                byHash.set(String(property.legacy_hash), { property, source: 'neon_properties' });
            }
        }
    }

    const missing = hashes.filter((hash) => !byHash.has(hash));
    for (let index = 0; index < missing.length; index += BASE44_QUERY_CHUNK) {
        const slice = missing.slice(index, index + BASE44_QUERY_CHUNK);
        const [primaryResult, legacyResult] = await Promise.all([
            service.entities.MasterProperty.filter(
                { address_hash: slice },
                null,
                slice.length
            ).catch(() => []),
            service.entities.MasterProperty.filter(
                { legacy_hash: slice },
                null,
                slice.length
            ).catch(() => [])
        ]);
        for (const property of [...asArray(primaryResult), ...asArray(legacyResult)]) {
            if (property?.address_hash && slice.includes(String(property.address_hash))) {
                byHash.set(String(property.address_hash), {
                    property,
                    source: 'base44_master_property'
                });
            }
            if (property?.legacy_hash && slice.includes(String(property.legacy_hash))) {
                byHash.set(String(property.legacy_hash), {
                    property,
                    source: 'base44_master_property'
                });
            }
        }
    }
    return byHash;
}

async function assertSchema(client: Client) {
    const result = await client.query(`
        SELECT
            to_regclass('public.route_snapshot_versions') AS route_versions,
            to_regclass('public.route_snapshot_stops') AS route_stops,
            to_regclass('public.route_snapshot_heads') AS route_heads,
            to_regclass('public.interaction_snapshot_versions') AS interaction_versions,
            to_regclass('public.interaction_snapshot_heads') AS interaction_heads
    `);
    const row = result.rows?.[0] || {};
    if (Object.values(row).some((value) => !value)) {
        throw new HttpError(
            409,
            'route_resilience_schema_missing',
            'Run setupRouteResilienceTables before reconciliation.'
        );
    }
}

async function existingRouteHeads(client: Client, routeIds: string[]) {
    if (routeIds.length === 0) return new Map();
    const result = await client.query(`
        SELECT route_id, tenant_key, manifest_sha256, snapshot_sha256
        FROM route_snapshot_heads
        WHERE route_id = ANY($1::text[])
    `, [routeIds]);
    return new Map((result.rows || []).map((row) => [String(row.route_id), row]));
}

async function existingInteractionHeads(client: Client, interactionIds: string[]) {
    if (interactionIds.length === 0) return new Map();
    const result = await client.query(`
        SELECT interaction_id, tenant_key, snapshot_sha256
        FROM interaction_snapshot_heads
        WHERE interaction_id = ANY($1::text[])
    `, [interactionIds]);
    return new Map((result.rows || []).map((row) => [String(row.interaction_id), row]));
}

async function writeRouteSnapshot(client: Client, snapshot: any) {
    const inserted = await client.query(`
        INSERT INTO route_snapshot_versions (
            route_id,
            tenant_key,
            manager_id,
            owner_email,
            source_created_at,
            source_updated_at,
            manifest_sha256,
            snapshot_sha256,
            ordered_hashes,
            route_payload,
            resolved_stop_count,
            unresolved_stop_count,
            capture_source
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9::jsonb, $10::jsonb, $11, $12, 'reconciler'
        )
        ON CONFLICT(route_id, snapshot_sha256) DO NOTHING
        RETURNING id
    `, [
        snapshot.routeId,
        snapshot.tenantKey,
        snapshot.managerId,
        snapshot.ownerEmail,
        snapshot.sourceCreatedAt,
        snapshot.sourceUpdatedAt,
        snapshot.manifestSha256,
        snapshot.snapshotSha256,
        JSON.stringify(snapshot.hashes),
        JSON.stringify(snapshot.routePayload),
        snapshot.resolvedCount,
        snapshot.unresolvedCount
    ]);

    let snapshotId = inserted.rows?.[0]?.id;
    if (!snapshotId) {
        const existing = await client.query(`
            SELECT id
            FROM route_snapshot_versions
            WHERE route_id = $1 AND snapshot_sha256 = $2
        `, [snapshot.routeId, snapshot.snapshotSha256]);
        snapshotId = existing.rows?.[0]?.id;
    }
    if (!snapshotId) throw new Error(`Could not resolve route snapshot version for ${snapshot.routeId}.`);

    for (let index = 0; index < snapshot.stops.length; index += STOP_WRITE_CHUNK) {
        const slice = snapshot.stops.slice(index, index + STOP_WRITE_CHUNK);
        await client.query(`
            INSERT INTO route_snapshot_stops (
                snapshot_id,
                route_id,
                tenant_key,
                stop_ordinal,
                address_hash,
                latitude,
                longitude,
                full_address,
                renderable,
                resolution_issue,
                resolution_source,
                property_snapshot
            )
            SELECT
                $1,
                $2,
                $3,
                stop_ordinal,
                address_hash,
                latitude,
                longitude,
                full_address,
                renderable,
                resolution_issue,
                resolution_source,
                property_snapshot
            FROM jsonb_to_recordset($4::jsonb) AS stop(
                stop_ordinal INTEGER,
                address_hash TEXT,
                latitude DOUBLE PRECISION,
                longitude DOUBLE PRECISION,
                full_address TEXT,
                renderable BOOLEAN,
                resolution_issue TEXT,
                resolution_source TEXT,
                property_snapshot JSONB
            )
            ON CONFLICT(snapshot_id, stop_ordinal) DO UPDATE SET
                address_hash = EXCLUDED.address_hash,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                full_address = EXCLUDED.full_address,
                renderable = EXCLUDED.renderable,
                resolution_issue = EXCLUDED.resolution_issue,
                resolution_source = EXCLUDED.resolution_source,
                property_snapshot = EXCLUDED.property_snapshot
        `, [snapshotId, snapshot.routeId, snapshot.tenantKey, JSON.stringify(slice)]);
    }

    const stopCount = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM route_snapshot_stops
        WHERE snapshot_id = $1
    `, [snapshotId]);
    if (Number(stopCount.rows?.[0]?.count || 0) !== snapshot.stops.length) {
        throw new Error(`Route snapshot ${snapshot.routeId} did not persist its complete ordered stop manifest.`);
    }

    await client.query(`
        INSERT INTO route_snapshot_heads (
            route_id,
            tenant_key,
            snapshot_id,
            manifest_sha256,
            snapshot_sha256,
            source_updated_at,
            reconciled_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT(route_id) DO UPDATE SET
            tenant_key = EXCLUDED.tenant_key,
            snapshot_id = EXCLUDED.snapshot_id,
            manifest_sha256 = EXCLUDED.manifest_sha256,
            snapshot_sha256 = EXCLUDED.snapshot_sha256,
            source_updated_at = EXCLUDED.source_updated_at,
            reconciled_at = NOW()
    `, [
        snapshot.routeId,
        snapshot.tenantKey,
        snapshotId,
        snapshot.manifestSha256,
        snapshot.snapshotSha256,
        snapshot.sourceUpdatedAt
    ]);
}

async function writeInteractionSnapshot(client: Client, snapshot: any) {
    const inserted = await client.query(`
        INSERT INTO interaction_snapshot_versions (
            interaction_id,
            tenant_key,
            manager_id,
            owner_email,
            route_id,
            address_hash,
            source_created_at,
            source_updated_at,
            snapshot_sha256,
            interaction_payload,
            capture_source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'reconciler')
        ON CONFLICT(interaction_id, snapshot_sha256) DO NOTHING
        RETURNING id
    `, [
        snapshot.interactionId,
        snapshot.tenantKey,
        snapshot.managerId,
        snapshot.ownerEmail,
        snapshot.routeId,
        snapshot.addressHash,
        snapshot.sourceCreatedAt,
        snapshot.sourceUpdatedAt,
        snapshot.snapshotSha256,
        JSON.stringify(snapshot.payload)
    ]);

    let snapshotId = inserted.rows?.[0]?.id;
    if (!snapshotId) {
        const existing = await client.query(`
            SELECT id
            FROM interaction_snapshot_versions
            WHERE interaction_id = $1 AND snapshot_sha256 = $2
        `, [snapshot.interactionId, snapshot.snapshotSha256]);
        snapshotId = existing.rows?.[0]?.id;
    }
    if (!snapshotId) {
        throw new Error(`Could not resolve interaction snapshot version for ${snapshot.interactionId}.`);
    }

    await client.query(`
        INSERT INTO interaction_snapshot_heads (
            interaction_id,
            tenant_key,
            snapshot_id,
            snapshot_sha256,
            source_updated_at,
            reconciled_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT(interaction_id) DO UPDATE SET
            tenant_key = EXCLUDED.tenant_key,
            snapshot_id = EXCLUDED.snapshot_id,
            snapshot_sha256 = EXCLUDED.snapshot_sha256,
            source_updated_at = EXCLUDED.source_updated_at,
            reconciled_at = NOW()
    `, [
        snapshot.interactionId,
        snapshot.tenantKey,
        snapshotId,
        snapshot.snapshotSha256,
        snapshot.sourceUpdatedAt
    ]);
}

Deno.serve(async (req: Request) => {
    const startedAt = new Date().toISOString();
    let client: Client | null = null;
    try {
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method not allowed' }, { status: 405 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) throw new HttpError(401, 'unauthorized', 'Unauthorized');
        if (normalized(user.role || user?.data?.role) !== 'admin') {
            throw new HttpError(403, 'admin_required', 'Admin access is required.');
        }

        const body = await req.json().catch(() => ({}));
        const apply = body.apply === true;
        if (apply && body.confirmation !== APPLY_CONFIRMATION) {
            throw new HttpError(
                400,
                'confirmation_required',
                `Set confirmation to ${APPLY_CONFIRMATION}. No snapshots were written.`
            );
        }

        const routeSkip = boundedInteger(body.route_skip, 0, 0, 10_000_000);
        const routeLimit = boundedInteger(body.route_limit, 25, 1, MAX_ROUTE_PAGE);
        const interactionSkip = boundedInteger(body.interaction_skip, 0, 0, 100_000_000);
        const interactionLimit = boundedInteger(
            body.interaction_limit,
            500,
            1,
            MAX_INTERACTION_PAGE
        );

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            throw new HttpError(500, 'database_not_configured', 'DATABASE_URL is not configured.');
        }

        client = new Client(databaseUrl);
        await client.connect();
        await assertSchema(client);

        const service = base44.asServiceRole;
        const [routeResult, interactionResult] = await Promise.all([
            service.entities.SavedRoute.filter({}, '-updated_date', routeLimit, routeSkip),
            service.entities.InteractionLog.filter(
                {},
                '-updated_date',
                interactionLimit,
                interactionSkip
            )
        ]);
        const routes = asArray(routeResult);
        const interactions = asArray(interactionResult);

        const pageHashes = routes.flatMap((route) =>
            (Array.isArray(route?.property_hashes) ? route.property_hashes : [])
                .map((hash: any) => String(hash || '').trim())
                .filter(Boolean)
        );
        if (pageHashes.length > MAX_ROUTE_STOPS_PER_PAGE) {
            throw new HttpError(
                413,
                'route_page_too_large',
                `This page contains more than ${MAX_ROUTE_STOPS_PER_PAGE} stops. Retry with a smaller route_limit.`
            );
        }
        const uniqueHashes = [...new Set(pageHashes)];
        const propertiesByHash = await loadPropertiesByHash(client, service, uniqueHashes);

        const routeSnapshots = [];
        const interactionSnapshots = [];
        const missingTenantRecords: any[] = [];
        const unresolvedStops: any[] = [];

        for (const route of routes) {
            const routeId = trimmed(route?.id);
            const identity = tenantIdentity(route);
            if (!routeId || !identity.tenantKey) {
                missingTenantRecords.push({ entity: 'SavedRoute', id: routeId });
                continue;
            }

            const hashes = (Array.isArray(route.property_hashes) ? route.property_hashes : [])
                .map((hash: any) => String(hash || '').trim())
                .filter(Boolean);
            const routePayload = pick(route, ROUTE_FIELDS);
            const stops = hashes.map((hash: string, stopOrdinal: number) => {
                const resolved = propertiesByHash.get(hash);
                const snapshot = propertySnapshot(resolved?.property);
                const latitude = coordinate(snapshot?.lat, -90, 90);
                const longitude = coordinate(snapshot?.lng, -180, 180);
                const renderable = latitude !== null && longitude !== null;
                const resolutionIssue = !snapshot
                    ? 'missing_property'
                    : (!renderable ? 'missing_coordinates' : null);
                if (resolutionIssue) {
                    unresolvedStops.push({
                        route_id: routeId,
                        stop_ordinal: stopOrdinal,
                        address_hash: hash,
                        reason: resolutionIssue
                    });
                }
                return {
                    stop_ordinal: stopOrdinal,
                    address_hash: hash,
                    latitude,
                    longitude,
                    full_address: trimmed(snapshot?.full_address),
                    renderable,
                    resolution_issue: resolutionIssue,
                    resolution_source: resolved?.source || 'missing',
                    property_snapshot: snapshot
                };
            });
            const manifestSha256 = await sha256(hashes);
            const snapshotSha256 = await sha256({ route: routePayload, stops });
            const unresolvedCount = stops.filter((stop) => !stop.renderable).length;
            routeSnapshots.push({
                routeId,
                ...identity,
                sourceCreatedAt: isoOrNull(route.created_date),
                sourceUpdatedAt: isoOrNull(route.updated_date),
                hashes,
                routePayload,
                stops,
                manifestSha256,
                snapshotSha256,
                resolvedCount: stops.length - unresolvedCount,
                unresolvedCount
            });
        }

        for (const interaction of interactions) {
            const interactionId = trimmed(interaction?.id);
            const addressHash = trimmed(interaction?.address_hash);
            const identity = tenantIdentity(interaction);
            if (!interactionId || !addressHash || !identity.tenantKey) {
                missingTenantRecords.push({ entity: 'InteractionLog', id: interactionId });
                continue;
            }
            const payload = pick(interaction, INTERACTION_FIELDS);
            interactionSnapshots.push({
                interactionId,
                ...identity,
                routeId: trimmed(interaction.route_id),
                addressHash,
                sourceCreatedAt: isoOrNull(interaction.created_date),
                sourceUpdatedAt: isoOrNull(interaction.updated_date),
                payload,
                snapshotSha256: await sha256(payload)
            });
        }

        const [routeHeads, interactionHeads] = await Promise.all([
            existingRouteHeads(client, routeSnapshots.map((snapshot) => snapshot.routeId)),
            existingInteractionHeads(
                client,
                interactionSnapshots.map((snapshot) => snapshot.interactionId)
            )
        ]);

        const routeChanges = routeSnapshots.filter((snapshot) =>
            routeHeads.get(snapshot.routeId)?.snapshot_sha256 !== snapshot.snapshotSha256
            || routeHeads.get(snapshot.routeId)?.tenant_key !== snapshot.tenantKey
        );
        const interactionChanges = interactionSnapshots.filter((snapshot) =>
            interactionHeads.get(snapshot.interactionId)?.snapshot_sha256 !== snapshot.snapshotSha256
            || interactionHeads.get(snapshot.interactionId)?.tenant_key !== snapshot.tenantKey
        );

        const runId = crypto.randomUUID();
        const summary = {
            run_id: runId,
            dry_run: !apply,
            source_records_changed: 0,
            route_page: {
                skip: routeSkip,
                limit: routeLimit,
                records_read: routes.length,
                records_snapshot_ready: routeSnapshots.length,
                versions_to_create_or_repair: routeChanges.length,
                unchanged: routeSnapshots.length - routeChanges.length,
                stop_count: routeSnapshots.reduce((total, route) => total + route.stops.length, 0),
                unresolved_stop_count: unresolvedStops.length,
                has_more: routes.length === routeLimit,
                next_skip: routeSkip + routes.length
            },
            interaction_page: {
                skip: interactionSkip,
                limit: interactionLimit,
                records_read: interactions.length,
                records_snapshot_ready: interactionSnapshots.length,
                versions_to_create_or_repair: interactionChanges.length,
                unchanged: interactionSnapshots.length - interactionChanges.length,
                has_more: interactions.length === interactionLimit,
                next_skip: interactionSkip + interactions.length
            },
            missing_tenant_count: missingTenantRecords.length,
            missing_tenant_records: missingTenantRecords.slice(0, 50),
            unresolved_stop_samples: unresolvedStops.slice(0, 50)
        };

        if (apply) {
            await client.query('BEGIN');
            try {
                for (const snapshot of routeSnapshots) {
                    await writeRouteSnapshot(client, snapshot);
                }
                for (const snapshot of interactionSnapshots) {
                    await writeInteractionSnapshot(client, snapshot);
                }
                await client.query(`
                    INSERT INTO route_resilience_reconciliation_runs (
                        run_id,
                        dry_run,
                        route_skip,
                        route_count,
                        route_stop_count,
                        unresolved_stop_count,
                        interaction_skip,
                        interaction_count,
                        missing_tenant_count,
                        summary,
                        started_at,
                        completed_at
                    )
                    VALUES (
                        $1, FALSE, $2, $3, $4, $5, $6, $7, $8,
                        $9::jsonb, $10, NOW()
                    )
                `, [
                    runId,
                    routeSkip,
                    routeSnapshots.length,
                    summary.route_page.stop_count,
                    unresolvedStops.length,
                    interactionSkip,
                    interactionSnapshots.length,
                    missingTenantRecords.length,
                    JSON.stringify(summary),
                    startedAt
                ]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            }
        }

        return Response.json({
            success: true,
            applied: apply,
            snapshots_written: apply
                ? {
                    routes: routeSnapshots.length,
                    route_stops: summary.route_page.stop_count,
                    interactions: interactionSnapshots.length
                }
                : { routes: 0, route_stops: 0, interactions: 0 },
            summary
        });
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        return Response.json({
            error: error instanceof HttpError ? error.code : 'route_resilience_failed',
            message: error.message
        }, { status });
    } finally {
        if (client) await client.end().catch(() => {});
    }
});
