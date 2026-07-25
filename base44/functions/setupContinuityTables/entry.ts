import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

// Provisions the continuity schema: an append-only replica of every
// irreplaceable field record (outcomes, houses, areas, routes) in a store we
// control, independent of the Base44 entity store that holds the live copy.
//
// This migration is strictly additive. It creates a dedicated `continuity`
// schema and never reads, writes, alters, or drops anything in the existing
// public schema. Running it twice is a no-op.
//
// The core guarantee lives in continuity.record_versions: a ledger with a
// BEFORE UPDATE OR DELETE trigger that raises on any mutation. Once a version
// lands there, no application bug, admin script, or restore run can erase it.
// Losing data for good would require dropping the table on purpose.

const MIGRATION_SECRET_ENV = 'CONTINUITY_MIGRATION_SECRET';

function isAuthorizedMigration(req: Request) {
    const expected = Deno.env.get(MIGRATION_SECRET_ENV);
    if (!expected) return false;
    const received = req.headers.get('x-continuity-migration-secret');
    if (!received || received.length !== expected.length) return false;
    // Constant-time compare so a wrong secret cannot be probed byte by byte.
    let mismatch = 0;
    for (let index = 0; index < expected.length; index += 1) {
        mismatch |= expected.charCodeAt(index) ^ received.charCodeAt(index);
    }
    return mismatch === 0;
}

