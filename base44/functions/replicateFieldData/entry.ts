import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

// Scheduled replication of every irreplaceable field record into the
// append-only continuity ledger. Read-only against the live Base44 store: this
// worker never creates, updates, or deletes an entity record.
//
// Two modes:
//   sweep     — watermark pass by updated_date. Cheap, runs every minute, and
//               backstops the realtime journal for any write path that does not
//               call it (offline replay, admin scripts, other functions).
//   reconcile — full key comparison to detect records that vanished from the
//               live store. Tombstones them in the mirror instead of deleting,
//               and refuses to do so when an implausible share is missing.
//
// The sweep intentionally re-reads a short overlap window before its cursor.
// Duplicate work is free (the ledger dedupes on content hash); a missed row
// caused by clock skew or same-timestamp writes is not.

const WORKER_SECRET_ENV = 'CONTINUITY_WORKER_SECRET';
const PAGE_SIZE = 500;
const DB_CHUNK_SIZE = 100;
const MAX_PAGES_PER_ENTITY = 12;
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
const TIME_BUDGET_MS = 85_000;
const RECONCILE_SCAN_CAP = 50_000;
const DEFAULT_DELETION_ALARM_RATIO = 0.02;
const DELETION_ALARM_MIN_RECORDS = 25;
const ALARM_SAMPLE_SIZE = 20;

// Ordered by how irreplaceable the data is. A knock outcome cannot be
// re-derived from anything; a MasterProperty row can be re-purchased.
const REPLICATED_ENTITIES = [
    { name: 'InteractionLog', label: 'outcomes', tier: 1 },
    { name: 'CanvasHouseEvent', label: 'canvas outcomes', tier: 1 },
    { name: 'SavedRoute', label: 'routes', tier: 1 },
    { name: 'DailyResult', label: 'daily outcomes', tier: 1 },
    { name: 'CanvasHousePin', label: 'canvas houses', tier: 2 },
    { name: 'CanvasSession', label: 'canvas areas', tier: 2 },
    { name: 'TerritoryPlan', label: 'areas', tier: 2 },
    { name: 'Appointment', label: 'appointments', tier: 2 },
    { name: 'RouteTemplate', label: 'route templates', tier: 3 },
    { name: 'TeamMember', label: 'team', tier: 3 },
    { name: 'MasterProperty', label: 'houses', tier: 3 }
];

const ENTITY_NAMES = new Set(REPLICATED_ENTITIES.map((entity) => entity.name));

// updated_date churns on every touch; hashing it would append a version for
// writes that changed nothing. It is still stored on the version row.
const HASH_EXCLUDED_FIELDS = new Set(['updated_date']);

function timingSafeEqual(expected: string, received: string) {
    if (!expected || !received || expected.length !== received.length) return false;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) {
        mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return mismatch === 0;
}

function isAuthorizedWorker(req: Request) {
    const expected = Deno.env.get(WORKER_SECRET_ENV);
    if (!expected) return false;
    return timingSafeEqual(expected, req.headers.get('x-continuity-worker-secret') || '');
}

function asArray(result: any) {
    return Array.isArray(result) ? result : (result?.items || []);
}

function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .filter((key) => !HASH_EXCLUDED_FIELDS.has(key))
            .sort()
            .map((key) => [key, canonicalize(value[key])])
    );
}

async function sha256(value: any) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isoOrNull(value: any) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function tenantKey(record: any) {
    const managerId = record?.manager_id ?? record?.manager_user_id ?? null;
    const value = String(managerId || '').trim();
    return value || null;
}

function chunk<T>(items: T[], size: number): T[][] {
    const output: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        output.push(items.slice(index, index + size));
    }
    return output;
}

async function readCursor(sql: any, entity: string) {
    const rows = await sql(
        `SELECT cursor_updated_at, rows_mirrored, consecutive_failures
         FROM continuity.replication_cursor WHERE entity = $1`,
        [entity]
    );
    return rows?.[0] || null;
}

async function writeCursor(sql: any, entity: string, cursorIso: string | null, mirrored: number) {
    await sql(
        `INSERT INTO continuity.replication_cursor
             (entity, cursor_updated_at, last_sweep_at, rows_mirrored, consecutive_failures, last_error, updated_at)
         VALUES ($1, $2, NOW(), $3, 0, NULL, NOW())
         ON CONFLICT (entity) DO UPDATE SET
             cursor_updated_at = GREATEST(
                 continuity.replication_cursor.cursor_updated_at,
                 COALESCE(EXCLUDED.cursor_updated_at, continuity.replication_cursor.cursor_updated_at)
             ),
             last_sweep_at = NOW(),
             rows_mirrored = continuity.replication_cursor.rows_mirrored + EXCLUDED.rows_mirrored,
             consecutive_failures = 0,
             last_error = NULL,
             updated_at = NOW()`,
        [entity, cursorIso, mirrored]
    );
}

