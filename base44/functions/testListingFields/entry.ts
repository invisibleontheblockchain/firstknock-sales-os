import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Diagnostic: Fetch a small sample of RentCast inactive listings and log key fields
// to verify daysOnMarket, removedDate, listedDate, lastSeenDate population rates.

const RENTCAST_API_KEY = Deno.env.get("RENTCAST_API_KEY");
const RENTCAST_BASE = "https://api.rentcast.io/v1";

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        let body = {};
        try { body = await req.json(); } catch (_e) {}

        const lat = body.lat || 32.7767;   // Default: Dallas, TX
        const lng = body.lng || -96.7970;
        const radius = body.radius || 5;
        const sampleSize = Math.min(body.sample_size || 20, 50);

        if (!RENTCAST_API_KEY) {
            return Response.json({ error: 'RENTCAST_API_KEY not configured' });
        }

        const params = new URLSearchParams({
            latitude: String(lat),
            longitude: String(lng),
            radius: String(radius),
            limit: String(sampleSize),
            offset: '0',
            status: 'Inactive',
            daysOld: '90'
        });

        console.log(`[testListingFields] Fetching ${sampleSize} inactive listings near ${lat},${lng} r=${radius}mi`);

        const res = await fetch(`${RENTCAST_BASE}/listings/sale?${params}`, {
            headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => 'no body');
            console.error(`[testListingFields] API error ${res.status}: ${errText}`);
            return Response.json({ error: `RentCast API ${res.status}`, detail: errText.slice(0, 500) });
        }

        const records = await res.json();
        const arr = Array.isArray(records) ? records : [];

        console.log(`[testListingFields] Got ${arr.length} records`);

        // Analyze field population
        const fieldStats = {
            total: arr.length,
            daysOnMarket: { populated: 0, null: 0, values: [] },
            removedDate: { populated: 0, null: 0 },
            listedDate: { populated: 0, null: 0 },
            lastSeenDate: { populated: 0, null: 0 },
            status: { populated: 0, null: 0, values: [] },
            price: { populated: 0, null: 0 },
        };

        const sampleRecords = [];

        for (const r of arr) {
            // daysOnMarket
            if (r.daysOnMarket !== null && r.daysOnMarket !== undefined) {
                fieldStats.daysOnMarket.populated++;
                fieldStats.daysOnMarket.values.push(r.daysOnMarket);
            } else {
                fieldStats.daysOnMarket.null++;
            }

            // removedDate
            if (r.removedDate) fieldStats.removedDate.populated++;
            else fieldStats.removedDate.null++;

            // listedDate
            if (r.listedDate) fieldStats.listedDate.populated++;
            else fieldStats.listedDate.null++;

            // lastSeenDate
            if (r.lastSeenDate) fieldStats.lastSeenDate.populated++;
            else fieldStats.lastSeenDate.null++;

            // status
            if (r.status) {
                fieldStats.status.populated++;
                if (!fieldStats.status.values.includes(r.status)) fieldStats.status.values.push(r.status);
            } else {
                fieldStats.status.null++;
            }

            // price
            if (r.price !== null && r.price !== undefined) fieldStats.price.populated++;
            else fieldStats.price.null++;

            // Compute derived DOM like processFetchChunk does
            const removed = r.removedDate ? new Date(r.removedDate) : null;
            const daysSinceRemoved = removed ? Math.round((Date.now() - removed.getTime()) / (1000 * 3600 * 24)) : null;
            const effectiveDOM = r.daysOnMarket || daysSinceRemoved;

            sampleRecords.push({
                address: r.formattedAddress || r.addressLine1 || 'unknown',
                daysOnMarket: r.daysOnMarket ?? null,
                daysSinceRemoved,
                effectiveDOM,
                removedDate: r.removedDate || null,
                listedDate: r.listedDate || null,
                lastSeenDate: r.lastSeenDate || null,
                status: r.status || null,
                price: r.price || null,
                wouldBeBatchDataEligible: effectiveDOM !== null && effectiveDOM < 30,
            });
        }

        // Summary
        const domValues = fieldStats.daysOnMarket.values;
        const summary = {
            field_population_rates: {
                daysOnMarket: `${fieldStats.daysOnMarket.populated}/${fieldStats.total} (${Math.round(fieldStats.daysOnMarket.populated / fieldStats.total * 100)}%)`,
                removedDate: `${fieldStats.removedDate.populated}/${fieldStats.total} (${Math.round(fieldStats.removedDate.populated / fieldStats.total * 100)}%)`,
                listedDate: `${fieldStats.listedDate.populated}/${fieldStats.total} (${Math.round(fieldStats.listedDate.populated / fieldStats.total * 100)}%)`,
                lastSeenDate: `${fieldStats.lastSeenDate.populated}/${fieldStats.total} (${Math.round(fieldStats.lastSeenDate.populated / fieldStats.total * 100)}%)`,
            },
            daysOnMarket_stats: domValues.length > 0 ? {
                min: Math.min(...domValues),
                max: Math.max(...domValues),
                avg: Math.round(domValues.reduce((a, b) => a + b, 0) / domValues.length),
                median: domValues.sort((a, b) => a - b)[Math.floor(domValues.length / 2)],
                under30: domValues.filter(v => v < 30).length,
                over30: domValues.filter(v => v >= 30).length,
            } : 'No daysOnMarket values found — relying on daysSinceRemoved fallback',
            batchdata_gate_impact: {
                eligible_count: sampleRecords.filter(r => r.wouldBeBatchDataEligible).length,
                gated_count: sampleRecords.filter(r => !r.wouldBeBatchDataEligible).length,
                savings_pct: `${Math.round(sampleRecords.filter(r => !r.wouldBeBatchDataEligible).length / Math.max(sampleRecords.length, 1) * 100)}%`,
            },
        };

        console.log(`[testListingFields] Summary: ${JSON.stringify(summary, null, 2)}`);

        return Response.json({
            summary,
            sample_records: sampleRecords.slice(0, 10), // First 10 for inspection
            api_calls_used: 1,
        });

    } catch (error) {
        console.error('[testListingFields] Error:', error.message, error.stack);
        return Response.json({ error: error.message }, { status: 500 });
    }
});