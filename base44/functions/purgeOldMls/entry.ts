import { createClientFromRequest } from "npm:@base44/sdk@0.8.23";

// v15 Purge: Delete all unverified RentCast MLS records from MasterProperty.
// Keeps: deed records (sale_confidence='high'), verified MLS (DEED_CONFIRMED, BATCHDATA_CONFIRMED)
// Deletes: HEURISTIC_SOLD, RECENT_OFF_MARKET, MLS_PENDING_VERIFICATION with data_source='rentcast'
//
// Invoke with POST body: { "action": "preview" } to see what would be deleted
//                        { "action": "purge" }   to actually delete

Deno.serve(async (req) => {
    const base44 = createClientFromRequest(req);

    try {
        const body = await req.json().catch(() => ({}));
        const action = body.action || 'preview';
        const targetZips = body.zips || null; // Optional: limit to specific zips

        console.log(`[purgeOldMls] action=${action}`);

        // Get all zip codes that have data, or use provided zips
        let zipsToProcess = targetZips;
        if (!zipsToProcess) {
            // Fetch all MasterProperty to discover zip codes
            // Use a broad query — get everything with data_source='rentcast'
            const allRentcast = await base44.asServiceRole.entities.MasterProperty.filter(
                { data_source: 'rentcast' }, null, 5000
            ).catch(() => []);
            const arr = Array.isArray(allRentcast) ? allRentcast : (allRentcast?.items || []);
            zipsToProcess = [...new Set(arr.map(p => p.zip_code).filter(Boolean))];
            console.log(`[purgeOldMls] Discovered ${zipsToProcess.length} zips with RentCast data, ${arr.length} total records`);
        }

        // Collect all unverified MLS records
        let toDelete = [];
        let toKeep = [];
        let totalScanned = 0;

        for (const zip of zipsToProcess) {
            try {
                const res = await base44.asServiceRole.entities.MasterProperty.filter(
                    { zip_code: zip }, null, 5000
                );
                const items = Array.isArray(res) ? res : (res?.items || []);
                totalScanned += items.length;

                for (const p of items) {
                    // KEEP: deed records, verified MLS, BatchData confirmed
                    const isVerified = (
                        p.sale_confidence === 'high' ||
                        p.sale_confidence === 'verified' ||
                        p.original_status === 'DEED_CONFIRMED' ||
                        p.original_status === 'BATCHDATA_CONFIRMED' ||
                        p.original_status === 'SOLD' ||
                        p.data_source === 'rentcast_crossref'
                    );

                    // Only target RentCast-sourced MLS records that aren't verified
                    const isUnverifiedMls = (
                        p.data_source === 'rentcast' && !isVerified
                    );

                    if (isUnverifiedMls) {
                        toDelete.push(p);
                    } else {
                        toKeep.push(p);
                    }
                }
            } catch (e) {
                console.error(`[purgeOldMls] Zip ${zip} failed: ${e.message}`);
            }
        }

        // Breakdown
        const deleteCounts = {};
        for (const p of toDelete) {
            const key = `${p.original_status}/${p.sale_confidence}`;
            deleteCounts[key] = (deleteCounts[key] || 0) + 1;
        }

        const keepCounts = {};
        for (const p of toKeep) {
            const key = `${p.original_status}/${p.sale_confidence}`;
            keepCounts[key] = (keepCounts[key] || 0) + 1;
        }

        console.log(`[purgeOldMls] Scanned ${totalScanned} | DELETE ${toDelete.length} | KEEP ${toKeep.length}`);
        console.log(`[purgeOldMls] Delete breakdown: ${JSON.stringify(deleteCounts)}`);
        console.log(`[purgeOldMls] Keep breakdown: ${JSON.stringify(keepCounts)}`);

        if (action === 'preview') {
            return Response.json({
                action: 'preview',
                total_scanned: totalScanned,
                will_delete: toDelete.length,
                will_keep: toKeep.length,
                delete_breakdown: deleteCounts,
                keep_breakdown: keepCounts,
                message: `Will delete ${toDelete.length} unverified MLS records. Call with action='purge' to execute.`
            });
        }

        // PURGE — actually delete the records
        if (action === 'purge') {
            let deleted = 0;
            let errors = 0;

            for (let i = 0; i < toDelete.length; i++) {
                try {
                    await base44.asServiceRole.entities.MasterProperty.delete(toDelete[i].id);
                    deleted++;
                    if (deleted % 100 === 0) {
                        console.log(`[purgeOldMls] Deleted ${deleted}/${toDelete.length}...`);
                    }
                } catch (e) {
                    errors++;
                    if (errors <= 5) console.error(`[purgeOldMls] Delete error: ${e.message}`);
                }
            }

            console.log(`[purgeOldMls] PURGE COMPLETE: deleted=${deleted}, errors=${errors}, kept=${toKeep.length}`);

            return Response.json({
                action: 'purge',
                deleted,
                errors,
                kept: toKeep.length,
                message: `Purged ${deleted} unverified MLS records. ${toKeep.length} verified records remain. Re-pull data to get fresh v15 results.`
            });
        }

        return Response.json({ error: 'Unknown action. Use "preview" or "purge".' }, { status: 400 });

    } catch (err) {
        console.error(`[purgeOldMls] Fatal: ${err.message}`);
        return Response.json({ error: err.message }, { status: 500 });
    }
});
