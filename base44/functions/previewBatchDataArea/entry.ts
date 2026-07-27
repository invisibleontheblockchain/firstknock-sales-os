import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;
const MAX_COUNTIES_PER_PULL = 1;
const PRECISION_PRICE_PER_USER = 99;
const BATCHDATA_PLAN_COST = 1000;
const BATCHDATA_PLAN_RECORDS = 100000;

function normalizePolygon(input) {
    if (!Array.isArray(input)) return [];
    return input
        .map(point => ({ lat: Number(point.lat), lng: Number(point.lng) }))
        .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function polygonAreaSqMi(points) {
    if (points.length < 3) return 0;
    const avgLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
    const milesPerLat = 69.0;
    const milesPerLng = 69.0 * Math.cos(avgLat * Math.PI / 180);
    const projected = points.map(p => ({ x: p.lng * milesPerLng, y: p.lat * milesPerLat }));
    let sum = 0;
    for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        const b = projected[(i + 1) % projected.length];
        sum += (a.x * b.y) - (b.x * a.y);
    }
    return Math.abs(sum) / 2;
}

function centroid(points) {
    if (points.length === 0) return null;
    return {
        lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
        lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length
    };
}

function boundsMiles(points) {
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;
    return {
        width_miles: Math.abs(maxLng - minLng) * 69.0 * Math.cos(midLat * Math.PI / 180),
        height_miles: Math.abs(maxLat - minLat) * 69.0
    };
}

const SANDBOX_PROBE_TIMEOUT_MS = 8000;

