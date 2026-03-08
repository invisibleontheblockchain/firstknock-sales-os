import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * processRegridChunk — V2 Regrid-native chunk processor
 * 
 * Replaces processFetchChunk (RentCast) for V2 pipeline.
 * Queries Regrid API paginated by polygon, normalizes data,
 * and upserts into MasterProperty entities.
 * 
 * Compatible with FetchJob polling pattern used by TerritoryPrompt.
 * 
 * Architecture:
 *   1. Find pending/running FetchJob with data_source='regrid'
 *   2. Query Regrid API with pagination (offset_id)
 *   3. Normalize parcels → MasterProperty schema
 *   4. Dedup + bulk insert
 *   5. Update FetchJob progress (self-chains for next chunk)
 */

const REGRID_TOKEN = Deno.env.get("REGRID_TOKEN");
const REGRID_BASE = "https://app.regrid.com/api/v2";
const PARCELS_PER_PAGE = 1000; // Regrid hard cap
const PAGES_PER_CHUNK = 5;    // 5 pages per serverless invocation = 5,000 parcels
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getBackoffDelay(attempt: number) {
    return BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
}

async function regridFetchPage(endpoint: string, params: Record<string, string>) {
    const url = new URL(`${REGRID_BASE}${endpoint}`);
    url.searchParams.set('token', REGRID_TOKEN!);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(url.toString());
        
        if (res.ok) {
            const data = await res.json();
            return data.parcels?.features || data.features || [];
        }
        
        if (res.status === 429) {
            if (attempt === MAX_RETRIES) throw new Error('Regrid rate limit exceeded');
            const retryAfter = res.headers.get('Retry-After');
            const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : getBackoffDelay(attempt);
            console.warn(`[processRegridChunk] 429 rate limited. Waiting ${Math.round(waitMs)}ms`);
            await sleep(waitMs);
            continue;
        }
        
        const text = await res.text();
        throw new Error(`Regrid API error ${res.status}: ${text}`);
    }
    return [];
}

/**
 * Categorize property type from Regrid use description
 */
function categorizeType(usedesc: string, zoningSubtype: string): string {
    const desc = (usedesc || '').toLowerCase();
    const zoning = (zoningSubtype || '').toLowerCase();
    if (desc.includes('single') || desc.includes('one family') || zoning.includes('single')) return 'Single Family';
    if (desc.includes('condo')) return 'Condo';
    if (desc.includes('townhouse') || desc.includes('town house')) return 'Townhouse';
    if (desc.includes('multi') || desc.includes('duplex') || desc.includes('triplex')) return 'Multi-Family';
    if (desc.includes('mobile') || desc.includes('manufactured')) return 'Manufactured';
    if (desc.includes('residential') || desc.includes('res ')) return 'Single Family';
    return 'Single Family';
}

/**
 * Normalize a Regrid feature to MasterProperty entity schema
 */
function normalizeToMasterProperty(feature: any) {
    const f = feature.properties?.fields || feature.properties || {};
    const geom = feature.geometry;

    const addressLine = f.address || '';
    const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
    const houseNumber = addressMatch ? parseInt(addressMatch[1]) : 0;
    const streetName = addressMatch ? addressMatch[2] : (addressLine || 'Unknown');
    const zip = f.szip || f.szip5 || '00000';
    const hash = f.ll_uuid || `${addressLine}-${zip}`;

    // Determine sold status from sale date
    let originalStatus = 'ELIGIBLE';
    const soldDate = f.saledate || f.last_ownership_transfer_date || null;
    if (soldDate) {
        const saleDate = new Date(soldDate);
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        if (!isNaN(saleDate.getTime()) && saleDate >= twelveMonthsAgo) {
            originalStatus = 'SOLD';
        }
    }

    // ROW exclusion (right-of-way)
    const isROW = (f.ll_row_parcel || '').toLowerCase() === 'true' || f.ll_row_parcel === true;

    return {
        address_hash: hash,
        house_number: houseNumber,
        street_name: streetName,
        full_address: `${addressLine}, ${f.scity || ''}, ${f.state2 || ''} ${zip}`.trim(),
        city: f.scity || f.city || '',
        state: f.state2 || '',
        zip_code: zip,
        lat: parseFloat(f.lat) || (geom?.coordinates ? geom.coordinates[1] : null),
        lng: parseFloat(f.lon) || (geom?.coordinates ? geom.coordinates[0] : null),
        original_status: originalStatus,
        beds: f.num_bedrooms ? Number(f.num_bedrooms) : 0,
        baths: f.num_bath ? Number(f.num_bath) : 0,
        sqft: f.sqft ? Number(f.sqft) : 0,
        lot_size: f.ll_gisacre ? Number(f.ll_gisacre) : 0,
        year_built: f.yearbuilt ? Number(f.yearbuilt) : 0,
        price: f.saleprice ? Number(f.saleprice) : 0,
        sold_date: soldDate,
        sale_type: 'Market',
        property_type: categorizeType(f.usedesc, f.zoning_subtype),
        mls_id: null,
        url: null,
        // V2 Regrid-specific fields
        regrid_id: f.ll_uuid || null,
        owner_name: f.eo_owner || f.owner || '',
        mailing_address: f.mailadd || '',
        assessed_value: f.parval ? Number(f.parval) : null,
        // Skip ROW parcels
        _is_row: isROW,
    };
}

