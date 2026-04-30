import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// v15 — "Clerk Gap" Architecture:
//   Phase 1 = 6-12 months of county deed records (verified ground truth)
//   Phase 2 = LAST 30 DAYS ONLY of MLS data (covers the courthouse recording gap)
//   • RentCast daysOld now set to 30 (was monthsBack*30+90 = 450+ days!)
//   • ALL Phase 2 survivors sent to BatchData for ground-truth verification
//   • No MLS property reaches the route without BatchData or deed confirmation
//   • Result: zero false "for sale sign" leads on routes
// v14 — BatchData Step 3 (partial — still pulled 12mo of MLS)
// v13 — Hardened MLS classifier (heuristic-only, no BatchData verification)
// v12 — Hybrid tiered BatchData: only DOM < 30 days gets medium confidence
// Architecture: Single sub-circle (40 sq mi ≈ 3.57mi radius), 2-phase (deeds + listings)
// Self-chain uses entity automation on FetchJob update instead of fire-and-forget setTimeout

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

// Configurable deed lag cutoff — default 120 days per Harris County worst-case research
// (90-day clerk backlog + 30-60 day RentCast propagation lag)
const DEED_LAG_CUTOFF_DAYS = parseInt(Deno.env.get("DEED_LAG_CUTOFF_DAYS") || '120', 10);

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
        // Raised floor from $10K → $30K. Under $30K in a disclosure state is almost always
        // a quitclaim / family transfer / tax sale, not an arm's-length sale → bad lead.
        if (p.lastSalePrice === null || p.lastSalePrice === undefined || p.lastSalePrice < 30000) return false;
        if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.3) return false;
    } else {
        if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice > 0 && p.lastSalePrice < 1000) return false;
    }
    const badTypes = ['Commercial', 'Industrial', 'Vacant Land', 'Agricultural'];
    if (p.propertyType && badTypes.includes(p.propertyType)) return false;
    return true;
}

