import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const RENTCAST_API_KEY = Deno.env.get('RENTCAST_API_KEY');
const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const LIMIT = 500;
const NON_DISCLOSURE_STATES = new Set(['AK', 'ID', 'KS', 'LA', 'MS', 'MO', 'MT', 'NM', 'ND', 'TX', 'UT', 'WY']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizeAddress(address) {
    if (!address) return '';
    let norm = String(address).toUpperCase().trim();
    norm = norm.replace(/[.,#]/g, '').replace(/\s+/g, ' ');
    const abbreviations = {
        STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN', ROAD: 'RD', COURT: 'CT', CIRCLE: 'CIR',
        PLACE: 'PL', TERRACE: 'TER', TRAIL: 'TRL', PARKWAY: 'PKWY', HIGHWAY: 'HWY', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W'
    };
    for (const [full, abbr] of Object.entries(abbreviations)) {
        norm = norm.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
    }
    return norm;
}

function generateNormalizedHash(addressLine, zipCode) {
    return `${normalizeAddress(addressLine)}|${String(zipCode || '00000').trim().slice(0, 5)}`;
}

function isPointInPolygon(point, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return true;
    const x = point.lng;
    const y = point.lat;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].lng;
        const yi = polygon[i].lat;
        const xj = polygon[j].lng;
        const yj = polygon[j].lat;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function getEligibilityRejectionReason(p) {
    if (!p.lastSaleDate) return 'missing_last_sale_date';
    const isNonDisclosure = p.state && NON_DISCLOSURE_STATES.has(String(p.state).toUpperCase());
    if (!isNonDisclosure) {
        if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice < 10000) return 'sale_price_below_10000';
        if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.15) return 'sale_price_below_15pct_assessed';
    } else if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice > 0 && p.lastSalePrice < 1000) {
        return 'non_disclosure_nominal_sale_price';
    }
    const badTypes = ['Commercial', 'Industrial', 'Vacant Land', 'Agricultural'];
    if (p.propertyType && badTypes.includes(p.propertyType)) return 'excluded_property_type';
    return null;
}

function isValidSoldProperty(p) {
    return getEligibilityRejectionReason(p) === null;
}

function sampleRecord(p, extra = {}) {
    const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : '');
    return {
        address: p.formattedAddress || p.addressLine1 || null,
        address_hash: generateNormalizedHash(addressLine, p.zipCode || '00000'),
        lat: p.latitude || null,
        lng: p.longitude || null,
        zipCode: p.zipCode || null,
        propertyType: p.propertyType || null,
        lastSaleDate: p.lastSaleDate || null,
        lastSalePrice: p.lastSalePrice ?? null,
        assessedValue: p.assessedValue ?? null,
        ...extra
    };
}

function summarizePropertyTypes(records) {
    const counts = {};
    for (const record of records) {
        const key = record.propertyType || 'missing';
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => ({ type, count }));
}

