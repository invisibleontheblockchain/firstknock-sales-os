import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
    const startedAt = Date.now();
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const requiredSecrets = ['DATABASE_URL', 'RENTCAST_API_KEY', 'BATCH_DATA_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
        const secrets = Object.fromEntries(requiredSecrets.map(name => [name, Boolean(Deno.env.get(name))]));
        const missingSecrets = requiredSecrets.filter(name => !secrets[name]);

        let neonOk = false;
        let neonLatencyMs = null;
        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (databaseUrl) {
            const neonStart = Date.now();
            const sql = neon(databaseUrl);
            await sql`SELECT 1 AS ok`;
            neonLatencyMs = Date.now() - neonStart;
            neonOk = true;
        }

        const recentFailedJobs = await base44.asServiceRole.entities.FetchJob.filter({ status: 'failed' }, '-updated_date', 5);
        const runningJobs = await base44.asServiceRole.entities.FetchJob.filter({ status: 'running' }, '-updated_date', 5);

        return Response.json({
            success: missingSecrets.length === 0 && neonOk,
            checked_at: new Date().toISOString(),
            latency_ms: Date.now() - startedAt,
            services: {
                base44_auth: true,
                neon: neonOk
            },
            neon_latency_ms: neonLatencyMs,
            secrets,
            missing_secrets: missingSecrets,
            jobs: {
                recent_failed_count: Array.isArray(recentFailedJobs) ? recentFailedJobs.length : (recentFailedJobs?.items || []).length,
                running_count: Array.isArray(runningJobs) ? runningJobs.length : (runningJobs?.items || []).length
            }
        });
    } catch (error) {
        return Response.json({
            success: false,
            checked_at: new Date().toISOString(),
            latency_ms: Date.now() - startedAt,
            error: error.message
        }, { status: 500 });
    }
});