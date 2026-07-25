import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

// Replays the continuity mirror back into the Base44 entity store.
//
// Dry run is the default and must be run first: it returns exactly what would
// be created, updated, and skipped without writing anything. A live restore
// additionally requires CONTINUITY_RESTORE_SECRET, so possessing an admin
// session is not by itself enough to bulk-write production records.
//
// Restore is additive. It recreates records that are gone and leaves records
// that still exist untouched unless overwrite_existing is explicitly set. It
// never deletes anything.
//
// Recreated records receive new ids from Base44, so entities are restored in
// dependency order and their foreign keys are rewritten through a persisted id
// map. Outcome-to-house links travel on address_hash, which is content-derived
// and survives a restore unchanged.

const RESTORE_SECRET_ENV = 'CONTINUITY_RESTORE_SECRET';
const DEFAULT_BATCH = 200;
const MAX_BATCH = 1000;
const TIME_BUDGET_MS = 100_000;

// Parents before children: a child's foreign key can only be rewritten once its
// parent has a restored id.
const RESTORE_ORDER = [
    'TeamMember',
    'CanvasSession',
    'TerritoryPlan',
    'RouteTemplate',
    'SavedRoute',
    'MasterProperty',
    'CanvasHousePin',
    'InteractionLog',
    'CanvasHouseEvent',
    'DailyResult',
    'Appointment'
];

// Fields holding a reference to another restored record, by owning entity.
const FOREIGN_KEYS: Record<string, { field: string; entity: string }[]> = {
    SavedRoute: [
        { field: 'assigned_to', entity: 'TeamMember' },
        { field: 'parent_route_id', entity: 'SavedRoute' }
    ],
    InteractionLog: [
        { field: 'route_id', entity: 'SavedRoute' },
        { field: 'rep_id', entity: 'TeamMember' }
    ],
    DailyResult: [{ field: 'route_id', entity: 'SavedRoute' }],
    Appointment: [{ field: 'route_id', entity: 'SavedRoute' }],
    CanvasHousePin: [{ field: 'campaign_id', entity: 'CanvasSession' }],
    CanvasHouseEvent: [
        { field: 'campaign_id', entity: 'CanvasSession' },
        { field: 'pin_id', entity: 'CanvasHousePin' }
    ]
};

// Server-owned on write. Replaying them would either be rejected or would
// falsify the audit trail.
const STRIPPED_FIELDS = new Set([
    'id',
    'created_date',
    'updated_date',
    'is_sample'
]);

function timingSafeEqual(expected: string, received: string) {
    if (!expected || !received || expected.length !== received.length) return false;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) {
        mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return mismatch === 0;
}

function hasRestoreSecret(req: Request) {
    const expected = Deno.env.get(RESTORE_SECRET_ENV);
    if (!expected) return false;
    return timingSafeEqual(expected, req.headers.get('x-continuity-restore-secret') || '');
}

function sanitizePayload(entity: string, payload: any, remap: Map<string, string>, managerRemap: Record<string, string>) {
    const record: any = {};
    for (const [key, value] of Object.entries(payload || {})) {
        if (STRIPPED_FIELDS.has(key)) continue;
        record[key] = value;
    }

    for (const reference of FOREIGN_KEYS[entity] || []) {
        const current = record[reference.field];
        if (!current) continue;
        const mapped = remap.get(`${reference.entity}:${String(current)}`);
        if (mapped) record[reference.field] = mapped;
    }

    // A tenant whose owning User was itself recreated needs its manager_id
    // retargeted, otherwise every restored row lands under an id nobody holds.
    if (record.manager_id && managerRemap[String(record.manager_id)]) {
        record.manager_id = managerRemap[String(record.manager_id)];
    }

    return record;
}

