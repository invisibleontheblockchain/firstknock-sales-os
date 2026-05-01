import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

// v9 — Grid Subdivision: breaks large areas into overlapping sub-circles (≤5mi)
// per RentCast support guidance. Large-radius queries silently drop records.
// Uses ONLY /v1/properties?saleDateRange (county deed records)
// MLS /listings/sale is permanently retired — Inactive status includes expired/withdrawn/cancelled
const DATABASE_URL = Deno.env.get('DATABASE_URL');

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
 * Break a large circular area into smaller overlapping sub-circles.
 * RentCast recommends radius ≤ 5mi for reliable results.
 * Generates a hex-style grid of circles that fully cover the original area.
 */
const SUB_CIRCLE_RADIUS = 5; // miles — sweet spot per RentCast support
const OVERLAP_FACTOR = 0.80; // 20% overlap to avoid boundary gaps

function generateSubCircles(centerLat, centerLng, radiusMiles) {
    if (radiusMiles <= SUB_CIRCLE_RADIUS) {
        // No subdivision needed — single circle covers it
        return [{ lat: centerLat, lng: centerLng, radius: radiusMiles }];
    }

    const step = SUB_CIRCLE_RADIUS * 2 * OVERLAP_FACTOR; // distance between centers in miles
    const latStep = step / 69.0; // 1° lat ≈ 69 miles
    const lngStep = step / (69.0 * Math.cos(centerLat * Math.PI / 180));

    const circles = [];
    // Grid extends to cover the full original radius
    const gridExtent = radiusMiles + SUB_CIRCLE_RADIUS * 0.5; // slight overshoot to catch edges
    const stepsNeeded = Math.ceil(gridExtent / step);

    for (let row = -stepsNeeded; row <= stepsNeeded; row++) {
        // Offset odd rows by half a step for better coverage (hex grid)
        const lngOffset = (Math.abs(row) % 2 === 1) ? lngStep * 0.5 : 0;
        for (let col = -stepsNeeded; col <= stepsNeeded; col++) {
            const subLat = centerLat + row * latStep;
            const subLng = centerLng + col * lngStep + lngOffset;

            // Check if this sub-circle center is close enough to be useful
            const dLat = (subLat - centerLat) * 69.0;
            const dLng = (subLng - centerLng) * 69.0 * Math.cos(centerLat * Math.PI / 180);
            const dist = Math.sqrt(dLat * dLat + dLng * dLng);

            // Include every sub-circle that overlaps the requested area.
            // The previous edge cutoff only allowed +1.5mi beyond the boundary, which under-covered
            // large 300mi² pulls; a 5mi fetch circle can still cover valid edge homes up to 5mi out.
            if (dist <= radiusMiles + SUB_CIRCLE_RADIUS) {
                circles.push({ lat: Math.round(subLat * 1e6) / 1e6, lng: Math.round(subLng * 1e6) / 1e6, radius: SUB_CIRCLE_RADIUS });
            }
        }
    }

    console.log(`[fetchArea-v9] Grid subdivision: ${radiusMiles}mi area → ${circles.length} sub-circles (r=${SUB_CIRCLE_RADIUS}mi each, ${Math.round(OVERLAP_FACTOR * 100)}% overlap)`);
    return circles;
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
            
            const dLat = Math.abs(job.latitude - lat);
            const dLng = Math.abs(job.longitude - lng);
            const overlapDegrees = 0.1;
            
            if (dLat < overlapDegrees && dLng < overlapDegrees && job.radius >= radius * 0.8) {
                const ageMs = Date.now() - new Date(job.completed_at).getTime();
                const ageDays = ageMs / (1000 * 60 * 60 * 24);
                
                if (ageDays < 90) {
                    const totalSubCircles = job.total_sub_circles || 1;
                    const completedSubCircles = job.completed_sub_circles ?? (job.phase === 'complete' ? totalSubCircles : 0);
                    const loadedRecords = (job.total_inserted || 0) + (job.total_existed || 0) + (job.total_updated || 0);
                    const hasCompleteCoverage = completedSubCircles >= totalSubCircles && loadedRecords >= 50;
                    console.log(`[fetchArea-v9] Found prior job ${job.id}: completeCoverage=${hasCompleteCoverage} (${completedSubCircles}/${totalSubCircles} cells, loaded=${loadedRecords})`);
                    return {
                        watermark: job.completed_at,
                        previousJobId: job.id,
                        ageDays: Math.round(ageDays),
                        previousApiCalls: job.total_api_calls || 0,
                        previousInserted: job.total_inserted || 0,
                        hasCompleteCoverage,
                        completedSubCircles,
                        totalSubCircles,
                        loadedRecords
                    };
                }
            }
        }
    } catch (e) {
        console.warn(`[fetchArea-v9] Delta watermark check failed (non-fatal): ${e.message}`);
    }
    return null;
}

