import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { latLngToCell } from 'npm:h3-js@4.1.0';

// v10 — Grid Subdivision + Deed/Listing Hybrid Architecture
// Large-radius queries to RentCast silently drop records (confirmed by RentCast support).
// Areas >5mi are subdivided into overlapping ≤5mi sub-circles.
// Phase 1 (Deeds): /v1/properties?saleDateRange (Recorded sales, 30-120 day lag)
// Phase 2 (Listings): /v1/listings/sale?status=Inactive (Pending sales, 0-30 day lag)

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

// ── Rate Limiting: Exponential Backoff + Full Jitter ──
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
                await sleep(Math.random() * backoff);
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
                console.log(`[backoff] Waiting ${Math.round(waitMs)}ms before retry`);
                await sleep(waitMs + Math.random() * waitMs * 0.5);
                continue;
            }
            return { records: [], total: null, status: 429 };
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => 'no body');
            logError(`API ${res.status}: ${errText.slice(0, 200)}`);
            if (res.status === 401) return { records: [], total: null, status: 401 };
            if (res.status >= 500 && attempt < MAX_RETRIES) {
                await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 1000);
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

// ── Address Normalization ──
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

const CORPORATE_KEYWORDS = ['LLC', 'INC', 'TRUST', 'HOLDINGS', 'BANK', 'PROPERTIES', 'CORP', 'COMPANY'];

function isValidSoldProperty(p) {
    if (!p.lastSaleDate) return false;
    if (p.lastSalePrice === null || p.lastSalePrice === undefined || p.lastSalePrice <= 100) return false;
    const badTypes = ['Commercial', 'Industrial', 'Vacant Land', 'Agricultural'];
    if (p.propertyType && badTypes.includes(p.propertyType)) return false;
    return true;
}