async function loadRemap(sql: any, restoreId: number) {
    const rows = await sql(
        `SELECT entity, original_id, restored_id FROM continuity.restore_id_map WHERE restore_id = $1`,
        [restoreId]
    ).catch(() => []);
    const remap = new Map<string, string>();
    for (const row of rows || []) {
        remap.set(`${row.entity}:${row.original_id}`, String(row.restored_id));
    }
    return remap;
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
        }

        const body = await req.json().catch(() => ({}));
        // Anything other than an explicit false stays a dry run. A restore must
        // never be something you trigger by forgetting a flag.
        const dryRun = body?.dry_run !== false;
        const overwriteExisting = body?.overwrite_existing === true;
        const includeTombstoned = body?.include_tombstoned !== false;
        const managerFilter = String(body?.manager_id || '').trim() || null;
        const entityFilter = String(body?.entity || '').trim() || null;
        const asOf = body?.as_of ? new Date(body.as_of) : null;
        const batchSize = Math.min(MAX_BATCH, Math.max(1, Number(body?.limit) || DEFAULT_BATCH));
        const managerRemap = (body?.manager_id_remap && typeof body.manager_id_remap === 'object')
            ? body.manager_id_remap
            : {};
        const continueRestoreId = Number(body?.restore_id) || null;

        if (!dryRun && !hasRestoreSecret(req)) {
            return Response.json({
                error: 'Forbidden: restore secret required for a live restore',
                code: 'continuity_restore_secret_required',
                hint: 'Run with dry_run true to preview the plan without a secret.'
            }, { status: 403 });
        }

        if (asOf && !Number.isFinite(asOf.getTime())) {
            return Response.json({ error: 'as_of is not a valid timestamp' }, { status: 400 });
        }
        if (entityFilter && !RESTORE_ORDER.includes(entityFilter)) {
            return Response.json({
                error: 'Unsupported entity',
                supported: RESTORE_ORDER
            }, { status: 400 });
        }

        const sql = neon(databaseUrl);
        const entities = entityFilter ? [entityFilter] : RESTORE_ORDER;

        let restoreId = continueRestoreId;
        if (!dryRun && !restoreId) {
            const rows = await sql(
                `INSERT INTO continuity.restore_runs
                     (requested_by, dry_run, entity, manager_id, as_of)
                 VALUES ($1, FALSE, $2, $3, $4) RETURNING restore_id`,
                [String(user.email || 'unknown').slice(0, 320), entityFilter, managerFilter, asOf?.toISOString() || null]
            );
            restoreId = Number(rows?.[0]?.restore_id) || null;
        }

        const remap = restoreId ? await loadRemap(sql, restoreId) : new Map<string, string>();
        const deadline = Date.now() + TIME_BUDGET_MS;

        const results: any[] = [];
        let planned = 0;
        let created = 0;
        let updatedCount = 0;
        let skipped = 0;
        let failed = 0;

        for (const entity of entities) {
            if (Date.now() > deadline) {
                results.push({ entity, skipped: 'time_budget_exhausted' });
                continue;
            }

            const handle = base44.asServiceRole.entities[entity];
            if (!handle) {
                results.push({ entity, skipped: 'entity_unavailable' });
                continue;
            }

            const conditions = ['entity = $1'];
            const params: any[] = [entity];
            if (managerFilter) {
                params.push(managerFilter);
                conditions.push(`manager_id = $${params.length}`);
            }
            if (asOf) {
                params.push(asOf.toISOString());
                conditions.push(`first_seen_at <= $${params.length}`);
            }
            if (!includeTombstoned) {
                conditions.push('deleted_detected_at IS NULL');
            }

            const candidates = await sql(
                `SELECT record_id, manager_id, payload, deleted_detected_at
                 FROM continuity.record_current
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY record_id
                 LIMIT ${batchSize}`,
                params
            );

            const entityResult = {
                entity,
                candidates: candidates?.length || 0,
                would_create: 0,
                would_update: 0,
                already_present: 0,
                created: 0,
                updated: 0,
                failed: 0,
                samples: [] as any[]
            };

            for (const row of candidates || []) {
                if (Date.now() > deadline) break;

                const originalId = String(row.record_id);
                // A restore that has already recreated this record must not do
                // so twice when the operator reruns to work through a backlog.
                if (remap.has(`${entity}:${originalId}`)) {
                    entityResult.already_present += 1;
                    skipped += 1;
                    continue;
                }

                const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
                const live = await handle.get(originalId).catch(() => null);

                if (live && !overwriteExisting) {
                    entityResult.already_present += 1;
                    skipped += 1;
                    continue;
                }

                planned += 1;
                if (entityResult.samples.length < 5) {
                    entityResult.samples.push({
                        record_id: originalId,
                        action: live ? 'update' : 'create',
                        tombstoned: !!row.deleted_detected_at
                    });
                }

                if (live) {
                    entityResult.would_update += 1;
                } else {
                    entityResult.would_create += 1;
                }

                if (dryRun) continue;

                try {
                    const record = sanitizePayload(entity, payload, remap, managerRemap);
                    if (live) {
                        await handle.update(originalId, record);
                        entityResult.updated += 1;
                        updatedCount += 1;
                        remap.set(`${entity}:${originalId}`, originalId);
                        await sql(
                            `INSERT INTO continuity.restore_id_map (restore_id, entity, original_id, restored_id)
                             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                            [restoreId, entity, originalId, originalId]
                        );
                    } else {
                        const recreated = await handle.create(record);
                        const newId = String(recreated?.id || '');
                        if (!newId) throw new Error('create returned no id');
                        entityResult.created += 1;
                        created += 1;
                        remap.set(`${entity}:${originalId}`, newId);
                        await sql(
                            `INSERT INTO continuity.restore_id_map (restore_id, entity, original_id, restored_id)
                             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
                            [restoreId, entity, originalId, newId]
                        );
                        await sql(
                            `UPDATE continuity.record_current SET restored_at = NOW()
                             WHERE entity = $1 AND record_id = $2`,
                            [entity, originalId]
                        ).catch(() => null);
                    }
                } catch (error: any) {
                    entityResult.failed += 1;
                    failed += 1;
                    console.error('[restoreFieldData] record failed', entity, originalId, error?.message);
                }
            }

            results.push(entityResult);
        }

        if (!dryRun && restoreId) {
            await sql(
                `UPDATE continuity.restore_runs SET
                     finished_at = NOW(), planned_count = $2, created_count = $3, updated_count = $4,
                     skipped_count = $5, failed_count = $6, ok = $7, detail = $8::jsonb
                 WHERE restore_id = $1`,
                [restoreId, planned, created, updatedCount, skipped, failed, failed === 0, JSON.stringify(results)]
            ).catch(() => null);
        }

        return Response.json({
            success: true,
            dry_run: dryRun,
            restore_id: restoreId,
            batch_size: batchSize,
            planned,
            created,
            updated: updatedCount,
            skipped,
            failed,
            results,
            next_step: dryRun
                ? 'Review the plan. Repeat with dry_run false and the restore secret to apply it.'
                : 'Rerun with the same restore_id to continue through the remaining records.'
        });
    } catch (error: any) {
        console.error('[restoreFieldData] failed', error?.message);
        return Response.json({ error: 'restore_failed' }, { status: 500 });
    }
});
