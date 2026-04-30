import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

function valueOrNull(value) {
    return value === undefined || value === '' ? null : value;
}

async function upsertProperty(sql, property, workspaceEmail) {
    const existingRows = await sql`
        SELECT id, sold_date, sale_confidence, original_status
        FROM properties
        WHERE address_hash = ${property.address_hash}
        LIMIT 1
    `;

    const soldDate = toNullableDate(property.sold_date);
    const rawPayload = JSON.stringify(property);
    const fullAddress = property.full_address || `${property.house_number || ''} ${property.street_name || ''}`.trim();

    if (existingRows.length === 0) {
        const inserted = await sql`
            INSERT INTO properties (
                address_hash, legacy_hash, full_address, house_number, street_name, city, state, zip_code,
                lat, lng, h3_index, owner_full_name, beds, baths, sqft, lot_size, year_built, price,
                sold_date, sale_type, property_type, mls_id, url, data_source, sale_confidence,
                original_status, raw_payload, updated_at
            ) VALUES (
                ${property.address_hash}, ${valueOrNull(property.legacy_hash)}, ${valueOrNull(fullAddress)},
                ${valueOrNull(property.house_number)}, ${valueOrNull(property.street_name)}, ${valueOrNull(property.city)}, ${valueOrNull(property.state)}, ${valueOrNull(property.zip_code)},
                ${valueOrNull(property.lat)}, ${valueOrNull(property.lng)}, ${valueOrNull(property.h3_index)}, ${valueOrNull(property.owner_full_name)}, ${valueOrNull(property.beds)},
                ${valueOrNull(property.baths)}, ${valueOrNull(property.sqft)}, ${valueOrNull(property.lot_size)}, ${valueOrNull(property.year_built)}, ${valueOrNull(property.price)},
                ${soldDate}, ${valueOrNull(property.sale_type)}, ${valueOrNull(property.property_type)}, ${valueOrNull(property.mls_id)}, ${valueOrNull(property.url)},
                ${valueOrNull(property.data_source)}, ${valueOrNull(property.sale_confidence)}, ${valueOrNull(property.original_status)}, ${rawPayload}, NOW()
            )
            RETURNING id
        `;

        await sql`
            INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
            VALUES (${inserted[0].id}, ${workspaceEmail}, 'base44_backfill', ${property.route_active !== false}, ${valueOrNull(property.original_status)}, NOW())
            ON CONFLICT (property_id, user_email)
            DO UPDATE SET route_active = EXCLUDED.route_active, status = EXCLUDED.status, updated_at = NOW()
        `;

        return 'inserted';
    }

    const existing = existingRows[0];
    const existingSaleDate = existing.sold_date ? new Date(existing.sold_date) : new Date(0);
    const incomingSaleDate = soldDate ? new Date(soldDate) : new Date(0);
    const statusChanged = property.sale_confidence !== existing.sale_confidence || property.original_status !== existing.original_status;
    const shouldUpdate = incomingSaleDate > existingSaleDate || statusChanged || property.route_active === false;

    if (shouldUpdate) {
        await sql`
            UPDATE properties SET
                legacy_hash = COALESCE(${valueOrNull(property.legacy_hash)}, legacy_hash),
                full_address = COALESCE(${valueOrNull(fullAddress)}, full_address),
                house_number = COALESCE(${valueOrNull(property.house_number)}, house_number),
                street_name = COALESCE(${valueOrNull(property.street_name)}, street_name),
                city = COALESCE(${valueOrNull(property.city)}, city),
                state = COALESCE(${valueOrNull(property.state)}, state),
                zip_code = COALESCE(${valueOrNull(property.zip_code)}, zip_code),
                lat = COALESCE(${valueOrNull(property.lat)}, lat),
                lng = COALESCE(${valueOrNull(property.lng)}, lng),
                h3_index = COALESCE(${valueOrNull(property.h3_index)}, h3_index),
                owner_full_name = COALESCE(${valueOrNull(property.owner_full_name)}, owner_full_name),
                beds = COALESCE(${valueOrNull(property.beds)}, beds),
                baths = COALESCE(${valueOrNull(property.baths)}, baths),
                sqft = COALESCE(${valueOrNull(property.sqft)}, sqft),
                lot_size = COALESCE(${valueOrNull(property.lot_size)}, lot_size),
                year_built = COALESCE(${valueOrNull(property.year_built)}, year_built),
                price = COALESCE(${valueOrNull(property.price)}, price),
                sold_date = COALESCE(${soldDate}, sold_date),
                sale_type = COALESCE(${valueOrNull(property.sale_type)}, sale_type),
                property_type = COALESCE(${valueOrNull(property.property_type)}, property_type),
                mls_id = COALESCE(${valueOrNull(property.mls_id)}, mls_id),
                url = COALESCE(${valueOrNull(property.url)}, url),
                data_source = COALESCE(${valueOrNull(property.data_source)}, data_source),
                sale_confidence = COALESCE(${valueOrNull(property.sale_confidence)}, sale_confidence),
                original_status = COALESCE(${valueOrNull(property.original_status)}, original_status),
                raw_payload = ${rawPayload},
                updated_at = NOW()
            WHERE id = ${existing.id}
        `;
    }

    await sql`
        INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
        VALUES (${existing.id}, ${workspaceEmail}, 'base44_backfill', ${property.route_active !== false}, ${valueOrNull(property.original_status)}, NOW())
        ON CONFLICT (property_id, user_email)
        DO UPDATE SET route_active = EXCLUDED.route_active, status = EXCLUDED.status, updated_at = NOW()
    `;

    return shouldUpdate ? 'updated' : 'skipped';
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
        const limit = Math.min(Number(body.limit || 10000), 10000);
        const dryRun = body.dry_run === true;

        const base44Properties = await base44.asServiceRole.entities.MasterProperty.list('created_date', limit);
        const properties = Array.isArray(base44Properties) ? base44Properties : (base44Properties?.items || []);

        if (dryRun) {
            return Response.json({
                success: true,
                dry_run: true,
                workspace_user_email: workspaceEmail,
                base44_records_found: properties.length,
                message: 'Dry run complete. No Neon records were changed.'
            });
        }

        const sql = neon(databaseUrl);
        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        let invalid = 0;

        for (const property of properties) {
            if (!property.address_hash) {
                invalid++;
                continue;
            }

            const result = await upsertProperty(sql, property, workspaceEmail);
            if (result === 'inserted') inserted++;
            if (result === 'updated') updated++;
            if (result === 'skipped') skipped++;
        }

        await sql`
            INSERT INTO ingestion_metrics (fetch_job_id, user_email, records_fetched, records_inserted, records_updated, records_skipped)
            VALUES ('base44_backfill', ${workspaceEmail}, ${properties.length}, ${inserted}, ${updated}, ${skipped + invalid})
        `;

        const neonCount = await sql`
            SELECT COUNT(*)::int AS total_properties
            FROM workspace_properties
            WHERE user_email = ${workspaceEmail}
        `;

        return Response.json({
            success: true,
            workspace_user_email: workspaceEmail,
            base44_records_read: properties.length,
            neon_workspace_records: neonCount[0]?.total_properties || 0,
            inserted,
            updated,
            skipped,
            invalid,
            safe_to_rerun: true
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});