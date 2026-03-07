import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { polygonToCells, latLngToCell } from 'npm:h3-js@4.1.0';

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

// Chunk config — maximum throughput per invocation
const PAGES_PER_CHUNK = 60;
const LIMIT = 500;
const MAX_PARALLEL = 15;
const PROPERTY_TYPES = 'Single Family|Townhouse|Condo|Multi-Family|Manufactured|Apartment|Land';

Deno.serve(async (req) => {
    const startTime = Date.now();

    try {
        const base44 = createClientFromRequest(req);

        // =====================================================================
        // SCHEDULED POLLING: Find the next job that needs work
        // =====================================================================
        let job = null;

        // First look for 'running' jobs (resume in progress)
        const runningJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { status: 'running' }, '-updated_date', 1
        );
        const runningArr = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        if (runningArr.length > 0) {
            job = runningArr[0];
        }

        // Then look for 'pending' jobs (new job to start)
        if (!job) {
            const pendingJobs = await base44.asServiceRole.entities.FetchJob.filter(
                { status: 'pending' }, 'created_date', 1
            );
            const pendingArr = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
            if (pendingArr.length > 0) {
                job = pendingArr[0];
            }
        }

        if (!job) {
            console.log('[processFetchChunk] No pending/running jobs found. Sleeping.');
            return Response.json({ idle: true, message: 'No active jobs' });
        }

        const jobId = job.id;
        const data = job;

        if (!RENTCAST_API_KEY) {
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'failed', error_message: 'RENTCAST_API_KEY not configured'
            });
            return Response.json({ error: 'No API key' });
        }

        console.log(`[processFetchChunk] === Processing job ${jobId}, offset=${data.current_offset}, status=${data.status}, chunk#=${data.chunk_number || 0} ===`);

        const { latitude, longitude, radius, polygon } = data;
        let currentOffset = data.current_offset || 0;
        let totalExpected = data.total_expected || 0;
        let totalFetched = data.total_fetched || 0;
        let totalInserted = data.total_inserted || 0;
        let totalExisted = data.total_existed || 0;
        let totalUpdated = data.total_updated || 0;
        let zipCodesFound = data.zip_codes_found || [];

        // Mark job as running if it was pending
        if (data.status === 'pending') {
            await base44.asServiceRole.entities.FetchJob.update(jobId, { status: 'running' });
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
                console.warn("[processFetchChunk] H3 failed:", e.message);
            }
        }

        // Determine sold cutoff from user's preference (default 3 months)
        // This is used ONLY for tagging status as SOLD — NOT as an API filter
        let monthsBack = 3;
        try {
            const users = await base44.asServiceRole.entities.User.filter({ email: data.user_email }, null, 1);
            const userArr = Array.isArray(users) ? users : (users?.items || []);
            if (userArr.length > 0 && userArr[0].pull_months_back) {
                monthsBack = userArr[0].pull_months_back;
            }
        } catch (e) { console.warn('Could not fetch user prefs:', e.message); }
        
        const soldCutoff = new Date();
        soldCutoff.setMonth(soldCutoff.getMonth() - monthsBack);

        // =====================================================================
        // FETCH PHASE: Get PAGES_PER_CHUNK pages from RentCast
        // =====================================================================
        const allRaw = [];
        let requestCount = 0;
        let reachedEnd = false;

        const includeTotal = currentOffset === 0;

        const offsets = [];
        for (let p = 0; p < PAGES_PER_CHUNK; p++) {
            offsets.push(currentOffset + p * LIMIT);
        }

        for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
            if (Date.now() - startTime > 45000) {
                console.warn(`[processFetchChunk] Time budget hit at offset ${offsets[i]}`);
                break;
            }

            const batch = offsets.slice(i, i + MAX_PARALLEL);
            const promises = batch.map(offset => {
                const params = new URLSearchParams({
                    latitude: String(latitude), longitude: String(longitude),
                    radius: String(radius), limit: String(LIMIT), offset: String(offset),
                    propertyType: PROPERTY_TYPES,
                });
                // Don't filter by saleDateRange — we want ALL properties in the area
                // The sold_date tagging happens post-fetch based on monthsBack
                if (offset === 0 && includeTotal) params.set('includeTotalCount', 'true');

                const url = `${RENTCAST_BASE}/properties?${params}`;
                if (offset === 0) console.log(`[processFetchChunk] API URL: ${url}`);

                return fetch(url, {
                    headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
                }).then(async res => {
                    if (!res.ok) {
                        const errText = await res.text().catch(() => 'no body');
                        console.error(`[processFetchChunk] API error ${res.status} at offset ${offset}: ${errText}`);
                        return { records: [], total: null };
                    }
                    const total = res.headers.get('X-Total-Count');
                    const records = await res.json();
                    if (offset === 0) console.log(`[processFetchChunk] First page: ${Array.isArray(records) ? records.length : 0} records, X-Total-Count: ${total}`);
                    return { records: Array.isArray(records) ? records : [], total };
                }).catch(e => {
                    console.error(`[processFetchChunk] Fetch error at offset ${offset}:`, e.message);
                    return { records: [], total: null };
                });
            });

            const results = await Promise.all(promises);
            requestCount += results.length;

            for (const r of results) {
                if (r.total && !totalExpected) {
                    totalExpected = parseInt(r.total, 10);
                    console.log(`[processFetchChunk] X-Total-Count: ${totalExpected}`);
                }
                allRaw.push(...r.records);
                if (r.records.length < LIMIT) reachedEnd = true;
            }

            if (reachedEnd) break;
            if (i + MAX_PARALLEL < offsets.length) await sleep(50);

        }

        const newOffset = currentOffset + allRaw.length;
        totalFetched += allRaw.length;
        console.log(`[processFetchChunk] Fetched ${allRaw.length} records (${requestCount} calls), new offset=${newOffset}, totalFetched=${totalFetched}`);

        // =====================================================================
        // MAP & FILTER PHASE
        // =====================================================================
        const mapped = [];
        const seenHashes = new Set();
        let chunkInserted = 0;
        let chunkExisted = 0;
        let chunkUpdated = 0;

        for (const p of allRaw) {
            if (polygon && polygon.length >= 3) {
                if (!p.latitude || !p.longitude) continue;
                if (useH3Filter) {
                    try {
                        const cell = latLngToCell(p.latitude, p.longitude, 9);
                        if (!polygonH3Cells.has(cell)) continue;
                    } catch (e) { continue; }
                }
                if (!isPointInPolygon({ lat: p.latitude, lng: p.longitude }, polygon)) continue;
            }

            if (!(p.addressLine1 || p.formattedAddress) || !p.latitude || !p.longitude) continue;

            const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : "");
            const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
            const house_number = addressMatch ? parseInt(addressMatch[1]) : 0;
            const street_name = addressMatch ? addressMatch[2] : (addressLine || "Unknown");

            let original_status = 'ELIGIBLE';
            if (p.lastSaleDate) {
                const saleDate = new Date(p.lastSaleDate);
                if (!isNaN(saleDate) && saleDate > soldCutoff) {
                    original_status = 'SOLD';
                }
            }

            const pZip = p.zipCode || '00000';
            const hash = p.id || `${p.addressLine1}-${pZip}`;

            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);

            if (pZip && !zipCodesFound.includes(pZip)) {
                zipCodesFound.push(pZip);
            }

            mapped.push({
                address_hash: hash, house_number, street_name,
                full_address: p.formattedAddress || p.addressLine1,
                city: p.city || '', state: p.state || '', zip_code: pZip,
                lat: p.latitude, lng: p.longitude, original_status,
                beds: p.bedrooms || 0, baths: p.bathrooms || 0,
                sqft: p.squareFootage || 0, lot_size: p.lotSize || 0,
                year_built: p.yearBuilt || 0, price: p.lastSalePrice || p.price || 0,
                sold_date: p.lastSaleDate || null, sale_type: 'Market',
                property_type: p.propertyType || 'Single Family',
                mls_id: p.assessorID || null, url: null
            });
        }

        console.log(`[processFetchChunk] Mapped ${mapped.length} properties from ${allRaw.length} raw records`);

        // =====================================================================
        // DB WRITE PHASE: Dedup and insert
        // =====================================================================
        if (mapped.length > 0) {
            const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
            const existingHashToId = new Map();

            for (let i = 0; i < uniqueZips.length; i += 10) {
                if (Date.now() - startTime > 55000) break;
                const zipChunk = uniqueZips.slice(i, i + 10);
                const promises = zipChunk.map(zip =>
                    base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                        .then(res => {
                            const arr = Array.isArray(res) ? res : (res?.items || []);
                            arr.forEach(p => existingHashToId.set(p.address_hash, { id: p.id, status: p.original_status }));
                        })
                        .catch(e => console.warn(`Fetch zip ${zip} failed:`, e.message))
                );
                await Promise.all(promises);
            }

            const toInsert = [];
            const soldUpdates = [];

            for (const p of mapped) {
                const existing = existingHashToId.get(p.address_hash);
                if (existing) {
                    chunkExisted++;
                    if (p.original_status === 'SOLD' && existing.status !== 'SOLD') {
                        soldUpdates.push({ id: existing.id, sold_date: p.sold_date, price: p.price });
                    }
                } else {
                    toInsert.push(p);
                }
            }

            // Bulk insert — larger batches for speed
            for (let i = 0; i < toInsert.length; i += 1000) {
                if (Date.now() - startTime > 58000) {
                    console.warn(`[processFetchChunk] Time limit during DB writes`);
                    break;
                }
                const chunk = toInsert.slice(i, i + 1000);
                try {
                    await base44.asServiceRole.entities.MasterProperty.bulkCreate(chunk);
                    chunkInserted += chunk.length;
                } catch (e) {
                    console.warn(`Bulk insert failed, retrying smaller:`, e.message);
                    await sleep(500);
                    for (let j = 0; j < chunk.length; j += 100) {
                        const small = chunk.slice(j, j + 100);
                        try {
                            await base44.asServiceRole.entities.MasterProperty.bulkCreate(small);
                            chunkInserted += small.length;
                        } catch (e2) { console.warn('Small chunk failed:', e2.message); }
                        await sleep(200);
                    }
                }
            }

            // Sold status updates (limited)
            for (let i = 0; i < Math.min(soldUpdates.length, 30); i++) {
                if (Date.now() - startTime > 60000) break;
                try {
                    await base44.asServiceRole.entities.MasterProperty.update(soldUpdates[i].id, {
                        original_status: 'SOLD', sold_date: soldUpdates[i].sold_date, price: soldUpdates[i].price
                    });
                    chunkUpdated++;
                } catch (e) { /* silent */ }
            }
        }

        // =====================================================================
        // UPDATE JOB STATUS
        // =====================================================================
        const newTotalInserted = totalInserted + chunkInserted;
        const newTotalExisted = totalExisted + chunkExisted;
        const newTotalUpdated = totalUpdated + chunkUpdated;
        const progressPct = totalExpected > 0
            ? Math.min(99, Math.round((totalFetched / totalExpected) * 100))
            : (reachedEnd ? 100 : 50);

        const isDone = reachedEnd || (totalExpected > 0 && totalFetched >= totalExpected);

        console.log(`[processFetchChunk] Chunk done: inserted=${chunkInserted}, existed=${chunkExisted}, updated=${chunkUpdated}`);
        console.log(`[processFetchChunk] Totals: fetched=${totalFetched}/${totalExpected}, inserted=${newTotalInserted}, existed=${newTotalExisted}, done=${isDone}`);

        if (isDone) {
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'completed',
                current_offset: newOffset,
                total_expected: totalExpected,
                total_fetched: totalFetched,
                total_inserted: newTotalInserted,
                total_existed: newTotalExisted,
                total_updated: newTotalUpdated,
                progress_pct: 100,
                zip_codes_found: zipCodesFound
            });

            // Update user's territory data
            try {
                const users = await base44.asServiceRole.entities.User.filter({ email: data.user_email }, null, 1);
                const userArr = Array.isArray(users) ? users : (users?.items || []);
                if (userArr.length > 0) {
                    const currentZips = userArr[0].territory_zip_codes || [];
                    const mergedZips = [...new Set([...zipCodesFound, ...currentZips])];
                    await base44.asServiceRole.entities.User.update(userArr[0].id, {
                        territory_zip_codes: mergedZips,
                        has_pulled_data: true,
                        has_defined_market: true,
                        territory_property_count: newTotalInserted + newTotalExisted,
                        last_data_pull: new Date().toISOString()
                    });
                }
            } catch (e) {
                console.error('Failed to update user:', e.message);
            }

            console.log(`[processFetchChunk] === JOB COMPLETE === ${newTotalInserted} inserted, ${newTotalExisted} existed, ${newTotalUpdated} updated`);
        } else {
            // Just update progress — the cron scheduler will pick up the next chunk
            const nextChunkNumber = (data.chunk_number || 0) + 1;
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running',
                current_offset: newOffset,
                total_expected: totalExpected,
                total_fetched: totalFetched,
                total_inserted: newTotalInserted,
                total_existed: newTotalExisted,
                total_updated: newTotalUpdated,
                progress_pct: progressPct,
                zip_codes_found: zipCodesFound,
                chunk_number: nextChunkNumber
            });
            console.log(`[processFetchChunk] Chunk #${nextChunkNumber} saved — cron will resume at offset ${newOffset} (${progressPct}%)`);
        }

        return Response.json({
            job_id: jobId,
            chunk_fetched: allRaw.length,
            chunk_inserted: chunkInserted,
            chunk_existed: chunkExisted,
            is_done: isDone,
            progress_pct: isDone ? 100 : progressPct
        });

    } catch (error) {
        console.error('[processFetchChunk] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});