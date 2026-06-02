import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const BATCHDATA_API_KEY = Deno.env.get('BATCH_DATA_API_KEY');
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const BATCHDATA_BASE = 'https://api.batchdata.com/api/v1/property/search';
const PIPELINE_LOCK_TTL_MS = 90 * 1000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function claimPipelineLock(base44, jobId, lockedBy) {
    const now = Date.now();
    const existing = await base44.asServiceRole.entities.PipelineLock.filter({ job_id: jobId }, '-created_date', 20).catch(() => []);
    const locks = Array.isArray(existing) ? existing : (existing?.items || []);

    for (const lock of locks) {
        const lockedAtMs = new Date(lock.locked_at || lock.created_date).getTime();
        if (!lockedAtMs || now - lockedAtMs > PIPELINE_LOCK_TTL_MS) {
            await base44.asServiceRole.entities.PipelineLock.delete(lock.id).catch(() => {});
        }
    }

    const active = locks.filter(lock => {
        const lockedAtMs = new Date(lock.locked_at || lock.created_date).getTime();
        return lockedAtMs && now - lockedAtMs <= PIPELINE_LOCK_TTL_MS;
    });
    if (active.length > 0) return { claimed: false, reason: 'active_lock', lockedBy: active[0]?.locked_by };

    const created = await base44.asServiceRole.entities.PipelineLock.create({
        job_id: jobId,
        locked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + PIPELINE_LOCK_TTL_MS).toISOString(),
        locked_by: lockedBy
    });
    return { claimed: true, lockId: created.id };
}

async function releasePipelineLock(base44, lockId) {
    if (lockId) await base44.asServiceRole.entities.PipelineLock.delete(lockId).catch(() => {});
}

function normalizeAddress(address) {
    return String(address || '')
        .toUpperCase()
        .trim()
        .replace(/[.,#]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\bSTREET\b/g, 'ST')
        .replace(/\bAVENUE\b/g, 'AVE')
        .replace(/\bBOULEVARD\b/g, 'BLVD')
        .replace(/\bDRIVE\b/g, 'DR')
        .replace(/\bLANE\b/g, 'LN')
        .replace(/\bROAD\b/g, 'RD')
        .replace(/\bCOURT\b/g, 'CT')
        .replace(/\bCIRCLE\b/g, 'CIR')
        .replace(/\bPLACE\b/g, 'PL')
        .replace(/\bTERRACE\b/g, 'TER')
        .replace(/\bPARKWAY\b/g, 'PKWY')
        .replace(/\bHIGHWAY\b/g, 'HWY');
}

function addressHash(addressLine, zipCode) {
    return `${normalizeAddress(addressLine)}|${String(zipCode || '00000').slice(0, 5)}`;
}

function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && value !== '');
}

