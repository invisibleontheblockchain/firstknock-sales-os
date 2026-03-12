import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { polygonToCells, latLngToCell } from 'npm:h3-js@4.1.0';

// v3 — Adds MLS Phase 2, better error logging, timing metrics, crash protection

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

function isPointInPolygon(point, vs) {
    if (!vs || vs.length < 3) return true;
    let x = point.lng, y = point.lat;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].lng, yi = vs[i].lat;
        let xj = vs[j].lng, yj = vs[j].lat;
        let intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Chunk config
const PAGES_PER_CHUNK = 20;
const LIMIT = 500;
const MAX_PARALLEL = 5;

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

        if (!job) {
            return Response.json({ idle: true, message: 'No active jobs' });
        }

        const jobId = job.id;
        const errorLog = job.error_log || [];
        const chunkTimings = job.chunk_timings || [];

        const logError = (msg) => {
            const entry = `[${new Date().toISOString()}] ${msg}`;
            errorLog.push(entry);
            console.error(entry);
            // Keep last 50 entries
            if (errorLog.length > 50) errorLog.splice(0, errorLog.length - 50);
        };

        if (!RENTCAST_API_KEY) {
            logError('RENTCAST_API_KEY not configured');
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'failed', error_message: 'RENTCAST_API_KEY not configured', error_log: errorLog
            });
            return Response.json({ error: 'No API key' });
        }

        const currentPhase = job.phase || 'deed_records';
        console.log(`[chunk-v3] Job ${jobId} | phase=${currentPhase} | offset=${job.current_offset} | chunk#=${job.chunk_number || 0}`);

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

        // Mark running + started_at
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

        // Sold cutoff — read from job, fallback to 12
        // Add 2-month buffer to account for courthouse recording delays (2-6 weeks)
        const monthsBack = job.sold_months || 12;
        const BUFFER_MONTHS = 2;
        const daysBack = (monthsBack + BUFFER_MONTHS) * 30;
        const soldCutoff = new Date();
        soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

        // Helper: filter point against polygon
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

        // ======================================================================
        // PHASE 1: DEED RECORDS (paginated /properties endpoint)
        // ======================================================================
        if (currentPhase === 'deed_records') {
            const allRaw = [];
            let requestCount = 0;
            let reachedEnd = false;

            const offsets = [];
            for (let p = 0; p < PAGES_PER_CHUNK; p++) {
                offsets.push(currentOffset + p * LIMIT);
            }

            for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
                if (Date.now() - chunkStart > 45000) {
                    console.warn(`[chunk-v3] Time budget hit at offset ${offsets[i]}`);
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

                    const url = `${RENTCAST_BASE}/properties?${params}`;
                    if (offset === offsets[0]) console.log(`[chunk-v3] Phase1 URL: ${url}`);

                    return fetch(url, {
                        headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
                    }).then(async res => {
                        if (!res.ok) {
                            const errText = await res.text().catch(() => 'no body');
                            logError(`API ${res.status} at offset ${offset}: ${errText}`);
                            if (res.status === 429) logError('RATE LIMITED — too many requests');
                            if (res.status === 401) logError('AUTH FAILED — check API key');
                            return { records: [], total: null, status: res.status };
                        }
                        const total = res.headers.get('X-Total-Count');
                        const records = await res.json();
                        return { records: Array.isArray(records) ? records : [], total, status: 200 };
                    }).catch(e => {
                        logError(`Fetch crash at offset ${offset}: ${e.message}`);
                        return { records: [], total: null, status: 0 };
                    });
                });

                const results = await Promise.all(promises);
                requestCount += results.length;
                totalApiCalls += results.length;

                // Check for fatal errors (all requests failed)
                const allFailed = results.every(r => r.status !== 200);
                if (allFailed && results.some(r => r.status === 401)) {
                    logError('All requests returned 401 — aborting job');
                    await base44.asServiceRole.entities.FetchJob.update(jobId, {
                        status: 'failed', error_message: 'RentCast API key invalid', error_log: errorLog, total_api_calls: totalApiCalls
                    });
                    return Response.json({ error: 'API auth failed' });
                }

                for (const r of results) {
                    if (r.total && !totalExpected) {
                        totalExpected = parseInt(r.total, 10);
                        console.log(`[chunk-v3] X-Total-Count: ${totalExpected}`);
                    }
                    allRaw.push(...r.records);
                    if (r.records.length < LIMIT) reachedEnd = true;
                }

                if (reachedEnd) break;
                if (i + MAX_PARALLEL < offsets.length) await sleep(50);
            }

            const newOffset = currentOffset + allRaw.length;
            totalFetched += allRaw.length;
            console.log(`[chunk-v3] Phase1 fetched ${allRaw.length} records (${requestCount} calls), offset now ${newOffset}`);

            // Map & filter
            const mapped = [];
            const seenHashes = new Set();

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
                    if (!isNaN(saleDate) && saleDate <= soldCutoff) {
                        original_status = 'ELIGIBLE';
                    }
                }

                const pZip = p.zipCode || '00000';
                const hash = p.id || `${p.addressLine1}-${pZip}`;
                if (seenHashes.has(hash)) continue;
                seenHashes.add(hash);

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

            // DB write
            let chunkInserted = 0, chunkExisted = 0, chunkUpdated = 0;

            if (mapped.length > 0) {
                const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
                const existingHashToId = new Map();

                for (let i = 0; i < uniqueZips.length; i += 20) {
                    if (Date.now() - chunkStart > 52000) break;
                    const zipChunk = uniqueZips.slice(i, i + 20);
                    const promises = zipChunk.map(zip =>
                        base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                            .then(res => {
                                const arr = Array.isArray(res) ? res : (res?.items || []);
                                arr.forEach(p => existingHashToId.set(p.address_hash, { id: p.id, status: p.original_status }));
                            })
                            .catch(e => logError(`DB zip lookup ${zip} failed: ${e.message}`))
                    );
                    await Promise.all(promises);
                }

                const toInsert = [];
                const soldUpdates = [];

                for (const p of mapped) {
                    const existing = existingHashToId.get(p.address_hash);
                    if (existing) {
                        chunkExisted++;
                        // Recency-wins: RentCast SOLD overrides any existing status
                        if (p.original_status === 'SOLD' && existing.status !== 'SOLD') {
                            soldUpdates.push({ id: existing.id, sold_date: p.sold_date, price: p.price });
                        }
                        // Hydrate: if existing record is UNVERIFIED or missing data, upgrade it
                        if (existing.status === 'UNVERIFIED' || existing.dataSource === 'csv_import') {
                            soldUpdates.push({
                                id: existing.id,
                                sold_date: p.sold_date,
                                price: p.price,
                                original_status: p.original_status,
                                data_source: 'rentcast',
                                sale_type: 'Deed',
                                city: p.city,
                                state: p.state,
                                zip_code: p.zip_code,
                                beds: p.beds,
                                baths: p.baths,
                                sqft: p.sqft,
                                lot_size: p.lot_size,
                                year_built: p.year_built,
                                property_type: p.property_type
                            });
                        }
                    } else {
                        toInsert.push(p);
                    }
                }

                for (let i = 0; i < toInsert.length; i += 1000) {
                    if (Date.now() - chunkStart > 55000) {
                        logError('Time limit hit during DB writes');
                        break;
                    }
                    const chunk = toInsert.slice(i, i + 1000);
                    try {
                        await base44.asServiceRole.entities.MasterProperty.bulkCreate(chunk);
                        chunkInserted += chunk.length;
                    } catch (e) {
                        logError(`Bulk insert failed: ${e.message}`);
                        for (let j = 0; j < chunk.length; j += 100) {
                            const small = chunk.slice(j, j + 100);
                            try {
                                await base44.asServiceRole.entities.MasterProperty.bulkCreate(small);
                                chunkInserted += small.length;
                            } catch (e2) { logError(`Small chunk insert failed: ${e2.message}`); }
                            await sleep(200);
                        }
                    }
                }

                for (let i = 0; i < Math.min(soldUpdates.length, 50); i++) {
                    if (Date.now() - chunkStart > 58000) break;
                    try {
                        await base44.asServiceRole.entities.MasterProperty.update(soldUpdates[i].id, {
                            original_status: 'SOLD', sold_date: soldUpdates[i].sold_date, price: soldUpdates[i].price
                        });
                        chunkUpdated++;
                    } catch (e) { /* skip */ }
                }
            }

            totalInserted += chunkInserted;
            totalExisted += chunkExisted;
            totalUpdated += chunkUpdated;

            const phase1Done = reachedEnd || (totalExpected > 0 && totalFetched >= totalExpected);
            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);

            console.log(`[chunk-v3] Phase1 chunk done in ${chunkDuration}s: ins=${chunkInserted}, exist=${chunkExisted}, upd=${chunkUpdated}`);

            if (phase1Done) {
                // Transition to MLS phase
                console.log(`[chunk-v3] Phase 1 COMPLETE — transitioning to MLS phase`);
                const nextChunk = (job.chunk_number || 0) + 1;
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    phase: 'mls_listings',
                    current_offset: 0,  // reset offset for MLS
                    total_expected: totalExpected,
                    total_fetched: totalFetched,
                    total_inserted: totalInserted,
                    total_existed: totalExisted,
                    total_updated: totalUpdated,
                    total_api_calls: totalApiCalls,
                    progress_pct: 70,  // Phase 1 = 70% of work
                    zip_codes_found: zipCodesFound,
                    chunk_number: nextChunk,
                    chunk_timings: chunkTimings,
                    error_log: errorLog
                });

                // Chain next chunk for MLS phase
                try {
                    base44.functions.invoke('processFetchChunk', {}).catch(() => {});
                } catch (e) { /* cron will pick up */ }
            } else {
                const progressPct = totalExpected > 0
                    ? Math.min(69, Math.round((totalFetched / totalExpected) * 70))
                    : 35;
                const nextChunk = (job.chunk_number || 0) + 1;

                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'deed_records',
                    current_offset: newOffset,
                    total_expected: totalExpected, total_fetched: totalFetched,
                    total_inserted: totalInserted, total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, progress_pct: progressPct,
                    zip_codes_found: zipCodesFound, chunk_number: nextChunk,
                    chunk_timings: chunkTimings, error_log: errorLog
                });

                try {
                    base44.functions.invoke('processFetchChunk', {}).catch(() => {});
                } catch (e) { /* cron will pick up */ }
            }

            return Response.json({
                job_id: jobId, phase: 'deed_records',
                chunk_fetched: allRaw.length, chunk_inserted: chunkInserted,
                chunk_existed: chunkExisted, chunk_duration_s: chunkDuration,
                is_phase_done: phase1Done
            });
        }

        // ======================================================================
        // PHASE 2: MLS SOLD LISTINGS (/listings/sale?status=Inactive)
        // ======================================================================
        if (currentPhase === 'mls_listings') {
            console.log(`[chunk-v3] Starting MLS Phase 2 — searching radius=${radius}mi`);

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
                        status: 'Inactive', daysOld: `0:${daysBack}`
                    });
                    if (offset === 0 && currentOffset === 0) params.set('includeTotalCount', 'true');

                    return fetch(`${RENTCAST_BASE}/listings/sale?${params}`, {
                        headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
                    }).then(async res => {
                        if (!res.ok) {
                            const errText = await res.text().catch(() => '');
                            logError(`MLS API ${res.status} at offset ${offset}: ${errText}`);
                            return { records: [], total: null };
                        }
                        const total = res.headers.get('X-Total-Count');
                        const records = await res.json();
                        return { records: Array.isArray(records) ? records : [], total };
                    }).catch(e => {
                        logError(`MLS fetch crash at offset ${offset}: ${e.message}`);
                        return { records: [], total: null };
                    });
                });

                const results = await Promise.all(promises);
                mlsRequestCount += results.length;

                let mlsTotalExpected = 0;
                for (const r of results) {
                    if (r.total) mlsTotalExpected = parseInt(r.total, 10);
                    allMls.push(...r.records);
                    if (r.records.length < LIMIT) mlsReachedEnd = true;
                }

                if (mlsReachedEnd) break;
                if (i + MAX_PARALLEL < mlsOffsets.length) await sleep(50);
            }

            totalApiCalls += mlsRequestCount;
            mlsApiCalls += mlsRequestCount;
            mlsFetched += allMls.length;
            console.log(`[chunk-v3] MLS fetched ${allMls.length} listings (${mlsRequestCount} calls)`);

            // Map MLS listings — only those inside polygon
            const mlsMapped = [];
            const seenMlsHashes = new Set();

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
                const hash = l.propertyId || l.id || `${addressLine}-${pZip}`;
                if (seenMlsHashes.has(hash)) continue;
                seenMlsHashes.add(hash);

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
                    mls_id: l.id || null, url: null,
                    data_source: 'rentcast'
                });
            }

            console.log(`[chunk-v3] MLS mapped ${mlsMapped.length} from ${allMls.length} raw`);

            // Dedup against existing DB
            let mlsInserted = 0;

            if (mlsMapped.length > 0) {
                const uniqueZips = [...new Set(mlsMapped.map(p => p.zip_code))];
                const existingHashes = new Set();

                for (let i = 0; i < uniqueZips.length; i += 20) {
                    if (Date.now() - chunkStart > 52000) break;
                    const zipChunk = uniqueZips.slice(i, i + 20);
                    const promises = zipChunk.map(zip =>
                        base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                            .then(res => {
                                const arr = Array.isArray(res) ? res : (res?.items || []);
                                arr.forEach(p => existingHashes.add(p.address_hash));
                            })
                            .catch(e => logError(`MLS DB lookup ${zip} failed: ${e.message}`))
                    );
                    await Promise.all(promises);
                }

                const toInsert = mlsMapped.filter(p => !existingHashes.has(p.address_hash));
                mlsNew += toInsert.length;
                console.log(`[chunk-v3] MLS: ${toInsert.length} new (${mlsMapped.length - toInsert.length} already existed)`);

                for (let i = 0; i < toInsert.length; i += 1000) {
                    if (Date.now() - chunkStart > 55000) break;
                    const chunk = toInsert.slice(i, i + 1000);
                    try {
                        await base44.asServiceRole.entities.MasterProperty.bulkCreate(chunk);
                        mlsInserted += chunk.length;
                    } catch (e) {
                        logError(`MLS bulk insert failed: ${e.message}`);
                        for (let j = 0; j < chunk.length; j += 100) {
                            const small = chunk.slice(j, j + 100);
                            try { await base44.asServiceRole.entities.MasterProperty.bulkCreate(small); mlsInserted += small.length; } catch {}
                            await sleep(200);
                        }
                    }
                }
            }

            totalInserted += mlsInserted;
            const mlsPhaseDone = mlsReachedEnd || allMls.length === 0;
            const chunkDuration = Math.round((Date.now() - chunkStart) / 1000);
            chunkTimings.push(chunkDuration);

            if (mlsPhaseDone) {
                // JOB COMPLETE
                const completedAt = new Date().toISOString();
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'completed', phase: 'complete',
                    current_offset: 0, total_inserted: totalInserted, total_existed: totalExisted,
                    total_updated: totalUpdated, total_api_calls: totalApiCalls,
                    mls_fetched: mlsFetched, mls_new: mlsNew, mls_api_calls: mlsApiCalls,
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

                console.log(`[chunk-v3] === JOB COMPLETE === deed=${totalFetched} mls=${mlsFetched} inserted=${totalInserted} existed=${totalExisted} apiCalls=${totalApiCalls}`);
            } else {
                const newMlsOffset = currentOffset + allMls.length;
                const nextChunk = (job.chunk_number || 0) + 1;
                await base44.asServiceRole.entities.FetchJob.update(jobId, {
                    status: 'running', phase: 'mls_listings',
                    current_offset: newMlsOffset, total_inserted: totalInserted,
                    total_existed: totalExisted, total_updated: totalUpdated,
                    total_api_calls: totalApiCalls, mls_fetched: mlsFetched,
                    mls_new: mlsNew, mls_api_calls: mlsApiCalls,
                    progress_pct: Math.min(99, 70 + Math.round((allMls.length / Math.max(1, allMls.length)) * 30)),
                    zip_codes_found: zipCodesFound, chunk_number: nextChunk,
                    chunk_timings: chunkTimings, error_log: errorLog
                });

                try {
                    base44.functions.invoke('processFetchChunk', {}).catch(() => {});
                } catch (e) { /* cron picks up */ }
            }

            return Response.json({
                job_id: jobId, phase: 'mls_listings',
                mls_fetched: allMls.length, mls_inserted: mlsInserted,
                chunk_duration_s: chunkDuration, is_done: mlsPhaseDone
            });
        }

        return Response.json({ error: 'Unknown phase', phase: currentPhase });

    } catch (error) {
        console.error('[chunk-v3] FATAL CRASH:', error.message, error.stack);
        // Try to mark job as failed
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
        } catch (e2) { console.error('[chunk-v3] Could not mark job failed:', e2.message); }
        return Response.json({ error: error.message }, { status: 500 });
    }
});