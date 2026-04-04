import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// v12 — Hybrid tiered BatchData: only DOM < 30 days gets medium confidence (BatchData-eligible)
// Architecture: Single sub-circle (40 sq mi ≈ 3.57mi radius), 2-phase (deeds + listings)
// Self-chain uses entity automation on FetchJob update instead of fire-and-forget setTimeout

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 20000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithBackoff(url, headers, logError) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(url, { headers }).catch(e => {
            logError(`Network error (attempt ${attempt + 1}): ${e.message}`);
            return null;
        });

        if (!res) {
            if (attempt < MAX_RETRIES) {
                const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
                await sleep(backoff + Math.random() * backoff * 0.3);
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
                await sleep(waitMs + Math.random() * waitMs * 0.3);
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

const NON_DISCLOSURE_STATES = new Set([
    'AK', 'ID', 'KS', 'LA', 'MS', 'MO', 'MT', 'NM', 'ND', 'TX', 'UT', 'WY'
]);

function isValidSoldProperty(p) {
    if (!p.lastSaleDate) return false;
    const isNonDisclosure = p.state && NON_DISCLOSURE_STATES.has(p.state.toUpperCase());
    if (!isNonDisclosure) {
        if (p.lastSalePrice === null || p.lastSalePrice === undefined || p.lastSalePrice < 10000) return false;
        if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.3) return false;
    } else {
        if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice > 0 && p.lastSalePrice < 1000) return false;
    }
    const badTypes = ['Commercial', 'Industrial', 'Vacant Land', 'Agricultural'];
    if (p.propertyType && badTypes.includes(p.propertyType)) return false;
    return true;
}

const CORPORATE_KEYWORDS = ['LLC', 'INC', 'TRUST', 'HOLDINGS', 'BANK', 'PROPERTIES', 'CORP', 'COMPANY'];

function computeSaleConfidence(p, isCorporate) {
    if (isCorporate) return 'medium';
    if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.5) return 'medium';
    return 'high';
}

function isCorporateOwner(p) {
    if (!p.owner || !Array.isArray(p.owner.names) || p.owner.names.length === 0) return false;
    return p.owner.names.some(name => 
        CORPORATE_KEYWORDS.some(kw => name.toUpperCase().includes(kw))
    );
}

// ── Reduced parallelism to avoid RentCast rate limits ──
const PAGES_PER_CHUNK = 10;   // Reduced from 20 — less pressure per chunk
const LIMIT = 500;
const MAX_PARALLEL = 2;        // Reduced from 3 — gentler on RentCast