async function fetchSubCircle(circle, saleDateRange, polygon, phase1Start, phase1End, index) {
    let offset = 0;
    let raw = 0;
    let eligible = 0;
    let polygonRejected = 0;
    let missingCoordsRejected = 0;
    let eligibilityRejected = 0;
    let dateRejected = 0;
    let duplicateWithinSubCircle = 0;
    let status = 'ok';
    const hashes = new Set();
    const duplicateGroups = {};
    const rawSamples = [];
    const rejectedTypes = [];
    const filterCounts = {
        missing_coordinates: 0,
        outside_polygon: 0,
        missing_last_sale_date: 0,
        sale_price_below_10000: 0,
        sale_price_below_15pct_assessed: 0,
        non_disclosure_nominal_sale_price: 0,
        excluded_property_type: 0,
        invalid_or_outside_sale_date_window: 0,
        duplicate_within_sub_circle: 0
    };
    const rejectedSamples = [];
    const duplicateSamples = [];

    while (true) {
        const params = new URLSearchParams({
            latitude: String(circle.lat),
            longitude: String(circle.lng),
            radius: String(circle.radius),
            limit: String(LIMIT),
            offset: String(offset),
            saleDateRange: String(saleDateRange)
        });
        if (offset === 0) params.set('includeTotalCount', 'true');

        const response = await fetch(`${RENTCAST_BASE}/properties?${params}`, {
            headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY }
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            status = `error_${response.status}`;
            return { index, ...circle, status, error: body.slice(0, 250), raw, eligible, polygonRejected, missingCoordsRejected, eligibilityRejected, dateRejected, duplicateWithinSubCircle, uniqueEligible: hashes.size, rawSamples, rejectedTypes: summarizePropertyTypes(rejectedTypes), filterCounts, rejectedSamples, duplicateSamples };
        }

        const records = await response.json();
        const batch = Array.isArray(records) ? records : [];
        raw += batch.length;
        if (rawSamples.length < 3) {
            rawSamples.push(...batch.slice(0, 3 - rawSamples.length).map(p => ({ address: p.formattedAddress || p.addressLine1, propertyType: p.propertyType, lastSaleDate: p.lastSaleDate, lastSalePrice: p.lastSalePrice })));
        }

        for (const p of batch) {
            if (!p.latitude || !p.longitude) {
                missingCoordsRejected++;
                filterCounts.missing_coordinates++;
                if (rejectedSamples.length < 30) rejectedSamples.push(sampleRecord(p, { reason: 'missing_coordinates', sub_circle: index }));
                continue;
            }
            if (!isPointInPolygon({ lat: p.latitude, lng: p.longitude }, polygon)) {
                polygonRejected++;
                filterCounts.outside_polygon++;
                if (rejectedSamples.length < 30) rejectedSamples.push(sampleRecord(p, { reason: 'outside_polygon', sub_circle: index }));
                continue;
            }
            const rejectionReason = getEligibilityRejectionReason(p);
            if (rejectionReason) {
                eligibilityRejected++;
                filterCounts[rejectionReason] = (filterCounts[rejectionReason] || 0) + 1;
                rejectedTypes.push(p);
                if (rejectedSamples.length < 30) rejectedSamples.push(sampleRecord(p, { reason: rejectionReason, sub_circle: index }));
                continue;
            }
            const saleDate = new Date(p.lastSaleDate);
            if (Number.isNaN(saleDate.getTime()) || saleDate < phase1Start || saleDate > phase1End) {
                dateRejected++;
                filterCounts.invalid_or_outside_sale_date_window++;
                if (rejectedSamples.length < 30) rejectedSamples.push(sampleRecord(p, { reason: 'invalid_or_outside_sale_date_window', sub_circle: index }));
                continue;
            }
            const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : '');
            const hash = generateNormalizedHash(addressLine, p.zipCode || '00000');
            if (hashes.has(hash)) {
                duplicateWithinSubCircle++;
                filterCounts.duplicate_within_sub_circle++;
                duplicateGroups[hash] = duplicateGroups[hash] || [];
                duplicateGroups[hash].push(sampleRecord(p, { reason: 'duplicate_within_sub_circle', sub_circle: index }));
                if (duplicateSamples.length < 15) duplicateSamples.push(sampleRecord(p, { reason: 'duplicate_within_sub_circle', sub_circle: index }));
                continue;
            }
            duplicateGroups[hash] = duplicateGroups[hash] || [];
            duplicateGroups[hash].push(sampleRecord(p, { reason: 'kept_first_occurrence', sub_circle: index }));
            hashes.add(hash);
            eligible++;
        }

        if (batch.length < LIMIT) break;
        offset += LIMIT;
        await sleep(150);
    }

    return { index, ...circle, status, raw, eligible, polygonRejected, missingCoordsRejected, eligibilityRejected, dateRejected, duplicateWithinSubCircle, uniqueEligible: hashes.size, rawSamples, rejectedTypes: summarizePropertyTypes(rejectedTypes), filterCounts, rejectedSamples, duplicateSamples, duplicateGroups, hashes: [...hashes] };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        if (!RENTCAST_API_KEY) return Response.json({ error: 'RENTCAST_API_KEY is not configured' }, { status: 500 });
        if (!DATABASE_URL) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const compact = body.compact !== false;
        const summaryOnly = body.summary_only === true;
        const includeSamples = body.include_samples === true;
        const brief = body.brief === true;
        const targetEmail = body.user_email || 'christian@nativapest.com';
        const jobId = body.job_id || null;
        const jobsRaw = jobId
            ? await base44.asServiceRole.entities.FetchJob.filter({ id: jobId }, null, 1)
            : await base44.asServiceRole.entities.FetchJob.filter({ user_email: targetEmail, status: 'completed' }, '-completed_at', 5);
        const jobs = Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw?.items || []);
        const job = jobs[0];
        if (!job) return Response.json({ error: `No completed FetchJob found for ${targetEmail}` }, { status: 404 });

        const monthsBack = Number(job.sold_months || 12);
        const phase1End = job.completed_at ? new Date(job.completed_at) : new Date();
        const phase1Start = new Date(phase1End);
        phase1Start.setMonth(phase1Start.getMonth() - monthsBack);
        const saleDateRange = Math.min(Math.ceil((phase1End.getTime() - phase1Start.getTime()) / (1000 * 3600 * 24)) + 1, 730);
        const subCircles = Array.isArray(job.sub_circles) && job.sub_circles.length > 0
            ? job.sub_circles
            : [{ lat: job.latitude, lng: job.longitude, radius: job.radius }];

        const subCircleResults = [];
        for (let i = 0; i < subCircles.length; i++) {
            const result = await fetchSubCircle(subCircles[i], saleDateRange, job.polygon || [], phase1Start, phase1End, i + 1);
            subCircleResults.push(result);
            await sleep(200);
        }

        const allEligibleHashes = [];
        const hashSources = {};
        const globalDuplicateSamples = [];
        const filterDropCounts = {};
        const rejectedSamples = [];
        for (const result of subCircleResults) {
            for (const [reason, count] of Object.entries(result.filterCounts || {})) {
                filterDropCounts[reason] = (filterDropCounts[reason] || 0) + count;
            }
            rejectedSamples.push(...(result.rejectedSamples || []).slice(0, Math.max(0, 30 - rejectedSamples.length)));
            for (const hash of result.hashes || []) {
                if (hashSources[hash]) {
                    if (globalDuplicateSamples.length < 15) {
                        globalDuplicateSamples.push({ address_hash: hash, kept_from_sub_circle: hashSources[hash], duplicate_from_sub_circle: result.index, duplicate_group: result.duplicateGroups?.[hash] || [] });
                    }
                } else {
                    hashSources[hash] = result.index;
                }
                allEligibleHashes.push(hash);
            }
        }
        const uniqueEligibleHashes = new Set(allEligibleHashes);
        const rawFetchTotal = subCircleResults.reduce((sum, r) => sum + r.raw, 0);
        const afterEligibilityFilter = subCircleResults.reduce((sum, r) => sum + r.eligible, 0);
        const afterDeduplication = uniqueEligibleHashes.size;
        const sql = neon(DATABASE_URL);

        const storedCounts = await sql`
            SELECT
                COUNT(*)::int AS final_stored_total,
                COUNT(*) FILTER (WHERE wp.route_active = TRUE)::int AS final_stored_active,
                COUNT(*) FILTER (WHERE wp.route_active = FALSE)::int AS inactive,
                COUNT(*) FILTER (WHERE p.original_status = 'REJECTED' OR p.sale_confidence = 'REJECTED')::int AS rejected,
                COUNT(*) FILTER (WHERE p.lat IS NULL OR p.lng IS NULL)::int AS missing_coords
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
        `;

        const capScan = {
            rentcast_page_limit: LIMIT,
            process_fetch_pages_per_chunk: 10,
            process_fetch_max_parallel: 2,
            evidence: 'No candidate storage cap found in schema/query path; inserts upsert by address_hash and workspace user.'
        };

        const compactSubCircles = subCircleResults.map(({ hashes, rawSamples, rejectedTypes, rejectedSamples, duplicateSamples, duplicateGroups, ...rest }) => compact ? rest : { ...rest, rawSamples, rejectedTypes, rejectedSamples, duplicateSamples });
        const totals = {
            raw_fetch_total_all_sub_circles: rawFetchTotal,
            after_eligibility_status_filter: afterEligibilityFilter,
            after_global_deduplication: afterDeduplication,
            final_stored_total: storedCounts[0].final_stored_total,
            final_stored_active_candidate_count: storedCounts[0].final_stored_active
        };

        console.log(`[ingestion-gap] ${targetEmail} stage counts ${JSON.stringify(totals)}`);
        console.log(`[ingestion-gap] per-sub-circle ${JSON.stringify(compactSubCircles.map(r => ({ index: r.index, status: r.status, raw: r.raw, eligible: r.eligible, polygonRejected: r.polygonRejected, eligibilityRejected: r.eligibilityRejected, duplicateWithinSubCircle: r.duplicateWithinSubCircle })))}`);

        const subCircleTable = compactSubCircles.map(r => `${r.index}:${r.status}:raw${r.raw}:eligible${r.eligible}:polyReject${r.polygonRejected}:eligReject${r.eligibilityRejected}:dupe${r.duplicateWithinSubCircle}`).join(' | ');
        const zeroRawSubCircles = compactSubCircles.filter(r => r.raw === 0).map(r => r.index);
        const zeroEligibleSubCircles = compactSubCircles.filter(r => r.eligible === 0).map(r => r.index);
        const errorSubCircles = compactSubCircles.filter(r => r.status !== 'ok').map(r => ({ index: r.index, status: r.status }));

        const response = {
            success: true,
            user_email: targetEmail,
            job: {
                id: job.id,
                completed_at: job.completed_at,
                sold_months: monthsBack,
                stored_total_fetched_on_job: job.total_fetched || 0,
                stored_phase1_union_records: Array.isArray(job.phase1_union_records) ? job.phase1_union_records.length : 0,
                stored_phase1_unique_hashes: Array.isArray(job.phase1_union_records) ? new Set(job.phase1_union_records.map(p => p.address_hash).filter(Boolean)).size : 0,
                completed_sub_circles: job.completed_sub_circles,
                total_sub_circles: job.total_sub_circles
            },
            stage_counts: totals,
            stored_breakdown: storedCounts[0],
            filter_drop_counts: filterDropCounts,
            rejected_samples: includeSamples ? rejectedSamples : [] ,
            sub_circle_table: subCircleTable,
            zero_raw_sub_circles: zeroRawSubCircles,
            zero_eligible_sub_circles: zeroEligibleSubCircles,
            error_sub_circles: errorSubCircles,
            deduplication: {
                key: 'normalized addressLine1/formattedAddress street portion + 5-digit zip; exact match after uppercasing, punctuation removal, whitespace collapse, and street suffix abbreviation',
                eligible_before_global_dedup: afterEligibilityFilter,
                removed_by_global_dedup: afterEligibilityFilter - afterDeduplication,
                duplicate_ratio_pct: afterEligibilityFilter > 0 ? Math.round(((afterEligibilityFilter - afterDeduplication) / afterEligibilityFilter) * 1000) / 10 : 0,
                duplicate_samples: includeSamples ? globalDuplicateSamples : [],
                sample_verdict: globalDuplicateSamples.length > 0 ? 'sampled duplicates share the same normalized address+zip across overlapping sub-circles' : 'no global duplicate samples captured'
            },
            filters: {
                sale_date_range_days: saleDateRange,
                phase1_start: phase1Start.toISOString(),
                phase1_end: phase1End.toISOString(),
                eligibility_rules: 'Required fields: latitude/lng and lastSaleDate. Geographic rule: point must be inside user polygon when polygon exists. Price rules: in disclosure states, keep missing price but drop explicit salePrice < $10k or salePrice < 15% assessedValue when assessedValue is present; in non-disclosure states only drop explicit nominal $1-$999. Property type rules: drop exact Commercial, Industrial, Vacant Land, Agricultural only. Missing optional sqft/yearBuilt/assessedValue/propertyType are kept.'
            },
            cap_scan: capScan
        };

        if (brief) {
            delete response.rejected_samples;
            delete response.sub_circle_table;
            delete response.zero_raw_sub_circles;
            delete response.zero_eligible_sub_circles;
            delete response.error_sub_circles;
        }
        if (!summaryOnly) response.sub_circle_counts = compactSubCircles;
        return Response.json(response);
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});