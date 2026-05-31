import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const FREE_AREA_LIMIT_SQ_MI = 40;
const PAID_AREA_LIMIT_SQ_MI = 300;
const MAX_COUNTIES_PER_PULL = 1;
const PRECISION_PRICE_PER_USER = 99;
const BATCHDATA_PLAN_COST = 1000;
const BATCHDATA_PLAN_RECORDS = 100000;
const DEFAULT_RECORD_CAP = 1000;

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
        const isPaid = user.subscription_status === 'active' || user.is_owner || user.role === 'admin';
        const maxArea = isPaid ? PAID_AREA_LIMIT_SQ_MI : FREE_AREA_LIMIT_SQ_MI;
        const hardRejected = areaSqMi > maxArea;
        const recordCap = Math.min(Number(body.record_cap || DEFAULT_RECORD_CAP), DEFAULT_RECORD_CAP);
        const costPerRecord = BATCHDATA_PLAN_COST / BATCHDATA_PLAN_RECORDS;
        const estimatedMaxCost = recordCap * costPerRecord;

        return Response.json({
            success: true,
            mode: 'dry_run_no_batchdata_charge',
            provider: 'batchdata',
            phase: 'phase_1_precision_preview',
            polygon_hash: await polygonHash(polygon),
            centroid: center,
            area_sq_mi: Number(areaSqMi.toFixed(2)),
            max_area_sq_mi: maxArea,
            hard_rejected: hardRejected,
            rejection_reason: hardRejected ? `Area is ${Math.round(areaSqMi)} sq mi, above the ${maxArea} sq mi limit.` : null,
            county_resolution: fips,
            county_count_cap: MAX_COUNTIES_PER_PULL,
            estimated_record_cap: recordCap,
            estimated_batchdata_cost_per_record: costPerRecord,
            estimated_max_batchdata_cost: Number(estimatedMaxCost.toFixed(2)),
            pricing_context: {
                precision_price_per_user: PRECISION_PRICE_PER_USER,
                break_even_records_per_user: Math.floor(PRECISION_PRICE_PER_USER / costPerRecord),
                batchdata_plan_cost: BATCHDATA_PLAN_COST,
                batchdata_plan_records: BATCHDATA_PLAN_RECORDS
            },
            message: hardRejected
                ? 'Preview only. No BatchData call was made. Redraw a smaller area before pulling data.'
                : 'Preview only. No BatchData call was made. Area is eligible for a Phase 1 Precision pull.'
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});