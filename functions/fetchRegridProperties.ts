import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * fetchRegridProperties — V2 replacement for fetchAreaProperties
 * 
 * Queries Regrid API (or local PostGIS when available) for properties
 * within a drawn polygon. Replaces RentCast pipeline.
 * 
 * Request body:
 *   polygon: Array<{lat, lng}> — the drawn territory boundary
 *   months_back: number — how many months of sales to include (1-12)
 * 
 * Response: FetchJob status compatible with existing TerritoryPrompt polling
 */
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { polygon, months_back = 3 } = body;

        if (!polygon || polygon.length < 3) {
            return Response.json({ error: 'A polygon with at least 3 points is required' }, { status: 400 });
        }

        // Enforce free tier pull limit
        const pullCount = user.area_pulls_count || 0;
        const isPaid = user.subscription_status === 'active' || user.is_owner;

        if (pullCount >= 5 && !isPaid) {
            return Response.json({
                error: 'pull_limit_reached',
                message: "You've used all 5 free data pulls. Upgrade to pull fresh leads for your territory."
            });
        }

        // Check for already-running jobs
        const runningJobs = await base44.entities.FetchJob.filter(
            { user_email: user.email, status: 'running' }, null, 5
        );
        const runningList = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        if (runningList.length > 0) {
            return Response.json({
                status: 'already_running',
                job_id: runningList[0].id,
                message: `A fetch job is already running (${runningList[0].progress_pct || 0}% complete).`
            });
        }

        const pendingJobs = await base44.entities.FetchJob.filter(
            { user_email: user.email, status: 'pending' }, null, 5
        );
        const pendingList = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
        if (pendingList.length > 0) {
            return Response.json({
                status: 'already_running',
                job_id: pendingList[0].id,
                message: 'A fetch job is starting up. Please wait.'
            });
        }

        // Convert polygon to GeoJSON for Regrid API
        const geoJsonPolygon = {
            type: 'Polygon',
            coordinates: [
                [...polygon.map(p => [p.lng, p.lat]),
                 [polygon[0].lng, polygon[0].lat]] // Close the ring
            ]
        };

        // Calculate center for fallback radius query
        const centerLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
        const centerLng = polygon.reduce((s, p) => s + p.lng, 0) / polygon.length;

        // Create the FetchJob
        const job = await base44.entities.FetchJob.create({
            status: 'pending',
            latitude: centerLat,
            longitude: centerLng,
            radius: 0, // Not used for polygon queries
            polygon: polygon,
            current_offset: 0,
            total_expected: 0,
            total_fetched: 0,
            total_inserted: 0,
            total_existed: 0,
            total_updated: 0,
            user_email: user.email,
            progress_pct: 0,
            zip_codes_found: [],
            date_slices: [],
            current_slice_index: 0,
            // V2 metadata
            data_source: 'regrid',
            months_back: months_back,
            geojson_polygon: geoJsonPolygon,
        });

        console.log(`[fetchRegridProperties] Created FetchJob ${job.id} for ${user.email} (Regrid V2)`);

        // Update user pull tracking
        try {
            await base44.auth.updateMe({
                area_pulls_count: pullCount + 1
            });
        } catch (e) {
            console.warn('Failed to update pull count:', e.message);
        }

        // Kick off the Regrid-native chunk processor
        try {
            console.log(`[fetchRegridProperties] Invoking processRegridChunk for job ${job.id}`);
            base44.functions.invoke('processRegridChunk', {}).catch(e => {
                console.warn('[fetchRegridProperties] Background chunk invoke failed:', e.message);
            });
        } catch (e) {
            console.warn('[fetchRegridProperties] Failed to invoke chunk processor:', e.message);
        }

        return Response.json({
            status: 'started',
            job_id: job.id,
            data_source: 'regrid',
            message: 'Regrid property fetch started. This will run in the background.'
        });

    } catch (error) {
        console.error('[fetchRegridProperties] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
