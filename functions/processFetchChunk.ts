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

// How many API pages to process per chunk execution
const PAGES_PER_CHUNK = 15;
const LIMIT = 500;
const MAX_PARALLEL = 5;
const PROPERTY_TYPES = 'Single Family,Townhouse,Condo,Multi-Family,Duplex,Triplex,Fourplex,Apartment,Mobile Home,Cooperative,Timeshare';

Deno.serve(async (req) => {
    const startTime = Date.now();
    
    try {
        const base44 = createClientFromRequest(req);
        const body = await req.json();

        // Entity automation payload
        const event = body.event;
        const data = body.data;

        if (!event || !data) {
            return Response.json({ error: 'No event data' }, { status: 400 });
        }

        const jobId = event.entity_id;
        const eventType = event.type;

        // Only process on create or update events
        if (eventType !== 'create' && eventType !== 'update') {
            return Response.json({ skipped: true, reason: 'Not a create/update event' });
        }

        // Only process pending or running jobs
        if (data.status !== 'pending' && data.status !== 'running') {
            console.log(`[processFetchChunk] Job ${jobId} status=${data.status}, skipping.`);
            return Response.json({ skipped: true, reason: `Status is ${data.status}` });
        }

        if (!RENTCAST_API_KEY) {
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'failed', error_message: 'RENTCAST_API_KEY not configured'
            });
            return Response.json({ error: 'No API key' });
        }

        console.log(`[processFetchChunk] === Processing job ${jobId}, offset=${data.current_offset}, status=${data.status} ===`);

        // Mark as running
        if (data.status === 'pending') {
            await base44.asServiceRole.entities.FetchJob.update(jobId, { status: 'running' });
        }

        const { latitude, longitude, radius, polygon } = data;
        let currentOffset = data.current_offset || 0;
        let totalExpected = data.total_expected || 0;
        let totalFetched = data.total_fetched || 0;
        let totalInserted = data.total_inserted || 0;
        let totalExisted = data.total_existed || 0;
        let totalUpdated = data.total_updated || 0;
        let zipCodesFound = data.zip_codes_found || [];

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

        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

        // =====================================================================
        // FETCH PHASE: Get PAGES_PER_CHUNK pages from RentCast
        // =====================================================================
        const allRaw = [];
        let requestCount = 0;
        let reachedEnd = false;

        // If this is the first chunk, include totalCount header
        const includeTotal = currentOffset === 0;

        // Build fetch tasks for this chunk
        const offsets = [];
        for (let p = 0; p < PAGES_PER_CHUNK; p++) {
            offsets.push(currentOffset + p * LIMIT);
        }

        // Execute in parallel batches of MAX_PARALLEL
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
                if (offset === 0 && includeTotal) params.set('includeTotalCount', 'true');

                return fetch(`${RENTCAST_BASE}/properties?${params}`, {
                    headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
                }).then(async res => {
                    if (!res.ok) return { records: [], total: null };
                    const total = res.headers.get('X-Total-Count');
                    const records = await res.json();
                    return { records: Array.isArray(records) ? records : [], total };
                }).catch(() => ({ records: [], total: null }));
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
            if (i + MAX_PARALLEL < offsets.length) await sleep(100);
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
                if (!isNaN(saleDate) && saleDate > twelveMonthsAgo) {
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

            // Fetch existing records for dedup
            for (let i = 0; i < uniqueZips.length; i += 5) {
                if (Date.now() - startTime > 55000) break;
                const zipChunk = uniqueZips.slice(i, i + 5);
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

            // Bulk insert
            for (let i = 0; i < toInsert.length; i += 500) {
                if (Date.now() - startTime > 58000) {
                    console.warn(`[processFetchChunk] Time limit during DB writes`);
                    break;
                }
                const chunk = toInsert.slice(i, i + 500);
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
        // UPDATE JOB STATUS — triggers next chunk if not done
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
            // Job complete!
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
                // Fetch user to get current territory_zip_codes
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
            // More chunks needed — update job to trigger next chunk via entity automation
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running',
                current_offset: newOffset,
                total_expected: totalExpected,
                total_fetched: totalFetched,
                total_inserted: newTotalInserted,
                total_existed: newTotalExisted,
                total_updated: newTotalUpdated,
                progress_pct: progressPct,
                zip_codes_found: zipCodesFound
            });
            console.log(`[processFetchChunk] Updated job — next chunk will resume at offset ${newOffset} (${progressPct}%)`);
        }

        return Response.json({
            chunk_fetched: allRaw.length,
            chunk_inserted: chunkInserted,
            chunk_existed: chunkExisted,
            is_done: isDone,
            progress_pct: isDone ? 100 : progressPct
        });

    } catch (error) {
        console.error('[processFetchChunk] Fatal:', error);

        // Try to mark job as failed
        try {
            const base44 = createClientFromRequest(req);
            const body = await req.json().catch(() => ({}));
            if (body?.event?.entity_id) {
                await base44.asServiceRole.entities.FetchJob.update(body.event.entity_id, {
                    status: 'failed',
                    error_message: error.message
                });
            }
        } catch (e) { /* can't recover */ }

        return Response.json({ error: error.message }, { status: 500 });
    }
});