async function recordCursorFailure(sql: any, entity: string, message: string) {
    await sql(
        `INSERT INTO continuity.replication_cursor (entity, consecutive_failures, last_error, updated_at)
         VALUES ($1, 1, $2, NOW())
         ON CONFLICT (entity) DO UPDATE SET
             consecutive_failures = continuity.replication_cursor.consecutive_failures + 1,
             last_error = EXCLUDED.last_error,
             updated_at = NOW()`,
        [entity, String(message || 'unknown error').slice(0, 500)]
    ).catch(() => null);
}

// Appends any record whose content hash differs from what the mirror already
// holds, then refreshes the latest-state projection for everything scanned.
async function persistRecords(sql: any, entity: string, records: any[], source: string) {
    if (!records.length) return 0;

    // Keyed by record id: ON CONFLICT DO UPDATE cannot touch the same row twice
    // in one statement, so a repeated id inside a batch would abort the write.
    const byRecordId = new Map<string, any>();
    for (const record of records) {
        const recordId = String(record?.id || '').trim();
        if (!recordId) continue;
        byRecordId.set(recordId, {
            recordId,
            managerId: tenantKey(record),
            createdBy: record?.created_by ? String(record.created_by).slice(0, 320) : null,
            payload: JSON.stringify(record),
            payloadHash: await sha256(record),
            sourceUpdatedAt: isoOrNull(record?.updated_date || record?.created_date)
        });
    }
    const prepared = [...byRecordId.values()];
    if (!prepared.length) return 0;

    let appended = 0;

    for (const batch of chunk(prepared, DB_CHUNK_SIZE)) {
        const params: any[] = [];
        const tuples = batch.map((row, index) => {
            const base = index * 7;
            params.push(
                entity,
                row.recordId,
                row.managerId,
                row.createdBy,
                row.payload,
                row.payloadHash,
                row.sourceUpdatedAt
            );
            return `($${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::text,`
                + ` $${base + 5}::jsonb, $${base + 6}::text, $${base + 7}::timestamptz)`;
        }).join(', ');

        const inserted = await sql(
            `INSERT INTO continuity.record_versions
                 (entity, record_id, manager_id, created_by, payload, payload_hash, source_updated_at, source)
             SELECT v.entity, v.record_id, v.manager_id, v.created_by, v.payload, v.payload_hash,
                    v.source_updated_at, ${'$' + (params.length + 1)}::text
             FROM (VALUES ${tuples}) AS v(entity, record_id, manager_id, created_by, payload,
                                          payload_hash, source_updated_at)
             ON CONFLICT DO NOTHING
             RETURNING version_id`,
            [...params, source]
        );
        appended += inserted?.length || 0;

        // Refresh latest-state for every scanned row so last_seen_at stays
        // fresh even when content did not change. An older-ordered arrival must
        // never overwrite a newer one.
        await sql(
            `INSERT INTO continuity.record_current
                 (entity, record_id, manager_id, created_by, payload, payload_hash, source_updated_at, version_id)
             SELECT v.entity, v.record_id, v.manager_id, v.created_by, v.payload, v.payload_hash, v.source_updated_at,
                    COALESCE((
                        SELECT MAX(rv.version_id) FROM continuity.record_versions rv
                        WHERE rv.entity = v.entity AND rv.record_id = v.record_id
                    ), 0)
             FROM (VALUES ${tuples}) AS v(entity, record_id, manager_id, created_by, payload,
                                          payload_hash, source_updated_at)
             ON CONFLICT (entity, record_id) DO UPDATE SET
                 manager_id = EXCLUDED.manager_id,
                 created_by = EXCLUDED.created_by,
                 payload = EXCLUDED.payload,
                 payload_hash = EXCLUDED.payload_hash,
                 source_updated_at = EXCLUDED.source_updated_at,
                 version_id = GREATEST(EXCLUDED.version_id, continuity.record_current.version_id),
                 last_seen_at = NOW(),
                 deleted_detected_at = NULL
             WHERE continuity.record_current.source_updated_at IS NULL
                OR EXCLUDED.source_updated_at IS NULL
                OR EXCLUDED.source_updated_at >= continuity.record_current.source_updated_at`,
            params
        );
    }

    return appended;
}