Deno.serve(async (req) => {
    const startTime = Date.now();

    try {
        const base44 = createClientFromRequest(req);

        // ═══════════════════════════════════════════════════════
        // FIND NEXT REGRID JOB
        // ═══════════════════════════════════════════════════════
        let job: any = null;

        // Look for running Regrid jobs first
        const runningJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { status: 'running', data_source: 'regrid' }, '-updated_date', 1
        );
        const runningArr = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        if (runningArr.length > 0) job = runningArr[0];

        // Then look for pending Regrid jobs
        if (!job) {
            const pendingJobs = await base44.asServiceRole.entities.FetchJob.filter(
                { status: 'pending', data_source: 'regrid' }, 'created_date', 1
            );
            const pendingArr = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
            if (pendingArr.length > 0) job = pendingArr[0];
        }

        if (!job) {
            console.log('[processRegridChunk] No Regrid jobs found. Sleeping.');
            return Response.json({ idle: true, message: 'No active Regrid jobs' });
        }

        const jobId = job.id;

        if (!REGRID_TOKEN) {
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'failed', error_message: 'REGRID_TOKEN not configured'
            });
            return Response.json({ error: 'REGRID_TOKEN not set' }, { status: 500 });
        }

        console.log(`[processRegridChunk] Processing job ${jobId}, source=regrid, progress=${job.progress_pct || 0}%`);

        // Mark as running if pending
        if (job.status === 'pending') {
            await base44.asServiceRole.entities.FetchJob.update(jobId, { status: 'running' });
        }

        // ═══════════════════════════════════════════════════════
        // QUERY REGRID API — PAGINATED
        // ═══════════════════════════════════════════════════════
        const { polygon, geojson_polygon } = job;
        let offsetId = job.current_offset || 0;
        let totalFetched = job.total_fetched || 0;
        let totalInserted = job.total_inserted || 0;
        let totalExisted = job.total_existed || 0;
        let totalUpdated = job.total_updated || 0;
        let zipCodesFound = job.zip_codes_found || [];

        const allFeatures: any[] = [];
        let pagesProcessed = 0;
        let reachedEnd = false;

        for (let page = 0; page < PAGES_PER_CHUNK; page++) {
            if (Date.now() - startTime > 45000) {
                console.warn('[processRegridChunk] Time budget hit');
                break;
            }

            // Build query — use the polygon center point with large radius
            // Once PostGIS is available, this will use ST_Within with the polygon directly
            const centerLat = polygon?.reduce((s: number, p: any) => s + p.lat, 0) / (polygon?.length || 1);
            const centerLng = polygon?.reduce((s: number, p: any) => s + p.lng, 0) / (polygon?.length || 1);

            const params: Record<string, string> = {
                lat: String(centerLat),
                lon: String(centerLng),
                radius: '16093', // ~10 miles in meters (conservative)
                limit: String(PARCELS_PER_PAGE),
                return_enhanced_ownership: 'true',
                return_stacked: 'false',
            };

            if (offsetId > 0) {
                params.offset_id = String(offsetId);
            }

            const features = await regridFetchPage('/parcels/point', params);
            pagesProcessed++;

            if (features.length === 0) {
                reachedEnd = true;
                break;
            }

            allFeatures.push(...features);
            totalFetched += features.length;

            // Get ogc_fid from last record for cursor pagination
            const lastFeature = features[features.length - 1];
            const lastOgcFid = lastFeature.properties?.fields?.ogc_fid || lastFeature.properties?.ogc_fid;
            if (!lastOgcFid) {
                reachedEnd = true;
                break;
            }
            offsetId = lastOgcFid;

            if (features.length < PARCELS_PER_PAGE) {
                reachedEnd = true;
                break;
            }

            // Rate limiting between pages
            await sleep(350);
        }

        console.log(`[processRegridChunk] Fetched ${allFeatures.length} features (${pagesProcessed} pages)`);

        // ═══════════════════════════════════════════════════════
        // NORMALIZE + FILTER + POINT-IN-POLYGON
        // ═══════════════════════════════════════════════════════
        const mapped: any[] = [];
        const seenHashes = new Set<string>();
        let chunkInserted = 0;
        let chunkExisted = 0;

        for (const feature of allFeatures) {
            const prop = normalizeToMasterProperty(feature);

            // Skip ROW parcels (highways, utility easements)
            if (prop._is_row) continue;

            // Skip properties without coordinates
            if (!prop.lat || !prop.lng) continue;

            // Point-in-polygon filter if we have a drawn boundary
            if (polygon && polygon.length >= 3) {
                if (!isPointInPolygon({ lat: prop.lat, lng: prop.lng }, polygon)) continue;
            }

            // Dedup by hash
            if (seenHashes.has(prop.address_hash)) continue;
            seenHashes.add(prop.address_hash);

            // Collect zip codes
            if (prop.zip_code && !zipCodesFound.includes(prop.zip_code)) {
                zipCodesFound.push(prop.zip_code);
            }

            // Remove internal field before insert
            const { _is_row, ...insertData } = prop;
            mapped.push(insertData);
        }

        console.log(`[processRegridChunk] Normalized ${mapped.length} properties (${allFeatures.length - mapped.length} filtered out)`);

        // ═══════════════════════════════════════════════════════
        // DB WRITE — DEDUP + BULK INSERT
        // ═══════════════════════════════════════════════════════
        if (mapped.length > 0) {
            // Check existing by zip
            const uniqueZips = [...new Set(mapped.map(p => p.zip_code))];
            const existingHashes = new Set<string>();

            for (let i = 0; i < uniqueZips.length; i += 20) {
                if (Date.now() - startTime > 50000) break;
                const zipChunk = uniqueZips.slice(i, i + 20);
                const promises = zipChunk.map(zip =>
                    base44.asServiceRole.entities.MasterProperty.filter({ zip_code: zip }, null, 5000)
                        .then((res: any) => {
                            const arr = Array.isArray(res) ? res : (res?.items || []);
                            arr.forEach((p: any) => existingHashes.add(p.address_hash));
                        })
                        .catch((e: any) => console.warn(`Fetch zip ${zip} failed:`, e.message))
                );
                await Promise.all(promises);
            }

            const toInsert = mapped.filter(p => {
                if (existingHashes.has(p.address_hash)) {
                    chunkExisted++;
                    return false;
                }
                return true;
            });

            // Bulk insert in batches of 500
            for (let i = 0; i < toInsert.length; i += 500) {
                if (Date.now() - startTime > 55000) break;
                const chunk = toInsert.slice(i, i + 500);
                try {
                    await base44.asServiceRole.entities.MasterProperty.bulkCreate(chunk);
                    chunkInserted += chunk.length;
                } catch (e: any) {
                    console.warn('Bulk insert failed, retrying smaller:', e.message);
                    for (let j = 0; j < chunk.length; j += 50) {
                        const small = chunk.slice(j, j + 50);
                        try {
                            await base44.asServiceRole.entities.MasterProperty.bulkCreate(small);
                            chunkInserted += small.length;
                        } catch (e2: any) { console.warn('Small chunk failed:', e2.message); }
                        await sleep(200);
                    }
                }
            }
        }

        // ═══════════════════════════════════════════════════════
        // UPDATE JOB STATUS
        // ═══════════════════════════════════════════════════════
        const newTotalInserted = totalInserted + chunkInserted;
        const newTotalExisted = totalExisted + chunkExisted;
        const isFullyDone = reachedEnd;

        // Progress estimate (Regrid doesn't give total count upfront, estimate by page count)
        const estimatedProgress = reachedEnd ? 100 : Math.min(95, Math.round((totalFetched / 10000) * 100));

        console.log(`[processRegridChunk] Chunk: inserted=${chunkInserted}, existed=${chunkExisted}, done=${isFullyDone}`);

        if (isFullyDone) {
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'completed',
                current_offset: offsetId,
                total_fetched: totalFetched,
                total_inserted: newTotalInserted,
                total_existed: newTotalExisted,
                total_updated: totalUpdated,
                progress_pct: 100,
                zip_codes_found: zipCodesFound,
            });

            // Update user's territory data
            try {
                const users = await base44.asServiceRole.entities.User.filter({ email: job.user_email }, null, 1);
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
            } catch (e: any) {
                console.error('Failed to update user:', e.message);
            }

            console.log(`[processRegridChunk] === JOB COMPLETE === ${newTotalInserted} inserted, ${newTotalExisted} existed`);
        } else {
            const nextChunkNumber = (job.chunk_number || 0) + 1;
            await base44.asServiceRole.entities.FetchJob.update(jobId, {
                status: 'running',
                current_offset: offsetId,
                total_fetched: totalFetched,
                total_inserted: newTotalInserted,
                total_existed: newTotalExisted,
                total_updated: totalUpdated,
                progress_pct: estimatedProgress,
                zip_codes_found: zipCodesFound,
                chunk_number: nextChunkNumber,
            });

            console.log(`[processRegridChunk] Chunk #${nextChunkNumber} saved — chaining next`);

            // Self-chain for next chunk
            try {
                base44.functions.invoke('processRegridChunk', {}).catch((e: any) => {
                    console.warn('[processRegridChunk] Self-chain failed (cron will pick up):', e.message);
                });
            } catch (e: any) {
                console.warn('[processRegridChunk] Chain failed:', e.message);
            }
        }

        return Response.json({
            job_id: jobId,
            chunk_fetched: allFeatures.length,
            chunk_inserted: chunkInserted,
            chunk_existed: chunkExisted,
            is_fully_done: isFullyDone,
            progress_pct: isFullyDone ? 100 : estimatedProgress
        });

    } catch (error: any) {
        console.error('[processRegridChunk] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});

// Point-in-polygon check (same as processFetchChunk)
function isPointInPolygon(point: { lat: number; lng: number }, vs: Array<{ lat: number; lng: number }>) {
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