Deno.serve(async (req) => {
    const chunkStart = Date.now();

    try {
        const base44 = createClientFromRequest(req);

        // ── MUTEX: Accept optional expected_chunk from self-chain ──
        let body = {};
        try { body = await req.json(); } catch (_e) { /* empty payload is fine */ }
        const expectedChunk = body.expected_chunk ?? null;

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

        // ── MUTEX CHECK: Prevent duplicate processing ──
        // If we were invoked with an expected_chunk and the job has moved past it,
        // another instance already processed this chunk. Bail out silently.
        const currentChunkNumber = job.chunk_number || 0;
        if (expectedChunk !== null && currentChunkNumber !== expectedChunk) {
            console.log(`[chunk-v12] MUTEX: expected_chunk=${expectedChunk} but job is at chunk=${currentChunkNumber}. Duplicate invocation — skipping.`);
            return Response.json({ skipped: true, reason: 'duplicate_invocation' });
        }

        const jobId = job.id;
        const errorLog = job.error_log || [];
        const chunkTimings = job.chunk_timings || [];
        const isDeltaPull = job.is_delta_pull || false;

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
        const subCircles = (job.sub_circles && job.sub_circles.length > 0) 
            ? job.sub_circles 
            : [{ lat: job.latitude, lng: job.longitude, radius: job.radius }];
        let currentSubCircle = job.current_sub_circle || 0;
        const totalSubCircles = job.total_sub_circles || subCircles.length;

        console.log(`[chunk-v12] Job ${jobId} | phase=${currentPhase} | sub-circle=${currentSubCircle + 1}/${totalSubCircles} | offset=${job.current_offset} | chunk#=${currentChunkNumber}`);

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
                const batch = toInsert.slice(i, i + 500);
                await base44.asServiceRole.entities.MasterProperty.bulkCreate(batch)
                    .then(() => chunkInserted += batch.length)
                    .catch(e => logError(`Bulk insert error: ${e.message}`));
            }
            for (let i = 0; i < Math.min(toUpdate.length, 50); i++) {
                if (Date.now() - chunkStart > 58000) break;
                const { id, ...payload } = toUpdate[i];
                await base44.asServiceRole.entities.MasterProperty.update(id, payload).then(() => chunkUpdated++).catch(() => {});
            }
            return { chunkInserted, chunkExisted, chunkUpdated };
        }

        // ── Helper: self-chain with mutex ──
        const nextChunkNumber = currentChunkNumber + 1;
        function scheduleNextChunk() {
            // Small delay to let the entity update propagate, then invoke with mutex token
            setTimeout(() => {
                base44.functions.invoke('processFetchChunk', { expected_chunk: nextChunkNumber }).catch(e => {
                    console.warn('[chunk-v11] Self-chain invoke failed:', e.message);
                });
            }, 500);
        }

        // ======================================================================
        // PHASE 1: DEED RECORDS — /v1/properties?saleDateRange
        // ======================================================================
        if (currentPhase === 'deed_records') {
            const saleDateRange = Math.min((monthsBack * 30) + 90, 730);
            const allRaw = [];
            let reachedEnd = false;

            // Sequential pagination with controlled parallelism
            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) offsets.push(currentOffset + p * LIMIT);

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 40000) break;
                const batch = offsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    const params = new URLSearchParams({
                        latitude: String(fetchLat), longitude: String(fetchLng),
                        radius: String(fetchRadius), limit: String(LIMIT),
                        offset: String(offset), saleDateRange: String(saleDateRange)
                    });
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
                await sleep(300); // Gentler pacing between batches
            }

            totalFetched += allRaw.length;
            console.log(`[chunk-v12] Phase 1 fetched ${allRaw.length} raw records (offset=${currentOffset}, totalExpected=${totalExpected})`);
            
            const soldCutoff = new Date();
            soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

            const mapped = [];
            const seenHashes = new Set();
            for (const p of allRaw) {
                if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) continue;
                if (!isValidSoldProperty(p)) continue;
                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                const pZip = p.zipCode || '00000';
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

                const corporate = isCorporateOwner(p);
                const confidence = computeSaleConfidence(p, corporate);

                mapped.push({
                    address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status, beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
                    sold_date: p.lastSaleDate || null, sale_type: corporate ? 'Corporate' : 'Deed', property_type: p.propertyType || 'Single Family', data_source: 'rentcast',
                    sale_confidence: confidence
                });
            }

            console.log(`[chunk-v12] Phase 1 mapped ${mapped.length} valid properties from ${allRaw.length} raw`);

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted;
            totalExisted += dbResult.chunkExisted;
            totalUpdated += dbResult.chunkUpdated;

            const subCircleDone = reachedEnd || allRaw.length === 0 || (totalExpected > 0 && (currentOffset + allRaw.length) >= totalExpected);
            let nextSubCircle = currentSubCircle, nextOffset = currentOffset + allRaw.length, nextPhase = 'deed_records';

            if (subCircleDone) {
                if (currentSubCircle < totalSubCircles - 1) {
                    nextSubCircle++;
                    nextOffset = 0;
                    totalExpected = 0;
                    console.log(`[chunk-v12] Phase 1 sub-circle ${currentSubCircle + 1} done, advancing to sub-circle ${nextSubCircle + 1}`);
                } else {
                    nextPhase = 'listings_records';
                    nextSubCircle = 0;
                    nextOffset = 0;
                    totalExpected = 0;
                    console.log(`[chunk-v12] Phase 1 COMPLETE for all sub-circles. Advancing to Phase 2 (listings).`);
                }
            } else {
            console.log(`[chunk-v12] Phase 1 sub-circle ${currentSubCircle + 1} needs more pages (nextOffset=${nextOffset})`);
            }

            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);
            const progressPct = nextPhase === 'deed_records' 
                ? Math.round(((nextSubCircle + (nextOffset > 0 ? 0.5 : 0)) / totalSubCircles) * 80) 
                : 80;

            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running', phase: nextPhase, current_offset: nextOffset, current_sub_circle: nextSubCircle,
                total_expected: totalExpected, total_fetched: totalFetched, total_inserted: totalInserted,
                total_existed: totalExisted, total_updated: totalUpdated,
                total_api_calls: totalApiCalls, progress_pct: progressPct,
                zip_codes_found: zipCodesFound, chunk_number: nextChunkNumber,
                chunk_timings: chunkTimings, error_log: errorLog
            });

            scheduleNextChunk();
            return Response.json({ status: 'running', phase: 'deed_records', job_id: jobId, sub_circle: currentSubCircle + 1, done: subCircleDone, fetched: allRaw.length, mapped: mapped.length });
        }

        // ======================================================================
        // PHASE 2: LISTINGS RECORDS — /v1/listings/sale?status=Inactive
        // ======================================================================
        if (currentPhase === 'listings_records') {
            const saleDateRange = Math.min((monthsBack * 30) + 90, 730);
            
            const allRaw = [];
            let reachedEnd = false;
            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) offsets.push(currentOffset + p * LIMIT);

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 40000) break;
                const batch = offsets.slice(i, i + MAX_PARALLEL);
                const promises = batch.map(offset => {
                    const params = new URLSearchParams({
                        latitude: String(fetchLat), longitude: String(fetchLng),
                        radius: String(fetchRadius), limit: String(LIMIT),
                        offset: String(offset), status: 'Inactive',
                        daysOld: String(saleDateRange)
                    });
                    return fetchWithBackoff(`${RENTCAST_BASE}/listings/sale?${params}`, { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }, logError);
                });
                const results = await Promise.all(promises);
                totalApiCalls += results.length;
                for (const r of results) {
                    allRaw.push(...r.records);
                    if (r.records.length < LIMIT) reachedEnd = true;
                }
                if (reachedEnd) break;
                await sleep(300);
            }

            console.log(`[chunk-v12] Phase 2 fetched ${allRaw.length} raw listings (offset=${currentOffset})`);

            const soldCutoff = new Date();
            soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

            const mapped = [];
            const seenHashes = new Set();
            let phase2Stats = { total: 0, countyLagRejected: 0, heuristicRejected: 0, heuristicLikelySold: 0, ambiguousKept: 0, batchdataEligible: 0, domGatedToLow: 0 };

            for (const p of allRaw) {
                if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) continue;
                
                if (!p.removedDate) continue;
                const removed = new Date(p.removedDate);
                if (isNaN(removed.getTime()) || removed < soldCutoff) continue;

                const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                const pZip = p.zipCode || '00000';
                
                const hash = generateNormalizedHash(addressLine, pZip);
                if (seenHashes.has(hash)) continue;
                seenHashes.add(hash);
                if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);

                const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                phase2Stats.total++;

                // ── FILTER 1: County Lag Rule ──
                const daysSinceRemoved = Math.round((Date.now() - removed.getTime()) / (1000 * 3600 * 24));
                if (daysSinceRemoved > 90) {
                    phase2Stats.countyLagRejected++;
                    continue;
                }

                // ── FILTER 2: Contract Boundary Auto-Reject ──
                const dom = p.daysOnMarket || daysSinceRemoved;
                const listed = p.listedDate ? new Date(p.listedDate) : null;
                const lastSeen = p.lastSeenDate ? new Date(p.lastSeenDate) : null;
                const listingDuration = (listed && !isNaN(removed.getTime()) && !isNaN(listed.getTime())) 
                    ? Math.round((removed.getTime() - listed.getTime()) / (1000 * 3600 * 24)) 
                    : dom;

                const isContractBoundary = (
                    Math.abs(dom - 90) <= 3 || Math.abs(dom - 180) <= 3 || Math.abs(dom - 365) <= 3 ||
                    Math.abs(listingDuration - 90) <= 3 || Math.abs(listingDuration - 180) <= 3 || Math.abs(listingDuration - 365) <= 3
                );
                if (isContractBoundary) {
                    phase2Stats.heuristicRejected++;
                    continue;
                }

                // ── FILTER 3: Heuristic Scoring ──
                let hScore = 0;

                // Negative signals
                if (dom > 150) hScore -= 3;
                else if (dom > 60) hScore -= 2;
                if (listingDuration < 7) hScore -= 1;
                if (lastSeen && Math.abs(lastSeen.getTime() - removed.getTime()) < 86400000) hScore -= 3;
                if (p.history && typeof p.history === 'object' && Object.keys(p.history).length >= 3) hScore -= 1;

                // Positive signals
                if (dom < 30) hScore += 3;
                if (listingDuration > 0 && listingDuration < 45) hScore += 2;
                if (lastSeen && (removed.getTime() - lastSeen.getTime()) >= 7 * 86400000) hScore += 1;
                if (p.history && typeof p.history === 'object' && Object.keys(p.history).length === 1) hScore += 1;

                // Classification — Hybrid Tiered Approach
                // Only DOM < 30 days gets 'medium' confidence (BatchData-eligible).
                // DOM 30-90 days: heuristic-only classification, always 'low' (no BatchData spend).
                // This cuts BatchData volume ~70-80% while keeping all high-value early signals.
                let mlsConfidence = 'low';
                let origStatus = 'RECENT_OFF_MARKET';
                const isFreshListing = dom < 30;

                if (hScore <= -4) {
                    phase2Stats.heuristicRejected++;
                    continue;
                } else if (hScore <= -2) {
                    phase2Stats.heuristicRejected++;
                    continue;
                } else if (hScore >= 3) {
                    origStatus = 'HEURISTIC_SOLD';
                    mlsConfidence = isFreshListing ? 'medium' : 'low';
                    phase2Stats.heuristicLikelySold++;
                    if (isFreshListing) phase2Stats.batchdataEligible++;
                    else phase2Stats.domGatedToLow++;
                } else if (hScore >= 1) {
                    origStatus = 'HEURISTIC_SOLD';
                    mlsConfidence = 'low'; // Never send score 1-2 to BatchData regardless of DOM
                    phase2Stats.heuristicLikelySold++;
                } else {
                    // Ambiguous (score -1 to 0) — keep as low confidence, skip BatchData
                    origStatus = 'HEURISTIC_SOLD';
                    mlsConfidence = 'low';
                    phase2Stats.ambiguousKept++;
                }

                mapped.push({
                    address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status: origStatus, beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.price || 0,
                    sold_date: p.removedDate || p.listedDate || null, sale_type: 'MLS', property_type: p.propertyType || 'Single Family', data_source: 'rentcast',
                    sale_confidence: mlsConfidence
                });
            }

            console.log(`[chunk-v12] Phase 2 stats: ${JSON.stringify(phase2Stats)}`);

            // ── Cross-reference with Phase 1 deed records (FREE verification) ──
            if (mapped.length > 0) {
                try {
                    const uniqueZips = [...new Set(mapped.map(m => m.zip_code))];
                    const deedHashSet = new Set();
                    for (let zi = 0; zi < uniqueZips.length; zi += 20) {
                        if (Date.now() - chunkStart > 50000) break;
                        const zipBatch = uniqueZips.slice(zi, zi + 20);
                        const promises = zipBatch.map(zip =>
                            base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip, sale_confidence: 'high' }, null, 5000)
                                .then(res => {
                                    const arr = Array.isArray(res) ? res : (res?.items || []);
                                    arr.forEach(mp => deedHashSet.add(mp.address_hash));
                                })
                                .catch(() => {})
                        );
                        await Promise.all(promises);
                    }

                    let crossRefCount = 0;
                    for (const m of mapped) {
                        if (deedHashSet.has(m.address_hash)) {
                            m.sale_confidence = 'verified';
                            m.original_status = 'DEED_CONFIRMED';
                            m.data_source = 'rentcast_crossref';
                            crossRefCount++;
                        }
                    }
                    if (crossRefCount > 0) console.log(`[chunk-v12] Cross-ref verified ${crossRefCount} listings against deed records`);
                } catch (err) {
                    logError(`Cross-ref failed (non-fatal): ${err.message}`);
                }
            }

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted;
            totalExisted += dbResult.chunkExisted;
            totalUpdated += dbResult.chunkUpdated;

            const subCircleDone = reachedEnd || allRaw.length === 0;
            let nextSubCircle = currentSubCircle;
            let nextOffset = currentOffset + (reachedEnd ? allRaw.length : (PAGES_PER_CHUNK * LIMIT));
            let jobDone = false;

            if (subCircleDone) {
                if (currentSubCircle < totalSubCircles - 1) {
                    nextSubCircle++;
                    nextOffset = 0;
                } else {
                    jobDone = true;
                }
            }

            if (jobDone) {
                const completedAt = new Date().toISOString();
                const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
                chunkTimings.push(chunkDuration);
                
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'completed', phase: 'complete', progress_pct: 100, completed_at: completedAt,
                    total_fetched: totalFetched, total_inserted: totalInserted, total_existed: totalExisted,
                    total_updated: totalUpdated, total_api_calls: totalApiCalls, zip_codes_found: zipCodesFound,
                    chunk_number: nextChunkNumber, chunk_timings: chunkTimings, error_log: errorLog
                });
                
                try {
                    const users = await base44.asServiceRole.entities.User.filter({ email: job.user_email }, null, 1);
                    const userArr = Array.isArray(users) ? users : (users?.items || []);
                    if (userArr.length > 0) {
                        await base44.asServiceRole.entities.User.update(userArr[0].id, {
                            has_pulled_data: true, last_data_pull: completedAt, territory_property_count: totalInserted + totalExisted
                        });
                    }
                } catch (_e) { /* non-fatal */ }
                
                console.log(`[chunk-v12] JOB COMPLETE | apiCalls=${totalApiCalls} | inserted=${totalInserted} | existed=${totalExisted} | updated=${totalUpdated}`);
                return Response.json({ status: 'completed', job_id: jobId });
            } else {
                const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
                chunkTimings.push(chunkDuration);
                const progressPct = 80 + Math.round(((nextSubCircle + (nextOffset > 0 ? 0.5 : 0)) / totalSubCircles) * 20);

                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'listings_records', current_offset: nextOffset, current_sub_circle: nextSubCircle,
                    total_fetched: totalFetched, total_inserted: totalInserted, total_existed: totalExisted,
                    total_updated: totalUpdated, total_api_calls: totalApiCalls, progress_pct: progressPct,
                    zip_codes_found: zipCodesFound, chunk_number: nextChunkNumber,
                    chunk_timings: chunkTimings, error_log: errorLog
                });

                scheduleNextChunk();
                return Response.json({ status: 'running', phase: 'listings_records', job_id: jobId, sub_circle: currentSubCircle + 1 });
            }
        }

        // Unknown phase — fail gracefully
        logError(`Unknown phase: ${currentPhase}`);
        await base44.asServiceRole.entities.FetchJob.update(jobId, { status: 'failed', error_message: `Unknown phase: ${currentPhase}`, error_log: errorLog });
        return Response.json({ error: `Unknown phase: ${currentPhase}` });

    } catch (error) {
        console.error('[chunk-v12] FATAL:', error.message, error.stack);
        return Response.json({ error: error.message }, { status: 500 });
    }
});