async function sweepEntity(base44: any, sql: any, definition: any, deadline: number) {
    const entity = definition.name;
    const handle = base44.asServiceRole.entities[entity];
    if (!handle) {
        return { entity, skipped: 'entity_unavailable', scanned: 0, appended: 0 };
    }

    const cursor = await readCursor(sql, entity);
    const cursorMs = cursor?.cursor_updated_at ? new Date(cursor.cursor_updated_at).getTime() : NaN;
    const fromIso = Number.isFinite(cursorMs)
        ? new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
        : null;

    let scanned = 0;
    let appended = 0;
    let highWaterIso = cursor?.cursor_updated_at ? new Date(cursor.cursor_updated_at).toISOString() : null;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES_PER_ENTITY; page += 1) {
        if (Date.now() > deadline) {
            truncated = true;
            break;
        }

        const query = fromIso ? { updated_date: { $gte: fromIso } } : {};
        const records = asArray(
            await handle.filter(query, 'updated_date', PAGE_SIZE, page * PAGE_SIZE)
        );
        if (!records.length) break;

        scanned += records.length;
        appended += await persistRecords(sql, entity, records, 'sweep');

        for (const record of records) {
            const candidate = isoOrNull(record?.updated_date || record?.created_date);
            if (candidate && (!highWaterIso || candidate > highWaterIso)) highWaterIso = candidate;
        }

        if (records.length < PAGE_SIZE) break;
        if (page === MAX_PAGES_PER_ENTITY - 1) truncated = true;
    }

    // Safe to advance even on a truncated pass: the walk is ascending by
    // updated_date from page zero, so everything at or below the high-water
    // mark has been mirrored. Holding the cursor back instead would re-read the
    // same oldest pages forever and never finish the initial backfill of a
    // large entity. Rows sharing the boundary timestamp are recovered by the
    // overlap window on the next run.
    await writeCursor(sql, entity, highWaterIso, appended);

    return { entity, label: definition.label, scanned, appended, truncated };
}