async function getNeonCachedZipCodes(lat, lng, radius, userEmail) {
    if (!DATABASE_URL) return [];
    const sql = neon(DATABASE_URL);
    const latRange = radius / 69.0;
    const lngRange = radius / (69.0 * Math.cos(lat * Math.PI / 180));
    const rows = await sql`
        SELECT DISTINCT p.zip_code
        FROM workspace_properties wp
        JOIN properties p ON p.id = wp.property_id
        WHERE wp.user_email = ${userEmail}
          AND p.zip_code IS NOT NULL
          AND p.lat BETWEEN ${lat - latRange} AND ${lat + latRange}
          AND p.lng BETWEEN ${lng - lngRange} AND ${lng + lngRange}
        LIMIT 100
    `;
    return rows.map(row => row.zip_code).filter(Boolean);
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json();
        let { latitude, longitude, radius, polygon, sold_months, include_mls, force_full_refresh } = body;

        if (!latitude || !longitude || !radius) {
            return Response.json({ error: 'Latitude, longitude, and radius are required' }, { status: 400 });
        }

        // Enforce pull limit (admins bypass)
        const pullCount = user.area_pulls_count || 0;
        const maxPulls = 9999; // unlimited for testing
        if (pullCount >= maxPulls) {
            return Response.json({
                error: 'pull_limit_reached',
                message: "Limit reached."
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

        // RentCast Limit Enforcement (Max 100 miles)
        if (optimizedRadius > 100) {
            console.warn(`[fetchArea-v9] ⚠️ Radius ${optimizedRadius}mi exceeds RentCast 100mi limit. Capping.`);
            return Response.json({ 
                error: 'radius_too_large', 
                message: 'Your search area results in a radius larger than 100 miles. Please redraw a smaller area to continue.' 
            }, { status: 400 });
        }

        // Fix #4: Server-side area enforcement (40 sq mi for free, 300 sq mi for paid)
        const areaSqMiles = Math.PI * optimizedRadius * optimizedRadius;
        const isPaid = user.subscription_status === 'active' || user.is_owner;
        const maxAreaSqMi = isPaid ? 350 : 50; // Generous padding over UI limits
        if (areaSqMiles > maxAreaSqMi) {
            console.warn(`[fetchArea-v9] ⚠️ Area ${Math.round(areaSqMiles)}sq mi exceeds ${maxAreaSqMi}sq mi limit for ${isPaid ? 'paid' : 'free'} user.`);
            return Response.json({
                error: 'area_too_large',
                message: isPaid 
                    ? `Your drawn area (~${Math.round(areaSqMiles)} sq mi) exceeds the 300 sq mi limit. Please draw a smaller area.`
                    : `Your drawn area (~${Math.round(areaSqMiles)} sq mi) exceeds the 40 sq mi free limit. Upgrade to pull larger territories.`
            }, { status: 400 });
        }

        const effectiveSoldMonths = sold_months || 12;

        // ================================================================
        // CDC DELTA-PULL CHECK
        // If we've pulled this area before, only fetch records updated since last pull
        // This is the single biggest API cost saver (~85% reduction on re-pulls)
        // ================================================================
        const deltaInfo = await findDeltaWatermark(base44, optimizedLat, optimizedLng, optimizedRadius);
        let isDeltaPull = !!deltaInfo && deltaInfo.hasCompleteCoverage && !force_full_refresh;
        let pullMode = isDeltaPull ? 'delta_refresh' : (deltaInfo ? 'full_refresh' : 'new_area');
        if (deltaInfo && !deltaInfo.hasCompleteCoverage) {
            console.log(`[fetchArea-v9] Prior pull coverage is not trustworthy — using FULL REFRESH to fill gaps.`);
        }
        if (force_full_refresh) {
            console.log(`[fetchArea-v9] User requested FULL REFRESH — bypassing delta mode.`);
        }
        
        // Check if reconciliation flagged stale ZIPs — force full pull if so
        const staleZips = user.stale_zips || [];
        if (isDeltaPull && staleZips.length > 0) {
            console.log(`[fetchArea-v8] ⚠️ Stale ZIPs detected (${staleZips.length}) from reconciliation — forcing FULL pull to catch silent deletes`);
            isDeltaPull = false;
            pullMode = 'full_refresh';
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

        // === SHARED PROPERTY CACHE — link existing Neon zips to user ===
        try {
            const cachedZipCodes = await getNeonCachedZipCodes(optimizedLat, optimizedLng, optimizedRadius, user.email);
            if (cachedZipCodes.length > 0) {
                const existingUserZips = user.territory_zip_codes || [];
                const mergedZips = [...new Set([...existingUserZips, ...cachedZipCodes])];
                if (mergedZips.length > existingUserZips.length) {
                    await base44.auth.updateMe({ territory_zip_codes: mergedZips });
                }
                console.log(`[fetchArea-v9] Neon cache: ${cachedZipCodes.length} existing zips linked to user`);
            }
        } catch (cacheErr) {
            console.warn(`[fetchArea-v9] Neon cache check failed (non-fatal): ${cacheErr.message}`);
        }

        // === GRID SUBDIVISION ===
        // RentCast support: large-radius queries silently drop records.
        // Break into ≤5mi sub-circles and combine results.
        const subCircles = generateSubCircles(optimizedLat, optimizedLng, optimizedRadius);

        // Resume recent failed job for the same area instead of starting over.
        const recentFailedJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { user_email: user.email, status: 'failed' },
            '-updated_date',
            20
        );
        const failedList = Array.isArray(recentFailedJobs) ? recentFailedJobs : (recentFailedJobs?.items || []);
        const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
        const resumableJob = failedList.find(job => {
            const updatedAt = job.updated_date ? new Date(job.updated_date).getTime() : 0;
            if (updatedAt < sixHoursAgo) return false;
            const dLat = Math.abs((job.latitude || 0) - optimizedLat);
            const dLng = Math.abs((job.longitude || 0) - optimizedLng);
            const radiusClose = Math.abs((job.radius || 0) - optimizedRadius) <= Math.max(0.5, optimizedRadius * 0.1);
            return dLat < 0.02 && dLng < 0.02 && radiusClose;
        });

        let job;
        if (resumableJob) {
            const resumedLog = [
                ...(resumableJob.error_log || []),
                `[${new Date().toISOString()}] Resuming failed job from sub-circle ${(resumableJob.current_sub_circle || 0) + 1}, offset ${resumableJob.current_offset || 0}`
            ];
            job = await base44.asServiceRole.entities.FetchJob.update(resumableJob.id, {
                status: 'pending',
                error_message: null,
                error_log: resumedLog
            });
        } else {
            // Create FetchJob with delta state + sub-circles
            job = await base44.entities.FetchJob.create({
                status: 'pending',
                latitude: optimizedLat,
                longitude: optimizedLng,
                radius: optimizedRadius,
                polygon: polygon || [],
                sold_months: effectiveSoldMonths,
                include_mls: include_mls !== false,
                pull_mode: pullMode,
                force_full_refresh: !!force_full_refresh,
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
                phase: 'deed_records',
                sub_circles: subCircles,
                current_sub_circle: 0,
                total_sub_circles: subCircles.length
            });
        }

        const now = new Date();
        const deedCutoff = new Date(now);
        deedCutoff.setMonth(deedCutoff.getMonth() - effectiveSoldMonths);
        const computedSaleDateRange = Math.ceil((now.getTime() - deedCutoff.getTime()) / (1000 * 3600 * 24)) + 1;
        const gridMsg = subCircles.length > 1 ? ` | GRID: ${subCircles.length} sub-circles (r=${SUB_CIRCLE_RADIUS}mi)` : ' | single circle';
        console.log(`[fetchArea-v9] Created FetchJob ${job.id} | delta=${isDeltaPull} | lat=${optimizedLat} lng=${optimizedLng} r=${optimizedRadius}mi | deedWindowDays=${computedSaleDateRange} | mlsWindowDays=30${gridMsg}`);

        try {
            await base44.auth.updateMe({ area_pulls_count: pullCount + 1 });
        } catch (e) { console.warn('Failed to update pull count:', e.message); }

        const resumeExpectedChunk = job.chunk_number || 0;
        setTimeout(() => {
            base44.functions.invoke('processFetchChunk', { expected_chunk: resumeExpectedChunk }).catch(e => {
                console.warn('[fetchArea-v9] Background chunk invoke failed:', e.message);
            });
        }, 500);

        return Response.json({
            status: 'started',
            job_id: job.id,
            optimized_radius: optimizedRadius,
            original_radius: radius,
            sold_months: effectiveSoldMonths,
            is_delta_pull: isDeltaPull,
            pull_mode: pullMode,
            delta_info: isDeltaPull ? {
                watermark: deltaInfo.watermark,
                age_days: deltaInfo.ageDays,
                estimated_savings: '~85% fewer API calls'
            } : null,
            sub_circles: subCircles.length,
            message: isDeltaPull 
                ? `Delta pull started — only fetching changes since ${deltaInfo.ageDays}d ago. Estimated ~85% fewer API calls.`
                : `${pullMode === 'full_refresh' ? 'Full refresh / fill gaps' : 'Full property fetch'} started (radius: ${optimizedRadius}mi, ${subCircles.length} grid cells). Running in background.`
        });

    } catch (error) {
        console.error('[fetchArea-v8] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});