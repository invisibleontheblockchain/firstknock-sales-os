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

function numberValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = numberValue(value.amount, value.value, value.estimatedValue, value.total, value.number, value.raw);
            if (nested !== null) return nested;
            continue;
        }
        const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function dateValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = dateValue(value.date, value.value, value.recordingDate, value.saleDate);
            if (nested) return nested;
            continue;
        }
        return value;
    }
    return null;
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

function closePolygon(points) {
    const polygon = Array.isArray(points) ? points
        .map(point => ({ latitude: Number(point.lat ?? point.latitude), longitude: Number(point.lng ?? point.longitude) }))
        .filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) : [];
    if (polygon.length < 3) throw new Error(`Invalid polygon: minimum 3 distinct points required. Received ${polygon.length} distinct points.`);
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    if (first.latitude !== last.latitude || first.longitude !== last.longitude) {
        polygon.push({ ...first });
    }
    const distinct = new Set(polygon.slice(0, -1).map(point => `${point.latitude.toFixed(7)},${point.longitude.toFixed(7)}`));
    if (distinct.size < 3) throw new Error(`Invalid polygon: minimum 3 distinct points required. Received ${distinct.size} distinct points.`);
    return polygon;
}

function soldWindowDays(soldMonths) {
    const months = Number(soldMonths || 1);
    if (months === 0.25) return 7;
    if (months === 0.5) return 14;
    if (months === 1) return 30;
    if (months === 3) return 90;
    if (months === 6) return 180;
    if (months === 9) return 270;
    if (months === 12) return 365;
    return Math.max(1, Math.round(months * 30));
}

