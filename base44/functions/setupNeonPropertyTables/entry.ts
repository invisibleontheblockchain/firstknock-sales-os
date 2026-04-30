import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) {
            return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });
        }

        const sql = neon(databaseUrl);

        await sql`CREATE TABLE IF NOT EXISTS properties (id BIGSERIAL PRIMARY KEY)`;

        const propertyColumns = [
            ['address_hash', 'TEXT'],
            ['legacy_hash', 'TEXT'],
            ['full_address', 'TEXT'],
            ['house_number', 'INTEGER'],
            ['street_name', 'TEXT'],
            ['city', 'TEXT'],
            ['state', 'TEXT'],
            ['zip_code', 'TEXT'],
            ['lat', 'DOUBLE PRECISION'],
            ['lng', 'DOUBLE PRECISION'],
            ['h3_index', 'TEXT'],
            ['owner_full_name', 'TEXT'],
            ['beds', 'DOUBLE PRECISION'],
            ['baths', 'DOUBLE PRECISION'],
            ['sqft', 'DOUBLE PRECISION'],
            ['lot_size', 'DOUBLE PRECISION'],
            ['year_built', 'INTEGER'],
            ['price', 'DOUBLE PRECISION'],
            ['sold_date', 'TIMESTAMPTZ'],
            ['sale_type', 'TEXT'],
            ['property_type', 'TEXT'],
            ['mls_id', 'TEXT'],
            ['url', 'TEXT'],
            ['data_source', 'TEXT'],
            ['sale_confidence', 'TEXT'],
            ['original_status', 'TEXT'],
            ['raw_payload', 'JSONB'],
            ['created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()'],
            ['updated_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()']
        ];

        for (const [name, definition] of propertyColumns) {
            await sql(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS ${name} ${definition}`);
        }

        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_address_hash_unique ON properties(address_hash)`;

        await sql`
            CREATE TABLE IF NOT EXISTS workspace_properties (
                id BIGSERIAL PRIMARY KEY,
                property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                workspace_id TEXT,
                fetch_job_id TEXT,
                route_active BOOLEAN NOT NULL DEFAULT TRUE,
                status TEXT,
                assigned_route_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(property_id, user_email)
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS property_sources (
                id BIGSERIAL PRIMARY KEY,
                property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,
                provider_record_id TEXT,
                fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                raw_payload JSONB,
                UNIQUE(property_id, provider, provider_record_id)
            )
        `;

        await sql`
            CREATE TABLE IF NOT EXISTS ingestion_metrics (
                id BIGSERIAL PRIMARY KEY,
                fetch_job_id TEXT,
                user_email TEXT,
                records_fetched INTEGER NOT NULL DEFAULT 0,
                records_inserted INTEGER NOT NULL DEFAULT 0,
                records_updated INTEGER NOT NULL DEFAULT 0,
                records_skipped INTEGER NOT NULL DEFAULT 0,
                storage_estimate_bytes BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;

        const indexStatements = [
            'CREATE INDEX IF NOT EXISTS idx_properties_address_hash ON properties(address_hash)',
            'CREATE INDEX IF NOT EXISTS idx_properties_zip_code ON properties(zip_code)',
            'CREATE INDEX IF NOT EXISTS idx_properties_lat_lng ON properties(lat, lng)',
            'CREATE INDEX IF NOT EXISTS idx_properties_sold_date ON properties(sold_date)',
            'CREATE INDEX IF NOT EXISTS idx_properties_data_source ON properties(data_source)',
            'CREATE INDEX IF NOT EXISTS idx_properties_mls_id ON properties(mls_id)',
            'CREATE INDEX IF NOT EXISTS idx_properties_zip_sold_date ON properties(zip_code, sold_date)',
            'CREATE INDEX IF NOT EXISTS idx_workspace_properties_user_active ON workspace_properties(user_email, route_active)',
            'CREATE INDEX IF NOT EXISTS idx_workspace_properties_workspace_active ON workspace_properties(workspace_id, route_active)',
            'CREATE INDEX IF NOT EXISTS idx_workspace_properties_fetch_job ON workspace_properties(fetch_job_id)',
            'CREATE INDEX IF NOT EXISTS idx_property_sources_provider_record ON property_sources(provider, provider_record_id)',
            'CREATE INDEX IF NOT EXISTS idx_ingestion_metrics_fetch_job ON ingestion_metrics(fetch_job_id)'
        ];

        for (const statement of indexStatements) {
            await sql(statement);
        }

        return Response.json({
            success: true,
            message: 'Neon property tables and indexes are ready',
            tables: ['properties', 'workspace_properties', 'property_sources', 'ingestion_metrics'],
            indexes_created: indexStatements.length
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});