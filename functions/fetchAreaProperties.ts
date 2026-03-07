import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { latitude, longitude, radius, polygon } = body;

        if (!latitude || !longitude || !radius) {
            return Response.json({ error: 'Latitude, longitude, and radius are required' }, { status: 400 });
        }

        // Enforce one free pull limit — check if user already used their pull
        const pullCount = user.area_pulls_count || 0;
        const isPaid = user.subscription_status === 'active' || user.is_owner;
        
        if (pullCount >= 5 && !isPaid) {
            return Response.json({
                error: 'pull_limit_reached',
                message: 'You\'ve used all 5 free data pulls. Upgrade to pull fresh leads for your territory.'
            });
        }

        // Check if there's already an active job for this user
        const existingJobs = await base44.entities.FetchJob.filter(
            { user_email: user.email, status: 'running' }, null, 5
        );
        const existing = Array.isArray(existingJobs) ? existingJobs : (existingJobs?.items || []);
        if (existing.length > 0) {
            return Response.json({
                status: 'already_running',
                job_id: existing[0].id,
                message: `A fetch job is already running (${existing[0].progress_pct || 0}% complete). Please wait for it to finish.`
            });
        }

        // Create the FetchJob
        const job = await base44.entities.FetchJob.create({
            status: 'pending',
            latitude,
            longitude,
            radius,
            polygon: polygon || [],
            current_offset: 0,
            total_expected: 0,
            total_fetched: 0,
            total_inserted: 0,
            total_existed: 0,
            total_updated: 0,
            user_email: user.email,
            progress_pct: 0,
            zip_codes_found: []
        });

        console.log(`[fetchAreaProperties] Created FetchJob ${job.id} for ${user.email}`);

        // Update user pull tracking
        try {
            await base44.auth.updateMe({
                area_pulls_count: pullCount + 1
            });
        } catch (e) {
            console.warn('Failed to update pull count:', e.message);
        }

        // IMMEDIATELY kick off the first chunk — don't wait for cron/entity automation
        try {
            console.log(`[fetchAreaProperties] Immediately invoking processFetchChunk for job ${job.id}`);
            base44.functions.invoke('processFetchChunk', {}).catch(e => {
                console.warn('[fetchAreaProperties] Background chunk invoke failed (automation will pick up):', e.message);
            });
        } catch (e) {
            console.warn('[fetchAreaProperties] Failed to invoke processFetchChunk:', e.message);
        }

        return Response.json({
            status: 'started',
            job_id: job.id,
            message: 'Property fetch started. This will run in the background — large areas may take a few minutes.'
        });

    } catch (error) {
        console.error('[fetchAreaProperties] Fatal:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});