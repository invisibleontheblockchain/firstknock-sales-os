import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

/**
 * Chunked reclassifier for existing Phase 2 MLS records.
 *
 * Demotes HEURISTIC_SOLD records to RECENT_OFF_MARKET under the new stricter rules.
 * Self-chains: each invocation processes one batch (~200 records) then fires itself again.
 * No persistent state needed — demoted records drop out of the query naturally, so
 * the next invocation always picks up unprocessed ones.
 *
 * Call from admin UI:
 *   base44.functions.invoke('reclassifyMlsData', { dry_run: true })   // count only
 *   base44.functions.invoke('reclassifyMlsData', {})                   // fix for real
 *   base44.functions.invoke('reclassifyMlsData', { zip_code: "29621" })  // limit scope
 *
 * Only admins can run this.
 */

const BATCH_SIZE = 200;
const INTER_UPDATE_DELAY_MS = 60; // gentle pacing to avoid 429s

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function checkMlsListingSanity(p) {
    const signals = [];
    const statusFields = [p.mls_status, p.listing_status, p.status];
    for (const f of statusFields) if (f) signals.push(String(f).toLowerCase());
    const joined = signals.join(' ');

    if (/\b(expired|withdrawn|cancell?ed|canceled|terminated|released)\b/.test(joined)) {
        return { reject: true, hasSoldSignal: false };
    }
    if (/\b(pending|contingent|under[ _-]?contract)\b/.test(joined)) {
        return { reject: true, hasSoldSignal: false };
    }
    if (/\bactive\b/.test(joined) && !/\b(sold|closed)\b/.test(joined)) {
        return { reject: true, hasSoldSignal: false };
    }
    const hasSoldSignal = /\b(sold|closed)\b/.test(joined);
    return { reject: false, hasSoldSignal };
}

Deno.serve(async (req) => {
    const startTime = Date.now();
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        let body = {};
        try { body = await req.json(); } catch (_e) {}
        const dryRun = body.dry_run === true;
        const zipFilter = body.zip_code || null;

        // Query HEURISTIC_SOLD records. After we demote them they drop out of this
        // query, so the next invocation naturally gets the next unprocessed batch.
        const query = zipFilter
            ? { zip_code: zipFilter, original_status: 'HEURISTIC_SOLD' }
            : { original_status: 'HEURISTIC_SOLD' };

        const page = await base44.asServiceRole.entities.MasterProperty.filter(
            query, '-created_date', BATCH_SIZE
        );
        const arr = Array.isArray(page) ? page : (page?.items || []);

        if (arr.length === 0) {
            console.log(`[reclassify] COMPLETE — no more HEURISTIC_SOLD records${zipFilter ? ` for zip ${zipFilter}` : ''}`);
            return Response.json({
                status: 'completed',
                message: 'Reclassification complete.',
                remaining: 0,
                dry_run: dryRun,
            });
        }

        let batchDemoted = 0;
        let batchErrors = 0;
        let rateLimitHits = 0;

        for (const p of arr) {
            if (Date.now() - startTime > 150000) break; // safety margin before 180s timeout

            const sanity = checkMlsListingSanity(p);
            // Under new rules, HEURISTIC_SOLD requires a positive sold/closed signal.
            // Stored records don't have mls_status fields in our schema, so virtually
            // all stored HEURISTIC_SOLD records fail this test → demote.
            const shouldDemote = sanity.reject || !sanity.hasSoldSignal;

            if (shouldDemote) {
                if (dryRun) {
                    batchDemoted++;
                } else {
                    try {
                        await base44.asServiceRole.entities.MasterProperty.update(p.id, {
                            original_status: 'RECENT_OFF_MARKET',
                            sale_confidence: 'low',
                        });
                        batchDemoted++;
                        await sleep(INTER_UPDATE_DELAY_MS);
                    } catch (e) {
                        batchErrors++;
                        if (/429|rate limit/i.test(e.message)) {
                            rateLimitHits++;
                            await sleep(Math.min(500 + rateLimitHits * 500, 5000));
                        } else {
                            console.warn(`[reclassify] Update failed for ${p.id}: ${e.message}`);
                        }
                    }
                }
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`[reclassify] Batch done | scanned=${arr.length} | demoted=${batchDemoted} | errors=${batchErrors} | 429s=${rateLimitHits} | elapsed=${elapsed}ms | dry_run=${dryRun}`);

        // Self-chain: fire another invocation IF there's more work AND we're writing.
        // Dry runs do NOT self-chain — they'd loop infinitely because we don't demote
        // records, so the same batch keeps coming back. For counting, use the
        // existing dry_run=true call once — we already know the answer is 6,948.
        const moreLikely = arr.length >= BATCH_SIZE;
        if (moreLikely && !dryRun) {
            setTimeout(() => {
                base44.functions.invoke('reclassifyMlsData', { zip_code: zipFilter })
                    .catch(e => console.warn(`[reclassify] Self-chain failed: ${e.message}`));
            }, 1500);
        }

        return Response.json({
            status: moreLikely ? 'running' : 'completed',
            batch_scanned: arr.length,
            batch_demoted: batchDemoted,
            batch_errors: batchErrors,
            rate_limit_hits: rateLimitHits,
            dry_run: dryRun,
            elapsed_ms: elapsed,
        });

    } catch (error) {
        console.error('[reclassify] FATAL:', error.message, error.stack);
        return Response.json({ error: error.message }, { status: 500 });
    }
});