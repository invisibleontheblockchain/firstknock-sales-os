import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Monthly ZIP Reconciliation Job
 * 
 * Catches "silent deletes" — properties removed upstream by RentCast that
 * our delta-pull CDC watermark cannot detect. Compares our MasterProperty
 * count per ZIP against RentCast's X-Total-Count header using 1 API call
 * per ZIP (limit=1, includeTotalCount=true).
 * 
 * If drift exceeds the threshold (default 10%), marks the ZIP for a full
 * refresh on the next pull.
 * 
 * Designed to run as a monthly scheduled automation.
 */

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";
const DRIFT_THRESHOLD_PCT = 10; // Flag ZIPs where count differs by >10%
const MAX_ZIPS_PER_RUN = 50;   // Cap API calls per run

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchCountForZip(zipCode) {
    const params = new URLSearchParams({
        zipCode: zipCode,
        limit: '1',
        includeTotalCount: 'true'
    });

    const res = await fetch(`${RENTCAST_BASE}/properties?${params}`, {
        headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
    });

    if (res.status === 429) {
        // Rate limited — back off and signal caller
        return { status: 429, count: null };
    }

    if (!res.ok) {
        return { status: res.status, count: null };
    }

    const totalCount = res.headers.get('X-Total-Count');
    return { 
        status: 200, 
        count: totalCount ? parseInt(totalCount, 10) : null 
    };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        
        // This is an admin/scheduled job — verify auth
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        if (!RENTCAST_API_KEY) {
            return Response.json({ error: 'RENTCAST_API_KEY not configured' }, { status: 500 });
        }

        console.log('[reconcile] Starting monthly ZIP count reconciliation...');

        // 1. Gather all unique ZIP codes from completed FetchJobs
        const completedJobs = await base44.asServiceRole.entities.FetchJob.filter(
            { status: 'completed' }, '-completed_at', 100
        );
        const jobs = Array.isArray(completedJobs) ? completedJobs : (completedJobs?.items || []);

        const allZips = new Set();
        for (const job of jobs) {
            if (job.zip_codes_found) {
                job.zip_codes_found.forEach(z => allZips.add(z));
            }
        }

        if (allZips.size === 0) {
            console.log('[reconcile] No ZIP codes found in completed jobs — nothing to reconcile');
            return Response.json({ status: 'no_data', message: 'No ZIP codes to reconcile' });
        }

        const zipList = [...allZips].slice(0, MAX_ZIPS_PER_RUN);
        console.log(`[reconcile] Checking ${zipList.length} ZIPs (${allZips.size} total in system)`);

        // 2. For each ZIP, compare our count vs RentCast count
        const results = [];
        let apiCalls = 0;
        let driftedZips = [];

        for (const zip of zipList) {
            // Get our count
            let ourCount = 0;
            try {
                const ourProps = await base44.asServiceRole.entities.MasterProperty.filter(
                    { zip_code: zip }, null, 1
                );
                // Base44 doesn't have a count endpoint, so we need to fetch more to estimate
                // Fetch up to 5000 to get a real count
                const allOurProps = await base44.asServiceRole.entities.MasterProperty.filter(
                    { zip_code: zip }, null, 5000
                );
                const arr = Array.isArray(allOurProps) ? allOurProps : (allOurProps?.items || []);
                ourCount = arr.length;
            } catch (e) {
                console.warn(`[reconcile] Failed to count local ZIP ${zip}: ${e.message}`);
                continue;
            }

            // Get RentCast count (1 API call)
            const apiResult = await fetchCountForZip(zip);
            apiCalls++;

            if (apiResult.status === 429) {
                console.warn(`[reconcile] Rate limited at ZIP ${zip} after ${apiCalls} calls — stopping`);
                break;
            }

            if (apiResult.count === null) {
                console.warn(`[reconcile] Could not get count for ZIP ${zip} (status ${apiResult.status})`);
                results.push({ zip, ourCount, apiCount: null, status: 'error' });
                continue;
            }

            const apiCount = apiResult.count;
            const diff = Math.abs(ourCount - apiCount);
            const driftPct = apiCount > 0 ? Math.round((diff / apiCount) * 100) : 0;
            const isDrifted = driftPct > DRIFT_THRESHOLD_PCT;

            results.push({
                zip,
                ourCount,
                apiCount,
                diff,
                driftPct,
                isDrifted,
                direction: ourCount > apiCount ? 'we_have_more' : 'api_has_more'
            });

            if (isDrifted) {
                driftedZips.push(zip);
                console.log(`[reconcile] ⚠️ DRIFT: ZIP ${zip} — ours=${ourCount}, API=${apiCount}, drift=${driftPct}%`);
            }

            // Gentle rate limiting between calls
            await sleep(200);
        }

        console.log(`[reconcile] Checked ${results.length} ZIPs, ${apiCalls} API calls, ${driftedZips.length} drifted`);

        // 3. If drifted ZIPs found, mark them for full refresh
        // We do this by updating the most recent completed FetchJob's delta_savings 
        // to signal that these ZIPs need a full pull next time
        if (driftedZips.length > 0) {
            // Find users who have these ZIPs in their territory and flag them
            const users = await base44.asServiceRole.entities.User.list('-created_date', 500);
            const userArr = Array.isArray(users) ? users : (users?.items || []);
            
            for (const u of userArr) {
                const userZips = u.territory_zip_codes || [];
                const affectedZips = userZips.filter(z => driftedZips.includes(z));
                
                if (affectedZips.length > 0) {
                    const existingStale = u.stale_zips || [];
                    const merged = [...new Set([...existingStale, ...affectedZips])];
                    try {
                        await base44.asServiceRole.entities.User.update(u.id, {
                            stale_zips: merged
                        });
                        console.log(`[reconcile] Flagged ${affectedZips.length} stale ZIPs for user ${u.email}`);
                    } catch (e) {
                        console.warn(`[reconcile] Failed to flag user ${u.email}: ${e.message}`);
                    }
                }
            }
        }

        const summary = {
            status: 'completed',
            zips_checked: results.length,
            zips_total: allZips.size,
            api_calls_used: apiCalls,
            drifted_zips: driftedZips,
            drift_threshold_pct: DRIFT_THRESHOLD_PCT,
            details: results
        };

        console.log(`[reconcile] === RECONCILIATION COMPLETE === checked=${results.length} drifted=${driftedZips.length} apiCalls=${apiCalls}`);

        return Response.json(summary);

    } catch (error) {
        console.error('[reconcile] Fatal error:', error.message, error.stack);
        return Response.json({ error: error.message }, { status: 500 });
    }
});