function isPointInPolygon(point, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return true;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = Number(polygon[i].lng), yi = Number(polygon[i].lat);
        const xj = Number(polygon[j].lng), yj = Number(polygon[j].lat);
        const intersects = ((yi > point.lat) !== (yj > point.lat)) &&
            (point.lng < (xj - xi) * (point.lat - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function normalizeBatchDataAddress(record) {
    const address = record.address || record.propertyAddress || record.situsAddress || {};
    const street = firstValue(address.street, address.streetAddress, address.addressLine1, record.addressLine1, record.formattedAddress?.split?.(',')?.[0]);
    return {
        street: street || '',
        city: firstValue(address.city, record.city) || '',
        state: firstValue(address.state, record.state) || '',
        zip: String(firstValue(address.zip, address.zipCode, record.zipCode, '') || '').slice(0, 5),
        lat: Number(firstValue(address.latitude, address.lat, record.latitude)),
        lng: Number(firstValue(address.longitude, address.lng, record.longitude))
    };
}

function mapBatchDataProperty(record, job) {
    const p = record.property || record;
    const address = normalizeBatchDataAddress(p);
    if (!address.street || !address.zip || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) return null;
    if (!isPointInPolygon({ lat: address.lat, lng: address.lng }, job.polygon || [])) return null;

    const owner = p.owner || {};
    const listing = p.listing || {};
    const building = p.building || p.structure || {};
    const sale = p.sale || p.lastSale || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const ids = p.ids || p.identifiers || {};
    const quickLists = p.quickLists || {};
    const listingStatus = firstValue(listing.status, listing.statusCategory);
    const listingStatusLower = String(listingStatus || '').toLowerCase();
    const saleDate = firstValue(lastSale.recordingDate, lastSale.saleDate, lastSale.date, p.lastSaleDate);
    const saleDateMs = saleDate ? new Date(saleDate).getTime() : 0;
    const soldMonths = Number(job.sold_months || 12);
    const cutoffMs = Date.now() - soldMonths * 30 * 24 * 60 * 60 * 1000;
    const ownerName = firstValue(owner.fullName, owner.name, owner.names?.[0]?.full, owner.names?.[0]);
    const price = Number(firstValue(lastSale.price, lastSale.salePrice, p.lastSalePrice, listing.price));
    const propertyType = firstValue(p.propertyType, p.landUse, building.propertyType) || 'Single Family';
    const badType = /commercial|industrial|vacant|agricultural|land/i.test(String(propertyType));
    const rejected =
        !saleDateMs || saleDateMs < cutoffMs ||
        listingStatusLower === 'active' || listingStatusLower === 'for sale' ||
        owner.ownerOccupied === false || quickLists.corporateOwned === true || quickLists.investorOwned === true || badType;

    const match = address.street.match(/^(\d+)\s+(.*)$/);
    const houseNumber = match ? parseInt(match[1], 10) : 0;
    const streetName = match ? match[2] : address.street;

    return {
        address_hash: addressHash(address.street, address.zip),
        legacy_hash: firstValue(ids.addressHash, ids.propertyId, p.id, p._id) || null,
        house_number: houseNumber,
        street_name: streetName,
        full_address: [address.street, address.city, address.state, address.zip].filter(Boolean).join(', '),
        city: address.city,
        state: address.state,
        zip_code: address.zip,
        lat: address.lat,
        lng: address.lng,
        owner_full_name: ownerName || null,
        beds: Number(firstValue(building.bedrooms, p.bedrooms)) || null,
        baths: Number(firstValue(building.bathrooms, p.bathrooms)) || null,
        sqft: Number(firstValue(building.livingArea, building.squareFeet, p.squareFootage)) || null,
        lot_size: Number(firstValue(p.lot?.size, p.lotSize)) || null,
        year_built: Number(firstValue(building.yearBuilt, p.yearBuilt)) || null,
        price: Number.isFinite(price) ? price : null,
        sold_date: saleDate || null,
        sale_type: 'BatchData',
        property_type: propertyType,
        data_source: 'batchdata',
        sale_confidence: rejected ? 'REJECTED' : 'verified',
        original_status: rejected ? 'REJECTED' : 'DEED_CONFIRMED',
        route_active: !rejected,
        raw_payload: JSON.stringify(p)
    };
}

function toNullableDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date.toISOString();
}

async function writePropertiesToNeon(sql, properties, job) {
    let inserted = 0, existed = 0, updated = 0;

    for (const p of properties) {
        const existingRows = await sql`
            SELECT id, sold_date, sale_confidence, original_status
            FROM properties
            WHERE address_hash = ${p.address_hash}
            LIMIT 1
        `;
        const soldDate = toNullableDate(p.sold_date);
        const rawPayload = p.raw_payload || JSON.stringify(p);

        if (existingRows.length === 0) {
            const created = await sql`
                INSERT INTO properties (
                    address_hash, legacy_hash, full_address, house_number, street_name, city, state, zip_code,
                    lat, lng, owner_full_name, beds, baths, sqft, lot_size, year_built, price,
                    sold_date, sale_type, property_type, data_source, sale_confidence, original_status, raw_payload, updated_at
                ) VALUES (
                    ${p.address_hash}, ${p.legacy_hash}, ${p.full_address}, ${p.house_number || null}, ${p.street_name || null},
                    ${p.city || null}, ${p.state || null}, ${p.zip_code || null}, ${p.lat}, ${p.lng}, ${p.owner_full_name || null},
                    ${p.beds || null}, ${p.baths || null}, ${p.sqft || null}, ${p.lot_size || null}, ${p.year_built || null},
                    ${p.price || null}, ${soldDate}, ${p.sale_type}, ${p.property_type}, ${p.data_source}, ${p.sale_confidence},
                    ${p.original_status}, ${rawPayload}, NOW()
                ) RETURNING id
            `;
            await sql`
                INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
                VALUES (${created[0].id}, ${job.user_email || 'unknown'}, ${job.id}, ${p.route_active !== false}, ${p.original_status}, NOW())
                ON CONFLICT (property_id, user_email)
                DO UPDATE SET fetch_job_id = EXCLUDED.fetch_job_id, route_active = EXCLUDED.route_active, status = EXCLUDED.status, updated_at = NOW()
            `;
            inserted++;
            continue;
        }

        const existing = existingRows[0];
        existed++;
        const existingDate = existing.sold_date ? new Date(existing.sold_date).getTime() : 0;
        const incomingDate = soldDate ? new Date(soldDate).getTime() : 0;
        const shouldUpdate = incomingDate > existingDate || p.sale_confidence !== existing.sale_confidence || p.original_status !== existing.original_status;

        if (shouldUpdate) {
            await sql`
                UPDATE properties SET
                    legacy_hash = COALESCE(${p.legacy_hash}, legacy_hash), full_address = COALESCE(${p.full_address}, full_address),
                    house_number = COALESCE(${p.house_number || null}, house_number), street_name = COALESCE(${p.street_name || null}, street_name),
                    city = COALESCE(${p.city || null}, city), state = COALESCE(${p.state || null}, state), zip_code = COALESCE(${p.zip_code || null}, zip_code),
                    lat = COALESCE(${p.lat}, lat), lng = COALESCE(${p.lng}, lng), owner_full_name = COALESCE(${p.owner_full_name || null}, owner_full_name),
                    beds = COALESCE(${p.beds || null}, beds), baths = COALESCE(${p.baths || null}, baths), sqft = COALESCE(${p.sqft || null}, sqft),
                    lot_size = COALESCE(${p.lot_size || null}, lot_size), year_built = COALESCE(${p.year_built || null}, year_built), price = COALESCE(${p.price || null}, price),
                    sold_date = COALESCE(${soldDate}, sold_date), sale_type = COALESCE(${p.sale_type}, sale_type), property_type = COALESCE(${p.property_type}, property_type),
                    data_source = ${p.data_source}, sale_confidence = ${p.sale_confidence}, original_status = ${p.original_status}, raw_payload = ${rawPayload}, updated_at = NOW()
                WHERE id = ${existing.id}
            `;
            updated++;
        }

        await sql`
            INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
            VALUES (${existing.id}, ${job.user_email || 'unknown'}, ${job.id}, ${p.route_active !== false}, ${p.original_status}, NOW())
            ON CONFLICT (property_id, user_email)
            DO UPDATE SET fetch_job_id = EXCLUDED.fetch_job_id, route_active = EXCLUDED.route_active, status = EXCLUDED.status, updated_at = NOW()
        `;
    }

    if (properties.length > 0) {
        await sql`
            INSERT INTO ingestion_metrics (fetch_job_id, user_email, records_inserted, records_updated, records_skipped)
            VALUES (${job.id}, ${job.user_email || 'unknown'}, ${inserted}, ${updated}, ${existed})
        `.catch(() => {});
    }

    return { inserted, existed, updated };
}

async function fetchBatchDataRecords(job) {
    const requested = Math.min(Math.max(Number(job.estimated_record_count || job.total_expected || 1000), 1), 1000);
    const criteria = job.fips_code ? { countyFipsCode: job.fips_code } : { query: `${job.latitude},${job.longitude}` };
    const response = await fetch(BATCHDATA_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCHDATA_API_KEY}` },
        body: JSON.stringify({
            searchCriteria: criteria,
            options: { datasets: ['basic', 'listing', 'deed', 'owner'], limit: requested }
        })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`BatchData request failed (${response.status}): ${text.slice(0, 300)}`);
    const payload = text ? JSON.parse(text) : {};
    const records = payload?.results?.properties || payload?.properties || payload?.results || [];
    return Array.isArray(records) ? records : [records].filter(Boolean);
}

Deno.serve(async (req) => {
    let base44 = null;
    let lockId = null;
    try {
        base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));

        if (body.self_test === true) {
            return Response.json({ success: true, active_provider: 'batchdata', rentcast_active: false, has_batchdata_key: !!BATCHDATA_API_KEY, has_database_url: !!DATABASE_URL });
        }

        if (!BATCHDATA_API_KEY) throw new Error('BATCH_DATA_API_KEY is not configured');
        if (!DATABASE_URL) throw new Error('DATABASE_URL is not configured');

        const running = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
        const runningArr = Array.isArray(running) ? running : (running?.items || []);
        let job = runningArr[0];
        if (!job) {
            const pending = await base44.asServiceRole.entities.FetchJob.filter({ status: 'pending' }, 'created_date', 1);
            const pendingArr = Array.isArray(pending) ? pending : (pending?.items || []);
            job = pendingArr[0];
        }
        if (!job) return Response.json({ idle: true, active_provider: 'batchdata' });
        if (job.status === 'cancelled') return Response.json({ status: 'cancelled', job_id: job.id });

        const expectedChunk = body.expected_chunk ?? null;
        if (expectedChunk !== null && (job.chunk_number || 0) !== expectedChunk) {
            return Response.json({ skipped: true, reason: 'duplicate_invocation', job_id: job.id });
        }

        const claim = await claimPipelineLock(base44, job.id, crypto.randomUUID());
        if (!claim.claimed) return Response.json({ skipped: true, reason: claim.reason, job_id: job.id });
        lockId = claim.lockId;

        const startedAt = job.started_at || new Date().toISOString();
        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'running',
            started_at: startedAt,
            provider: 'batchdata',
            mode_tag: 'PRECISION_TARGET',
            phase: 'batchdata_precision',
            progress_pct: Math.max(job.progress_pct || 0, 5)
        });

        const sql = neon(DATABASE_URL);
        const rawRecords = Array.isArray(body.synthetic_records) ? body.synthetic_records : await fetchBatchDataRecords(job);
        const seen = new Set();
        const mapped = [];
        let rejected = 0;
        let outsideOrInvalid = 0;
        const zipCodes = [...(job.zip_codes_found || [])];

        for (const raw of rawRecords) {
            const property = mapBatchDataProperty(raw, job);
            if (!property) { outsideOrInvalid++; continue; }
            if (seen.has(property.address_hash)) continue;
            seen.add(property.address_hash);
            if (property.zip_code && !zipCodes.includes(property.zip_code)) zipCodes.push(property.zip_code);
            if (property.route_active === false) rejected++;
            mapped.push(property);
        }

        const result = await writePropertiesToNeon(sql, mapped, job);
        const completedAt = new Date().toISOString();
        const activeCount = mapped.filter(p => p.route_active !== false).length;
        const errorLog = [...(job.error_log || []), `[${completedAt}] BatchData-only Precision complete: raw=${rawRecords.length}, mapped=${mapped.length}, active=${activeCount}, rejected=${rejected}, outside_or_invalid=${outsideOrInvalid}`];

        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'completed',
            phase: 'complete',
            progress_pct: 100,
            completed_at: completedAt,
            total_fetched: rawRecords.length,
            total_inserted: result.inserted,
            total_existed: result.existed,
            total_updated: result.updated,
            total_api_calls: (job.total_api_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : 1),
            total_batchdata_calls: (job.total_batchdata_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : 1),
            completed_sub_circles: 1,
            total_sub_circles: 1,
            zip_codes_found: zipCodes,
            chunk_number: (job.chunk_number || 0) + 1,
            chunk_timings: [...(job.chunk_timings || []), Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)],
            error_log: errorLog
        });

        const users = await base44.asServiceRole.entities.User.filter({ email: job.user_email }, null, 1).catch(() => []);
        const userArr = Array.isArray(users) ? users : (users?.items || []);
        if (userArr[0]) {
            await base44.asServiceRole.entities.User.update(userArr[0].id, {
                has_pulled_data: true,
                last_data_pull: completedAt,
                territory_property_count: result.inserted + result.existed
            }).catch(() => {});
        }

        await releasePipelineLock(base44, lockId);
        lockId = null;
        await sleep(10);
        return Response.json({ success: true, status: 'completed', job_id: job.id, active_provider: 'batchdata', raw: rawRecords.length, mapped: mapped.length, active: activeCount });
    } catch (error) {
        if (base44 && lockId) await releasePipelineLock(base44, lockId);
        console.error('[processFetchChunk batchdata-only] Fatal:', error.message);
        try {
            const recovery = base44 || createClientFromRequest(req);
            const running = await recovery.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
            const arr = Array.isArray(running) ? running : (running?.items || []);
            if (arr[0]) {
                await recovery.asServiceRole.entities.FetchJob.update(arr[0].id, {
                    status: 'failed',
                    error_message: `BatchData processing failed: ${error.message}`,
                    error_log: [...(arr[0].error_log || []), `[${new Date().toISOString()}] FATAL: ${error.message}`]
                });
            }
        } catch {}
        return Response.json({ error: error.message }, { status: 500 });
    }
});