// ── MLS Listing Sanity Check ──
// Reject listings that are clearly NOT a sale, AND require a POSITIVE sold signal
// before treating a listing as a likely sale. Previous version returned "clean" for
// any listing with no visible status signals — but RentCast's /listings/sale?status=Inactive
// endpoint routinely returns listings with NO status fields populated (we already
// filtered server-side). "No signal" is NOT the same as "sold" — it's ambiguous at best,
// and in the field it routinely turns out to be "seller withdrew / sign still up".
// This was the root cause of "first 5 doors had for-sale signs".
// Returns { reject: boolean, hasSoldSignal: boolean, reason: string }
function checkMlsListingSanity(p) {
    const signals = [];
    if (p.status) signals.push(String(p.status).toLowerCase());
    if (p.mlsStatus) signals.push(String(p.mlsStatus).toLowerCase());
    if (p.listingStatus) signals.push(String(p.listingStatus).toLowerCase());
    if (p.history && typeof p.history === 'object') {
        const entries = Object.values(p.history).slice(-3);
        for (const e of entries) {
            if (e && typeof e === 'object') {
                if (e.event) signals.push(String(e.event).toLowerCase());
                if (e.status) signals.push(String(e.status).toLowerCase());
            }
        }
    }
    const joined = signals.join(' ');

    // HARD REJECT — explicitly not a sale
    if (/\b(expired|withdrawn|cancell?ed|canceled|terminated|released)\b/.test(joined)) {
        return { reject: true, hasSoldSignal: false, reason: 'mls_non_sale_status' };
    }
    // HARD REJECT — under contract but not closed
    if (/\b(pending|contingent|under[ _-]?contract|active[ _-]?under[ _-]?contract)\b/.test(joined)) {
        return { reject: true, hasSoldSignal: false, reason: 'mls_pending_not_closed' };
    }
    // HARD REJECT — still active on market (for-sale sign definitely up)
    if (/\bactive\b/.test(joined) && !/\b(sold|closed)\b/.test(joined)) {
        return { reject: true, hasSoldSignal: false, reason: 'mls_still_active' };
    }

    // Positive sold signal required for high/medium-confidence classification
    const hasSoldSignal = /\b(sold|closed)\b/.test(joined);
    return { reject: false, hasSoldSignal, reason: null };
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
            console.log(`[chunk-v15] MUTEX: expected_chunk=${expectedChunk} but job is at chunk=${currentChunkNumber}. Duplicate invocation — skipping.`);
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

        console.log(`[chunk-v15] Job ${jobId} | phase=${currentPhase} | sub-circle=${currentSubCircle + 1}/${totalSubCircles} | offset=${job.current_offset} | chunk#=${currentChunkNumber}`);

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
        const phase1End = new Date();
        const phase1Start = new Date(phase1End);
        phase1Start.setMonth(phase1Start.getMonth() - monthsBack);
        const phase2End = new Date();
        const phase2Start = new Date(phase2End);
        phase2Start.setDate(phase2Start.getDate() - 30);
        console.log(`[chunk-v15] Date windows | phase1Start=${phase1Start.toISOString()} | phase1End=${phase1End.toISOString()} | phase2Start=${phase2Start.toISOString()} | phase2End=${phase2End.toISOString()}`);
        const filterPoint = (lat, lng) => (!polygon || polygon.length < 3) ? true : isPointInPolygon({ lat, lng }, polygon);

        let knockedHashesCache = null;
        async function loadKnockedHashes() {
            if (knockedHashesCache) return knockedHashesCache;
            knockedHashesCache = new Set();
            const logs = await base44.asServiceRole.entities.InteractionLog.list('-created_date', 10000).catch(e => {
                logError(`Delta sync knocked-log load failed: phase=delta api=InteractionLog.list error=${e.message}`);
                return [];
            });
            const logArr = Array.isArray(logs) ? logs : (logs?.items || []);
            for (const log of logArr) {
                if (log.address_hash && log.parsed_status) knockedHashesCache.add(log.address_hash);
            }
            console.log(`[chunk-v15] Delta sync loaded ${knockedHashesCache.size} knocked property hashes to preserve`);
            return knockedHashesCache;
        }

        // ── Helper: write mapped properties to DB ──
        async function writeToDb(mapped) {
            let chunkInserted = 0, chunkExisted = 0, chunkUpdated = 0;
            if (mapped.length === 0) return { chunkInserted, chunkExisted, chunkUpdated };

            const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
            const knockedHashes = isDeltaPull ? await loadKnockedHashes() : new Set();
            const existingHashToId = new Map();

            for (let i = 0; i < uniqueZips.length; i += 20) {
                if (Date.now() - chunkStart > 50000) break;
                const zipChunk = uniqueZips.slice(i, i + 20);
                const promises = zipChunk.map(zip =>
                    base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                        .then(res => {
                            const arr = Array.isArray(res) ? res : (res?.items || []);
                            arr.forEach(p => existingHashToId.set(p.address_hash, {
                                id: p.id,
                                soldDate: p.sold_date,
                                price: p.price,
                                saleConfidence: p.sale_confidence,
                                originalStatus: p.original_status,
                                routeActive: p.route_active !== false
                            }));
                        })
                        .catch(() => {})
                );
                await Promise.all(promises);
            }

            const toInsert = [], toUpdate = [];
            for (const p of mapped) {
                const existing = existingHashToId.get(p.address_hash);
                if (existing && knockedHashes.has(p.address_hash)) {
                    chunkExisted++;
                    console.log(`[chunk-v15] Delta sync skip knocked property: ${p.full_address || `${p.house_number} ${p.street_name}`} (${p.address_hash})`);
                    continue;
                }
                if (existing) {
                    chunkExisted++;
                    const existingSaleDate = existing.soldDate ? new Date(existing.soldDate) : new Date(0);
                    const incomingSaleDate = p.sold_date ? new Date(p.sold_date) : new Date(0);
                    const statusChanged = p.sale_confidence !== existing.saleConfidence || p.original_status !== existing.originalStatus;
                    const routeActiveChanged = p.route_active !== undefined && p.route_active !== existing.routeActive;
                    const shouldDeactivateRoute = p.route_active === false || p.original_status === 'REJECTED' || p.sale_confidence === 'REJECTED';

                    if (incomingSaleDate > existingSaleDate || statusChanged || routeActiveChanged || shouldDeactivateRoute) {
                        const { address_hash, ...updatePayload } = p;
                        toUpdate.push({ id: existing.id, ...updatePayload, ...(shouldDeactivateRoute ? { route_active: false } : {}) });
                    }
                } else if (p.route_active !== false && p.original_status !== 'REJECTED' && p.sale_confidence !== 'REJECTED') {
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

        // ── Helper: self-chain with mutex + retry-on-429 ──
        // Prior bug: when Base44 returned 429 Rate Limit on the self-invoke, the chain
        // died silently and the job sat in 'running' forever (classic "stuck at 91%").
        // Now we retry up to 5 times with exponential backoff (0.5s, 2s, 5s, 10s, 20s),
        // and if ALL attempts fail we bump the job into 'pending' so the watchdog /
        // next poll can resurrect it instead of leaving it permanently stalled.
        const nextChunkNumber = currentChunkNumber + 1;
        function scheduleNextChunk() {
            const delays = [500, 2000, 5000, 10000, 20000];
            let attempt = 0;
            const tryInvoke = () => {
                base44.functions.invoke('processFetchChunk', { expected_chunk: nextChunkNumber })
                    .catch(async (e) => {
                        const msg = e?.message || String(e);
                        const is429 = /429|rate limit/i.test(msg);
                        attempt++;
                        console.warn(`[chunk-v15] Self-chain attempt ${attempt}/${delays.length} failed (${is429 ? '429' : 'other'}): ${msg}`);
                        if (attempt < delays.length) {
                            setTimeout(tryInvoke, delays[attempt]);
                        } else {
                            // All retries exhausted — log the stall but leave status as 'running'
                            // so the scheduled "Cron Fetch Job Processor" automation (runs every
                            // 5 min) can resurrect the chain by invoking processFetchChunk again.
                            // We DON'T flip to 'pending' because the watchdog would then kill it
                            // based on its created_date (which is minutes-to-hours old by now).
                            try {
                                const recoveryLog = errorLog.slice();
                                recoveryLog.push(`[${new Date().toISOString()}] Self-chain failed after ${delays.length} retries: ${msg}. Awaiting cron resurrection.`);
                                // Bump updated_date so the watchdog's staleness clock resets
                                // (gives the cron a full 30-min window to resume before watchdog kills it).
                                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                                    error_log: recoveryLog
                                });
                                console.warn(`[chunk-v15] Job ${jobId} self-chain exhausted — cron will resume.`);
                            } catch (recoveryErr) {
                                console.error(`[chunk-v15] Could not log stall: ${recoveryErr.message}`);
                            }
                        }
                    });
            };
            setTimeout(tryInvoke, delays[0]);
        }

        // ======================================================================
        // PHASE 1: DEED RECORDS — /v1/properties?saleDateRange
        // ======================================================================
        if (currentPhase === 'deed_records') {
            // Phase 1 = deed ground-truth window only: [phase1Start] → [phase1End].
            // Do not pull or store older deed records for this job; they are outside the route window.
            const saleDateRange = Math.min(Math.ceil((phase1End.getTime() - phase1Start.getTime()) / (1000 * 3600 * 24)) + 1, 730);
            let reachedEnd = false;

            // OPT: Single-pass fetch+map. Previously we accumulated every raw record in `allRaw`
            // then looped again to map. At 5K records/chunk that's 2x memory + 2x iteration for
            // zero benefit. Now we map inline as each page arrives — same logic, half the memory.
            const mapped = [];
            const seenHashes = new Set();
            let rawFetchedThisChunk = 0; // tracks raw record count for offset advancement
            let rejectedByFilter = 0, rejectedByPolygon = 0, rejectedByDupe = 0;

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

                // Inline map — process each record immediately, don't buffer.
                for (const r of results) {
                    if (r.status !== 200) {
                        const apiCall = `${RENTCAST_BASE}/properties?saleDateRange=${saleDateRange}&offset=${currentOffset}`;
                        logError(`Phase 1 hard failure: phase=phase1 property=area api=${apiCall} status=${r.status}`);
                        throw new Error(`Phase 1 failed while fetching deed records (status ${r.status}). Not proceeding to Phase 2.`);
                    }
                    if (r.total && !totalExpected) totalExpected = parseInt(r.total, 10);
                    rawFetchedThisChunk += r.records.length;
                    if (r.records.length < LIMIT) reachedEnd = true;

                    for (const p of r.records) {
                        if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) { rejectedByPolygon++; continue; }
                        if (!isValidSoldProperty(p)) { rejectedByFilter++; continue; }
                        const saleDate = new Date(p.lastSaleDate);
                        if (isNaN(saleDate.getTime()) || saleDate < phase1Start || saleDate > phase1End) { rejectedByFilter++; continue; }
                        const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
                        const pZip = p.zipCode || '00000';
                        const hash = generateNormalizedHash(addressLine, pZip);
                        if (seenHashes.has(hash)) { rejectedByDupe++; continue; }
                        seenHashes.add(hash);
                        if (pZip && !zipCodesFound.includes(pZip)) zipCodesFound.push(pZip);

                        const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
                        const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
                        const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

                        const original_status = 'SOLD';

                        const corporate = isCorporateOwner(p);
                        const confidence = computeSaleConfidence(p, corporate);

                        mapped.push({
                            address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                            lat: p.latitude, lng: p.longitude, original_status, beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                            sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.lastSalePrice || 0,
                            sold_date: p.lastSaleDate || null, sale_type: corporate ? 'Corporate' : 'Deed', property_type: p.propertyType || 'Single Family', data_source: 'rentcast',
                            sale_confidence: confidence, route_active: true
                        });
                    }
                }

                if (reachedEnd) break;
                await sleep(300); // Gentler pacing between batches
            }

            totalFetched += rawFetchedThisChunk;
            console.log(`[chunk-v15] Phase 1 inline-mapped ${mapped.length}/${rawFetchedThisChunk} raw (polygon-rej=${rejectedByPolygon}, filter-rej=${rejectedByFilter}, dupe=${rejectedByDupe}, totalExpected=${totalExpected})`);
            if (rawFetchedThisChunk > 0 && mapped.length === 0) throw new Error('Phase 1 hard failure: zero deed records survived validation. Not proceeding to Phase 2.');

            const phase1UnionRecords = [...(job.phase1_union_records || []), ...mapped];
            const phase1UnionHashSet = new Set(phase1UnionRecords.map(p => p.address_hash).filter(Boolean));
            console.log(`[chunk-v15] Phase 1 union seed captured from current fetch: added=${mapped.length}, total=${phase1UnionRecords.length}, hashes=${phase1UnionHashSet.size}`);

            const dbResult = await writeToDb(mapped);
            totalInserted += dbResult.chunkInserted;
            totalExisted += dbResult.chunkExisted;
            totalUpdated += dbResult.chunkUpdated;

            const subCircleDone = reachedEnd || rawFetchedThisChunk === 0 || (totalExpected > 0 && (currentOffset + rawFetchedThisChunk) >= totalExpected);
            let nextSubCircle = currentSubCircle, nextOffset = currentOffset + rawFetchedThisChunk, nextPhase = 'deed_records';

            if (subCircleDone) {
                if (currentSubCircle < totalSubCircles - 1) {
                    nextSubCircle++;
                    nextOffset = 0;
                    totalExpected = 0;
                    console.log(`[chunk-v15] Phase 1 sub-circle ${currentSubCircle + 1} done, advancing to sub-circle ${nextSubCircle + 1}`);
                } else {
                    // v15: Phase 2 covers the "clerk gap" (last 30 days).
                    // Gated behind include_mls flag which is set by frontend based on
                    // paid subscription status. Free/trial users only get Phase 1 deeds.
                    const includeMls = job.include_mls !== false;
                    if (includeMls) {
                        nextPhase = 'listings_records';
                        nextSubCircle = 0;
                        nextOffset = 0;
                        totalExpected = 0;
                        console.log(`[chunk-v15] Phase 1 COMPLETE. Advancing to Phase 2 (MLS + verification) — paid user.`);
                    } else {
                        // Phase 2 explicitly disabled — complete with deeds only
                        console.log(`[chunk-v15] Phase 1 COMPLETE. Phase 2 skipped because include_mls=false.`);
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
                        return Response.json({ status: 'completed', job_id: jobId, phase: 'deed_only' });
                    }
                }
            } else {
            console.log(`[chunk-v15] Phase 1 sub-circle ${currentSubCircle + 1} needs more pages (nextOffset=${nextOffset})`);
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
                zip_codes_found: zipCodesFound, phase1_union_records: phase1UnionRecords, chunk_number: nextChunkNumber,
                chunk_timings: chunkTimings, error_log: errorLog
            });

            scheduleNextChunk();
            return Response.json({ status: 'running', phase: 'deed_records', job_id: jobId, sub_circle: currentSubCircle + 1, done: subCircleDone, fetched: rawFetchedThisChunk, mapped: mapped.length });
        }

        // ======================================================================
        // PHASE 2: LISTINGS RECORDS — /v1/listings/sale?status=Inactive
        // ======================================================================
        // ARCHITECTURE (v15): Phase 2 ONLY covers the "clerk gap" — the last
        // 30 days where county deeds haven't been recorded yet.
        //
        //   Phase 1 = 6-12 months of county deed records (verified ground truth)
        //   Phase 2 = LAST 30 DAYS ONLY of MLS data (covers the clerk gap)
        //
        // Previously this pulled (monthsBack * 30 + 90) = 450+ days of MLS data
        // which was the root cause of 80-90% false positives on routes.
        // Now we only ask RentCast for 30 days, and ALL survivors go to BatchData.
        // ======================================================================
        if (currentPhase === 'listings_records') {
            // FIXED: Only pull last 30 days of MLS data (the clerk gap)
            // Previously: Math.min((monthsBack * 30) + 90, 730) = 450+ days
            const MLS_CLERK_GAP_DAYS = 30;
            
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
                        daysOld: String(MLS_CLERK_GAP_DAYS)
                    });
                    if (offset === 0 && currentOffset === 0) params.set('includeTotalCount', 'true');
                    return fetchWithBackoff(`${RENTCAST_BASE}/listings/sale?${params}`, { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }, logError);
                });
                const results = await Promise.all(promises);
                totalApiCalls += results.length;
                for (const r of results) {
                    if (r.total && currentOffset === 0) console.log(`[chunk-v15] Phase 2 RentCast total available: ${parseInt(r.total, 10)} listings for last ${MLS_CLERK_GAP_DAYS} days`);
                    allRaw.push(...r.records);
                    if (r.records.length < LIMIT) reachedEnd = true;
                }
                if (reachedEnd) break;
                await sleep(300);
            }

            console.log(`[chunk-v15] Phase 2 fetched ${allRaw.length} raw MLS listings from last ${MLS_CLERK_GAP_DAYS} days (offset=${currentOffset})`);

            // ── Delta validation: load previously seen listingIds from this job's zip codes ──
            // This prevents reprocessing listings we've already classified on prior pulls
            let seenListingIds = null;
            if (isDeltaPull && allRaw.length > 0) {
                try {
                    seenListingIds = new Set();
                    // Check existing MasterProperty records for this area — any listing we already have
                    // with a data_source of 'rentcast' was already processed
                    const uniqueZips = [...new Set(allRaw.map(p => p.zipCode).filter(Boolean))];
                    for (let zi = 0; zi < uniqueZips.length; zi += 20) {
                        if (Date.now() - chunkStart > 35000) break;
                        const zipBatch = uniqueZips.slice(zi, zi + 20);
                        const promises = zipBatch.map(zip =>
                            base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip, data_source: 'rentcast' }, null, 5000)
                                .then(res => {
                                    const arr = Array.isArray(res) ? res : (res?.items || []);
                                    arr.forEach(mp => {
                                        if (mp.mls_id) seenListingIds.add(mp.mls_id);
                                    });
                                })
                                .catch(() => {})
                        );
                        await Promise.all(promises);
                    }
                    console.log(`[chunk-v15] Delta validation: loaded ${seenListingIds.size} previously seen listing IDs`);
                } catch (err) {
                    logError(`Delta validation load failed (non-fatal): ${err.message}`);
                    seenListingIds = null; // Disable delta check, process all
                }
            }

            // Phase 2 uses the runtime clerk-gap window: [phase2Start] → [phase2End].
            const mapped = [];
            const seenHashes = new Set();
            let phase2Stats = { total: 0, outsideWindowRejected: 0, heuristicRejected: 0, heuristicPassed: 0, ambiguousRejected: 0, batchdataVerified: 0, batchdataDropped: 0, deltaSkipped: 0, mlsStatusRejected: 0, deedCrossRef: 0 };

            for (const p of allRaw) {
                if (!p.latitude || !p.longitude || !filterPoint(p.latitude, p.longitude)) continue;
                
                if (!p.removedDate) continue;
                const removed = new Date(p.removedDate);
                if (isNaN(removed.getTime()) || removed < phase2Start || removed > phase2End) continue;

                // ── HARD GATE: Reject if MLS status signals clearly say "not sold" ──
                // Expired / Withdrawn / Cancelled / Pending / Active = for-sale sign still up.
                // This is THE biggest source of "rep knocked wrong house" complaints.
                const sanity = checkMlsListingSanity(p);
                if (sanity.reject) {
                    phase2Stats.mlsStatusRejected++;
                    continue;
                }
                // Track whether we saw a *positive* sold/closed signal. Used below
                // to gate HEURISTIC_SOLD classification — we never label a listing
                // as "sold" purely on DOM heuristics anymore.
                const hasSoldSignal = sanity.hasSoldSignal;

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

                // ── FILTER 0: Delta Validation — skip listings already processed ──
                // Uses listingId from RentCast to avoid reprocessing on subsequent pulls
                const listingId = p.id || p.listingId || null;
                if (listingId && seenListingIds && seenListingIds.has(listingId)) {
                    phase2Stats.deltaSkipped++;
                    continue;
                }

                // ── FILTER 1: 30-Day Window Enforcement ──
                // Since we only asked RentCast for 30 days, this is a safety net.
                // Anything somehow older than our clerk gap window gets dropped.
                const daysSinceRemoved = Math.round((phase2End.getTime() - removed.getTime()) / (1000 * 3600 * 24));
                if (removed < phase2Start || removed > phase2End) {
                    phase2Stats.outsideWindowRejected++;
                    continue;
                }

                const dom = p.daysOnMarket || daysSinceRemoved;
                const listed = p.listedDate ? new Date(p.listedDate) : null;
                const lastSeen = p.lastSeenDate ? new Date(p.lastSeenDate) : null;
                const listingDuration = (listed && !isNaN(removed.getTime()) && !isNaN(listed.getTime())) 
                    ? Math.round((removed.getTime() - listed.getTime()) / (1000 * 3600 * 24)) 
                    : dom;

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

                // Classification (v15) — Simplified for 30-day window
                // Since we're only pulling the last 30 days, every listing here is fresh.
                // The heuristic just filters out obvious garbage (withdrawn same-day, etc).
                // ALL survivors go to BatchData for ground-truth verification.
                // Nothing reaches the route unverified.
                let mlsConfidence = 'low';
                let origStatus = 'MLS_PENDING_VERIFICATION';

                if (hScore <= -2) {
                    // Clearly not sold — drop entirely
                    phase2Stats.heuristicRejected++;
                    continue;
                } else if (hScore <= 0) {
                    // Ambiguous — drop (not worth spending BatchData credits on)
                    phase2Stats.ambiguousRejected++;
                    continue;
                } else {
                    // Score > 0: survived heuristic, will be sent to BatchData
                    // If RentCast gave us an explicit sold signal, note it but still verify
                    origStatus = hasSoldSignal ? 'MLS_LIKELY_SOLD' : 'MLS_PENDING_VERIFICATION';
                    mlsConfidence = 'low'; // stays low until BatchData confirms
                    phase2Stats.heuristicPassed++;
                }

                mapped.push({
                    address_hash: hash, house_number, street_name, city: p.city || '', state: p.state || '', zip_code: pZip,
                    lat: p.latitude, lng: p.longitude, original_status: origStatus, beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                    sqft: p.squareFootage || 0, lot_size: p.lotSize || 0, year_built: p.yearBuilt || 0, price: p.price || 0,
                    sold_date: p.removedDate || p.listedDate || null, sale_type: 'MLS', property_type: p.propertyType || 'Single Family', data_source: 'rentcast',
                    sale_confidence: mlsConfidence,
                    mls_id: listingId || '',
                    route_active: true
                });
            }

            console.log(`[chunk-v15] Phase 2 stats (30-day window): ${JSON.stringify(phase2Stats)}`);

            // ── Cross-reference with Phase 1 deed records (FREE verification) ──
            const phase1DeedsForUnion = job.phase1_union_records || [];
            const phase1DeedHashSet = new Set(phase1DeedsForUnion.map(p => p.address_hash).filter(Boolean));
            console.log(`[chunk-v15] Phase 1 union seed loaded from current run memory: phase1=${phase1DeedsForUnion.length}, hashes=${phase1DeedHashSet.size}`);

            let crossRefCount = 0;
            for (const m of mapped) {
                if (phase1DeedHashSet.has(m.address_hash)) {
                    m.sale_confidence = 'verified';
                    m.original_status = 'DEED_CONFIRMED';
                    m.data_source = 'rentcast_crossref';
                    crossRefCount++;
                }
            }
            if (crossRefCount > 0) console.log(`[chunk-v15] Cross-ref verified ${crossRefCount} listings against deed records`);

            // ── Step 3: BatchData Verification — ALL Phase 2 MLS Listings ──
            // v15: Since Phase 2 now only pulls the last 30 days, there's no need
            // for a secondary date filter. ALL MLS listings that survived the
            // heuristic and aren't already deed-confirmed get sent to BatchData.
            // This is the ONLY way MLS data reaches the route — no exceptions.
            // Cost control is now handled by the 30-day MLS window — no artificial 50-record cap.
            const BATCH_DATA_API_KEY = Deno.env.get("BATCH_DATA_API_KEY");
            if (BATCH_DATA_API_KEY && mapped.length > 0) {
                // Send ALL non-deed-confirmed MLS listings to BatchData
                const ambiguousMls = mapped.filter(m => {
                    const removedDate = new Date(m.sold_date);
                    return m.sale_confidence === 'low' &&
                        removedDate >= phase2Start && removedDate <= phase2End &&
                        !phase1DeedHashSet.has(m.address_hash);
                });
                const batchdataCandidates = ambiguousMls;
                console.log(`[chunk-v15] Phase 2 BatchData candidates: ${batchdataCandidates.length} properties`);

                if (batchdataCandidates.length > 0) {
                    console.log(`[chunk-v15] Step 3: Sending ${batchdataCandidates.length} MLS listings to BatchData for verification`);
                    let bdVerified = 0, bdRejected = 0, bdErrors = 0;

                    try {
                        let batchDataAttempted = 0;
                        for (let b = 0; b < batchdataCandidates.length; b += 10) {
                            // Time guard — don't let BatchData calls push us past function timeout
                            if (Date.now() - chunkStart > 45000) {
                                console.log(`[chunk-v15] Step 3 time guard: stopping after ${b} BatchData calls (${Math.round((Date.now() - chunkStart) / 1000)}s elapsed)`);
                                break;
                            }

                            const batch = batchdataCandidates.slice(b, b + 10);
                            batchDataAttempted += batch.length;
                            const promises = batch.map(async (cm) => {
                                try {
                                    const query = `${cm.house_number} ${cm.street_name}, ${cm.city}, ${cm.state} ${cm.zip_code}`;
                                    const res = await fetch('https://api.batchdata.com/api/v1/property/search', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BATCH_DATA_API_KEY}` },
                                        body: JSON.stringify({
                                            searchCriteria: { query },
                                            options: {
                                                datasets: ['basic', 'listing', 'owner']
                                            }
                                        })
                                    });
                                    if (!res.ok) {
                                        // If credits exhausted (402) or auth failed (401), don't count as error per-record
                                        if (res.status === 402 || res.status === 401) {
                                            logError(`BatchData fatal failure: phase=phase2 property=${query} api=property/search status=${res.status}`);
                                            return { hash: cm.address_hash, outcome: 'api_error', status: res.status };
                                        }
                                        logError(`BatchData property failure: phase=phase2 property=${query} api=property/search status=${res.status}`);
                                        return { hash: cm.address_hash, outcome: 'skip' };
                                    }
                                    const data = await res.json();
                                    const properties = data?.results?.properties || [];
                                    const topResult = properties[0] || {};
                                    const listing = topResult.listing || data?.results?.listing || {};
                                    const owner = topResult.owner || {};
                                    
                                    // BatchData listing fields
                                    const apiStatus = (listing.status || '').toLowerCase();
                                    const statusCat = (listing.statusCategory || '').toLowerCase();
                                    const soldDate = listing.soldDate || null;

                                    // BatchData owner dataset field
                                    const ownerFullName = owner.fullName || owner.names?.[0]?.full || null;

                                    if (apiStatus.includes('sold') || statusCat === 'sold') {
                                        return { hash: cm.address_hash, outcome: 'sold', soldDate, ownerFullName };
                                    }
                                    if (statusCat === 'pending' || apiStatus.includes('pending') ||
                                        statusCat === 'expired' || apiStatus.includes('expired') ||
                                        statusCat === 'withdrawn' || apiStatus.includes('withdrawn')) {
                                        return { hash: cm.address_hash, outcome: 'rejected' };
                                    }
                                    // Cancelled, active, unknown, or no match → not sold
                                    return { hash: cm.address_hash, outcome: 'not_sold' };
                                } catch (e) {
                                    logError(`BatchData exception: phase=phase2 property=${cm.house_number} ${cm.street_name}, ${cm.city}, ${cm.state} ${cm.zip_code} api=property/search error=${e.message}`);
                                    return { hash: cm.address_hash, outcome: 'skip' };
                                }
                            });

                            const batchResults = await Promise.all(promises);
                            
                            // Check if we hit a fatal API error (credits/auth) — stop sending more
                            const fatalError = batchResults.find(r => r.outcome === 'api_error');
                            if (fatalError) {
                                logError(`Phase 2 partial failure: BatchData returned ${fatalError.status}; Phase 1 deed records remain committed and unverified MLS will be rejected.`);
                                console.warn(`[chunk-v15] Step 3 stopping: BatchData returned ${fatalError.status} — likely credits exhausted or auth issue`);
                                break;
                            }

                            for (const result of batchResults) {
                                const match = mapped.find(m => m.address_hash === result.hash);
                                if (!match) continue;

                                if (result.outcome === 'sold') {
                                    match.sale_confidence = 'verified';
                                    match.original_status = 'BATCHDATA_CONFIRMED';
                                    match.data_source = 'batchdata_verified';
                                    if (result.soldDate) match.sold_date = result.soldDate;
                                    if (result.ownerFullName) match.owner_full_name = result.ownerFullName;
                                    bdVerified++;
                                } else if (result.outcome === 'not_sold') {
                                    match.sale_confidence = 'REJECTED';
                                    match.original_status = 'REJECTED';
                                    bdRejected++;
                                } else if (result.outcome === 'pending' || result.outcome === 'rejected') {
                                    match.sale_confidence = 'REJECTED';
                                    match.original_status = 'REJECTED';
                                    bdRejected++;
                                } else {
                                    match.sale_confidence = 'REJECTED';
                                    match.original_status = 'REJECTED';
                                    bdErrors++;
                                }
                            }

                            // Rate-limit pacing — 250ms between batches of 10
                            if (b + 10 < batchdataCandidates.length) await sleep(250);
                        }

                        // Filter out BatchData-rejected listings
                        const preRejectCount = mapped.length;
                        const rejectedHashes = new Set(mapped.filter(m => m.original_status === 'REJECTED').map(m => m.address_hash));
                        // Don't splice mapped — just mark, writeToDb will handle filtering
                        
                        phase2Stats.batchdataVerified += bdVerified;
                        phase2Stats.batchdataDropped += bdRejected;
                        
                        console.log(`[chunk-v15] Step 3 BatchData credit usage: sent=${batchDataAttempted}, creditsConsumed=${batchDataAttempted}, verified=${bdVerified}, rejected=${bdRejected}, errors=${bdErrors}`);
                        console.log(`[chunk-v15] Step 3 results: ${bdVerified} verified sold, ${bdRejected} rejected (not sold/pending/expired/withdrawn), ${bdErrors} errors/skipped`);
                    } catch (err) {
                        // Non-fatal to the job, but unverified MLS must never pass through to routes.
                        logError(`Step 3 BatchData failed (phase2 only, deeds preserved): ${err.message}`);
                        for (const m of mapped) {
                            if (m.sale_confidence === 'low' && m.original_status !== 'DEED_CONFIRMED') {
                                m.sale_confidence = 'REJECTED';
                                m.original_status = 'REJECTED';
                            }
                        }
                    }
                } else {
                    console.log(`[chunk-v15] Step 3 skipped: no ambiguous MLS listings to verify`);
                }
            } else if (mapped.length > 0) {
                logError('Step 3 BatchData skipped: BATCH_DATA_API_KEY missing. Rejecting unverified MLS and preserving Phase 1 deeds.');
                for (const m of mapped) {
                    if (m.sale_confidence === 'low' && m.original_status !== 'DEED_CONFIRMED') {
                        m.sale_confidence = 'REJECTED';
                        m.original_status = 'REJECTED';
                    }
                }
            }

            // Deactivate existing rejected Phase 2 records without deleting their DB history.
            const rejectedForDeactivation = mapped
                .filter(m => m.original_status === 'REJECTED' || m.sale_confidence === 'REJECTED')
                .map(m => ({ ...m, route_active: false }));
            if (rejectedForDeactivation.length > 0) {
                const deactivationResult = await writeToDb(rejectedForDeactivation);
                totalExisted += deactivationResult.chunkExisted;
                totalUpdated += deactivationResult.chunkUpdated;
                console.log(`[chunk-v15] Delta sync deactivated ${deactivationResult.chunkUpdated} rejected existing route records; deed records preserved`);
            }

            // Age out stale Phase 2 records from prior runs that are now outside the 30-day clerk-gap window.
            // These records will not appear in the current RentCast 30-day MLS response, so they must be
            // explicitly deactivated during refetch if no Phase 1 deed record has since confirmed them.
            if (isDeltaPull) {
                const stalePhase2ForDeactivation = [];
                const staleCutoff = phase2Start;
                const lookupZips = [...new Set([...zipCodesFound, ...mapped.map(m => m.zip_code)].filter(Boolean))];

                for (let zi = 0; zi < lookupZips.length; zi += 20) {
                    if (Date.now() - chunkStart > 50000) break;
                    const zipBatch = lookupZips.slice(zi, zi + 20);
                    const promises = zipBatch.map(zip =>
                        base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                            .then(res => {
                                const arr = Array.isArray(res) ? res : (res?.items || []);
                                for (const existingProp of arr) {
                                    if (!existingProp.lat || !existingProp.lng || !filterPoint(existingProp.lat, existingProp.lng)) continue;
                                    if (phase1DeedHashSet.has(existingProp.address_hash)) continue;
                                    if (!['BATCHDATA_CONFIRMED', 'MLS_PENDING_VERIFICATION'].includes(existingProp.original_status)) continue;
                                    if (!existingProp.sold_date || new Date(existingProp.sold_date) >= staleCutoff) continue;
                                    if (existingProp.route_active === false) continue;

                                    stalePhase2ForDeactivation.push({
                                        ...existingProp,
                                        route_active: false,
                                        sale_confidence: 'REJECTED',
                                        original_status: 'REJECTED'
                                    });
                                }
                            })
                            .catch(e => logError(`Stale Phase 2 age-out lookup failed for zip ${zip}: ${e.message}`))
                    );
                    await Promise.all(promises);
                }

                if (stalePhase2ForDeactivation.length > 0) {
                    const staleResult = await writeToDb(stalePhase2ForDeactivation);
                    totalExisted += staleResult.chunkExisted;
                    totalUpdated += staleResult.chunkUpdated;
                    console.log(`[chunk-v15] Delta sync aged out ${staleResult.chunkUpdated} stale Phase 2 MLS records older than 30 days; no deed match found`);
                }
            }

            // Filter out REJECTED records (from heuristic scoring or BatchData Step 3)
            const finalMapped = mapped.filter(m => m.original_status !== 'REJECTED' && (m.original_status === 'DEED_CONFIRMED' || m.original_status === 'BATCHDATA_CONFIRMED' || m.sale_confidence === 'verified'));
            if (finalMapped.length < mapped.length) {
                console.log(`[chunk-v15] Filtered out ${mapped.length - finalMapped.length} REJECTED records before DB write`);
            }

            // Phase 1 + Phase 2 union before final write: deeds stay, verified MLS gap-fill joins, no duplicates.
            const unionByKey = new Map();
            let phase1KeyCollisions = 0;
            let phase1NullKeys = 0;

            const getUnionKey = (p) => {
                const fallback = generateNormalizedHash(p.full_address || `${p.house_number || ''} ${p.street_name || ''}`, p.zip_code || '00000');
                return String(p.parcel_id || p.apn || p.address_hash || fallback || '').trim();
            };

            for (const p of phase1DeedsForUnion) {
                const key = getUnionKey(p);
                if (!key) {
                    phase1NullKeys++;
                    console.warn(`[chunk-v15] Union key null — skipped: ${p.full_address || `${p.house_number || ''} ${p.street_name || ''}`}`);
                    continue;
                }

                if (unionByKey.has(key)) {
                    phase1KeyCollisions++;
                    const existing = unionByKey.get(key);
                    const existingDate = existing?.sold_date ? new Date(existing.sold_date) : new Date(0);
                    const incomingDate = p.sold_date ? new Date(p.sold_date) : new Date(0);
                    console.warn(`[chunk-v15] Union key collision — keeping newest sold_date for key=${key}`);
                    if (incomingDate > existingDate) unionByKey.set(key, p);
                    continue;
                }

                unionByKey.set(key, p);
            }
            for (const p of finalMapped) {
                const key = getUnionKey(p);
                if (key && !unionByKey.has(key)) unionByKey.set(key, p);
            }
            const combinedRouteCandidates = Array.from(unionByKey.values());
            console.log(`[chunk-v15] Phase union/dedup before write: phase1=${phase1DeedsForUnion.length}, phase2=${finalMapped.length}, combined=${combinedRouteCandidates.length}, phase1KeyCollisions=${phase1KeyCollisions}, phase1NullKeys=${phase1NullKeys}`);

            const dbResult = await writeToDb(combinedRouteCandidates);
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
                
                console.log(`[chunk-v15] JOB COMPLETE | apiCalls=${totalApiCalls} | inserted=${totalInserted} | existed=${totalExisted} | updated=${totalUpdated}`);
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
        console.error('[chunk-v15] FATAL:', error.message, error.stack);

        // Attempt to mark the job as failed so it doesn't stay stuck in 'running' forever
        try {
            const base44Recovery = createClientFromRequest(req);
            const stuckJobs = await base44Recovery.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 1);
            const stuckArr = Array.isArray(stuckJobs) ? stuckJobs : (stuckJobs?.items || []);
            if (stuckArr.length > 0) {
                const job = stuckArr[0];
                const existingLog = job.error_log || [];
                existingLog.push(`[${new Date().toISOString()}] FATAL: ${error.message}`);
                await base44Recovery.asServiceRole.entities.FetchJob.update(job.id, {
                    status: 'failed',
                    error_message: `Processing crashed: ${error.message}`,
                    error_log: existingLog
                });
                console.log(`[chunk-v15] Marked job ${job.id} as failed after fatal error`);
            }
        } catch (recoveryErr) {
            console.error('[chunk-v15] Could not mark job as failed during recovery:', recoveryErr.message);
        }

        return Response.json({ error: error.message }, { status: 500 });
    }
});