function isCorporateOwner(p) {
    if (!p.owner || !Array.isArray(p.owner.names) || p.owner.names.length === 0) return false;
    return p.owner.names.some(name => 
        CORPORATE_KEYWORDS.some(kw => name.toUpperCase().includes(kw))
    );
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
            await base44.asServiceRole.entities.FetchJob.update(jobId, { status: 'failed', error_message: 'RENTCAST_API_KEY not configured', error_log: errorLog });
            return Response.json({ error: 'No API key' });
        }

        let currentPhase = job.phase || 'deed_records';
        const subCircles = job.sub_circles || [{ lat: job.latitude, lng: job.longitude, radius: job.radius }];
        let currentSubCircle = job.current_sub_circle || 0;
        const totalSubCircles = subCircles.length;

        console.log(`[chunk-v10] Job ${jobId} | phase=${currentPhase} | sub-circle=${currentSubCircle + 1}/${totalSubCircles} | offset=${job.current_offset} | delta=${isDeltaPull}`);

        const { polygon } = job;
        const activeCircle = subCircles[currentSubCircle] || subCircles[0];
        const fetchLat = activeCircle.lat;
        const fetchLng = activeCircle.lng;
        const fetchRadius = activeCircle.radius;

        let currentOffset = job.current_offset || 0;
        let totalExpected = job.total_expected || 0;
        let totalFetched = job.total_fetched || 0;
        let totalInserted = job.total_inserted || 0;
        let totalExisted = job.total_existed || 0;
        let totalUpdated = job.total_updated || 0;
        let zipCodesFound = job.zip_codes_found || [];
        let totalApiCalls = job.total_api_calls || 0;

        if (job.status === 'pending') {
            await base44.asServiceRole.entities.FetchJob.update(jobId, { status: 'running', started_at: new Date().toISOString() });
        }

        const monthsBack = job.sold_months || 12;
        const filterPoint = (lat, lng) => (!polygon || polygon.length < 3) ? true : isPointInPolygon({ lat, lng }, polygon);

        // ── Helper: write mapped properties to DB ──
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
                            arr.forEach(p => existingHashToId.set(p.address_hash, { id: p.id, soldDate: p.sold_date, price: p.price }));
                        })
                        .catch(() => {})
                );
                await Promise.all(promises);
            }

            const toInsert = [], toUpdate = [];
            for (const p of mapped) {
                const existing = existingHashToId.get(p.address_hash);
                if (existing) {
                    chunkExisted++;
                    const existingSaleDate = existing.soldDate ? new Date(existing.soldDate) : new Date(0);
                    const incomingSaleDate = p.sold_date ? new Date(p.sold_date) : new Date(0);
                    if (incomingSaleDate > existingSaleDate) {
                        const { address_hash, ...updatePayload } = p;
                        toUpdate.push({ id: existing.id, ...updatePayload });
                    }
                } else {
                    toInsert.push(p);
                }
            }

            for (let i = 0; i < toInsert.length; i += 500) {
                if (Date.now() - chunkStart > 55000) break;
                await base44.asServiceRole.entities.MasterProperty.bulkCreate(toInsert.slice(i, i + 500)).then(() => chunkInserted += Math.min(500, toInsert.length - i)).catch(e => logError(`Bulk insert error: ${e.message}`));
            }
            for (let i = 0; i < Math.min(toUpdate.length, 50); i++) {
                if (Date.now() - chunkStart > 58000) break;
                const { id, ...payload } = toUpdate[i];
                await base44.asServiceRole.entities.MasterProperty.update(id, payload).then(() => chunkUpdated++).catch(() => {});
            }
            return { chunkInserted, chunkExisted, chunkUpdated };
        }

        // ======================================================================
        // PHASE 1: DEED RECORDS
        // ======================================================================
        if (currentPhase === 'deed_records') {
            const DEED_LAG_DAYS = 90;
            const saleDateRange = (monthsBack * 30) + DEED_LAG_DAYS;
            const allRaw = [];
            let reachedEnd = false;

            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) offsets.push(currentOffset + p * LIMIT);

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 40000) break;
                const batch = offsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    const params = new URLSearchParams({ latitude: String(fetchLat), longitude: String(fetchLng), radius: String(fetchRadius), limit: String(LIMIT), offset: String(offset), saleDateRange: String(saleDateRange) });
                    if (offset === 0 && currentOffset === 0) params.set('includeTotalCount', 'true');
                    return fetchWithBackoff(`${RENTCAST_BASE}/properties?${params}`, { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }, logError);
                });

                const results = await Promise.all(promises);
                totalApiCalls += results.length;
                for (const r of results) {
                    if (r.total && !totalExpected) totalExpected = parseInt(r.total, 10);
                    allRaw.push(...r.records);
                    if (r.records.length < LIMIT) reachedEnd = true;
                }
                if (reachedEnd) break;
                await sleep(150);
            }

            totalFetched += allRaw.length;
            const soldCutoff = new Date();
            soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

            const mapped = [];
            const seenHashes = new Set();
            for (const p of allRaw) {
                if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) continue;
                if (!isValidSoldProperty(p)) continue;
                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                const pZip = p.zipCode || '00000';
                // Use normalized hash (matches Phase 2 listings) to prevent duplicate DB records
                const hash = generateNormalizedHash(addressLine, pZip);
                if (seenHashes.has(hash)) continue;
                seenHashes.add(hash);
                if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);

                const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                let original_status = 'SOLD';
                if (p.lastSaleDate) {
                    const saleDate = new Date(p.lastSaleDate);
                    if (!isNaN(saleDate.getTime()) && saleDate <= soldCutoff) original_status = 'ELIGIBLE';
                }

                mapped.push({
                    address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status, beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
                    sold_date: p.lastSaleDate || null, sale_type: 'Deed', property_type: p.propertyType || 'Single Family', data_source: 'rentcast'
                });
            }

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted; totalExisted += dbResult.chunkExisted; totalUpdated += dbResult.chunkUpdated;

            const subCircleDone = reachedEnd || allRaw.length === 0 || (totalExpected > 0 && (currentOffset + allRaw.length) >= totalExpected);
            let nextSubCircle = currentSubCircle, nextOffset = currentOffset + allRaw.length, nextPhase = 'deed_records';

            if (subCircleDone) {
                if (currentSubCircle < totalSubCircles - 1) {
                    nextSubCircle++; nextOffset = 0; totalExpected = 0;
                } else {
                    nextPhase = 'listings_records'; nextSubCircle = 0; nextOffset = 0; totalExpected = 0;
                }
            }

            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);
            const progressPct = nextPhase === 'deed_records' ? Math.round((nextSubCircle / totalSubCircles) * 90) : 90;

            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running', phase: nextPhase, current_offset: nextOffset, current_sub_circle: nextSubCircle,
                total_expected: totalExpected, total_fetched: totalFetched, total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                total_api_calls: totalApiCalls, progress_pct: progressPct, zip_codes_found: zipCodesFound, chunk_number: (job.chunk_number || 0) + 1, chunk_timings: chunkTimings, error_log: errorLog
            });
            setTimeout(() => base44.functions.invoke('processFetchChunk', {}).catch(() => {}), 0);
            return Response.json({ status: 'running', phase: 'deed_records', job_id: jobId, sub_circle: currentSubCircle + 1, done: subCircleDone });
        }

        // ======================================================================
        // PHASE 2: LISTINGS RECORDS (Early Warning Radar / MLS Inactive)
        // ======================================================================
        if (currentPhase === 'listings_records') {
            const DEED_LAG_DAYS = 90;
            const saleDateRange = (monthsBack * 30) + DEED_LAG_DAYS;
            
            const allRaw = [];
            let reachedEnd = false;
            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) offsets.push(currentOffset + p * LIMIT);

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 40000) break;
                const batch = offsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    // Fetch Inactive status, using daysOld to cast a wide net based on the listedDate
                    const params = new URLSearchParams({ latitude: String(fetchLat), longitude: String(fetchLng), radius: String(fetchRadius), limit: String(LIMIT), offset: String(offset), status: 'Inactive', daysOld: String(saleDateRange) });
                    return fetchWithBackoff(`${RENTCAST_BASE}/listings/sale?${params}`, { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }, logError);
                });
                const results = await Promise.all(promises);
                totalApiCalls += results.length;
                for (const r of results) {
                    allRaw.push(...r.records);
                    if (r.records.length < LIMIT) reachedEnd = true;
                }
                if (reachedEnd) break;
                await sleep(150);
            }

            const soldCutoff = new Date();
            soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

            const mapped = [];
            const seenHashes = new Set();
            for (const p of allRaw) {
                if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) continue;
                
                // Local filter: remove items where removedDate is too old
                if (!p.removedDate) continue;
                const removed = new Date(p.removedDate);
                if (isNaN(removed.getTime()) || removed < soldCutoff) continue;

                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                const pZip = p.zipCode || '00000';
                
                // Use normalized hash to match how fetchZipProperties.ts does deed deduplication
                const hash = generateNormalizedHash(addressLine, pZip);
                if (seenHashes.has(hash)) continue;
                seenHashes.add(hash);
                if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);

                const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                mapped.push({
                    address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status: 'RECENT_OFF_MARKET', beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.price || 0,
                    sold_date: p.removedDate || p.listedDate || null, sale_type: 'MLS', property_type: p.propertyType || 'Single Family', data_source: 'rentcast'
                });
            }

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted; totalExisted += dbResult.chunkExisted; totalUpdated += dbResult.chunkUpdated;

            const subCircleDone = reachedEnd || allRaw.length === 0;
            let nextSubCircle = currentSubCircle, nextOffset = currentOffset + (reachedEnd ? allRaw.length : (PAGES_PER_CHUNK * LIMIT)), jobDone = false;

            if (subCircleDone) {
                if (currentSubCircle < totalSubCircles - 1) {
                    nextSubCircle++; nextOffset = 0;
                } else {
                    jobDone = true;
                }
            }

            if (jobDone) {
                const completedAt = new Date().toISOString();
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'completed', phase: 'complete', progress_pct: 100, completed_at: completedAt,
                    total_fetched: totalFetched, total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, zip_codes_found: zipCodesFound
                });
                try {
                    const users = await base44.asServiceRole.entities.User.filter({ email: job.user_email }, null, 1);
                    const userArr = Array.isArray(users) ? users : (users?.items || []);
                    if (userArr.length > 0) {
                        await base44.asServiceRole.entities.User.update(userArr[0].id, {
                            has_pulled_data: true, last_data_pull: completedAt, territory_property_count: totalInserted + totalExisted
                        });
                    }
                } catch (e) {}
                console.log(`[chunk-v10] JOB COMPLETE | totalApiCalls=${totalApiCalls} | totalInserted=${totalInserted}`);
                return Response.json({ status: 'completed', job_id: jobId });
            } else {
                const progressPct = 90 + Math.round((nextSubCircle / totalSubCircles) * 10);
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'listings_records', current_offset: nextOffset, current_sub_circle: nextSubCircle,
                    total_fetched: totalFetched, total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, progress_pct: progressPct, zip_codes_found: zipCodesFound, chunk_number: (job.chunk_number || 0) + 1
                });
                setTimeout(() => base44.functions.invoke('processFetchChunk', {}).catch(() => {}), 0);
                return Response.json({ status: 'running', phase: 'listings_records', job_id: jobId, sub_circle: currentSubCircle + 1 });
            }
        }

    } catch (error) {
        console.error('[chunk-v10] FATAL:', error.message);
        return Response.json({ error: error.message }, { status: 500 });
    }
});