import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { polygonToCells, latLngToCell } from 'npm:h3-js@4.1.0';

// v7 — MLS Sold-Only Architecture: /listings/sale?status=Inactive (confirmed sold homes) is the PRIMARY and DEFAULT endpoint

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

// ── Rate Limiting: Token Bucket with Exponential Backoff + Full Jitter ──
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 16000;

async function fetchWithBackoff(url, headers, logError) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(url, { headers }).catch(e => {
            logError(`Network error (attempt ${attempt + 1}): ${e.message}`);
            return null;
        });

        if (!res) {
            if (attempt < MAX_RETRIES) {
                const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
                const jitter = Math.random() * backoff;
                await sleep(jitter);
                continue;
            }
            return { records: [], total: null, status: 0 };
        }

        if (res.status === 429) {
            logError(`RATE LIMITED (429) — attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
            if (attempt < MAX_RETRIES) {
                const retryAfter = res.headers.get('Retry-After');
                const waitMs = retryAfter 
                    ? parseInt(retryAfter) * 1000 
                    : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt + 1));
                const jitter = Math.random() * waitMs * 0.5;
                console.log(`[backoff] Waiting ${Math.round(waitMs + jitter)}ms before retry`);
                await sleep(waitMs + jitter);
                continue;
            }
            return { records: [], total: null, status: 429 };
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => 'no body');
            logError(`API ${res.status}: ${errText.slice(0, 200)}`);
            if (res.status === 401) return { records: [], total: null, status: 401 };
            if (res.status >= 500 && attempt < MAX_RETRIES) {
                const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
                await sleep(backoff + Math.random() * backoff);
                continue;
            }
            return { records: [], total: null, status: res.status };
        }

        const total = res.headers.get('X-Total-Count');
        const records = await res.json();
        return { records: Array.isArray(records) ? records : [], total, status: 200 };
    }
    return { records: [], total: null, status: 0 };
}

// ── Address Normalization (lightweight USPS-style) ──
const STREET_ABBREVIATIONS = {
    'STREET': 'ST', 'AVENUE': 'AVE', 'BOULEVARD': 'BLVD', 'DRIVE': 'DR',
    'LANE': 'LN', 'ROAD': 'RD', 'COURT': 'CT', 'CIRCLE': 'CIR',
    'PLACE': 'PL', 'TERRACE': 'TER', 'WAY': 'WAY', 'TRAIL': 'TRL',
    'PARKWAY': 'PKWY', 'HIGHWAY': 'HWY', 'NORTH': 'N', 'SOUTH': 'S',
    'EAST': 'E', 'WEST': 'W', 'NORTHEAST': 'NE', 'NORTHWEST': 'NW',
    'SOUTHEAST': 'SE', 'SOUTHWEST': 'SW', 'APARTMENT': 'APT', 'SUITE': 'STE',
    'UNIT': 'UNIT', 'BUILDING': 'BLDG', 'FLOOR': 'FL'
};

function normalizeAddress(address) {
    if (!address) return '';
    let norm = address.toUpperCase().trim();
    norm = norm.replace(/[.,#]/g, '').replace(/\s+/g, ' ');
    for (const [full, abbr] of Object.entries(STREET_ABBREVIATIONS)) {
        norm = norm.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
    }
    return norm;
}

function generateNormalizedHash(addressLine, zipCode) {
    const normAddr = normalizeAddress(addressLine);
    const normZip = (zipCode || '00000').trim().slice(0, 5);
    return `${normAddr}|${normZip}`;
}

function isPointInPolygon(point, vs) {
    if (!vs || vs.length < 3) return true;
    let x = point.lng, y = point.lat;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].lng, yi = vs[i].lat;
        let xj = vs[j].lng, yj = vs[j].lat;
        let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PAGES_PER_CHUNK = 20;
const LIMIT = 500;
const MAX_PARALLEL = 3;

Deno.serve(async (req) => {
    const chunkStart = Date.now();

    try {
        const base44 = createClientFromRequest(req);

        // Find next job
        let job = null;
        const runningJobs = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
        const runningArr = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        if (runningArr.length > 0) job = runningArr[0];

        if (!job) {
            const pendingJobs = await base44.asServiceRole.entities.FetchJob.filter({ status: 'pending' }, 'created_date', 1);
            const pendingArr = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
            if (pendingArr.length > 0) job = pendingArr[0];
        }

        if (!job) return Response.json({ idle: true, message: 'No active jobs' });

        const jobId = job.id;
        const errorLog = job.error_log || [];
        const chunkTimings = job.chunk_timings || [];
        const isDeltaPull = job.is_delta_pull || false;
        const deltaWatermark = job.delta_watermark || null;

        const logError = (msg) => {
            const entry = `[${new Date().toISOString()}] ${msg}`;
            errorLog.push(entry);
            console.error(entry);
            if (errorLog.length > 50) errorLog.splice(0, errorLog.length - 50);
        };

        if (!RENTCAST_API_KEY) {
            logError('RENTCAST_API_KEY not configured');
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'failed', error_message: 'RENTCAST_API_KEY not configured', error_log: errorLog
            });
            return Response.json({ error: 'No API key' });
        }

        const currentPhase = job.phase || 'mls_listings';
        console.log(`[chunk-v7] Job ${jobId} | phase=${currentPhase} | offset=${job.current_offset} | delta=${isDeltaPull} | chunk#=${job.chunk_number || 0}`);

        const { latitude, longitude, radius, polygon } = job;
        let currentOffset = job.current_offset || 0;
        let totalExpected = job.total_expected || 0;
        let totalFetched = job.total_fetched || 0;
        let totalInserted = job.total_inserted || 0;
        let totalExisted = job.total_existed || 0;
        let totalUpdated = job.total_updated || 0;
        let zipCodesFound = job.zip_codes_found || [];
        let totalApiCalls = job.total_api_calls || 0;
        let mlsFetched = job.mls_fetched || 0;
        let mlsNew = job.mls_new || 0;
        let mlsApiCalls = job.mls_api_calls || 0;

        if (job.status === 'pending') {
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running', started_at: new Date().toISOString()
            });
        }

        // Pre-compute H3 cells for polygon filtering
        let polygonH3Cells = new Set();
        let useH3Filter = false;
        if (polygon && polygon.length >= 3) {
            try {
                const h3Polygon = polygon.map(p => [p.lat, p.lng]);
                if (h3Polygon[0][0] !== h3Polygon[h3Polygon.length - 1][0] || h3Polygon[0][1] !== h3Polygon[h3Polygon.length - 1][1]) {
                    h3Polygon.push([...h3Polygon[0]]);
                }
                const cells = polygonToCells(h3Polygon, 9);
                polygonH3Cells = new Set(cells);
                useH3Filter = cells.length > 0;
            } catch (e) {
                logError(`H3 polygon computation failed: ${e.message}`);
            }
        }

        const monthsBack = job.sold_months || 12;
        const BUFFER_MONTHS = 2;
        const daysBack = (monthsBack + BUFFER_MONTHS) * 30;

        const filterPoint = (lat, lng) => {
            if (!polygon || polygon.length < 3) return true;
            if (useH3Filter) {
                try {
                    const cell = latLngToCell(lat, lng, 9);
                    if (!polygonH3Cells.has(cell)) return false;
                } catch (e) { return false; }
            }
            return isPointInPolygon({ lat, lng }, polygon);
        };

        // Helper: write mapped properties to DB with dedup
        async function writeToDb(mapped) {
            let chunkInserted = 0, chunkExisted = 0, chunkUpdated = 0;
            if (mapped.length === 0) return { chunkInserted, chunkExisted, chunkUpdated };

            const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
            const existingHashToId = new Map();

            for (let i = 0; i < uniqueZips.length; i += 20) {
                if (Date.now() - chunkStart > 50000) break;
                const zipChunk = uniqueZips.slice(i, i + 20);
                const promises = zipChunk.map(zip =>
                    base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                        .then(res => {
                            const arr = Array.isArray(res) ? res : (res?.items || []);
                            arr.forEach(p => existingHashToId.set(p.address_hash, { id: p.id, status: p.original_status, dataSource: p.data_source }));
                        })
                        .catch(e => logError(`DB zip lookup ${zip} failed: ${e.message}`))
                );
                await Promise.all(promises);
            }

            const toInsert = [];
            const toUpdate = [];

            for (const p of mapped) {
                const existing = existingHashToId.get(p.address_hash);
                if (existing) {
                    chunkExisted++;
                    // Update if we have newer/better data
                    if (p.original_status === 'SOLD' && existing.status !== 'SOLD') {
                        toUpdate.push({ id: existing.id, sold_date: p.sold_date, price: p.price, original_status: 'SOLD' });
                    }
                    if (existing.status === 'UNVERIFIED' || existing.dataSource === 'csv_import') {
                        toUpdate.push({
                            id: existing.id, sold_date: p.sold_date, price: p.price,
                            original_status: p.original_status, data_source: 'rentcast',
                            sale_type: p.sale_type, city: p.city, state: p.state,
                            zip_code: p.zip_code, beds: p.beds, baths: p.baths,
                            sqft: p.sqft, lot_size: p.lot_size, year_built: p.year_built,
                            property_type: p.property_type
                        });
                    }
                } else {
                    toInsert.push(p);
                }
            }

            // Bulk insert new records
            for (let i = 0; i < toInsert.length; i += 1000) {
                if (Date.now() - chunkStart > 55000) { logError('Time limit hit during DB writes'); break; }
                const chunk = toInsert.slice(i, i + 1000);
                try {
                    await base44.asServiceRole.entities.MasterProperty.bulkCreate(chunk);
                    chunkInserted += chunk.length;
                } catch (e) {
                    logError(`Bulk insert failed: ${e.message}`);
                    for (let j = 0; j < chunk.length; j += 100) {
                        const small = chunk.slice(j, j + 100);
                        try { await base44.asServiceRole.entities.MasterProperty.bulkCreate(small); chunkInserted += small.length; } catch (e2) { logError(`Small chunk insert failed: ${e2.message}`); }
                        await sleep(200);
                    }
                }
            }

            // Apply updates
            for (let i = 0; i < Math.min(toUpdate.length, 100); i++) {
                if (Date.now() - chunkStart > 58000) break;
                try {
                    const upd = toUpdate[i];
                    const { id, ...updatePayload } = upd;
                    await base44.asServiceRole.entities.MasterProperty.update(id, updatePayload);
                    chunkUpdated++;
                } catch (e) { /* skip */ }
            }

            return { chunkInserted, chunkExisted, chunkUpdated };
        }

        // ======================================================================
        // PHASE 1 (PRIMARY): MLS SOLD HOMES via /listings/sale?status=Inactive
        // This is THE default and only primary endpoint — confirmed sold homes only
        // No active listings — those are people leaving, not knock targets
        // ======================================================================
        if (currentPhase === 'mls_listings') {
            console.log(`[chunk-v7] ★ PRIMARY PHASE: MLS Listings — radius=${radius}mi delta=${isDeltaPull}`);

            const allMls = [];
            let mlsRequestCount = 0;
            let mlsReachedEnd = false;

            const mlsOffsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) {
                mlsOffsets.push(currentOffset + p * LIMIT);
            }

            for (let i = 0; i < mlsOffsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 45000) break;

                const batch = mlsOffsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    const params = new URLSearchParams({
                        latitude: String(latitude), longitude: String(longitude),
                        radius: String(radius), limit: String(LIMIT), offset: String(offset),
                        status: 'Inactive',
                        daysOld: `0:${daysBack}`
                    });
                    if (offset === 0 && currentOffset === 0) params.set('includeTotalCount', 'true');

                    const url = `${RENTCAST_BASE}/listings/sale?${params}`;
                    if (offset === mlsOffsets[0] && i === 0) console.log(`[chunk-v7] MLS Sold URL: ${url}`);

                    return fetchWithBackoff(url,
                        { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY },
                        logError
                    );
                });

                const results = await Promise.all(promises);
                mlsRequestCount += results.length;

                const allFailed = results.every(r => r.status !== 200);
                if (allFailed && results.some(r => r.status === 401)) {
                    logError('All requests returned 401 — aborting job');
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'failed', error_message: 'RentCast API key invalid', error_log: errorLog, total_api_calls: totalApiCalls + mlsRequestCount
                    });
                    return Response.json({ error: 'API auth failed' });
                }
                
                if (allFailed && results.some(r => r.status === 429)) {
                    logError('MLS phase rate-limited — pausing');
                    const nextChunk = (job.chunk_number || 0) + 1;
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'running', phase: 'mls_listings',
                        current_offset: currentOffset,
                        total_api_calls: totalApiCalls + mlsRequestCount,
                        chunk_number: nextChunk, error_log: errorLog
                    });
                    await sleep(5000);
                    try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
                    return Response.json({ paused: true, reason: 'rate_limited' });
                }

                let mlsTotalExpected = 0;
                for (const r of results) {
                    if (r.total) {
                        mlsTotalExpected = parseInt(r.total, 10);
                        if (!totalExpected) totalExpected = mlsTotalExpected;
                    }
                    allMls.push(...r.records);
                    if (r.records.length < LIMIT) mlsReachedEnd = true;
                }

                if (mlsReachedEnd) break;
                if (i + MAX_PARALLEL < mlsOffsets.length) await sleep(150);
            }

            totalApiCalls += mlsRequestCount;
            mlsApiCalls += mlsRequestCount;
            mlsFetched += allMls.length;
            console.log(`[chunk-v7] MLS Sold fetched ${allMls.length} listings (${mlsRequestCount} calls)`);

            // Map MLS listings
            const mlsMapped = [];
            const seenHashes = new Set();
            const seenNormalized = new Set();

            for (const l of allMls) {
                const lat = l.latitude;
                const lng = l.longitude;
                if (!lat || !lng) continue;
                if (!filterPoint(lat, lng)) continue;
                if (!l.addressLine1 && !l.formattedAddress) continue;

                const addressLine = l.addressLine1 || (l.formattedAddress ? l.formattedAddress.split(',')[0] : "");
                const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                const pZip = l.zipCode || '00000';
                const hash = l.id || l.propertyId || `${addressLine}-${pZip}`;
                if (seenHashes.has(hash)) continue;
                
                const normKey = generateNormalizedHash(addressLine, pZip);
                if (seenNormalized.has(normKey)) continue;
                
                seenHashes.add(hash);
                seenNormalized.add(normKey);

                if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);

                mlsMapped.push({
                    address_hash: hash, house_number, street_name,
                    full_address: l.formattedAddress || l.addressLine1,
                    city: l.city || '', state: l.state || '', zip_code: pZip,
                    lat, lng, original_status: 'SOLD',
                    beds: l.bedrooms || 0, baths: l.bathrooms || 0,
                    sqft: l.squareFootage || 0, lot_size: l.lotSize || 0,
                    year_built: l.yearBuilt || 0, price: l.price || 0,
                    sold_date: l.removedDate || l.listedDate || null, sale_type: 'MLS',
                    property_type: l.propertyType || 'Single Family',
                    mls_id: l.mlsNumber || l.id || null, url: null,
                    data_source: 'rentcast'
                });
            }

            console.log(`[chunk-v7] MLS Sold mapped ${mlsMapped.length} from ${allMls.length} raw`);

            // Write to DB
            const dbResult = await writeToDb(mlsMapped);
            mlsNew += dbResult.chunkInserted;
            totalInserted += dbResult.chunkInserted;
            totalExisted += dbResult.chunkExisted;
            totalUpdated += dbResult.chunkUpdated;

            const mlsSoldDone = mlsReachedEnd || allMls.length === 0;
            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);

            console.log(`[chunk-v7] MLS Sold chunk done in ${chunkDuration}s: ins=${dbResult.chunkInserted}, exist=${dbResult.chunkExisted}, upd=${dbResult.chunkUpdated}`);

            if (mlsSoldDone) {
                // Skip active listings — go straight to deed records for supplemental enrichment
                console.log(`[chunk-v7] MLS Sold COMPLETE (${mlsFetched} confirmed sold homes) — skipping active, going to deed records`);
                const nextChunk = (job.chunk_number || 0) + 1;
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    phase: 'deed_records', current_offset: 0,
                    total_expected: totalExpected, total_fetched: totalFetched + allMls.length,
                    total_inserted: totalInserted, total_existed: totalExisted,
                    total_updated: totalUpdated, total_api_calls: totalApiCalls,
                    mls_fetched: mlsFetched, mls_new: mlsNew, mls_api_calls: mlsApiCalls,
                    progress_pct: 50, zip_codes_found: zipCodesFound,
                    chunk_number: nextChunk, chunk_timings: chunkTimings, error_log: errorLog
                });
                try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
            } else {
                const newOffset = currentOffset + allMls.length;
                const progressPct = totalExpected > 0
                    ? Math.min(39, Math.round((mlsFetched / totalExpected) * 40))
                    : 20;
                const nextChunk = (job.chunk_number || 0) + 1;
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'mls_listings',
                    current_offset: newOffset,
                    total_expected: totalExpected, total_fetched: totalFetched + allMls.length,
                    total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, mls_fetched: mlsFetched,
                    mls_new: mlsNew, mls_api_calls: mlsApiCalls,
                    progress_pct: progressPct,
                    zip_codes_found: zipCodesFound, chunk_number: nextChunk,
                    chunk_timings: chunkTimings, error_log: errorLog
                });
                try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
            }

            return Response.json({
                job_id: jobId, phase: 'mls_listings', is_delta: isDeltaPull,
                mls_fetched: allMls.length, mls_inserted: dbResult.chunkInserted,
                chunk_duration_s: chunkDuration, is_phase_done: mlsSoldDone
            });
        }

        // ======================================================================
        // PHASE 2 (SUPPLEMENTAL): DEED RECORDS via /properties
        // Enriches MLS data with ownership, tax, and historical deed info
        // ======================================================================
        if (currentPhase === 'deed_records') {
            console.log(`[chunk-v7] Phase 3 (supplemental): Deed Records`);

            const allRaw = [];
            let requestCount = 0;
            let reachedEnd = false;

            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) {
                offsets.push(currentOffset + p * LIMIT);
            }

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 45000) {
                    console.warn(`[chunk-v7] Time budget hit at offset ${offsets[i]}`);
                    break;
                }

                const batch = offsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    const params = new URLSearchParams({
                        latitude: String(latitude), longitude: String(longitude),
                        radius: String(radius), limit: String(LIMIT), offset: String(offset),
                        saleDateRange: `1:${daysBack}`,
                    });
                    if (offset === 0 && currentOffset === 0) params.set('includeTotalCount', 'true');
                    
                    // CDC Delta-Pull filter
                    if (isDeltaPull && deltaWatermark) {
                        const watermarkDate = new Date(deltaWatermark);
                        watermarkDate.setDate(watermarkDate.getDate() - 1);
                        params.set('lastUpdated_gte', watermarkDate.toISOString().split('T')[0]);
                        if (offset === offsets[0] && i === 0) {
                            console.log(`[chunk-v7] 🔄 DELTA FILTER: lastUpdated_gte=${watermarkDate.toISOString().split('T')[0]}`);
                        }
                    }

                    const url = `${RENTCAST_BASE}/properties?${params}`;
                    if (offset === offsets[0] && i === 0) console.log(`[chunk-v7] Deed URL: ${url}`);

                    return fetchWithBackoff(url, { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }, logError);
                });

                const results = await Promise.all(promises);
                requestCount += results.length;
                totalApiCalls += results.length;

                const allFailed = results.every(r => r.status !== 200);
                if (allFailed && results.some(r => r.status === 401)) {
                    logError('Deed records 401 — aborting');
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'failed', error_message: 'RentCast API key invalid', error_log: errorLog, total_api_calls: totalApiCalls
                    });
                    return Response.json({ error: 'API auth failed' });
                }
                
                if (allFailed && results.some(r => r.status === 429)) {
                    logError('Deed records rate-limited — pausing');
                    const nextChunk = (job.chunk_number || 0) + 1;
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'running', phase: 'deed_records',
                        current_offset: currentOffset,
                        total_api_calls: totalApiCalls, chunk_number: nextChunk,
                        error_log: errorLog
                    });
                    await sleep(5000);
                    try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
                    return Response.json({ paused: true, reason: 'deed_rate_limited' });
                }

                for (const r of results) {
                    if (r.total && !totalExpected) totalExpected = parseInt(r.total, 10);
                    allRaw.push(...r.records);
                    if (r.records.length < LIMIT) reachedEnd = true;
                }

                if (reachedEnd) break;
                if (i + MAX_PARALLEL < offsets.length) await sleep(150);
            }

            totalFetched += allRaw.length;
            console.log(`[chunk-v7] Deed fetched ${allRaw.length} records (${requestCount} calls)`);

            // Map deed records
            const soldCutoff = new Date();
            soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

            const mapped = [];
            const seenHashes = new Set();
            const seenNormalized = new Set();

            for (const p of allRaw) {
                if (!p.latitude || !p.longitude) continue;
                if (!filterPoint(p.latitude, p.longitude)) continue;
                if (!(p.addressLine1 || p.formattedAddress)) continue;

                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                let original_status = 'SOLD';
                if (p.lastSaleDate) {
                    const saleDate = new Date(p.lastSaleDate);
                    if (!isNaN(saleDate) && saleDate <= soldCutoff) original_status = 'ELIGIBLE';
                }

                const pZip = p.zipCode || '00000';
                const hash = p.id || `${p.addressLine1}-${pZip}`;
                
                if (seenHashes.has(hash)) continue;
                const normKey = generateNormalizedHash(addressLine, pZip);
                if (seenNormalized.has(normKey)) continue;
                
                seenHashes.add(hash);
                seenNormalized.add(normKey);

                if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);

                mapped.push({
                    address_hash: hash, house_number, street_name,
                    full_address: p.formattedAddress || p.addressLine1,
                    city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status,
                    beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
                    year_built: p.yearBuilt || 0, price: p.lastSalePrice || p.price || 0,
                    sold_date: p.lastSaleDate || null, sale_type: 'Deed',
                    property_type: p.propertyType || 'Single Family',
                    mls_id: p.assessorID || null, url: null,
                    data_source: 'rentcast'
                });
            }

            const dedupSaved = allRaw.length - mapped.length;
            if (dedupSaved > 0) console.log(`[chunk-v7] Deed normalization caught ${dedupSaved} duplicates`);

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted;
            totalExisted += dbResult.chunkExisted;
            totalUpdated += dbResult.chunkUpdated;

            const newOffset = currentOffset + allRaw.length;
            const phase3Done = reachedEnd || (totalExpected > 0 && totalFetched >= totalExpected);
            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);

            console.log(`[chunk-v7] Deed chunk done in ${chunkDuration}s: ins=${dbResult.chunkInserted}, exist=${dbResult.chunkExisted}, upd=${dbResult.chunkUpdated}`);

            // Calculate delta savings
            let deltaSavings = job.delta_savings || null;
            if (isDeltaPull && phase3Done && deltaSavings) {
                deltaSavings.actual_calls = totalApiCalls;
                deltaSavings.savings_pct = deltaSavings.estimated_full_calls > 0 
                    ? Math.round((1 - totalApiCalls / deltaSavings.estimated_full_calls) * 100)
                    : 0;
                console.log(`[chunk-v7] 📊 DELTA SAVINGS: ${deltaSavings.savings_pct}% (${deltaSavings.estimated_full_calls} → ${totalApiCalls} calls)`);
            }

            if (phase3Done) {
                // ALL DONE — complete the job
                const completedAt = new Date().toISOString();
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'completed', phase: 'complete',
                    current_offset: 0, total_fetched: totalFetched,
                    total_inserted: totalInserted, total_existed: totalExisted,
                    total_updated: totalUpdated, total_api_calls: totalApiCalls,
                    mls_fetched: mlsFetched, mls_new: mlsNew, mls_api_calls: mlsApiCalls,
                    delta_savings: deltaSavings,
                    progress_pct: 100, zip_codes_found: zipCodesFound,
                    completed_at: completedAt, chunk_timings: chunkTimings, error_log: errorLog
                });

                // Update user territory
                try {
                    const users = await base44.asServiceRole.entities.User.filter({ email: job.user_email }, null, 1);
                    const userArr = Array.isArray(users) ? users : (users?.items || []);
                    if (userArr.length > 0) {
                        const currentZips = userArr[0].territory_zip_codes || [];
                        const mergedZips = [...new Set([...zipCodesFound, ...currentZips])];
                        await base44.asServiceRole.entities.User.update(userArr[0].id, {
                            territory_zip_codes: mergedZips, has_pulled_data: true,
                            has_defined_market: true, territory_property_count: totalInserted + totalExisted,
                            last_data_pull: completedAt
                        });
                    }
                } catch (e) { logError(`User update failed: ${e.message}`); }

                const deltaMsg = isDeltaPull ? ` | DELTA savings: ${deltaSavings?.savings_pct || 0}%` : '';
                console.log(`[chunk-v7] === JOB COMPLETE === mls_sold=${mlsFetched} deed=${totalFetched} inserted=${totalInserted} existed=${totalExisted} apiCalls=${totalApiCalls}${deltaMsg}`);
            } else {
                const progressPct = 60 + (totalExpected > 0
                    ? Math.min(39, Math.round((totalFetched / totalExpected) * 40))
                    : 20);
                const nextChunk = (job.chunk_number || 0) + 1;
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'deed_records',
                    current_offset: newOffset,
                    total_expected: totalExpected, total_fetched: totalFetched,
                    total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, delta_savings: deltaSavings,
                    progress_pct: Math.min(99, progressPct),
                    zip_codes_found: zipCodesFound, chunk_number: nextChunk,
                    chunk_timings: chunkTimings, error_log: errorLog
                });
                try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
            }

            return Response.json({
                job_id: jobId, phase: 'deed_records', is_delta: isDeltaPull,
                chunk_fetched: allRaw.length, chunk_inserted: dbResult.chunkInserted,
                chunk_existed: dbResult.chunkExisted, chunk_duration_s: chunkDuration,
                dedup_saved: dedupSaved, is_phase_done: phase3Done
            });
        }

        return Response.json({ error: 'Unknown phase', phase: currentPhase });

    } catch (error) {
        console.error('[chunk-v7] FATAL CRASH:', error.message, error.stack);
        try {
            const base44 = createClientFromRequest(req);
            const runningJobs = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
            const arr = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
            if (arr.length > 0) {
                await base44.asServiceRole.entities.FetchJob.update(arr[0].id, {
                    status: 'failed',
                    error_message: `CRASH: ${error.message}`,
                    error_log: [...(arr[0].error_log || []), `[${new Date().toISOString()}] FATAL: ${error.message}\n${error.stack}`]
                });
            }
        } catch (e2) { console.error('[chunk-v7] Could not mark job failed:', e2.message); }
        return Response.json({ error: error.message }, { status: 500 });
    }
});