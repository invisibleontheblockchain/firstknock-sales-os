import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// v8 — Deed-Only Architecture: uses ONLY /v1/properties?saleDateRange (county deed records)
// MLS /listings/sale is permanently retired — Inactive status includes expired/withdrawn/cancelled

function computeBoundingCircle(polygon) {
    if (!polygon || polygon.length < 3) return null;
    let sumLat = 0, sumLng = 0;
    for (const p of polygon) { sumLat += p.lat; sumLng += p.lng; }
    const centerLat = sumLat / polygon.length;
    const centerLng = sumLng / polygon.length;
    let maxDistMiles = 0;
    for (const p of polygon) {
        const dLat = (p.lat - centerLat) * 69.0;
        const dLng = (p.lng - centerLng) * 69.0 * Math.cos(centerLat * Math.PI / 180);
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);
        if (dist > maxDistMiles) maxDistMiles = dist;
    }
    return { lat: centerLat, lng: centerLng, radius: Math.ceil((maxDistMiles * 1.05) * 10) / 10 };
}

/**
 * Check for a previous completed pull that covers this same area.
 * Returns the most recent completed job's timestamp if found, else null.
 */
async function findDeltaWatermark(base44, lat, lng, radius) {
    try {
        // Look for completed jobs near this center (within ~0.05 degrees ≈ 3.5 miles)
        const recentJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { status: 'completed' }, '-completed_at', 50
        );
        const jobs = Array.isArray(recentJobs) ? recentJobs : (recentJobs?.items || []);
        
        for (const job of jobs) {
            if (!job.completed_at || !job.latitude || !job.longitude) continue;
            
            // Check if this job covers roughly the same area
            const dLat = Math.abs(job.latitude - lat);
            const dLng = Math.abs(job.longitude - lng);
            const overlapDegrees = 0.1; // ~7 miles tolerance
            
            if (dLat < overlapDegrees && dLng < overlapDegrees && job.radius >= radius * 0.8) {
                const ageMs = Date.now() - new Date(job.completed_at).getTime();
                const ageDays = ageMs / (1000 * 60 * 60 * 24);
                
                // Only use as watermark if less than 90 days old
                if (ageDays < 90) {
                    console.log(`[fetchArea-v8] Found delta watermark from ${Math.round(ageDays)}d ago (job ${job.id})`);
                    return {
                        watermark: job.completed_at,
                        previousJobId: job.id,
                        ageDays: Math.round(ageDays),
                        previousApiCalls: job.total_api_calls || 0,
                        previousInserted: job.total_inserted || 0
                    };
                }
            }
        }
    } catch (e) {
        console.warn(`[fetchArea-v8] Delta watermark check failed (non-fatal): ${e.message}`);
    }
    return null;
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
        let optimizedRadius = radius;
        let optimizedLat = latitude;
        let optimizedLng = longitude;
        
        if (polygon && polygon.length >= 3) {
            const bounding = computeBoundingCircle(polygon);
            if (bounding && bounding.radius < radius) {
                optimizedLat = bounding.lat;
                optimizedLng = bounding.lng;
                optimizedRadius = bounding.radius;
                console.log(`[fetchArea-v8] Tighter bounding circle: ${optimizedRadius}mi (saved ${(radius - optimizedRadius).toFixed(1)}mi)`);
            }
        }

        const effectiveSoldMonths = sold_months || 12;

        // ================================================================
        // CDC DELTA-PULL CHECK
        // If we've pulled this area before, only fetch records updated since last pull
        // This is the single biggest API cost saver (~85% reduction on re-pulls)
        // ================================================================
        const deltaInfo = await findDeltaWatermark(base44, optimizedLat, optimizedLng, optimizedRadius);
        let isDeltaPull = !!deltaInfo;
        
        // Check if reconciliation flagged stale ZIPs — force full pull if so
        const staleZips = user.stale_zips || [];
        if (isDeltaPull && staleZips.length > 0) {
            console.log(`[fetchArea-v8] ⚠️ Stale ZIPs detected (${staleZips.length}) from reconciliation — forcing FULL pull to catch silent deletes`);
            isDeltaPull = false;
            // Clear the stale flag since we're doing a full refresh
            try {
                await base44.auth.updateMe({ stale_zips: [] });
            } catch (e) { console.warn('Failed to clear stale_zips:', e.message); }
        }
        
        if (isDeltaPull) {
            console.log(`[fetchArea-v8] ✅ DELTA PULL — watermark=${deltaInfo.watermark} (${deltaInfo.ageDays}d ago). Previous pull used ${deltaInfo.previousApiCalls} API calls.`);
        } else if (staleZips.length > 0) {
            console.log(`[fetchArea-v8] Full pull (forced by reconciliation drift on ${staleZips.length} ZIPs)`);
        } else {
            console.log(`[fetchArea-v8] Full pull — no previous data found for this area`);
        }

        // === SHARED PROPERTY CACHE — link existing zips to user ===
        try {
            const latRange = optimizedRadius / 69.0;
            const lngRange = optimizedRadius / (69.0 * Math.cos(optimizedLat * Math.PI / 180));
            const sampleProps = await base44.asServiceRole.entities.MasterProperty.filter(
                { 
                    lat: { $gte: optimizedLat - latRange, $lte: optimizedLat + latRange },
                    lng: { $gte: optimizedLng - lngRange, $lte: optimizedLng + lngRange }
                }, null, 500
            );
            const sampleArr = Array.isArray(sampleProps) ? sampleProps : (sampleProps?.items || []);
            
            if (sampleArr.length > 0) {
                const zipSet = new Set();
                sampleArr.forEach(p => { if (p.zip_code) zipSet.add(p.zip_code); });
                const cachedZipCodes = [...zipSet];
                
                const existingUserZips = user.territory_zip_codes || [];
                const mergedZips = [...new Set([...existingUserZips, ...cachedZipCodes])];
                if (mergedZips.length > existingUserZips.length) {
                    await base44.auth.updateMe({ territory_zip_codes: mergedZips });
                }
                console.log(`[fetchArea-v8] Cache: ${sampleArr.length} existing props across ${cachedZipCodes.length} zips`);
            }
        } catch (cacheErr) {
            console.warn(`[fetchArea-v8] Cache check failed (non-fatal): ${cacheErr.message}`);
        }

        // Create FetchJob with delta state
        const job = await base44.entities.FetchJob.create({
            status: 'pending',
            latitude: optimizedLat,
            longitude: optimizedLng,
            radius: optimizedRadius,
            polygon: polygon || [],
            sold_months: effectiveSoldMonths,
            is_delta_pull: isDeltaPull,
            delta_watermark: isDeltaPull ? deltaInfo.watermark : null,
            delta_savings: isDeltaPull ? { estimated_full_calls: deltaInfo.previousApiCalls, actual_calls: 0, savings_pct: 0 } : null,
            current_offset: 0,
            total_expected: 0,
            total_fetched: 0,
            total_inserted: 0,
            total_existed: 0,
            total_updated: 0,
            total_api_calls: 0,
            user_email: user.email,
            progress_pct: 0,
            zip_codes_found: [],
            error_log: [],
            chunk_timings: [],
            phase: 'deed_records'
        });

        const computedSaleDateRange = (effectiveSoldMonths * 30) + 90;
        console.log(`[fetchArea-v8] Created FetchJob ${job.id} | delta=${isDeltaPull} | lat=${optimizedLat} lng=${optimizedLng} r=${optimizedRadius}mi | saleDateRange=${computedSaleDateRange} | phase=deed_records (deed-only)`);

        try {
            await base44.auth.updateMe({ area_pulls_count: pullCount + 1 });
        } catch (e) { console.warn('Failed to update pull count:', e.message); }

        setTimeout(() => {
            base44.functions.invoke('processFetchChunk', {}).catch(e => {
                console.warn('[fetchArea-v8] Background chunk invoke failed:', e.message);
            });
        }, 0);

        return Response.json({
            status: 'started',
            job_id: job.id,
            optimized_radius: optimizedRadius,
            original_radius: radius,
            sold_months: effectiveSoldMonths,
            is_delta_pull: isDeltaPull,
            delta_info: isDeltaPull ? {
                watermark: deltaInfo.watermark,
                age_days: deltaInfo.ageDays,
                estimated_savings: '~85% fewer API calls'
            } : null,
            message: isDeltaPull 
                ? `Delta pull started — only fetching changes since ${deltaInfo.ageDays}d ago. Estimated ~85% fewer API calls.`
                : `Full property fetch started (radius: ${optimizedRadius}mi). Running in background.`
        });

    } catch (error) {
        console.error('[fetchArea-v8] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});