async function reconcileEntity(base44: any, sql: any, definition: any, deadline: number, options: any) {
    const entity = definition.name;
    const handle = base44.asServiceRole.entities[entity];
    if (!handle) return { entity, skipped: 'entity_unavailable' };

    const liveIds = new Set<string>();
    let capped = false;

    for (let skip = 0; skip < RECONCILE_SCAN_CAP; skip += PAGE_SIZE) {
        if (Date.now() > deadline) {
            capped = true;
            break;
        }
        const records = asArray(await handle.filter({}, 'created_date', PAGE_SIZE, skip));
        for (const record of records) {
            const id = String(record?.id || '').trim();
            if (id) liveIds.add(id);
        }
        if (records.length < PAGE_SIZE) break;
        if (skip + PAGE_SIZE >= RECONCILE_SCAN_CAP) capped = true;
    }

    // A partial listing cannot prove absence. Refusing to tombstone here is the
    // difference between a mirror that records a deletion and one that invents
    // one.
    if (capped) {
        return { entity, skipped: 'scan_incomplete', live_ids_seen: liveIds.size, tombstoned: 0 };
    }

    const mirrored = await sql(
        `SELECT record_id, manager_id FROM continuity.record_current
         WHERE entity = $1 AND deleted_detected_at IS NULL`,
        [entity]
    );

    const missing = (mirrored || []).filter((row: any) => !liveIds.has(String(row.record_id)));
    const mirroredCount = mirrored?.length || 0;
    const missingCount = missing.length;

    if (!missingCount) {
        await sql(
            `UPDATE continuity.replication_cursor SET last_full_reconcile_at = NOW(), updated_at = NOW()
             WHERE entity = $1`,
            [entity]
        );
        return { entity, mirrored: mirroredCount, missing: 0, tombstoned: 0 };
    }

    const thresholdRatio = Number.isFinite(Number(options?.deletion_alarm_ratio))
        ? Math.min(1, Math.max(0, Number(options.deletion_alarm_ratio)))
        : DEFAULT_DELETION_ALARM_RATIO;
    const missingRatio = mirroredCount ? missingCount / mirroredCount : 0;

    // Small absolute counts are ordinary housekeeping. A large share going
    // missing at once is the shape of the failure we are defending against.
    const suspicious = missingCount >= DELETION_ALARM_MIN_RECORDS && missingRatio > thresholdRatio;

    if (suspicious && !options?.acknowledge_mass_deletion) {
        await sql(
            `INSERT INTO continuity.deletion_alarms
                 (entity, manager_id, mirrored_count, missing_count, missing_ratio,
                  threshold_ratio, action, sample_ids)
             VALUES ($1, NULL, $2, $3, $4, $5, 'blocked', $6::jsonb)`,
            [
                entity,
                mirroredCount,
                missingCount,
                missingRatio,
                thresholdRatio,
                JSON.stringify(missing.slice(0, ALARM_SAMPLE_SIZE).map((row: any) => row.record_id))
            ]
        );
        return {
            entity,
            mirrored: mirroredCount,
            missing: missingCount,
            missing_ratio: Number(missingRatio.toFixed(4)),
            tombstoned: 0,
            alarm: 'blocked',
            note: 'Mass deletion suspected. Mirror retains every record. Acknowledge to tombstone.'
        };
    }

    let tombstoned = 0;
    for (const batch of chunk(missing.map((row: any) => String(row.record_id)), DB_CHUNK_SIZE)) {
        const updated = await sql(
            `UPDATE continuity.record_current SET deleted_detected_at = NOW()
             WHERE entity = $1 AND record_id = ANY($2::text[]) AND deleted_detected_at IS NULL
             RETURNING record_id`,
            [entity, batch]
        );
        tombstoned += updated?.length || 0;
    }

    if (suspicious) {
        await sql(
            `INSERT INTO continuity.deletion_alarms
                 (entity, manager_id, mirrored_count, missing_count, missing_ratio,
                  threshold_ratio, action, sample_ids, acknowledged_at, acknowledged_by)
             VALUES ($1, NULL, $2, $3, $4, $5, 'tombstoned', $6::jsonb, NOW(), $7)`,
            [
                entity,
                mirroredCount,
                missingCount,
                missingRatio,
                thresholdRatio,
                JSON.stringify(missing.slice(0, ALARM_SAMPLE_SIZE).map((row: any) => row.record_id)),
                String(options?.acknowledged_by || 'worker').slice(0, 320)
            ]
        );
    }

    await sql(
        `UPDATE continuity.replication_cursor SET last_full_reconcile_at = NOW(), updated_at = NOW()
         WHERE entity = $1`,
        [entity]
    );

    return {
        entity,
        mirrored: mirroredCount,
        missing: missingCount,
        missing_ratio: Number(missingRatio.toFixed(4)),
        tombstoned,
        alarm: suspicious ? 'acknowledged' : null
    };
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (req.method !== 'POST') {
        return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
    }
    if (!isAuthorizedWorker(req)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const databaseUrl = Deno.env.get('DATABASE_URL');
    if (!databaseUrl) {
        return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === 'reconcile' ? 'reconcile' : 'sweep';
    const requested = Array.isArray(body?.entities)
        ? body.entities.map((name: any) => String(name)).filter((name: string) => ENTITY_NAMES.has(name))
        : null;
    const definitions = requested?.length
        ? REPLICATED_ENTITIES.filter((definition) => requested.includes(definition.name))
        : REPLICATED_ENTITIES;

    const sql = neon(databaseUrl);
    const base44 = createClientFromRequest(req);
    const deadline = Date.now() + TIME_BUDGET_MS;

    const runRows = await sql(
        `INSERT INTO continuity.replication_runs (mode) VALUES ($1) RETURNING run_id`,
        [mode]
    ).catch(() => null);
    const runId = runRows?.[0]?.run_id || null;

    const results: any[] = [];
    let rowsScanned = 0;
    let versionsAppended = 0;
    let tombstonesMarked = 0;
    let alarmsRaised = 0;
    let ok = true;

    for (const definition of definitions) {
        if (Date.now() > deadline) {
            results.push({ entity: definition.name, skipped: 'time_budget_exhausted' });
            continue;
        }
        try {
            const result = mode === 'reconcile'
                ? await reconcileEntity(base44, sql, definition, deadline, body || {})
                : await sweepEntity(base44, sql, definition, deadline);
            results.push(result);
            rowsScanned += Number(result?.scanned || 0);
            versionsAppended += Number(result?.appended || 0);
            tombstonesMarked += Number(result?.tombstoned || 0);
            if (result?.alarm === 'blocked') alarmsRaised += 1;
        } catch (error: any) {
            ok = false;
            await recordCursorFailure(sql, definition.name, error?.message);
            // Log the entity, not the payload: these records carry homeowner
            // addresses and rep identities.
            console.error('[replicateFieldData] entity failed', definition.name, error?.message);
            results.push({ entity: definition.name, error: 'replication_failed' });
        }
    }

    if (runId) {
        await sql(
            `UPDATE continuity.replication_runs SET
                 finished_at = NOW(), entities_processed = $2, rows_scanned = $3,
                 versions_appended = $4, tombstones_marked = $5, alarms_raised = $6,
                 ok = $7, detail = $8::jsonb
             WHERE run_id = $1`,
            [
                runId,
                results.length,
                rowsScanned,
                versionsAppended,
                tombstonesMarked,
                alarmsRaised,
                ok,
                JSON.stringify(results)
            ]
        ).catch(() => null);
    }

    return Response.json({
        success: ok,
        mode,
        run_id: runId,
        entities_processed: results.length,
        rows_scanned: rowsScanned,
        versions_appended: versionsAppended,
        tombstones_marked: tombstonesMarked,
        alarms_raised: alarmsRaised,
        results
    }, { status: ok ? 200 : 500 });
});
