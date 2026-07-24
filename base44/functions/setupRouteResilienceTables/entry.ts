import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const CONFIRMATION = 'CREATE_ROUTE_RESILIENCE_TABLES';

Deno.serve(async (req) => {
    try {
        if (req.method !== 'POST') {
            return Response.json({ error: 'Method not allowed' }, { status: 405 });
        }

        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (String(user.role || user?.data?.role || '').toLowerCase() !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const body = await req.json().catch(() => ({}));
        if (body.confirmation !== CONFIRMATION) {
            return Response.json({
                error: 'confirmation_required',
                message: `Set confirmation to ${CONFIRMATION}. No schema changes were made.`
            }, { status: 400 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
        }
        const sql = neon(databaseUrl);

        // These tables are intentionally additive and append-only. Source Base44
        // entities are never changed by setup or reconciliation.
        await sql`
            CREATE TABLE IF NOT EXISTS route_snapshot_versions (
                id BIGSERIAL PRIMARY KEY,
                route_id TEXT NOT NULL,
                tenant_key TEXT NOT NULL CHECK (length(tenant_key) > 0),
                manager_id TEXT,
                owner_email TEXT,
                source_created_at TIMESTAMPTZ,
                source_updated_at TIMESTAMPTZ,
                manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
                snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
                ordered_hashes JSONB NOT NULL CHECK (jsonb_typeof(ordered_hashes) = 'array'),
                route_payload JSONB NOT NULL CHECK (jsonb_typeof(route_payload) = 'object'),
                resolved_stop_count INTEGER NOT NULL DEFAULT 0 CHECK (resolved_stop_count >= 0),
                unresolved_stop_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_stop_count >= 0),
                capture_source TEXT NOT NULL DEFAULT 'reconciler',
                captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(route_id, snapshot_sha256),
                UNIQUE(id, route_id, tenant_key),
                CHECK (
                    resolved_stop_count + unresolved_stop_count
                    = jsonb_array_length(ordered_hashes)
                )
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS route_snapshot_stops (
                snapshot_id BIGINT NOT NULL,
                route_id TEXT NOT NULL,
                tenant_key TEXT NOT NULL CHECK (length(tenant_key) > 0),
                stop_ordinal INTEGER NOT NULL CHECK (stop_ordinal >= 0),
                address_hash TEXT NOT NULL CHECK (length(address_hash) > 0),
                latitude DOUBLE PRECISION CHECK (
                    latitude IS NULL OR latitude BETWEEN -90 AND 90
                ),
                longitude DOUBLE PRECISION CHECK (
                    longitude IS NULL OR longitude BETWEEN -180 AND 180
                ),
                full_address TEXT,
                renderable BOOLEAN NOT NULL,
                resolution_issue TEXT CHECK (
                    resolution_issue IS NULL
                    OR resolution_issue IN ('missing_property', 'missing_coordinates')
                ),
                resolution_source TEXT NOT NULL CHECK (
                    resolution_source IN ('neon_properties', 'base44_master_property', 'missing')
                ),
                property_snapshot JSONB,
                captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY(snapshot_id, stop_ordinal),
                FOREIGN KEY(snapshot_id, route_id, tenant_key)
                    REFERENCES route_snapshot_versions(id, route_id, tenant_key)
                    ON DELETE RESTRICT
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS route_snapshot_heads (
                route_id TEXT PRIMARY KEY,
                tenant_key TEXT NOT NULL CHECK (length(tenant_key) > 0),
                snapshot_id BIGINT NOT NULL,
                manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
                snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
                source_updated_at TIMESTAMPTZ,
                reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                FOREIGN KEY(snapshot_id, route_id, tenant_key)
                    REFERENCES route_snapshot_versions(id, route_id, tenant_key)
                    ON DELETE RESTRICT
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS interaction_snapshot_versions (
                id BIGSERIAL PRIMARY KEY,
                interaction_id TEXT NOT NULL,
                tenant_key TEXT NOT NULL CHECK (length(tenant_key) > 0),
                manager_id TEXT,
                owner_email TEXT,
                route_id TEXT,
                address_hash TEXT NOT NULL,
                source_created_at TIMESTAMPTZ,
                source_updated_at TIMESTAMPTZ,
                snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
                interaction_payload JSONB NOT NULL CHECK (jsonb_typeof(interaction_payload) = 'object'),
                capture_source TEXT NOT NULL DEFAULT 'reconciler',
                captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(interaction_id, snapshot_sha256),
                UNIQUE(id, interaction_id, tenant_key)
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS interaction_snapshot_heads (
                interaction_id TEXT PRIMARY KEY,
                tenant_key TEXT NOT NULL CHECK (length(tenant_key) > 0),
                snapshot_id BIGINT NOT NULL,
                snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
                source_updated_at TIMESTAMPTZ,
                reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                FOREIGN KEY(snapshot_id, interaction_id, tenant_key)
                    REFERENCES interaction_snapshot_versions(id, interaction_id, tenant_key)
                    ON DELETE RESTRICT
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS route_resilience_reconciliation_runs (
                run_id TEXT PRIMARY KEY,
                dry_run BOOLEAN NOT NULL,
                route_skip INTEGER NOT NULL,
                route_count INTEGER NOT NULL,
                route_stop_count INTEGER NOT NULL,
                unresolved_stop_count INTEGER NOT NULL,
                interaction_skip INTEGER NOT NULL,
                interaction_count INTEGER NOT NULL,
                missing_tenant_count INTEGER NOT NULL,
                summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
                started_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_route_snapshot_versions_tenant_route ON route_snapshot_versions(tenant_key, route_id, captured_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_route_snapshot_stops_tenant_route ON route_snapshot_stops(tenant_key, route_id, stop_ordinal)',
            'CREATE INDEX IF NOT EXISTS idx_route_snapshot_stops_hash ON route_snapshot_stops(address_hash)',
            'CREATE INDEX IF NOT EXISTS idx_interaction_snapshot_versions_tenant_route ON interaction_snapshot_versions(tenant_key, route_id, captured_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_interaction_snapshot_versions_hash ON interaction_snapshot_versions(tenant_key, address_hash, captured_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_route_resilience_runs_completed ON route_resilience_reconciliation_runs(completed_at DESC)'
        ];
        for (const statement of indexes) {
            await sql(statement);
        }

        return Response.json({
            success: true,
            additive_only: true,
            source_records_changed: 0,
            tables: [
                'route_snapshot_versions',
                'route_snapshot_stops',
                'route_snapshot_heads',
                'interaction_snapshot_versions',
                'interaction_snapshot_heads',
                'route_resilience_reconciliation_runs'
            ],
            indexes_created: indexes.length
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
