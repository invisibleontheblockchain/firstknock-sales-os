import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
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

// Non-disclosure states where sale prices are not required in public records
const NON_DISCLOSURE_STATES = new Set([
    'AK', 'ID', 'KS', 'LA', 'MS', 'MO', 'MT', 'NM', 'ND', 'TX', 'UT', 'WY'
]);

function isValidSoldProperty(p) {
    if (!p.lastSaleDate) return false;
    const isNonDisclosure = p.state && NON_DISCLOSURE_STATES.has(p.state.toUpperCase());

    if (!isNonDisclosure) {
        // Disclosure states: require realistic sale price
        if (p.lastSalePrice === null || p.lastSalePrice === undefined || p.lastSalePrice < 10000) return false;
        // Reject if sale price is suspiciously low vs assessed value (likely transfer, not a real sale)
        if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.3) return false;
    } else {
        // Non-disclosure states: allow null/zero price if we have a sale date
        // Still reject obvious non-arm's-length transfers (< $1000)
        if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice > 0 && p.lastSalePrice < 1000) return false;
    }

    const badTypes = ['Commercial', 'Industrial', 'Vacant Land', 'Agricultural'];
    if (p.propertyType && badTypes.includes(p.propertyType)) return false;
    return true;
}

const CORPORATE_KEYWORDS = ['LLC', 'INC', 'TRUST', 'HOLDINGS', 'BANK', 'PROPERTIES', 'CORP', 'COMPANY'];

/**
 * Compute sale confidence: high = genuine sale, medium = possible, low = likely not a real sale
 */
