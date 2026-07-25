import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

// Verification for the continuity mirror. A backup nobody checks is a rumour,
// so this endpoint answers one question directly: if the live store vanished
// right now, what would we get back?
//
// Rather than comparing totals, it probes recall. It pulls the most recently
// updated records straight from the live store and checks each one is present
// in the mirror with a matching content hash. That catches the failure that
// actually matters — replication silently falling behind or dropping writes —
// which a row count would happily hide.
//
// Readable by an admin session or by the worker secret, so an uptime monitor
// can poll it without an interactive login.

const WORKER_SECRET_ENV = 'CONTINUITY_WORKER_SECRET';
const PROBE_SIZE = 25;
const SWEEP_LAG_WARN_MS = 10 * 60 * 1000;
const SWEEP_LAG_CRITICAL_MS = 60 * 60 * 1000;
const SNAPSHOT_WARN_MS = 36 * 60 * 60 * 1000;

const PROBED_ENTITIES = [
    { name: 'InteractionLog', label: 'Outcomes', tier: 1 },
    { name: 'CanvasHouseEvent', label: 'Canvas outcomes', tier: 1 },
    { name: 'SavedRoute', label: 'Routes', tier: 1 },
    { name: 'DailyResult', label: 'Daily outcomes', tier: 1 },
    { name: 'CanvasHousePin', label: 'Canvas houses', tier: 2 },
    { name: 'CanvasSession', label: 'Canvas areas', tier: 2 },
    { name: 'TerritoryPlan', label: 'Areas', tier: 2 },
    { name: 'Appointment', label: 'Appointments', tier: 2 },
    { name: 'RouteTemplate', label: 'Route templates', tier: 3 },
    { name: 'TeamMember', label: 'Team', tier: 3 },
    { name: 'MasterProperty', label: 'Houses', tier: 3 }
];

function timingSafeEqual(expected: string, received: string) {
    if (!expected || !received || expected.length !== received.length) return false;
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) {
        mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return mismatch === 0;
}

function hasWorkerSecret(req: Request) {
    const expected = Deno.env.get(WORKER_SECRET_ENV);
    if (!expected) return false;
    return timingSafeEqual(expected, req.headers.get('x-continuity-worker-secret') || '');
}

function asArray(result: any) {
    return Array.isArray(result) ? result : (result?.items || []);
}

// Must match the digest used by replicateFieldData and the realtime journal,
// or every probe would report a false mismatch.
function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .filter((key) => key !== 'updated_date')
            .sort()
            .map((key) => [key, canonicalize(value[key])])
    );
}

async function sha256(value: any) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ageMs(value: any) {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? Date.now() - parsed : null;
}

