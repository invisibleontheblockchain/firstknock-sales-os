import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { latLngToCell } from 'npm:h3-js@4.1.0';

// v9 — Grid Subdivision + Deed-Only Architecture
// Large-radius queries to RentCast silently drop records (confirmed by RentCast support).
// Areas >5mi are subdivided into overlapping ≤5mi sub-circles, each fetched independently.
// /v1/properties?saleDateRange is the ONLY endpoint — county deed records guarantee
// every returned record is a legally confirmed, closed transaction.
// saleDateRange = (sold_months * 30) + 90 to account for 30–90 day county deed recording lag.

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

// ── Data Validation per audit report (Table 11) ──
const CORPORATE_KEYWORDS = ['LLC', 'INC', 'TRUST', 'HOLDINGS', 'BANK', 'PROPERTIES', 'CORP', 'COMPANY'];

function isValidSoldProperty(p) {
    // HIGH confidence checks — discard on failure
    if (!p.lastSaleDate) return false;
    if (p.lastSalePrice === null || p.lastSalePrice === undefined || p.lastSalePrice <= 100) return false;
    // Filter commercial/vacant land
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
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'failed', error_message: 'RENTCAST_API_KEY not configured', error_log: errorLog
            });
            return Response.json({ error: 'No API key' });
        }

        // Migration: old jobs created before v8 may still have 'mls_listings' phase — redirect to deed_records
        let currentPhase = job.phase || 'deed_records';
        if (currentPhase === 'mls_listings') {
            console.log(`[chunk-v8] Migrating old job from mls_listings -> deed_records`);
            currentPhase = 'deed_records';
            await base44.asServiceRole.entities.FetchJob.update(jobId, { phase: 'deed_records', current_offset: 0 });
        }
        // === SUB-CIRCLE GRID SUPPORT ===
        // Read the pre-computed sub-circles from the job (set by fetchAreaProperties v9)
        const subCircles = job.sub_circles || [{ lat: job.latitude, lng: job.longitude, radius: job.radius }];
        let currentSubCircle = job.current_sub_circle || 0;
        const totalSubCircles = subCircles.length;

        console.log(`[chunk-v9] Job ${jobId} | phase=${currentPhase} | sub-circle=${currentSubCircle + 1}/${totalSubCircles} | offset=${job.current_offset} | delta=${isDeltaPull} | chunk#=${job.chunk_number || 0}`);

        const { polygon } = job;
        // Use current sub-circle's coordinates instead of job's original (potentially too-large) radius
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
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running', started_at: new Date().toISOString()
            });
        }

        // Compute saleDateRange with 90-day deed recording lag buffer
        const monthsBack = job.sold_months || 12;
        const DEED_LAG_DAYS = 90;
        const saleDateRange = (monthsBack * 30) + DEED_LAG_DAYS;

        const filterPoint = (lat, lng) => {
            if (!polygon || polygon.length < 3) return true;
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
                            arr.forEach(p => existingHashToId.set(p.address_hash, { id: p.id, status: p.original_status, dataSource: p.data_source, soldDate: p.sold_date }));
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
                    // Upsert: update if incoming record has newer lastSaleDate
                    const existingSaleDate = existing.soldDate ? new Date(existing.soldDate) : new Date(0);
                    const incomingSaleDate = p.sold_date ? new Date(p.sold_date) : new Date(0);
                    
                    if (incomingSaleDate > existingSaleDate || existing.status === 'UNVERIFIED' || existing.dataSource === 'csv_import') {
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
                    const { id, ...updatePayload } = toUpdate[i];
                    await base44.asServiceRole.entities.MasterProperty.update(id, updatePayload);
                    chunkUpdated++;
                } catch (e) { /* skip */ }
            }

            return { chunkInserted, chunkExisted, chunkUpdated };
        }

        // ======================================================================
        // SINGLE PHASE: /v1/properties with saleDateRange (deed-confirmed sales)
        // This is THE ONLY data source — county deed records guarantee confirmed sales.
        // saleDateRange accounts for 30–90 day county recording lag.
        // ======================================================================
        if (currentPhase === 'deed_records') {
            console.log(`[chunk-v9] ★ DEED RECORDS: sub-circle ${currentSubCircle + 1}/${totalSubCircles} | lat=${fetchLat} lng=${fetchLng} r=${fetchRadius}mi | saleDateRange=${saleDateRange} | delta=${isDeltaPull}`);

            const allRaw = [];
            let requestCount = 0;
            let reachedEnd = false;

            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) {
                offsets.push(currentOffset + p * LIMIT);
            }

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 45000) {
                    console.warn(`[chunk-v9] Time budget hit at offset ${offsets[i]}`);
                    break;
                }

                const batch = offsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    // Use the sub-circle's coordinates instead of the original large circle
                    const params = new URLSearchParams({
                        latitude: String(fetchLat), longitude: String(fetchLng),
                        radius: String(fetchRadius), limit: String(LIMIT), offset: String(offset),
                        saleDateRange: String(saleDateRange),
                    });
                    if (offset === 0 && currentOffset === 0) params.set('includeTotalCount', 'true');
                    // NOTE: RentCast does NOT support lastUpdated_gte or any server-side delta filter.
                    // Delta savings are achieved post-fetch by skipping unchanged DB records.

                    const url = `${RENTCAST_BASE}/properties?${params}`;
                    if (offset === offsets[0] && i === 0) {
                        console.log(`[chunk-v9] RentCast Fetch: ${url}`);
                        console.log(`[chunk-v9] Sub-circle ${currentSubCircle + 1}/${totalSubCircles}: lat=${fetchLat} lng=${fetchLng} r=${fetchRadius}mi, saleDateRange=${saleDateRange} days`);
                    }

                    return fetchWithBackoff(url, { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }, logError);
                });

                const results = await Promise.all(promises);
                requestCount += results.length;
                totalApiCalls += results.length;

                const allFailed = results.every(r => r.status !== 200);
                if (allFailed && results.some(r => r.status === 401)) {
                    logError('All requests returned 401 — aborting job');
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'failed', error_message: 'RentCast API key invalid', error_log: errorLog, total_api_calls: totalApiCalls
                    });
                    return Response.json({ error: 'API auth failed' });
                }
                
                if (allFailed && results.some(r => r.status === 429)) {
                    logError('Rate-limited — pausing chunk');
                    const nextChunk = (job.chunk_number || 0) + 1;
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'running', phase: 'deed_records',
                        current_offset: currentOffset,
                        current_sub_circle: currentSubCircle,
                        total_api_calls: totalApiCalls, chunk_number: nextChunk,
                        error_log: errorLog
                    });
                    await sleep(5000);
                    try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
                    return Response.json({ paused: true, reason: 'rate_limited' });
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
            console.log(`[chunk-v9] Fetched ${allRaw.length} records (${requestCount} API calls) from sub-circle ${currentSubCircle + 1}/${totalSubCircles}`);

            // Map and validate deed records
            const soldCutoff = new Date();
            soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

            const mapped = [];
            const seenHashes = new Set();
            const seenNormalized = new Set();
            let skippedValidation = 0;
            let skippedCorporate = 0;
            let skippedDeltaUnchanged = 0;

            // ── DELTA PRE-FILTER: Load existing DB records for comparison ──
            // RentCast has no server-side delta filter, so we achieve delta savings
            // by comparing fetched records against our DB and skipping unchanged ones.
            let existingRecordMap = new Map();
            if (isDeltaPull && deltaWatermark) {
                try {
                    const rawZips = [...new Set(allRaw.map(r => r.zipCode).filter(Boolean))];
                    for (let zi = 0; zi < rawZips.length; zi += 20) {
                        if (Date.now() - chunkStart > 40000) break;
                        const zipBatch = rawZips.slice(zi, zi + 20);
                        const lookups = zipBatch.map(z =>
                            base44.asServiceRole.entities.MasterProperty.filter({ zip_code: z }, null, 5000)
                                .then(res => {
                                    const arr = Array.isArray(res) ? res : (res?.items || []);
                                    arr.forEach(p => existingRecordMap.set(p.address_hash, {
                                        soldDate: p.sold_date, price: p.price
                                    }));
                                })
                                .catch(() => {})
                        );
                        await Promise.all(lookups);
                    }
                    console.log(`[chunk-v8] DELTA: Loaded ${existingRecordMap.size} existing records for comparison`);
                } catch (e) {
                    logError(`Delta pre-load failed (falling back to full): ${e.message}`);
                    existingRecordMap = new Map();
                }
            }

            for (const p of allRaw) {
                if (!p.latitude || !p.longitude) continue;
                if (!filterPoint(p.latitude, p.longitude)) continue;
                if (!(p.addressLine1 || p.formattedAddress)) continue;

                // ── Data quality validation (audit Table 11) ──
                if (!isValidSoldProperty(p)) {
                    skippedValidation++;
                    continue;
                }

                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                const pZip = p.zipCode || '00000';
                const hash = p.id || `${addressLine}-${pZip}`;

                // ── DELTA: Skip records that haven't changed since last pull ──
                if (isDeltaPull && existingRecordMap.size > 0) {
                    const existing = existingRecordMap.get(hash);
                    if (existing) {
                        const sameSoldDate = existing.soldDate === (p.lastSaleDate || null);
                        const samePrice = existing.price === (p.lastSalePrice || 0);
                        if (sameSoldDate && samePrice) {
                            skippedDeltaUnchanged++;
                            if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);
                            continue;
                        }
                    }
                }

                const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                // Determine status: SOLD if within target window, ELIGIBLE if older
                let original_status = 'SOLD';
                if (p.lastSaleDate) {
                    const saleDate = new Date(p.lastSaleDate);
                    if (!isNaN(saleDate) && saleDate <= soldCutoff) original_status = 'ELIGIBLE';
                }

                // Flag corporate owners but still include them (they get routed differently)
                const corporateOwner = isCorporateOwner(p);
                if (corporateOwner) skippedCorporate++;
                
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
                    year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
                    sold_date: p.lastSaleDate || null, sale_type: 'Deed',
                    property_type: p.propertyType || 'Single Family',
                    mls_id: p.assessorID || null, url: null,
                    data_source: 'rentcast'
                });
            }

            const dedupSaved = allRaw.length - mapped.length - skippedValidation - skippedDeltaUnchanged;
            const deltaMsg = isDeltaPull ? ` | delta_skipped=${skippedDeltaUnchanged}` : '';
            console.log(`[chunk-v9] Mapped ${mapped.length} from ${allRaw.length} raw | skipped: ${skippedValidation} validation, ${dedupSaved} dedup, ${skippedCorporate} corporate${deltaMsg}`);

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted;
            totalExisted += dbResult.chunkExisted;
            totalUpdated += dbResult.chunkUpdated;

            const newOffset = currentOffset + allRaw.length;

            // Check if the CURRENT sub-circle is done (reached end of its pages)
            const subCircleDone = reachedEnd || 
                                  allRaw.length === 0 ||
                                  (totalExpected > 0 && newOffset >= totalExpected);
            
            // Check if we should advance to next sub-circle
            let nextSubCircle = currentSubCircle;
            let nextOffset = newOffset;
            if (subCircleDone && currentSubCircle < totalSubCircles - 1) {
                // Move to next sub-circle — reset offset and totalExpected
                nextSubCircle = currentSubCircle + 1;
                nextOffset = 0;
                totalExpected = 0; // Will be re-fetched from next sub-circle's first request
                console.log(`[chunk-v9] Sub-circle ${currentSubCircle + 1}/${totalSubCircles} complete → advancing to sub-circle ${nextSubCircle + 1}`);
            }

            // Phase is done ONLY when the LAST sub-circle is also done
            const phaseDone = subCircleDone && nextSubCircle >= totalSubCircles - 1;
                              
            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);

            console.log(`[chunk-v9] Chunk done in ${chunkDuration}s: ins=${dbResult.chunkInserted}, exist=${dbResult.chunkExisted}, upd=${dbResult.chunkUpdated} | sub-circle=${currentSubCircle + 1}/${totalSubCircles} done=${subCircleDone}`);

            // Calculate delta savings — now based on DB writes saved, not API calls
            let deltaSavings = job.delta_savings || null;
            if (isDeltaPull && phaseDone) {
                const totalRecordsProcessed = totalFetched;
                const totalWritesSaved = skippedDeltaUnchanged + (job.delta_skipped_total || 0);
                deltaSavings = deltaSavings || {};
                deltaSavings.actual_calls = totalApiCalls;
                deltaSavings.records_skipped = totalWritesSaved;
                deltaSavings.records_fetched = totalRecordsProcessed;
                deltaSavings.savings_pct = totalRecordsProcessed > 0
                    ? Math.round((totalWritesSaved / totalRecordsProcessed) * 100)
                    : 0;
                console.log(`[chunk-v9] DELTA SAVINGS: ${deltaSavings.savings_pct}% DB writes saved (${totalWritesSaved}/${totalRecordsProcessed} records unchanged)`);
            }

            if (phaseDone) {
                // JOB COMPLETE
                const completedAt = new Date().toISOString();
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'completed', phase: 'complete',
                    current_offset: 0, total_fetched: totalFetched,
                    total_inserted: totalInserted, total_existed: totalExisted,
                    total_updated: totalUpdated, total_api_calls: totalApiCalls,
                    delta_savings: deltaSavings, delta_skipped_total: (job.delta_skipped_total || 0) + skippedDeltaUnchanged,
                    progress_pct: 100, zip_codes_found: zipCodesFound,
                    completed_at: completedAt, chunk_timings: chunkTimings, error_log: errorLog
                });

                try {
                    // Update user territory
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
                console.log(`[chunk-v9] === JOB COMPLETE === fetched=${totalFetched} inserted=${totalInserted} existed=${totalExisted} updated=${totalUpdated} apiCalls=${totalApiCalls} subCircles=${totalSubCircles}${deltaMsg}`);
            } else {
                // Progress: weight sub-circle index AND within-sub-circle progress
                let progressPct;
                if (totalSubCircles > 1) {
                    // Multi-circle: base progress on sub-circle index, refined by page progress within current sub-circle
                    const circleBasePct = (nextSubCircle / totalSubCircles) * 100;
                    const withinCirclePct = totalExpected > 0
                        ? (nextOffset / totalExpected) * (100 / totalSubCircles)
                        : (totalFetched > 0 ? 5 : 0);
                    progressPct = Math.min(99, Math.round(circleBasePct + withinCirclePct));
                } else {
                    progressPct = totalExpected > 0
                        ? Math.min(99, Math.round((totalFetched / totalExpected) * 100))
                        : Math.min(80, Math.round(totalFetched / 100));
                }
                const nextChunk = (job.chunk_number || 0) + 1;
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'deed_records',
                    current_offset: nextOffset,
                    current_sub_circle: nextSubCircle,
                    total_expected: totalExpected, total_fetched: totalFetched,
                    total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, delta_savings: deltaSavings,
                    delta_skipped_total: (job.delta_skipped_total || 0) + skippedDeltaUnchanged,
                    progress_pct: Math.min(99, progressPct),
                    zip_codes_found: zipCodesFound, chunk_number: nextChunk,
                    chunk_timings: chunkTimings, error_log: errorLog
                });
                try { base44.functions.invoke('processFetchChunk', {}).catch(() => {}); } catch (e) {}
            }

            return Response.json({
                job_id: jobId, phase: 'deed_records', is_delta: isDeltaPull,
                chunk_fetched: allRaw.length, chunk_inserted: dbResult.chunkInserted,
                chunk_existed: dbResult.chunkExisted, chunk_updated: dbResult.chunkUpdated,
                skipped_validation: skippedValidation, skipped_corporate: skippedCorporate,
                chunk_duration_s: chunkDuration, dedup_saved: dedupSaved,
                is_done: phaseDone
            });
        }

        return Response.json({ error: 'Unknown phase', phase: currentPhase });

    } catch (error) {
        console.error('[chunk-v8] FATAL CRASH:', error.message, error.stack);
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
        } catch (e2) { console.error('[chunk-v8] Could not mark job failed:', e2.message); }
        return Response.json({ error: error.message }, { status: 500 });
    }
});