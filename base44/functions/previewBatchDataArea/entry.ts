import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const FREE_AREA_LIMIT_SQ_MI = 40;
const PAID_AREA_LIMIT_SQ_MI = 300;
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

async function runSandboxProbe(center) {
    const apiKey = Deno.env.get('BATCH_DATA_SANDBOX_KEY');
    if (!apiKey || !center) return null;

    const response = await fetch('https://api.batchdata.com/api/v1/property/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            searchCriteria: { query: `${center.lat},${center.lng}` },
            options: { datasets: ['basic'], limit: 5 }
        })
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw_text: text.slice(0, 300) }; }
    const records = payload?.results?.properties || payload?.properties || payload?.results || [];
    const list = Array.isArray(records) ? records : [records].filter(Boolean);
    return { ok: response.ok, status: response.status, record_count: list.length };
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
        const isAdminTestOverride = user.role === 'admin' && body.test_account_type;
        const isPaid = isAdminTestOverride
            ? body.test_account_type === 'paid'
            : (user.subscription_status === 'active' || user.is_owner || user.role === 'admin');
        const maxArea = isPaid ? PAID_AREA_LIMIT_SQ_MI : FREE_AREA_LIMIT_SQ_MI;
        const maxProperties = isPaid ? PAID_PROPERTY_CAP : FREE_PROPERTY_CAP;
        const requestedRaw = Number(body.requested_properties || body.record_cap || maxProperties);
        const requestedProperties = Math.max(1, Math.min(Number.isFinite(requestedRaw) ? requestedRaw : maxProperties, maxProperties));
        const box = boundsMiles(polygon);
        const maxSpanMiles = isPaid ? 35 : 15;
        const hardRejected = areaSqMi > maxArea || box.width_miles > maxSpanMiles || box.height_miles > maxSpanMiles;
        const rejectionReason = areaSqMi > maxArea
            ? `Area is ${Math.round(areaSqMi)} sq mi, above the ${maxArea} sq mi limit.`
            : (hardRejected ? `Area is too wide (${Math.round(Math.max(box.width_miles, box.height_miles))} miles across). Redraw a tighter area.` : null);
        const costPerRecord = BATCHDATA_PLAN_COST / BATCHDATA_PLAN_RECORDS;
        const estimatedMaxCost = requestedProperties * costPerRecord;
        const sandboxProbe = body.sandbox_probe === true && !hardRejected ? await runSandboxProbe(center) : null;

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
                max_allowed_span: maxSpanMiles
            },
            account_type: isPaid ? 'paid_or_admin' : 'free',
            max_area_sq_mi: maxArea,
            max_allowed_properties: maxProperties,
            requested_properties: requestedProperties,
            returned_property_count: hardRejected ? 0 : requestedProperties,
            hard_rejected: hardRejected,
            rejection_reason: rejectionReason,
            county_resolution: fips,
            county_count_cap: MAX_COUNTIES_PER_PULL,
            sandbox_probe: sandboxProbe,
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
                : `This area is eligible to pull up to ${requestedProperties} BatchData properties from your drawn Precision territory.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});