Deno.serve(async (req) => {
    try {
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }
        if (!isAuthorizedMigration(req)) {
            return Response.json({
                error: 'Forbidden: migration secret required',
                code: 'continuity_migration_secret_required'
            }, { status: 403 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
        }

        const sql = neon(databaseUrl);

        await sql('CREATE SCHEMA IF NOT EXISTS continuity');

        // ── The ledger ────────────────────────────────────────────────────────
        // Every version of every mirrored record, forever. Append-only.
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.record_versions (
                version_id        BIGSERIAL PRIMARY KEY,
                entity            TEXT NOT NULL,
                record_id         TEXT NOT NULL,
                manager_id        TEXT,
                created_by        TEXT,
                payload           JSONB NOT NULL,
                payload_hash      TEXT NOT NULL,
                source_updated_at TIMESTAMPTZ,
                source            TEXT NOT NULL,
                captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        // Dedupe key: the same state arriving from both the realtime hook and a
        // later sweep must not double-write. A genuine revert to an older
        // payload still lands, because its source_updated_at differs.
        await sql(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_continuity_versions_dedupe
            ON continuity.record_versions (
                entity,
                record_id,
                payload_hash,
                COALESCE(source_updated_at, '-infinity'::timestamptz)
            )
        `);

        const versionIndexes = [
            `CREATE INDEX IF NOT EXISTS idx_continuity_versions_record
             ON continuity.record_versions (entity, record_id, version_id DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_continuity_versions_captured
             ON continuity.record_versions (entity, captured_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_continuity_versions_manager
             ON continuity.record_versions (manager_id, entity, captured_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_continuity_versions_source_updated
             ON continuity.record_versions (entity, source_updated_at DESC)`
        ];
        for (const statement of versionIndexes) await sql(statement);

        // Make the ledger physically append-only. This is the whole point: a
        // bad loop in the app or a careless admin script cannot rewrite history
        // here the way it can in the live store.
        await sql(`
            CREATE OR REPLACE FUNCTION continuity.reject_ledger_mutation()
            RETURNS TRIGGER AS $ledger$
            BEGIN
                RAISE EXCEPTION
                    'continuity.record_versions is append-only; % is not permitted', TG_OP
                    USING ERRCODE = 'raise_exception';
            END;
            $ledger$ LANGUAGE plpgsql
        `);

        const ledgerTriggerExists = await sql(`
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'trg_continuity_versions_append_only'
              AND NOT tgisinternal
            LIMIT 1
        `);
        if (!ledgerTriggerExists.length) {
            await sql(`
                CREATE TRIGGER trg_continuity_versions_append_only
                BEFORE UPDATE OR DELETE ON continuity.record_versions
                FOR EACH ROW EXECUTE FUNCTION continuity.reject_ledger_mutation()
            `);
        }

        // ── Latest-known-state projection ─────────────────────────────────────
        // Rebuildable from the ledger at any time. Exists so restore and health
        // checks do not have to scan every version.
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.record_current (
                entity              TEXT NOT NULL,
                record_id           TEXT NOT NULL,
                manager_id          TEXT,
                created_by          TEXT,
                payload             JSONB NOT NULL,
                payload_hash        TEXT NOT NULL,
                source_updated_at   TIMESTAMPTZ,
                version_id          BIGINT NOT NULL,
                first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                deleted_detected_at TIMESTAMPTZ,
                restored_at         TIMESTAMPTZ,
                PRIMARY KEY (entity, record_id)
            )
        `);

        const currentIndexes = [
            `CREATE INDEX IF NOT EXISTS idx_continuity_current_manager
             ON continuity.record_current (entity, manager_id)`,
            `CREATE INDEX IF NOT EXISTS idx_continuity_current_live
             ON continuity.record_current (entity) WHERE deleted_detected_at IS NULL`,
            `CREATE INDEX IF NOT EXISTS idx_continuity_current_tombstoned
             ON continuity.record_current (entity, deleted_detected_at DESC)
             WHERE deleted_detected_at IS NOT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_continuity_current_updated
             ON continuity.record_current (entity, source_updated_at DESC)`
        ];
        for (const statement of currentIndexes) await sql(statement);

        // ── Replication bookkeeping ───────────────────────────────────────────
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.replication_cursor (
                entity                 TEXT PRIMARY KEY,
                cursor_updated_at      TIMESTAMPTZ,
                last_sweep_at          TIMESTAMPTZ,
                last_full_reconcile_at TIMESTAMPTZ,
                rows_mirrored          BIGINT NOT NULL DEFAULT 0,
                consecutive_failures   INTEGER NOT NULL DEFAULT 0,
                last_error             TEXT,
                updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.replication_runs (
                run_id            BIGSERIAL PRIMARY KEY,
                started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                finished_at       TIMESTAMPTZ,
                mode              TEXT NOT NULL,
                entities_processed INTEGER NOT NULL DEFAULT 0,
                rows_scanned      INTEGER NOT NULL DEFAULT 0,
                versions_appended INTEGER NOT NULL DEFAULT 0,
                tombstones_marked INTEGER NOT NULL DEFAULT 0,
                alarms_raised     INTEGER NOT NULL DEFAULT 0,
                ok                BOOLEAN NOT NULL DEFAULT FALSE,
                detail            JSONB
            )
        `);
        await sql(`
            CREATE INDEX IF NOT EXISTS idx_continuity_runs_started
            ON continuity.replication_runs (started_at DESC)
        `);

        // ── Mass-deletion canary ──────────────────────────────────────────────
        // When a reconcile pass finds an implausible share of a tenant's records
        // missing, it refuses to tombstone and files an alarm instead. A real
        // bulk delete then needs a human acknowledgement before the mirror
        // agrees the records are gone.
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.deletion_alarms (
                alarm_id         BIGSERIAL PRIMARY KEY,
                raised_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                entity           TEXT NOT NULL,
                manager_id       TEXT,
                mirrored_count   INTEGER NOT NULL,
                missing_count    INTEGER NOT NULL,
                missing_ratio    DOUBLE PRECISION NOT NULL,
                threshold_ratio  DOUBLE PRECISION NOT NULL,
                action           TEXT NOT NULL,
                sample_ids       JSONB,
                acknowledged_at  TIMESTAMPTZ,
                acknowledged_by  TEXT
            )
        `);
        await sql(`
            CREATE INDEX IF NOT EXISTS idx_continuity_alarms_open
            ON continuity.deletion_alarms (raised_at DESC)
            WHERE acknowledged_at IS NULL
        `);

        // ── Off-site snapshot log ─────────────────────────────────────────────
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.snapshot_exports (
                export_id      BIGSERIAL PRIMARY KEY,
                started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                finished_at    TIMESTAMPTZ,
                destination    TEXT,
                object_key     TEXT,
                byte_size      BIGINT,
                row_count      BIGINT,
                entities       JSONB,
                content_sha256 TEXT,
                ok             BOOLEAN NOT NULL DEFAULT FALSE,
                error          TEXT
            )
        `);
        await sql(`
            CREATE INDEX IF NOT EXISTS idx_continuity_snapshots_started
            ON continuity.snapshot_exports (started_at DESC)
        `);

        // ── Restore audit ─────────────────────────────────────────────────────
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.restore_runs (
                restore_id     BIGSERIAL PRIMARY KEY,
                started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                finished_at    TIMESTAMPTZ,
                requested_by   TEXT NOT NULL,
                dry_run        BOOLEAN NOT NULL DEFAULT TRUE,
                entity         TEXT,
                manager_id     TEXT,
                as_of          TIMESTAMPTZ,
                planned_count  INTEGER NOT NULL DEFAULT 0,
                created_count  INTEGER NOT NULL DEFAULT 0,
                updated_count  INTEGER NOT NULL DEFAULT 0,
                skipped_count  INTEGER NOT NULL DEFAULT 0,
                failed_count   INTEGER NOT NULL DEFAULT 0,
                ok             BOOLEAN NOT NULL DEFAULT FALSE,
                detail         JSONB
            )
        `);
        await sql(`
            CREATE INDEX IF NOT EXISTS idx_continuity_restores_started
            ON continuity.restore_runs (started_at DESC)
        `);

        // Recreated records receive fresh ids from Base44. This map lets a
        // restore rewrite foreign keys (route_id, pin_id, campaign_id, ...) so
        // the rebuilt data is linked rather than a pile of orphans.
        await sql(`
            CREATE TABLE IF NOT EXISTS continuity.restore_id_map (
                restore_id  BIGINT NOT NULL,
                entity      TEXT NOT NULL,
                original_id TEXT NOT NULL,
                restored_id TEXT NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (restore_id, entity, original_id)
            )
        `);
        await sql(`
            CREATE INDEX IF NOT EXISTS idx_continuity_restore_map_lookup
            ON continuity.restore_id_map (restore_id, original_id)
        `);

        const ledgerGuard = await sql(`
            SELECT COUNT(*)::int AS count FROM pg_trigger
            WHERE tgname = 'trg_continuity_versions_append_only' AND NOT tgisinternal
        `);

        return Response.json({
            success: true,
            message: 'Continuity schema is ready',
            schema: 'continuity',
            tables: [
                'record_versions',
                'record_current',
                'replication_cursor',
                'replication_runs',
                'deletion_alarms',
                'snapshot_exports',
                'restore_runs',
                'restore_id_map'
            ],
            append_only_guard_installed: Number(ledgerGuard?.[0]?.count || 0) === 1,
            touched_existing_data: false
        });
    } catch (error: any) {
        console.error('[setupContinuityTables] failed', error?.message);
        return Response.json({ error: 'Continuity migration failed' }, { status: 500 });
    }
});