Deno.serve(async (req) => {
    try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

        const base44 = createClientFromRequest(req);
        let authorized = hasWorkerSecret(req);
        if (!authorized) {
            const user = await base44.auth.me().catch(() => null);
            authorized = user?.role === 'admin';
        }
        if (!authorized) {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            return Response.json({
                status: 'critical',
                error: 'DATABASE_URL is not configured',
                message: 'The continuity mirror has no destination. Nothing is being backed up.'
            }, { status: 500 });
        }

        const sql = neon(databaseUrl);
        const url = new URL(req.url);
        const skipProbe = url.searchParams.get('probe') === 'false';

        const schemaReady = await sql(`
            SELECT COUNT(*)::int AS count FROM information_schema.tables
            WHERE table_schema = 'continuity' AND table_name = 'record_current'
        `).catch(() => null);

        if (!Number(schemaReady?.[0]?.count || 0)) {
            return Response.json({
                status: 'critical',
                schema_ready: false,
                message: 'The continuity schema does not exist. Run setupContinuityTables.'
            }, { status: 200 });
        }

        const [mirrorRows, cursorRows, alarmRows, snapshotRows, ledgerRows, guardRows] = await Promise.all([
            sql(`SELECT entity,
                        COUNT(*)::int AS mirrored,
                        COUNT(*) FILTER (WHERE deleted_detected_at IS NOT NULL)::int AS tombstoned,
                        MAX(last_seen_at) AS last_seen_at
                 FROM continuity.record_current GROUP BY entity`),
            sql(`SELECT entity, cursor_updated_at, last_sweep_at, last_full_reconcile_at,
                        rows_mirrored, consecutive_failures, last_error
                 FROM continuity.replication_cursor`),
            sql(`SELECT alarm_id, entity, missing_count, mirrored_count, missing_ratio, raised_at
                 FROM continuity.deletion_alarms
                 WHERE acknowledged_at IS NULL ORDER BY raised_at DESC LIMIT 20`),
            sql(`SELECT started_at, finished_at, object_key, row_count, byte_size, ok, error
                 FROM continuity.snapshot_exports ORDER BY started_at DESC LIMIT 1`),
            sql(`SELECT COUNT(*)::bigint AS versions FROM continuity.record_versions`),
            sql(`SELECT COUNT(*)::int AS count FROM pg_trigger
                 WHERE tgname = 'trg_continuity_versions_append_only' AND NOT tgisinternal`)
        ]);

        const mirrorByEntity = new Map((mirrorRows || []).map((row: any) => [row.entity, row]));
        const cursorByEntity = new Map((cursorRows || []).map((row: any) => [row.entity, row]));

        const entities: any[] = [];
        let worstTier1Probe = 1;
        let anyProbeRan = false;

        for (const definition of PROBED_ENTITIES) {
            const mirror: any = mirrorByEntity.get(definition.name) || {};
            const cursor: any = cursorByEntity.get(definition.name) || {};
            const sweepLag = ageMs(cursor.last_sweep_at);

            const entry: any = {
                entity: definition.name,
                label: definition.label,
                tier: definition.tier,
                mirrored: Number(mirror.mirrored || 0),
                tombstoned: Number(mirror.tombstoned || 0),
                last_mirrored_at: mirror.last_seen_at || null,
                last_sweep_at: cursor.last_sweep_at || null,
                last_full_reconcile_at: cursor.last_full_reconcile_at || null,
                sweep_lag_seconds: sweepLag === null ? null : Math.round(sweepLag / 1000),
                consecutive_failures: Number(cursor.consecutive_failures || 0),
                last_error: cursor.last_error || null
            };

            if (!skipProbe) {
                const handle = base44.asServiceRole.entities[definition.name];
                if (handle) {
                    const live = asArray(
                        await handle.filter({}, '-updated_date', PROBE_SIZE).catch(() => [])
                    );
                    if (live.length) {
                        anyProbeRan = true;
                        const ids = live.map((record: any) => String(record?.id || '')).filter(Boolean);
                        const mirrored = await sql(
                            `SELECT record_id, payload_hash FROM continuity.record_current
                             WHERE entity = $1 AND record_id = ANY($2::text[])`,
                            [definition.name, ids]
                        ).catch(() => []);
                        const hashById = new Map(
                            (mirrored || []).map((row: any) => [String(row.record_id), String(row.payload_hash)])
                        );

                        let matched = 0;
                        let stale = 0;
                        const missing: string[] = [];
                        for (const record of live) {
                            const id = String(record?.id || '');
                            if (!id) continue;
                            const mirroredHash = hashById.get(id);
                            if (!mirroredHash) {
                                missing.push(id);
                                continue;
                            }
                            if (mirroredHash === await sha256(record)) matched += 1;
                            else stale += 1;
                        }

                        const recall = ids.length ? matched / ids.length : 1;
                        entry.probe = {
                            sampled: ids.length,
                            matched,
                            stale,
                            missing: missing.length,
                            recall: Number(recall.toFixed(4))
                        };
                        if (definition.tier === 1) worstTier1Probe = Math.min(worstTier1Probe, recall);
                    } else {
                        entry.probe = { sampled: 0, note: 'no live records to verify' };
                    }
                }
            }

            entities.push(entry);
        }

        const openAlarms = alarmRows || [];
        const snapshot = snapshotRows?.[0] || null;
        const snapshotAge = ageMs(snapshot?.started_at);
        const appendOnlyGuard = Number(guardRows?.[0]?.count || 0) === 1;

        const worstSweepLag = entities.reduce((worst, entry) => {
            if (entry.sweep_lag_seconds === null) return worst;
            return Math.max(worst, entry.sweep_lag_seconds * 1000);
        }, 0);
        const neverSwept = entities.filter((entry) => entry.tier === 1 && !entry.last_sweep_at);

        const problems: string[] = [];
        let status = 'healthy';

        if (!appendOnlyGuard) {
            problems.push('The append-only guard on continuity.record_versions is missing. History is mutable.');
            status = 'critical';
        }
        if (neverSwept.length) {
            problems.push(`Replication has never run for: ${neverSwept.map((entry) => entry.entity).join(', ')}.`);
            status = 'critical';
        }
        if (anyProbeRan && worstTier1Probe < 0.995) {
            problems.push(`Only ${(worstTier1Probe * 100).toFixed(1)}% of the newest irreplaceable records are mirrored.`);
            status = worstTier1Probe < 0.95 ? 'critical' : 'degraded';
        }
        if (worstSweepLag > SWEEP_LAG_CRITICAL_MS) {
            problems.push('Replication has not swept in over an hour.');
            status = 'critical';
        } else if (worstSweepLag > SWEEP_LAG_WARN_MS && status === 'healthy') {
            problems.push('Replication is lagging beyond ten minutes.');
            status = 'degraded';
        }
        if (openAlarms.length) {
            problems.push(`${openAlarms.length} unacknowledged mass-deletion alarm(s). Records are retained pending review.`);
            if (status === 'healthy') status = 'degraded';
        }
        if (entities.some((entry) => entry.consecutive_failures >= 3)) {
            problems.push('One or more entities are failing replication repeatedly.');
            status = 'critical';
        }
        if (snapshot && snapshotAge !== null && snapshotAge > SNAPSHOT_WARN_MS && status === 'healthy') {
            problems.push('The most recent off-site snapshot is over 36 hours old.');
            status = 'degraded';
        }

        return Response.json({
            status,
            schema_ready: true,
            append_only_guard: appendOnlyGuard,
            checked_at: new Date().toISOString(),
            total_versions_retained: Number(ledgerRows?.[0]?.versions || 0),
            total_records_mirrored: entities.reduce((sum, entry) => sum + entry.mirrored, 0),
            entities,
            open_deletion_alarms: openAlarms,
            last_snapshot: snapshot
                ? {
                    started_at: snapshot.started_at,
                    object_key: snapshot.object_key,
                    row_count: snapshot.row_count,
                    byte_size: snapshot.byte_size,
                    ok: snapshot.ok,
                    age_hours: snapshotAge === null ? null : Number((snapshotAge / 3_600_000).toFixed(1))
                }
                : { configured: false, note: 'No off-site snapshot has been taken yet.' },
            problems
        });
    } catch (error: any) {
        console.error('[continuityHealth] failed', error?.message);
        return Response.json({ status: 'unknown', error: 'health_check_failed' }, { status: 500 });
    }
});
