import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const FREE_AREA_LIMIT_SQ_MI = 40;
const PAID_AREA_LIMIT_SQ_MI = 300;
const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;

function normalizePolygon(input) {
    if (!Array.isArray(input)) return [];
    return input.map(point => ({ lat: Number(point.lat), lng: Number(point.lng) })).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
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
    return {
        lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
        lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length
    };
}

function boundsMiles(points) {
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;
    return {
        width_miles: Math.abs(maxLng - minLng) * 69.0 * Math.cos(midLat * Math.PI / 180),
        height_miles: Math.abs(maxLat - minLat) * 69.0
    };
}

async function resolveFips(center) {
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
            return Response.json({ error: 'Precision pulls now require a freehand drawn polygon.' }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const isPaid = user.subscription_status === 'active' || user.is_owner || user.role === 'admin';
        const maxArea = isPaid ? PAID_AREA_LIMIT_SQ_MI : FREE_AREA_LIMIT_SQ_MI;
        const maxProperties = isPaid ? PAID_PROPERTY_CAP : FREE_PROPERTY_CAP;
        const requestedRaw = Number(body.requested_properties || body.record_cap || maxProperties);
        const requestedProperties = Math.max(1, Math.min(Number.isFinite(requestedRaw) ? requestedRaw : maxProperties, maxProperties));
        const box = boundsMiles(polygon);
        const maxSpanMiles = isPaid ? 35 : 15;

        if (areaSqMi > maxArea || box.width_miles > maxSpanMiles || box.height_miles > maxSpanMiles) {
            return Response.json({
                error: 'area_too_large',
                message: `Area is too large for this account. Limit is ${maxArea} sq mi and ${maxSpanMiles} miles across.`
            }, { status: 400 });
        }

        const fips = await resolveFips(center);
        if (!fips?.fips_code) {
            return Response.json({ error: 'Could not resolve county/FIPS for this area. Please redraw inside a supported US county.' }, { status: 400 });
        }

        if (body.dry_run === true) {
            return Response.json({
                status: 'dry_run',
                provider: 'batchdata',
                phase: 'batchdata_precision',
                fips_code: fips.fips_code,
                area_sq_mi: Number(areaSqMi.toFixed(2)),
                requested_properties: requestedProperties,
                message: 'Dry run only — BatchData-only Precision path validated without creating a FetchJob.'
            });
        }

        const runningJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'running' }, null, 5);
        const pendingJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'pending' }, null, 5);
        const activeJob = (Array.isArray(runningJobs) ? runningJobs : runningJobs?.items || [])[0] || (Array.isArray(pendingJobs) ? pendingJobs : pendingJobs?.items || [])[0];
        if (activeJob) return Response.json({ status: 'already_running', job_id: activeJob.id, message: 'A data pull is already running.' });

        const hash = await polygonHash(polygon);
        const job = await base44.entities.FetchJob.create({
            status: 'pending',
            provider: 'batchdata',
            mode_tag: 'PRECISION_TARGET',
            phase: 'batchdata_precision',
            latitude: center.lat,
            longitude: center.lng,
            radius: Math.sqrt(areaSqMi / Math.PI),
            polygon,
            fips_code: fips.fips_code,
            area_sq_mi: Number(areaSqMi.toFixed(2)),
            polygon_hash: hash,
            estimated_record_count: requestedProperties,
            estimated_cost: Number((requestedProperties * 0.01).toFixed(2)),
            dry_run_metadata: { county_resolution: fips, requested_properties: requestedProperties, batchdata_only_started_at: new Date().toISOString() },
            sold_months: Number(body.sold_months || 12),
            include_mls: false,
            pull_mode: 'new_area',
            user_email: user.email,
            progress_pct: 0,
            current_offset: 0,
            total_expected: requestedProperties,
            total_sub_circles: 1,
            completed_sub_circles: 0,
            total_batchdata_calls: 0,
            error_log: [],
            chunk_timings: []
        });

        base44.asServiceRole.functions.invoke('processFetchChunk', { expected_chunk: 0 }).catch(error => {
            console.warn(`[fetchAreaProperties] BatchData processor invoke failed: ${error.message}`);
        });

        return Response.json({
            status: 'started',
            job_id: job.id,
            provider: 'batchdata',
            phase: 'batchdata_precision',
            requested_properties: requestedProperties,
            message: `BatchData Precision pull started for up to ${requestedProperties} properties.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});