function isoDateDaysAgo(days) {
    const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

function buildBatchDataRequest(job, skip = 0, take = 500, mode = 'strict_polygon') {
    const filters = job.dry_run_metadata?.filters || {};
    const minPriceRaw = Number(filters.min_price);
    const maxPriceRaw = Number(filters.max_price);
    const minPrice = Number.isFinite(minPriceRaw) && minPriceRaw > 0 ? minPriceRaw : 100000;
    const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : null;
    const estimatedValue = { min: minPrice };
    if (maxPrice) estimatedValue.max = maxPrice;

    // Always compute the sold window date filter — applied to ALL modes
    const soldMinDate = isoDateDaysAgo(soldWindowDays(job.sold_months || 12));

    const options = {
        skip,
        take: Math.min(Math.max(Number(take) || 500, 1), 500),
        datasets: ['basic', 'listing', 'deed', 'owner']
    };

    if (mode === 'centroid_fallback') {
        return {
            searchCriteria: {
                query: `${job.latitude},${job.longitude}`,
                intel: { lastSoldDate: { minDate: soldMinDate } }
            },
            options
        };
    }

    const searchCriteria = {
        address: {
            geoLocationPolygon: {
                geoPoints: closePolygon(job.polygon || [])
            }
        },
        intel: { lastSoldDate: { minDate: soldMinDate } }
    };

    if (mode === 'strict_polygon') {
        searchCriteria.general = { standardizedLandUseCode: { equals: 'R2' } };
        searchCriteria.valuation = { estimatedValue };
    }

    return { searchCriteria, options };
}

function extractBatchDataRecords(payload) {
    const batch = payload?.results?.properties || payload?.properties || payload?.results || [];
    return Array.isArray(batch) ? batch : [batch].filter(Boolean);
}

function extractBatchDataTotal(payload) {
    return Number(payload?.results?.totalRecordCount ?? payload?.totalRecordCount ?? payload?.meta?.totalRecordCount ?? 0) || null;
}

function normalizeBatchDataAddress(record) {
    const address = record.address || record.propertyAddress || record.situsAddress || {};
    const location = address.location || {};
    const formattedStreet = typeof record.formattedAddress === 'string' ? record.formattedAddress.split(',')[0] : '';
    const street = firstValue(address.street, address.streetAddress, address.addressLine1, record.addressLine1, formattedStreet);
    return {
        street: street || '',
        city: firstValue(address.city, record.city) || '',
        state: firstValue(address.state, record.state) || '',
        zip: String(firstValue(address.zip, address.zipCode, record.zipCode, '') || '').slice(0, 5),
        lat: Number(firstValue(location.latitude, address.latitude, address.lat, record.latitude, record.lat)),
        lng: Number(firstValue(location.longitude, address.longitude, address.lng, record.longitude, record.lng))
    };
}

function mapBatchDataProperty(record, job) {
    const p = record.property || record;
    const address = normalizeBatchDataAddress(p);
    if (!address.street || !address.zip || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) return null;
    if (!isPointInPolygon({ lat: address.lat, lng: address.lng }, job.polygon || [])) return null;

    const owner = p.owner || {};
    const listing = p.listing || {};
    const intel = p.intel || {};
    const building = p.building || p.structure || p.propertyInfo || p.assessment?.building || p.assessor?.building || {};
    const sale = p.sale || p.lastSale || p.deed?.sale || p.transaction || {};
    const lastSale = sale.lastSale || sale.lastTransfer || sale;
    const valuation = p.valuation || p.avm || p.estimatedValue || p.assessment?.valuation || p.assessor?.valuation || {};
    const general = p.general || p.property || p.propertyInfo || {};
    const ids = p.ids || p.identifiers || {};
    const listingStatus = firstValue(listing.status, listing.statusCategory);
    const listingStatusLower = String(listingStatus || '').toLowerCase();
    const saleDate = dateValue(
        p.listing?.soldDate,
        p.deedHistory?.[0]?.saleDate,
        intel.lastSoldDate,
        intel.lastSaleDate,
        intel.lastTransferDate,
        sale?.lastSaleDate,
        sale?.recordingDate,
        sale?.saleDate,
        sale?.date,
        lastSale?.recordingDate,
        lastSale?.saleDate,
        lastSale?.date,
        p.lastSaleDate
    );
    const saleDateMs = saleDate ? new Date(saleDate).getTime() : 0;
    const hasValidSaleDate = saleDateMs > 0 && !Number.isNaN(saleDateMs);
    const cutoffMs = Date.now() - soldWindowDays(job.sold_months || 12) * 24 * 60 * 60 * 1000;
    const ownerName = firstValue(owner.fullName, owner.name, owner.ownerName, owner.names?.[0]?.full, owner.names?.[0]?.name, owner.names?.[0]);
    const saleAmount = numberValue(
        intel.lastSoldPrice,
        intel.lastSalePrice,
        intel.lastTransferPrice,
        sale?.amount,
        sale?.price,
        sale?.salePrice,
        lastSale?.amount,
        lastSale?.price,
        lastSale?.salePrice,
        p.lastSalePrice
    );
    const estimatedValue = numberValue(
        intel.estimatedValue, intel.estimatedMarketValue, intel.totalMarketValue, intel.propertyValue, intel.estValue,
        intel.avm, intel.avmValue, intel.value, intel.amount,
        valuation.estimatedValue, valuation.value, valuation.avm, valuation.avmValue, valuation.amount,
        p.estimatedValue, p.estimated_value, p.avm, p.avmValue, p.assessedValue,
        listing.price, listing.listPrice
    );
    const price = estimatedValue ?? saleAmount;
    const landUseCode = firstValue(general.standardizedLandUseCode, p.standardizedLandUseCode);
    const propertyType = firstValue(general.propertyTypeDetail, general.propertyType, p.propertyType, p.landUse, building.propertyType) || 'Single Family';
    const nonResidential = /commercial|industrial|vacant|agricultural|land/i.test(String(propertyType));
    const landUseRejected = landUseCode && landUseCode !== 'R2';

    // ── Confirmed-sale gate ──────────────────────────────────────────────
    // A property is only a confirmed sale if it has POSITIVE evidence:
    //   1. Listing status explicitly says Sold / Closed / Settled, OR
    //   2. There is a real sale amount (deed recorded with money changing hands)
    // Off-market properties with just a date but no sale evidence are rejected.
    const isSoldStatus = ['sold', 'closed', 'settled'].includes(listingStatusLower);
    const hasSaleEvidence = saleAmount !== null && saleAmount > 0;
    const isConfirmedSale = hasValidSaleDate && saleDateMs >= cutoffMs && (isSoldStatus || hasSaleEvidence);
    const rejected = !isConfirmedSale || landUseRejected || nonResidential || listingStatusLower === 'active' || listingStatusLower === 'for sale';

    const match = address.street.match(/^(\d+)\s+(.*)$/);
    const houseNumber = match ? parseInt(match[1], 10) : 0;
    const streetName = match ? match[2] : address.street;

    return {
        address_hash: addressHash(address.street, address.zip),
        legacy_hash: firstValue(ids.propertyId, ids.id, p.id, p.propertyId) || null,
        house_number: houseNumber,
        street_name: streetName,
        full_address: [address.street, address.city, address.state, address.zip].filter(Boolean).join(', '),
        city: address.city,
        state: address.state,
        zip_code: address.zip,
        lat: address.lat,
        lng: address.lng,
        owner_full_name: ownerName || null,
        beds: numberValue(building.bedroomCount, building.bedrooms, building.beds, building.rooms?.beds, p.bedrooms, p.beds),
        baths: numberValue(building.bathroomCount, building.bathrooms, building.baths, building.rooms?.baths, p.bathrooms, p.baths),
        sqft: numberValue(
            intel.livingAreaSquareFeet, intel.totalBuildingAreaSquareFeet, intel.buildingSquareFeet, intel.squareFeet,
            intel.sqft, intel.livingArea, intel.buildingSqft,
            building.livingAreaSquareFeet, building.livingArea, building.squareFeet,
            building.totalBuildingAreaSquareFeet, building.totalAreaSqFt, building.area,
            p.squareFootage, p.sqft, p.livingAreaSquareFeet
        ),
        lot_size: numberValue(p.lot?.size, p.lot?.lotSizeSquareFeet, p.lotSize, p.lot_size, p.lotSizeSquareFeet),
        year_built: numberValue(intel.yearBuilt, intel.effectiveYearBuilt, intel.buildYear, intel.year_built, building.yearBuilt, building.effectiveYearBuilt, p.yearBuilt, p.year_built),
        price: price ?? null,
        sold_date: saleDate || null,
        sale_type: 'BatchData',
        property_type: propertyType,
        data_source: 'batchdata',
        sale_confidence: rejected ? 'REJECTED' : 'verified',
        original_status: rejected ? 'REJECTED' : 'BATCHDATA_CONFIRMED',
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
            SELECT id, sold_date, sale_confidence, original_status, owner_full_name, beds, baths, sqft, lot_size, year_built, price
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
        const hasNewMetadata =
            (!existing.owner_full_name && p.owner_full_name) ||
            (!existing.beds && p.beds) ||
            (!existing.baths && p.baths) ||
            (!existing.sqft && p.sqft) ||
            (!existing.lot_size && p.lot_size) ||
            (!existing.year_built && p.year_built) ||
            (!existing.price && p.price);
        const shouldUpdate = incomingDate > existingDate || hasNewMetadata || p.sale_confidence !== existing.sale_confidence || p.original_status !== existing.original_status;

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

async function batchDataFetchWithRetry(requestBody) {
    for (let attempt = 1; attempt <= 4; attempt++) {
        const response = await fetch(BATCHDATA_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCHDATA_API_KEY}` },
            body: JSON.stringify(requestBody)
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw_text: text.slice(0, 1000) }; }

        if (response.ok) return payload;
        if (response.status === 401) throw new Error('Authentication failed. Verify the BatchData API token is correct and active.');
        if (response.status === 400) throw new Error(`BatchData rejected the polygon search request: ${text.slice(0, 1000)}`);
        if (response.status === 429 && attempt < 4) {
            await sleep(2 ** attempt * 1000);
            continue;
        }
        if ((response.status === 500 || response.status === 503) && attempt < 2) {
            await sleep(5000);
            continue;
        }
        throw new Error(`BatchData request failed (${response.status}): ${text.slice(0, 1000)}`);
    }
    throw new Error('Rate limit exceeded after 3 retries.');
}

async function fetchBatchDataRecordsForMode(job, mode, requested) {
    const records = [];
    let skip = 0;
    let totalRecordCount = null;

    while (records.length < requested) {
        const take = Math.min(500, requested - records.length);
        const requestBody = buildBatchDataRequest(job, skip, take, mode);
        const payload = await batchDataFetchWithRetry(requestBody);
        const list = extractBatchDataRecords(payload);
        if (totalRecordCount === null) totalRecordCount = extractBatchDataTotal(payload);
        records.push(...list);
        if (list.length < take) break;
        if (totalRecordCount !== null && records.length >= totalRecordCount) break;
        skip += take;
    }

    return records.slice(0, requested);
}

async function fetchBatchDataRecords(job) {
    const requested = Math.min(Math.max(Number(job.estimated_record_count || job.total_expected || 1000), 1), 1000);
    const modes = ['strict_polygon', 'broad_polygon', 'centroid_fallback'];
    const attempts = [];

    for (const mode of modes) {
        const records = await fetchBatchDataRecordsForMode(job, mode, requested);
        attempts.push({ mode, count: records.length });
        if (records.length > 0) return { records, attempts, mode_used: mode };
    }

    return { records: [], attempts, mode_used: 'none' };
}

Deno.serve(async (req) => {
    let base44 = null;
    let lockId = null;
    try {
        base44 = createClientFromRequest(req);
        const body = await req.json().catch(() => ({}));

        if (body.self_test === true) {
            return Response.json({ success: true, active_provider: 'batchdata', rentcast_active: false, batchdata_polygon_search: true, datasets: ['basic', 'listing', 'deed', 'owner'], has_batchdata_key: !!BATCHDATA_API_KEY, has_database_url: !!DATABASE_URL });
        }

        if (body.request_preview === true) {
            const previewJob = body.job || {
                polygon: body.polygon || [
                    { lat: 33.4622, lng: -112.1866 },
                    { lat: 33.3493, lng: -112.1915 },
                    { lat: 33.2931, lng: -112.1338 }
                ],
                latitude: body.latitude || 33.37,
                longitude: body.longitude || -112.08,
                sold_months: body.sold_months || 12,
                dry_run_metadata: { filters: { min_price: body.min_price ?? 100000, max_price: body.max_price ?? null } }
            };
            return Response.json({
                success: true,
                requests: {
                    strict_polygon: buildBatchDataRequest(previewJob, 0, 500, 'strict_polygon'),
                    broad_polygon: buildBatchDataRequest(previewJob, 0, 500, 'broad_polygon'),
                    centroid_fallback: buildBatchDataRequest(previewJob, 0, 500, 'centroid_fallback')
                }
            });
        }

        if (body.map_preview === true) {
            const previewJob = body.job || {
                polygon: body.polygon || [],
                sold_months: body.sold_months || 12,
                dry_run_metadata: { filters: { min_price: body.min_price ?? 100000, max_price: body.max_price ?? null } }
            };
            const records = Array.isArray(body.synthetic_records) ? body.synthetic_records : [];
            const mapped = records.map(record => mapBatchDataProperty(record, previewJob)).filter(Boolean);
            return Response.json({ success: true, raw: records.length, mapped: mapped.length, active: mapped.filter(p => p.route_active !== false).length, properties: mapped });
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
        const batchFetch = Array.isArray(body.synthetic_records)
            ? { records: body.synthetic_records, attempts: [{ mode: 'synthetic_records', count: body.synthetic_records.length }], mode_used: 'synthetic_records' }
            : await fetchBatchDataRecords(job);
        const rawRecords = batchFetch.records;
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
        const errorLog = [...(job.error_log || []), `[${completedAt}] BatchData-only Precision complete: mode=${batchFetch.mode_used}, attempts=${JSON.stringify(batchFetch.attempts)}, raw=${rawRecords.length}, mapped=${mapped.length}, active=${activeCount}, rejected=${rejected}, outside_or_invalid=${outsideOrInvalid}`];

        await base44.asServiceRole.entities.FetchJob.update(job.id, {
            status: 'completed',
            phase: 'complete',
            progress_pct: 100,
            completed_at: completedAt,
            total_fetched: rawRecords.length,
            total_inserted: result.inserted,
            total_existed: result.existed,
            total_updated: result.updated,
            total_api_calls: (job.total_api_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : batchFetch.attempts.length),
            total_batchdata_calls: (job.total_batchdata_calls || 0) + (Array.isArray(body.synthetic_records) ? 0 : batchFetch.attempts.length),
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
        return Response.json({ success: true, status: 'completed', job_id: job.id, active_provider: 'batchdata', mode_used: batchFetch.mode_used, attempts: batchFetch.attempts, raw: rawRecords.length, mapped: mapped.length, active: activeCount });
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