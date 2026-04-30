import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

function valueOrNull(value) {
    return value === undefined || value === '' ? null : value;
}

function buildValues(rows, columns) {
    const params = [];
    const placeholders = rows.map((row, rowIndex) => {
        const values = columns.map((column) => row[column]);
        params.push(...values);
        const start = rowIndex * columns.length;
        return `(${values.map((_, valueIndex) => `$${start + valueIndex + 1}`).join(', ')})`;
    }).join(', ');
    return { placeholders, params };
}

async function bulkUpsertProperties(sql, properties) {
    if (properties.length === 0) return [];

    const rows = properties.map(property => ({
        address_hash: property.address_hash,
        legacy_hash: valueOrNull(property.legacy_hash),
        full_address: valueOrNull(property.full_address || `${property.house_number || ''} ${property.street_name || ''}`.trim()),
        house_number: valueOrNull(property.house_number),
        street_name: valueOrNull(property.street_name),
        city: valueOrNull(property.city),
        state: valueOrNull(property.state),
        zip_code: valueOrNull(property.zip_code),
        lat: valueOrNull(property.lat),
        lng: valueOrNull(property.lng),
        h3_index: valueOrNull(property.h3_index),
        owner_full_name: valueOrNull(property.owner_full_name),
        beds: valueOrNull(property.beds),
        baths: valueOrNull(property.baths),
        sqft: valueOrNull(property.sqft),
        lot_size: valueOrNull(property.lot_size),
        year_built: valueOrNull(property.year_built),
        price: valueOrNull(property.price),
        sold_date: toNullableDate(property.sold_date),
        sale_type: valueOrNull(property.sale_type),
        property_type: valueOrNull(property.property_type),
        mls_id: valueOrNull(property.mls_id),
        url: valueOrNull(property.url),
        data_source: valueOrNull(property.data_source),
        sale_confidence: valueOrNull(property.sale_confidence),
        original_status: valueOrNull(property.original_status),
        raw_payload: JSON.stringify(property)
    }));

    const columns = Object.keys(rows[0]);
    const { placeholders, params } = buildValues(rows, columns);

    return await sql.query(`
        INSERT INTO properties (${columns.join(', ')}, updated_at)
        VALUES ${placeholders.replace(/\)/g, ', NOW())')}
        ON CONFLICT (address_hash)
        DO UPDATE SET
            legacy_hash = COALESCE(EXCLUDED.legacy_hash, properties.legacy_hash),
            full_address = COALESCE(EXCLUDED.full_address, properties.full_address),
            house_number = COALESCE(EXCLUDED.house_number, properties.house_number),
            street_name = COALESCE(EXCLUDED.street_name, properties.street_name),
            city = COALESCE(EXCLUDED.city, properties.city),
            state = COALESCE(EXCLUDED.state, properties.state),
            zip_code = COALESCE(EXCLUDED.zip_code, properties.zip_code),
            lat = COALESCE(EXCLUDED.lat, properties.lat),
            lng = COALESCE(EXCLUDED.lng, properties.lng),
            h3_index = COALESCE(EXCLUDED.h3_index, properties.h3_index),
            owner_full_name = COALESCE(EXCLUDED.owner_full_name, properties.owner_full_name),
            beds = COALESCE(EXCLUDED.beds, properties.beds),
            baths = COALESCE(EXCLUDED.baths, properties.baths),
            sqft = COALESCE(EXCLUDED.sqft, properties.sqft),
            lot_size = COALESCE(EXCLUDED.lot_size, properties.lot_size),
            year_built = COALESCE(EXCLUDED.year_built, properties.year_built),
            price = COALESCE(EXCLUDED.price, properties.price),
            sold_date = COALESCE(EXCLUDED.sold_date, properties.sold_date),
            sale_type = COALESCE(EXCLUDED.sale_type, properties.sale_type),
            property_type = COALESCE(EXCLUDED.property_type, properties.property_type),
            mls_id = COALESCE(EXCLUDED.mls_id, properties.mls_id),
            url = COALESCE(EXCLUDED.url, properties.url),
            data_source = COALESCE(EXCLUDED.data_source, properties.data_source),
            sale_confidence = COALESCE(EXCLUDED.sale_confidence, properties.sale_confidence),
            original_status = COALESCE(EXCLUDED.original_status, properties.original_status),
            raw_payload = EXCLUDED.raw_payload,
            updated_at = NOW()
        RETURNING id, address_hash
    `, params);
}

async function bulkUpsertWorkspace(sql, propertyRows, propertyMap, workspaceEmail) {
    if (propertyRows.length === 0) return;

    const rows = propertyRows.map(property => ({
        property_id: propertyMap.get(property.address_hash),
        user_email: workspaceEmail,
        fetch_job_id: 'base44_backfill',
        route_active: property.route_active !== false,
        status: valueOrNull(property.original_status)
    })).filter(row => row.property_id);

    if (rows.length === 0) return;

    const columns = Object.keys(rows[0]);
    const { placeholders, params } = buildValues(rows, columns);

    await sql.query(`
        INSERT INTO workspace_properties (${columns.join(', ')}, updated_at)
        VALUES ${placeholders.replace(/\)/g, ', NOW())')}
        ON CONFLICT (property_id, user_email)
        DO UPDATE SET
            fetch_job_id = EXCLUDED.fetch_job_id,
            route_active = EXCLUDED.route_active,
            status = EXCLUDED.status,
            updated_at = NOW()
    `, params);
}

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

        const body = await req.json().catch(() => ({}));
        const workspaceEmail = body.user_email || user.email;
        const limit = Math.min(Number(body.limit || 5000), 10000);
        const dryRun = body.dry_run === true;

        const base44Properties = await base44.asServiceRole.entities.MasterProperty.list('created_date', limit);
        const rawProperties = (Array.isArray(base44Properties) ? base44Properties : (base44Properties?.items || []))
            .filter(property => property.address_hash);
        const propertiesByHash = new Map();
        for (const property of rawProperties) {
            propertiesByHash.set(property.address_hash, property);
        }
        const properties = Array.from(propertiesByHash.values());

        if (dryRun) {
            return Response.json({
                success: true,
                dry_run: true,
                workspace_user_email: workspaceEmail,
                base44_records_found: properties.length,
                message: 'Dry run complete. No Neon records were changed.'
            });
        }

        const client = new Client(databaseUrl);
        await client.connect();

        const propertyResult = await bulkUpsertProperties(client, properties);
        const propertyRows = propertyResult.rows || propertyResult;
        const propertyMap = new Map(propertyRows.map(row => [row.address_hash, row.id]));
        await bulkUpsertWorkspace(client, properties, propertyMap, workspaceEmail);

        await client.query(
            `INSERT INTO ingestion_metrics (fetch_job_id, user_email, records_fetched, records_inserted, records_updated, records_skipped)
             VALUES ($1, $2, $3, $4, 0, 0)`,
            ['base44_backfill', workspaceEmail, properties.length, propertyRows.length]
        );

        const neonCount = await client.query(
            `SELECT COUNT(*)::int AS total_properties FROM workspace_properties WHERE user_email = $1`,
            [workspaceEmail]
        );

        await client.end();

        return Response.json({
            success: true,
            workspace_user_email: workspaceEmail,
            base44_records_read: properties.length,
            neon_workspace_records: neonCount.rows?.[0]?.total_properties || 0,
            upserted: propertyRows.length,
            safe_to_rerun: true
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});