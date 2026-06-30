import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import Stripe from 'npm:stripe@14.14.0';

const FREE_AREA_LIMIT_SQ_MI = 40;
const PAID_AREA_LIMIT_SQ_MI = 300;
const FREE_PROPERTY_CAP = 50;
const PAID_PROPERTY_CAP = 1000;

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
    return {
        lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
        lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length
    };
}

function isPrecisionProUser(user) {
    const tier = String(user?.subscription_tier || '').toLowerCase();
    const status = String(user?.subscription_status || '').toLowerCase();
    if (user?.is_owner || user?.role === 'admin') return true;
    return ['active', 'trialing'].includes(status) && ['pro', 'precision'].includes(tier);
}

async function hasConfirmedPaidPrecisionAccess(user) {
    const tier = String(user?.subscription_tier || '').toLowerCase();
    const status = String(user?.subscription_status || '').toLowerCase();
    if (user?.is_owner || user?.role === 'admin') return true;
    if (!['pro', 'precision'].includes(tier)) return false;
    if (status === 'active' && user?.subscription_paid_confirmed === true) return true;
    if (!user?.stripe_customer_id) return false;

    const secret = Deno.env.get('STRIPE_SECRET_KEY');
    if (!secret) return false;

    const stripe = new Stripe(secret);
    const subscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: 'all',
        limit: 10,
        expand: ['data.latest_invoice']
    });

    return subscriptions.data.some((subscription) => {
        const amountCents = subscription.items?.data?.[0]?.price?.unit_amount || 0;
        const latestInvoice = subscription.latest_invoice;
        const invoicePaid = latestInvoice && typeof latestInvoice !== 'string' && latestInvoice.status === 'paid';
        const trialEnded = !subscription.trial_end || subscription.trial_end * 1000 <= Date.now();
        return subscription.status === 'active' && trialEnded && invoicePaid && amountCents >= 9900;
    });
}

function isPremiumRecentRange(soldMonths) {
    const months = Number(soldMonths || 12);
    return Number.isFinite(months) && months <= 1;
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
            return Response.json({ error: 'At least 3 polygon points are required.' }, { status: 400 });
        }

        const areaSqMi = polygonAreaSqMi(polygon);
        const center = centroid(polygon);
        const forceFreeForSelfTest = body.self_test_force_free === true && body.dry_run === true;
        const isPaid = !forceFreeForSelfTest && (user.subscription_status === 'active' || user.subscription_status === 'trialing' || user.is_owner || user.role === 'admin');
        const hasPaidPrecisionCapacity = !forceFreeForSelfTest && await hasConfirmedPaidPrecisionAccess(user);
        const hasPrecisionPro = !forceFreeForSelfTest && isPrecisionProUser(user);
        const requestedSoldMonths = Number(body.sold_months || 12);
        if (isPremiumRecentRange(requestedSoldMonths) && !hasPrecisionPro) {
            return Response.json({
                error: 'upgrade_required',
                message: '1 day, 2 day, 1 week, 2 week, and 1 month Precision pulls require a Pro plan.'
            }, { status: 403 });
        }
        const maxArea = isPaid ? PAID_AREA_LIMIT_SQ_MI : FREE_AREA_LIMIT_SQ_MI;
        const maxProperties = hasPaidPrecisionCapacity ? PAID_PROPERTY_CAP : FREE_PROPERTY_CAP;
        const requestedRaw = Number(body.requested_properties || maxProperties);
        const requestedValue = Math.max(1, Number.isFinite(requestedRaw) ? requestedRaw : maxProperties);
        if (!hasPaidPrecisionCapacity && requestedValue > FREE_PROPERTY_CAP) {
            return Response.json({
                error: 'paid_precision_required',
                message: 'Precision pulls over 50 houses require the paid $99/month Precision plan after the first payment clears. Free trials and card-on-file accounts stay capped at 50 houses.'
            }, { status: 403 });
        }
        const requestedProperties = Math.max(1, Math.min(requestedValue, maxProperties));
        const minPriceRaw = Number(body.min_price);
        const maxPriceRaw = Number(body.max_price);
        const minPrice = Number.isFinite(minPriceRaw) && minPriceRaw > 0 ? minPriceRaw : 100000;
        const maxPrice = Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? maxPriceRaw : null;
        const box = boundsMiles(polygon);
        const maxSpanMiles = isPaid ? 35 : 15;
        if (areaSqMi > maxArea) {
            return Response.json({
                error: 'area_too_large',
                message: `Precision pulls are limited to ${maxArea.toLocaleString()} square miles per draw. Your selected area is ${Math.round(areaSqMi).toLocaleString()} square miles. Please draw a smaller territory.`
            }, { status: 400 });
        }
        if (box.width_miles > maxSpanMiles || box.height_miles > maxSpanMiles) {
            return Response.json({
                error: 'area_span_too_large',
                message: `Precision pulls are limited to about ${maxSpanMiles} miles across per draw. Please draw a tighter territory.`
            }, { status: 400 });
        }

        const fips = await resolveFips(center);
        if (!fips?.fips_code) {
            return Response.json({ error: 'Could not resolve county/FIPS for this area. Please redraw inside a supported US county.' }, { status: 400 });
        }

        if (body.dry_run === true) {
            return Response.json({
                success: true,
                dry_run: true,
                provider: 'batchdata',
                fips_code: fips.fips_code,
                requested_properties: requestedProperties,
                sold_months: requestedSoldMonths,
                previous_pull_date: body.previous_pull_date || null,
                include_unresolved_followups: body.include_unresolved_followups === true,
                area_sq_mi: Number(areaSqMi.toFixed(2))
            });
        }

        const runningJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'running' }, null, 5);
        const pendingJobs = await base44.entities.FetchJob.filter({ user_email: user.email, status: 'pending' }, null, 5);
        const runningList = Array.isArray(runningJobs) ? runningJobs : (runningJobs?.items || []);
        const pendingList = Array.isArray(pendingJobs) ? pendingJobs : (pendingJobs?.items || []);
        const existingJob = runningList[0] || pendingList[0];
        if (existingJob) {
            return Response.json({ status: 'already_running', job_id: existingJob.id, message: 'A data pull is already running.' });
        }

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
            dry_run_metadata: {
                county_resolution: fips,
                requested_properties: requestedProperties,
                count_mode: body.count_mode === 'max_available' ? 'max_available' : 'fixed',
                repull_mode: body.repull_mode || 'new_area',
                previous_pull_date: body.previous_pull_date || null,
                force_full_refresh: body.force_full_refresh === true,
                include_unresolved_followups: body.include_unresolved_followups === true,
                filters: {
                    min_price: minPrice,
                    max_price: maxPrice
                },
                paid_pull_started_at: new Date().toISOString()
            },
            sold_months: requestedSoldMonths,
            force_full_refresh: body.force_full_refresh === true,
            pull_mode: body.force_full_refresh === true ? 'full_refresh' : 'new_area',
            include_mls: false,
            user_email: user.email,
            progress_pct: 0,
            current_offset: 0,
            total_expected: requestedProperties,
            total_sub_circles: 1,
            completed_sub_circles: 0,
            total_batchdata_calls: 0
        });

        base44.asServiceRole.functions.invoke('processFetchChunk', { expected_chunk: 0 }).catch(error => {
            console.warn(`[startBatchDataPull] Background processor invoke failed: ${error.message}`);
        });

        return Response.json({
            success: true,
            status: 'started',
            job_id: job.id,
            provider: 'batchdata',
            requested_properties: requestedProperties,
            message: `Paid BatchData pull started for up to ${requestedProperties} properties.`
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});