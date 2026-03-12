import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// v3 — Adds shared property cache: reuse existing MasterProperty data from other users' pulls

function computeBoundingCircle(polygon) {
    if (!polygon || polygon.length < 3) return null;
    
    // Find centroid
    let sumLat = 0, sumLng = 0;
    for (const p of polygon) { sumLat += p.lat; sumLng += p.lng; }
    const centerLat = sumLat / polygon.length;
    const centerLng = sumLng / polygon.length;
    
    // Find max distance from centroid to any vertex (in miles)
    let maxDistMiles = 0;
    for (const p of polygon) {
        const dLat = (p.lat - centerLat) * 69.0; // ~69 miles per degree latitude
        const dLng = (p.lng - centerLng) * 69.0 * Math.cos(centerLat * Math.PI / 180);
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);
        if (dist > maxDistMiles) maxDistMiles = dist;
    }
    
    // Add 5% buffer to make sure we don't clip edges
    return {
        lat: centerLat,
        lng: centerLng,
        radius: Math.ceil((maxDistMiles * 1.05) * 10) / 10 // round up to 0.1 mi
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json();
        let { latitude, longitude, radius, polygon, sold_months } = body;

        if (!latitude || !longitude || !radius) {
            return Response.json({ error: 'Latitude, longitude, and radius are required' }, { status: 400 });
        }

        // Enforce pull limit (admins bypass)
        const pullCount = user.area_pulls_count || 0;
        const isPaid = user.subscription_status === 'active' || user.is_owner || user.role === 'admin';
        if (pullCount >= 5 && !isPaid) {
            return Response.json({
                error: 'pull_limit_reached',
                message: 'You\'ve used all 5 free data pulls. Upgrade to pull fresh leads for your territory.'
            });
        }

        // Check for active jobs
        const runningJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'running' }, null, 5);
        const runningList = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        if (runningList.length > 0) {
            return Response.json({
                status: 'already_running', job_id: runningList[0].id,
                message: `A fetch job is already running (${runningList[0].progress_pct || 0}% complete). Please wait for it to finish.`
            });
        }
        const pendingJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'pending' }, null, 5);
        const pendingList = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
        if (pendingList.length > 0) {
            return Response.json({
                status: 'already_running', job_id: pendingList[0].id,
                message: 'A fetch job is starting up. Please wait for it to finish.'
            });
        }

        // === MINIMUM BOUNDING CIRCLE ===
        // If polygon provided, compute tightest circle that covers it
        let optimizedRadius = radius;
        let optimizedLat = latitude;
        let optimizedLng = longitude;
        
        if (polygon && polygon.length >= 3) {
            const bounding = computeBoundingCircle(polygon);
            if (bounding) {
                console.log(`[fetchArea-v2] Bounding circle: center=${bounding.lat.toFixed(4)},${bounding.lng.toFixed(4)} radius=${bounding.radius}mi (original: ${radius}mi)`);
                // Only use bounding circle if it's smaller than what was passed
                if (bounding.radius < radius) {
                    optimizedLat = bounding.lat;
                    optimizedLng = bounding.lng;
                    optimizedRadius = bounding.radius;
                    console.log(`[fetchArea-v2] Using tighter bounding circle: ${optimizedRadius}mi (saved ${(radius - optimizedRadius).toFixed(1)}mi)`);
                } else {
                    console.log(`[fetchArea-v2] Keeping original radius (bounding=${bounding.radius}mi >= original=${radius}mi)`);
                }
            }
        }

        // Default sold_months
        const effectiveSoldMonths = sold_months || 12;

        // ================================================================
        // SHARED PROPERTY CACHE — check if other users already pulled 
        // properties in this area so we can skip redundant API calls
        // ================================================================
        let cachedPropertyCount = 0;
        let cachedZipCodes = [];
        try {
            // Sample nearby zip codes by querying MasterProperty near the target coords
            // Use a small lat/lng bounding box to find zip codes already in the DB
            const latRange = optimizedRadius / 69.0; // ~69 miles per degree
            const lngRange = optimizedRadius / (69.0 * Math.cos(optimizedLat * Math.PI / 180));
            
            // Query properties within the bounding box to discover cached zip codes
            const sampleProps = await base44.asServiceRole.entities.MasterProperty.filter(
                { 
                    lat: { $gte: optimizedLat - latRange, $lte: optimizedLat + latRange },
                    lng: { $gte: optimizedLng - lngRange, $lte: optimizedLng + lngRange }
                }, 
                null, 
                500
            );
            const sampleArr = Array.isArray(sampleProps) ? sampleProps : (sampleProps?.items || []);
            
            if (sampleArr.length > 0) {
                // Collect unique zip codes from cached data
                const zipSet = new Set();
                sampleArr.forEach(p => { if (p.zip_code) zipSet.add(p.zip_code); });
                cachedZipCodes = [...zipSet];
                cachedPropertyCount = sampleArr.length;
                
                console.log(`[fetchArea-v3] CACHE HIT: Found ${cachedPropertyCount} cached properties across ${cachedZipCodes.length} zip codes`);
                
                // Link cached zip codes to this user immediately
                const existingUserZips = user.territory_zip_codes || [];
                const mergedZips = [...new Set([...existingUserZips, ...cachedZipCodes])];
                
                if (mergedZips.length > existingUserZips.length) {
                    await base44.auth.updateMe({ 
                        territory_zip_codes: mergedZips,
                    });
                    console.log(`[fetchArea-v3] Linked ${mergedZips.length - existingUserZips.length} cached zip codes to user`);
                }
                
                // If we have substantial cached data (200+ properties), check if we even need a fresh pull
                if (cachedPropertyCount >= 200) {
                    // Check how old the cached data is
                    const latestProp = sampleArr.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];
                    const cacheAge = Date.now() - new Date(latestProp.created_date).getTime();
                    const cacheAgeDays = cacheAge / (1000 * 60 * 60 * 24);
                    
                    if (cacheAgeDays < 30) {
                        // Cache is fresh enough — count total properties for this area
                        let totalCached = 0;
                        for (const zip of cachedZipCodes) {
                            const zipProps = await base44.asServiceRole.entities.MasterProperty.filter(
                                { zip_code: zip }, null, 1
                            );
                            const zipArr = Array.isArray(zipProps) ? zipProps : (zipProps?.items || []);
                            totalCached += zipArr.length > 0 ? 1 : 0; // just confirming zip has data
                        }
                        
                        console.log(`[fetchArea-v3] Cache is ${Math.round(cacheAgeDays)}d old with ${cachedZipCodes.length} zips — still pulling fresh data to supplement`);
                    }
                }
            } else {
                console.log(`[fetchArea-v3] No cached data in this area — full pull needed`);
            }
        } catch (cacheErr) {
            // Cache check is best-effort — never block the pull
            console.warn(`[fetchArea-v3] Cache check failed (non-fatal): ${cacheErr.message}`);
        }

        const job = await base44.entities.FetchJob.create({
            status: 'pending',
            latitude: optimizedLat,
            longitude: optimizedLng,
            radius: optimizedRadius,
            polygon: polygon || [],
            sold_months: effectiveSoldMonths,
            current_offset: 0,
            total_expected: 0,
            total_fetched: 0,
            total_inserted: 0,
            total_existed: 0,
            total_updated: 0,
            total_api_calls: 0,
            mls_fetched: 0,
            mls_new: 0,
            mls_api_calls: 0,
            user_email: user.email,
            progress_pct: 0,
            zip_codes_found: [],
            error_log: [],
            chunk_timings: [],
            phase: 'deed_records'
        });

        console.log(`[fetchArea-v2] Created FetchJob ${job.id} for ${user.email} | lat=${optimizedLat} lng=${optimizedLng} radius=${optimizedRadius}mi sold_months=${effectiveSoldMonths}`);

        // Update user pull tracking
        try {
            await base44.auth.updateMe({ area_pulls_count: pullCount + 1 });
        } catch (e) { console.warn('Failed to update pull count:', e.message); }

        // Fire-and-forget: kick off chunk processor without awaiting
        setTimeout(() => {
            base44.functions.invoke('processFetchChunk', {}).catch(e => {
                console.warn('[fetchArea-v2] Background chunk invoke failed:', e.message);
            });
        }, 0);

        return Response.json({
            status: 'started',
            job_id: job.id,
            optimized_radius: optimizedRadius,
            original_radius: radius,
            sold_months: effectiveSoldMonths,
            message: `Property fetch started (radius: ${optimizedRadius}mi, sold: ${effectiveSoldMonths}mo). Running in background.`
        });

    } catch (error) {
        console.error('[fetchArea-v2] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});