// The probe is a provider REACHABILITY check. It queries the polygon centroid
// as a text string, so it says nothing about the drawn geometry and nothing
// about how many properties the area contains. A failure here must therefore
// never fail the Preview: the county resolution, area and allowance estimate
// are all still valid without it.
async function runSandboxProbe(center) {
    const apiKey = Deno.env.get('BATCH_DATA_SANDBOX_KEY');
    if (!apiKey || !center) return { probe: null, error: null };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), SANDBOX_PROBE_TIMEOUT_MS) : null;
    try {
        const response = await fetch('https://api.batchdata.com/api/v1/property/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                searchCriteria: { query: `${center.lat},${center.lng}` },
                options: { datasets: ['basic'], limit: 5 }
            }),
            ...(controller ? { signal: controller.signal } : {})
        });
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw_text: text.slice(0, 300) }; }
        const records = payload?.results?.properties || payload?.properties || payload?.results || [];
        const list = Array.isArray(records) ? records : [records].filter(Boolean);
        return { probe: { ok: response.ok, status: response.status, record_count: list.length }, error: null };
    } catch (error) {
        console.warn(`[previewBatchDataArea] provider probe unavailable: ${error?.message || error}`);
        return { probe: null, error: 'provider_unreachable' };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function resolveFips(center) {
    if (!center) return null;
    const url = `https://geo.fcc.gov/api/census/block/find?latitude=${encodeURIComponent(center.lat)}&longitude=${encodeURIComponent(center.lng)}&format=json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    return {
        fips_code: data?.County?.FIPS || null,
        county_name: data?.County?.name || null,
        state_code: data?.State?.code || null,
        state_name: data?.State?.name || null
    };
}

async function polygonHash(points) {
    const normalized = points.map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function getAuthoritativePrecisionUsage(base44) {
    const response = await base44.functions.invoke('getPrecisionUsage', {});
    const usage = response?.data || response;
    if (!usage?.success || usage?.complete !== true || Number(usage?.version) < 2) {
        throw new Error(usage?.message || 'Precision usage is unavailable.');
    }
    const fields = ['limit', 'used', 'reserved', 'meter_used', 'remaining', 'lifetime_used'];
    if (fields.some(field => !Number.isFinite(Number(usage[field])) || Number(usage[field]) < 0)) {
        throw new Error('Precision usage returned an invalid allowance snapshot.');
    }
    return usage;
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const polygon = normalizePolygon(body.polygon);
        if (polygon.length < 3) {
            return Response.json({ error: 'At least 3 polygon points are required for a freehand area preview.' }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const fips = await resolveFips(center);
        const usage = await getAuthoritativePrecisionUsage(base44);
        const isPaid = usage.paid_access === true;
        const existingRouteHomes = Math.max(0, Number(usage.lifetime_used || 0));
        const freeHomesRemaining = isPaid ? null : Math.max(0, Number(usage.remaining || 0));
        const paidPropertyLimit = PAID_PROPERTY_CAP;
        const paidPropertiesUsed = isPaid ? Math.max(0, Number(usage.meter_used || 0)) : null;
        const paidPropertiesRemaining = isPaid ? Math.max(0, Number(usage.remaining || 0)) : null;
        const maxProperties = isPaid ? paidPropertiesRemaining : freeHomesRemaining;
        const requestedRaw = Number(body.requested_properties || body.record_cap || maxProperties);
        const requestedProperties = maxProperties <= 0
            ? 0
            : Math.max(1, Math.min(Number.isFinite(requestedRaw) ? requestedRaw : maxProperties, maxProperties));
        const box = boundsMiles(polygon);
        const hardRejected = false; // Square mileage limits removed entirely for all accounts
        const rejectionReason = null;
        const costPerRecord = BATCHDATA_PLAN_COST / BATCHDATA_PLAN_RECORDS;
        const estimatedMaxCost = requestedProperties * costPerRecord;
        const probeResult = body.sandbox_probe === true && !hardRejected
            ? await runSandboxProbe(center)
            : { probe: null, error: null };
        const sandboxProbe = probeResult.probe;
        const sandboxProbeError = probeResult.error;

        return Response.json({
            success: true,
            mode: 'sandbox_preview_no_paid_batchdata_charge',
            provider: 'batchdata',
            sandbox: true,
            paid_pull_enabled: true,
            phase: 'phase_1_precision_preview',
            polygon_hash: await polygonHash(polygon),
            centroid: center,
            area_sq_mi: Number(areaSqMi.toFixed(2)),
            bounds_miles: {
                width: Number(box.width_miles.toFixed(2)),
                height: Number(box.height_miles.toFixed(2)),
                max_allowed_span: null
            },
            account_type: isPaid ? 'paid_or_admin' : 'free',
            max_area_sq_mi: null,
            max_allowed_properties: maxProperties,
            requested_properties: requestedProperties,
            existing_active_properties: existingRouteHomes,
            existing_route_homes: existingRouteHomes,
            excluded_route_home_count: existingRouteHomes,
            free_properties_remaining: freeHomesRemaining,
            paid_properties_used: paidPropertiesUsed,
            paid_properties_reserved: isPaid ? Number(usage.reserved || 0) : null,
            paid_properties_remaining: paidPropertiesRemaining,
            paid_property_limit: isPaid ? paidPropertyLimit : null,
            precision_usage_period_start: usage.period_start || null,
            returned_property_count: hardRejected ? 0 : requestedProperties,
            hard_rejected: hardRejected,
            rejection_reason: rejectionReason,
            county_resolution: fips,
            county_count_cap: MAX_COUNTIES_PER_PULL,
            sandbox_probe: sandboxProbe,
            sandbox_probe_error: sandboxProbeError,
            // The probe queries the polygon CENTROID as a text string. It is a
            // provider reachability check, not a measurement of this area.
            sandbox_probe_meaning: 'provider_reachability_at_centroid',
            // `returned_property_count` is an allowance ceiling, not an
            // availability measurement. Nothing here counted properties.
            availability_measured: false,
            estimated_batchdata_cost_per_record: costPerRecord,
            estimated_max_batchdata_cost: Number(estimatedMaxCost.toFixed(2)),
            pricing_context: {
                precision_price_per_user: PRECISION_PRICE_PER_USER,
                break_even_records_per_user: Math.floor(PRECISION_PRICE_PER_USER / costPerRecord),
                batchdata_plan_cost: BATCHDATA_PLAN_COST,
                batchdata_plan_records: BATCHDATA_PLAN_RECORDS
            },
            message: hardRejected
                ? 'Sandbox preview only. Redraw a smaller area before any live BatchData pull.'
                : requestedProperties <= 0
                    ? 'This account has already received its included 50 single-family Precision route homes. Upgrade to Precision for larger routes.'
                : `This area is eligible to pull up to ${requestedProperties} BatchData properties from your drawn Precision territory.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
