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

        const tables = await sql`
            SELECT
                relname AS table_name,
                pg_total_relation_size(relid)::bigint AS total_bytes,
                pg_relation_size(relid)::bigint AS table_bytes,
                (pg_total_relation_size(relid) - pg_relation_size(relid))::bigint AS index_bytes
            FROM pg_catalog.pg_statio_user_tables
            WHERE relname IN ('properties', 'workspace_properties', 'property_sources', 'ingestion_metrics')
            ORDER BY relname
        `;

        const propertyCountRows = await sql`SELECT COUNT(*)::int AS count FROM properties`;
        const workspacePropertyCountRows = await sql`SELECT COUNT(*)::int AS count FROM workspace_properties`;
        const totalRows = propertyCountRows[0]?.count || 0;
        const linkedRows = workspacePropertyCountRows[0]?.count || 0;
        const totalBytes = tables.reduce((sum, row) => sum + Number(row.total_bytes || 0), 0);
        const propertyTable = tables.find(row => row.table_name === 'properties');
        const propertyBytes = Number(propertyTable?.total_bytes || 0);
        const bytesPerProperty = totalRows > 0 ? Math.round(propertyBytes / totalRows) : 0;
        const estimatedPer10000 = bytesPerProperty * 10000;
        const freePlanStorageBytes = 0.5 * 1024 * 1024 * 1024;
        const estimatedFreePlanCapacity = bytesPerProperty > 0 ? Math.floor(freePlanStorageBytes / bytesPerProperty) : null;

        return Response.json({
            success: true,
            property_count: totalRows,
            workspace_property_count: linkedRows,
            total_storage_bytes: totalBytes,
            total_storage_mb: Math.round((totalBytes / 1024 / 1024) * 100) / 100,
            bytes_per_property: bytesPerProperty,
            estimated_storage_per_10000_properties_mb: Math.round((estimatedPer10000 / 1024 / 1024) * 100) / 100,
            estimated_free_plan_property_capacity: estimatedFreePlanCapacity,
            tables: tables.map(row => ({
                table_name: row.table_name,
                total_mb: Math.round((Number(row.total_bytes) / 1024 / 1024) * 100) / 100,
                table_mb: Math.round((Number(row.table_bytes) / 1024 / 1024) * 100) / 100,
                index_mb: Math.round((Number(row.index_bytes) / 1024 / 1024) * 100) / 100
            }))
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});