function computeSaleConfidence(p, isCorporate) {
    // Corporate buyer (bank, LLC, trust) = likely foreclosure or investment transfer
    if (isCorporate) return 'medium';
    // Very low price relative to assessed value = likely non-arm's-length transfer
    if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.5) return 'medium';
    // Strong signal: realistic price, personal buyer
    return 'high';
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
        // CRITICAL: sub_circles must be read from the job entity.
        // If missing (legacy jobs), fall back to a single circle.
        const subCircles = (job.sub_circles && job.sub_circles.length > 0) 
            ? job.sub_circles 
            : [{ lat: job.latitude, lng: job.longitude, radius: job.radius }];
        let currentSubCircle = job.current_sub_circle || 0;
        const totalSubCircles = job.total_sub_circles || subCircles.length;
        
        console.log(`[chunk-v10] sub_circles loaded: ${subCircles.length} circles, current=${currentSubCircle}, total=${totalSubCircles}, first_circle=${JSON.stringify(subCircles[0])}`);

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
            // Research finding: add +90 days to compensate for 30-90 day county deed recording lag
            // A home closed 90 days ago may not have its deed recorded yet — saleDateRange=180 captures it
            const saleDateRange = Math.min((monthsBack * 30) + 90, 730);
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
            const saleDateRange = Math.min((monthsBack * 30) + 90, 730);
            
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
            let phase2Stats = { total: 0, countyLagRejected: 0, heuristicRejected: 0, heuristicLikelySold: 0, ambiguousToBatchData: 0, crossRefVerified: 0 };

            for (const p of allRaw) {
                if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) continue;
                
                // Local filter: remove items where removedDate is too old
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
                // Research: If removed > 90 days ago and not in Phase 1 deeds, it's expired/withdrawn.
                // County deeds lag 30-90 days. If it hasn't appeared in deed records by now, it never sold.
                const daysSinceRemoved = Math.round((new Date().getTime() - removed.getTime()) / (1000 * 3600 * 24));
                if (daysSinceRemoved > 90) {
                    phase2Stats.countyLagRejected++;
                    // Don't even write these to DB — they're noise. Skip entirely.
                    continue;
                }

                // ── FILTER 2: Heuristic Scoring ──
                // Score each listing to classify as likely-sold, likely-expired, or ambiguous
                const dom = p.daysOnMarket || daysSinceRemoved;
                const listed = p.listedDate ? new Date(p.listedDate) : null;
                const lastSeen = p.lastSeenDate ? new Date(p.lastSeenDate) : null;
                const listingDuration = (listed && !isNaN(removed.getTime()) && !isNaN(listed.getTime())) 
                    ? Math.round((removed.getTime() - listed.getTime()) / (1000 * 3600 * 24)) 
                    : dom;

                let hScore = 0;

                // ══════════════════════════════════════════════════════════
                // RESEARCH-BACKED HEURISTIC SCORING MODEL
                // Per Deep Research Report: Zero-Cost Classification Pipeline
                // ══════════════════════════════════════════════════════════

                // ── AUTO-REJECT: Contract boundary clustering ──
                // Research: "Contract expirations are highly predictable. If it hits exactly
                // 180 days, the probability of it being an expiration approaches 99%.
                // Do not waste points here; filter it out immediately."
                const isContractBoundary = (
                    Math.abs(dom - 90) <= 3 || Math.abs(dom - 180) <= 3 || Math.abs(dom - 365) <= 3 ||
                    Math.abs(listingDuration - 90) <= 3 || Math.abs(listingDuration - 180) <= 3 || Math.abs(listingDuration - 365) <= 3
                );
                if (isContractBoundary) {
                    phase2Stats.heuristicRejected++;
                    // Auto-reject — don't write to DB
                    continue;
                }

                // ── Negative signals (expired/withdrawn indicators) ──

                // Extended market time = strong expired signal
                if (dom > 150) hScore -= 3;
                else if (dom > 60) hScore -= 2;

                // Ultra-short listing (< 7 days) = likely withdrawal/cancellation
                if (listingDuration < 7) hScore -= 1;

                // Abrupt same-day removal (lastSeenDate == removedDate)
                // Research: "-3 pts — Abrupt removals without a Pending transition
                // period are almost exclusively cancellations or withdrawals."
                if (lastSeen && Math.abs(lastSeen.getTime() - removed.getTime()) < 86400000) hScore -= 3;

                // Multiple listing history entries = prior failed attempts
                if (p.history && typeof p.history === 'object') {
                    const historyCount = Object.keys(p.history).length;
                    if (historyCount >= 3) hScore -= 1;
                }

                // ── Positive signals (sold indicators) ──
                // Fast removal (< 30 days DOM) = strongly correlates with accepted offer
                if (dom < 30) hScore += 3;

                // Short duration (< 45 days listing to removal) = consistent with sale closing
                if (listingDuration > 0 && listingDuration < 45) hScore += 2;

                // Gradual removal pattern (lastSeenDate >= 7 days before removedDate)
                // Research: "Sold listings typically follow a pattern where the listing remains
                // visible but inactive for a period (under contract/pending) before removal."
                if (lastSeen && (removed.getTime() - lastSeen.getTime()) >= 7 * 86400000) hScore += 1;

                // Single listing history = first attempt (higher sold probability)
                if (p.history && typeof p.history === 'object' && Object.keys(p.history).length === 1) hScore += 1;

                // ── Classification decision ──
                // Research thresholds:
                //   >= 3: LIKELY SOLD (75-85% confidence) — no BatchData needed
                //   1-2:  PROBABLY SOLD (60-70%) — classify with lower confidence
                //   -1-0: AMBIGUOUS — route to BatchData
                //   -2/-3: PROBABLY EXPIRED (60-70%) — classify expired
                //   <= -4: LIKELY EXPIRED (75-85%) — no BatchData needed
                let mlsConfidence = 'low';
                let origStatus = 'RECENT_OFF_MARKET';

                if (hScore <= -4) {
                    // Overwhelmingly expired/withdrawn — auto-reject, don't write to DB
                    phase2Stats.heuristicRejected++;
                    continue;
                } else if (hScore <= -2) {
                    // Probably expired — classify with low confidence flag
                    origStatus = 'PROBABLY_EXPIRED';
                    mlsConfidence = 'REJECTED';
                    phase2Stats.heuristicRejected++;
                    continue; // Skip DB write for probable expired too
                } else if (hScore >= 3) {
                    // Strong sold signals (75-85% confidence) — classify as sold WITHOUT BatchData
                    origStatus = 'HEURISTIC_SOLD';
                    mlsConfidence = 'medium';
                    phase2Stats.heuristicLikelySold++;
                } else if (hScore >= 1) {
                    // Probably sold (60-70% confidence) — classify with lower confidence
                    origStatus = 'HEURISTIC_SOLD';
                    mlsConfidence = 'low';
                    phase2Stats.heuristicLikelySold++;
                } else {
                    // Ambiguous: scores -1 to 0 — only THESE go to BatchData
                    phase2Stats.ambiguousToBatchData++;
                }

                mapped.push({
                    address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status: origStatus, beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.price || 0,
                    sold_date: p.removedDate || p.listedDate || null, sale_type: 'MLS', property_type: p.propertyType || 'Single Family', data_source: 'rentcast',
                    sale_confidence: mlsConfidence
                });
            }

            console.log(`[chunk-v10] Phase 2 heuristic stats: ${JSON.stringify(phase2Stats)}`);

            // ── Validation: Cross-Reference + Cache + Queue ──
            const BATCH_DATA_API_KEY = Deno.env.get("BATCH_DATA_API_KEY");
            // Skip expensive BatchData validation for free-tier 40mi/3mo pulls (sold_months <= 3)
            // Only run full validation for paid 300mi/1mo pulls
            const skipBatchDataValidation = monthsBack <= 3;
            if (skipBatchDataValidation) {
                console.log(`[chunk-v10] Skipping BatchData validation for ${monthsBack}-month pull (free tier). Ambiguous MLS records will be kept as low-confidence.`);
            }
            if (mapped.length > 0) {
                try {
                    const hashes = mapped.map(m => m.address_hash);
                    
                    // CROSS-REFERENCE: Check if any Phase 2 addresses already exist in MasterProperty
                    // from Phase 1 deed records. If so, they're confirmed sold — FREE verification.
                    const uniqueZips = [...new Set(mapped.map(m => m.zip_code))];
                    const deedHashSet = new Set();
                    for (let zi = 0; zi < uniqueZips.length; zi += 20) {
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

                    // Promote Phase 2 records that match Phase 1 deed hashes
                    for (const m of mapped) {
                        if (m.original_status !== 'REJECTED' && m.sale_confidence !== 'REJECTED' && deedHashSet.has(m.address_hash)) {
                            m.sale_confidence = 'verified';
                            m.original_status = 'DEED_CONFIRMED';
                            m.data_source = 'rentcast_crossref';
                            phase2Stats.crossRefVerified++;
                        }
                    }

                    // Check BatchData validation cache for remaining ambiguous records
                    // COST GUARD: Only run BatchData for paid 300mi pulls (sold_months > 3)
                    if (BATCH_DATA_API_KEY && !skipBatchDataValidation) {
                        const ambiguousHashes = mapped.filter(m => m.original_status === 'RECENT_OFF_MARKET' && m.sale_confidence === 'low').map(m => m.address_hash);
                        
                        if (ambiguousHashes.length > 0) {
                            const existingValidation = await base44.asServiceRole.entities.PropertyValidationCache.filter({
                                "address_hash__in": ambiguousHashes
                            }, null, ambiguousHashes.length * 2);
                            
                            const validationArr = Array.isArray(existingValidation) ? existingValidation : (existingValidation?.items || []);
                            const validationMap = new Map();
                            validationArr.forEach(v => validationMap.set(v.address_hash, v));

                            const cacheMisses = [];
                            for (const m of mapped) {
                                if (m.original_status !== 'RECENT_OFF_MARKET' || m.sale_confidence !== 'low') continue;
                                
                                const verified = validationMap.get(m.address_hash);
                                if (verified) {
                                    if (verified.status === 'sold') {
                                        m.sale_confidence = 'verified';
                                        m.data_source = 'batchdata_verified';
                                    } else {
                                        m.original_status = 'REJECTED';
                                        m.sale_confidence = 'REJECTED';
                                    }
                                } else {
                                    cacheMisses.push({
                                        address_hash: m.address_hash,
                                        normalized_address: `${m.house_number} ${m.street_name}, ${m.city}, ${m.state} ${m.zip_code}`,
                                        status: 'pending',
                                        provider_id: 'batchdata'
                                    });
                                }
                            }

                            // Process up to 100 genuinely ambiguous cache misses synchronously via BatchData
                            const allowedMisses = cacheMisses.slice(0, 100);
                            if (cacheMisses.length > 100) {
                                console.warn(`[chunk-v10] Capping BatchData sync requests at 100 (omitting ${cacheMisses.length - 100})`);
                            }

                            if (allowedMisses.length > 0) {
                                console.log(`[chunk-v10] Launching synchronous BatchData check for ${allowedMisses.length} ambiguous records...`);
                                
                                for (let b = 0; b < allowedMisses.length; b += 10) {
                                    const batch = allowedMisses.slice(b, b + 10);
                                    const promises = batch.map(async (cm) => {
                                        try {
                                            const url = 'https://api.batchdata.com/api/v1/property/search';
                                            const res = await fetch(url, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCH_DATA_API_KEY}` },
                                                body: JSON.stringify({ searchCriteria: { query: cm.normalized_address } })
                                            });
                                            if (!res.ok) return { hash: cm.address_hash, verifiedSold: false };
                                            
                                            const data = await res.json();
                                            const results = data?.results || {};
                                            // BatchData response structure: results.properties is an array
                                            const properties = results.properties || [];
                                            const prop = properties[0] || {};
                                            const listing = prop.listing || {};
                                            const transfer = prop.lastTransfer || prop.transfer || {};
                                            
                                            // Research: statusCategory DOES NOT EXIST on RentCast.
                                            // On BatchData, check listing.statusType, transfer data, and salePrice.
                                            const apiStatus = (listing.statusType || listing.status || '').toLowerCase();
                                            const salePrice = transfer.salePrice || listing.price || 0;
                                            const hasRecentTransfer = transfer.recordingDate && 
                                                ((Date.now() - new Date(transfer.recordingDate).getTime()) < 365 * 86400000);
                                            
                                            const isSold = apiStatus.includes('sold') || apiStatus.includes('closed') || 
                                                salePrice > 10000 || hasRecentTransfer;
                                            return { hash: cm.address_hash, verifiedSold: isSold };
                                        } catch (e) {
                                            return { hash: cm.address_hash, verifiedSold: false };
                                        }
                                    });
                                    
                                    const batchResults = await Promise.all(promises);
                                    
                                    const bdSoldHashes = new Set(batchResults.filter(r => r.verifiedSold).map(r => r.hash));
                                    const bdRejectedHashes = new Set(batchResults.filter(r => !r.verifiedSold).map(r => r.hash));
                                    
                                    for (const m of mapped) {
                                        if (bdSoldHashes.has(m.address_hash)) {
                                            m.sale_confidence = 'verified';
                                            m.original_status = 'BATCHDATA_CONFIRMED';
                                            m.data_source = 'batchdata_verified';
                                        } else if (bdRejectedHashes.has(m.address_hash)) {
                                            m.sale_confidence = 'REJECTED';
                                            m.original_status = 'REJECTED';
                                        }
                                    }
                                    
                                    // Sleep is already defined in this file
                                    await sleep(250);
                                }
                            }
                        }
                    }

                    console.log(`[chunk-v10] Phase 2 final stats: ${JSON.stringify(phase2Stats)}`);
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    logError(`Validation layer failed: ${errMsg}`);
                }
            }
            // ── End Validation ──

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