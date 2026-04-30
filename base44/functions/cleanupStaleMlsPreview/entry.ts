import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const STALE_DAYS = 30;
const PHASE_2_STATUSES = new Set(['BATCHDATA_CONFIRMED', 'MLS_PENDING_VERIFICATION']);
const REJECTED_CONFIDENCE = 'REJECTED';

function isPhase1DeedRecord(property) {
    const dataSource = String(property.data_source || '').toLowerCase();
    const saleType = String(property.sale_type || '').toLowerCase();
    const originalStatus = String(property.original_status || '').toUpperCase();

    return dataSource.includes('deed') ||
        dataSource.includes('county_deed') ||
        saleType === 'deed' ||
        originalStatus === 'DEED_CONFIRMED';
}

function isOlderThanCutoff(soldDate, cutoff) {
    if (!soldDate) return false;
    const parsed = new Date(soldDate);
    return !Number.isNaN(parsed.getTime()) && parsed < cutoff;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        let body = {};
        try { body = await req.json(); } catch (_e) { body = {}; }
        const apply = body.apply === true;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - STALE_DAYS);

        const propertiesRaw = await base44.asServiceRole.entities.MasterProperty.list('-created_date', 10000);
        const properties = Array.isArray(propertiesRaw) ? propertiesRaw : (propertiesRaw?.items || []);

        const logsRaw = await base44.asServiceRole.entities.InteractionLog.list('-created_date', 10000);
        const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);
        const knockedHashes = new Set(logs.map(log => log.address_hash).filter(Boolean));

        const deedHashes = new Set(
            properties
                .filter(isPhase1DeedRecord)
                .map(property => property.address_hash)
                .filter(Boolean)
        );

        const skipped = {
            deedRecords: 0,
            rejectedOrInactive: 0,
            knocked: 0,
            noSoldDateOrFresh: 0,
            deedHashMatch: 0,
            wrongStatus: 0
        };

        const candidates = [];

        for (const property of properties) {
            if (isPhase1DeedRecord(property)) {
                skipped.deedRecords++;
                continue;
            }

            if (property.sale_confidence === REJECTED_CONFIDENCE || property.route_active === false) {
                skipped.rejectedOrInactive++;
                continue;
            }

            if (property.knocked === true || knockedHashes.has(property.address_hash)) {
                skipped.knocked++;
                continue;
            }

            if (!PHASE_2_STATUSES.has(property.original_status)) {
                skipped.wrongStatus++;
                continue;
            }

            if (!isOlderThanCutoff(property.sold_date, cutoff)) {
                skipped.noSoldDateOrFresh++;
                continue;
            }

            if (deedHashes.has(property.address_hash)) {
                skipped.deedHashMatch++;
                continue;
            }

            candidates.push(property);
        }

        let deactivated = 0;
        if (apply) {
            for (const property of candidates) {
                await base44.asServiceRole.entities.MasterProperty.update(property.id, {
                    route_active: false,
                    sale_confidence: 'REJECTED',
                    original_status: 'REJECTED'
                });
                deactivated++;
            }
        }

        const totalSkipped = Object.values(skipped).reduce((sum, count) => sum + count, 0);
        console.log(`[stale-mls-cleanup] apply=${apply} scanned=${properties.length} candidates=${candidates.length} deactivated=${deactivated} skipped=${totalSkipped} cutoff=${cutoff.toISOString()}`);
        console.log(`[stale-mls-cleanup] skipped=${JSON.stringify(skipped)}`);
        console.log(`[stale-mls-cleanup] deed records touched=0`);

        return Response.json({
            apply,
            cutoff: cutoff.toISOString(),
            scanned: properties.length,
            staleCandidates: candidates.length,
            deactivated,
            skipped,
            totalSkipped,
            deedRecordsTouched: 0,
            sample: candidates.slice(0, 20).map(property => ({
                id: property.id,
                address_hash: property.address_hash,
                full_address: property.full_address || `${property.house_number || ''} ${property.street_name || ''}`.trim(),
                original_status: property.original_status,
                sale_confidence: property.sale_confidence,
                sold_date: property.sold_date,
                data_source: property.data_source,
                sale_type: property.sale_type
            }))
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});