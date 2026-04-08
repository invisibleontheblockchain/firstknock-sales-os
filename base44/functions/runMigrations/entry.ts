import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        const DATABASE_URL = Deno.env.get("DATABASE_URL");
        if (!DATABASE_URL) {
            return Response.json({ error: 'DATABASE_URL not configured' }, { status: 500 });
        }

        const sql = neon(DATABASE_URL);
        const results = [];

        // Migration 001: listing_seen_log
        await sql`
            CREATE TABLE IF NOT EXISTS listing_seen_log (
                listingId VARCHAR(255) PRIMARY KEY,
                firstSeenDate TIMESTAMP NOT NULL DEFAULT NOW(),
                lastProcessedDate TIMESTAMP NOT NULL DEFAULT NOW(),
                classification VARCHAR(50),
                confidence FLOAT
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_listing_seen_log_listingId ON listing_seen_log(listingId)`;
        results.push('001: listing_seen_log ✓');

        // Migration 002: heuristic_score_log
        await sql`
            CREATE TABLE IF NOT EXISTS heuristic_score_log (
                id SERIAL PRIMARY KEY,
                listingId VARCHAR(255),
                formattedAddress TEXT,
                score INTEGER NOT NULL,
                signals JSONB,
                classification VARCHAR(50),
                batchdataResult VARCHAR(50),
                createdAt TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_heuristic_score_listingId ON heuristic_score_log(listingId)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_heuristic_score_classification ON heuristic_score_log(classification)`;
        results.push('002: heuristic_score_log ✓');

        // Migration 003: pending_confirmation_queue
        await sql`
            CREATE TABLE IF NOT EXISTS pending_confirmation_queue (
                listingId VARCHAR(255) PRIMARY KEY,
                formattedAddress TEXT,
                addressHash VARCHAR(255),
                classifiedAt TIMESTAMP NOT NULL DEFAULT NOW(),
                reCheckDate TIMESTAMP,
                status VARCHAR(50) DEFAULT 'pending',
                heuristicScore INTEGER,
                batchdataResult VARCHAR(50)
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_pending_queue_status ON pending_confirmation_queue(status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_pending_queue_recheck ON pending_confirmation_queue(reCheckDate)`;
        results.push('003: pending_confirmation_queue ✓');

        // Migration 004: job_runs
        await sql`
            CREATE TABLE IF NOT EXISTS job_runs (
                id SERIAL PRIMARY KEY,
                jobId VARCHAR(255),
                startedAt TIMESTAMP NOT NULL DEFAULT NOW(),
                completedAt TIMESTAMP,
                status VARCHAR(50) DEFAULT 'running',
                totalFetched INTEGER DEFAULT 0,
                totalInserted INTEGER DEFAULT 0,
                totalSkippedDelta INTEGER DEFAULT 0,
                totalBatchdataCalls INTEGER DEFAULT 0,
                totalApiCalls INTEGER DEFAULT 0,
                costEstimate NUMERIC DEFAULT 0,
                errorCount INTEGER DEFAULT 0,
                metadata JSONB
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_job_runs_jobId ON job_runs(jobId)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status)`;
        results.push('004: job_runs ✓');

        console.log('[runMigrations] All migrations completed:', results);
        return Response.json({ success: true, migrations: results });

    } catch (error) {
        console.error('[runMigrations] FATAL:', error.message, error.stack);
        return Response.json({ error: error.message }, { status: 500 });
    }
});