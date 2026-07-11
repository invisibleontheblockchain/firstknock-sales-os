import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';
import {
    applyJobScopedOwnerObservation,
    exactFetchJobBelongsToTarget
} from './jobEvidenceLogic.js';

const POLYGON_BOUNDARY_TOLERANCE_DEGREES = 5e-6;
const JOB_MEMBERSHIP_CONTRACT = 'property_sources_v1';

function parseRawPayload(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try { return JSON.parse(value); } catch { return {}; }
}

function providerSearchFilterEvidence(rawPayload) {
    const evidence = rawPayload?._firstknock?.search_evidence || {};
    const mappedEvidence = rawPayload?._firstknock?.mapped_evidence || {};
    const minimum = Number(evidence.valuation_estimated_value_min);
    const maximum = Number(evidence.valuation_estimated_value_max);
    const recentSaleSources = Array.isArray(evidence.recent_sale_sources)
        ? evidence.recent_sale_sources.filter(source => source === 'intel' || source === 'sale')
        : [];
    return {
        provider_estimated_value_min: Number.isFinite(minimum) && minimum > 0 ? minimum : null,
        provider_estimated_value_max: Number.isFinite(maximum) && maximum > 0 ? maximum : null,
        provider_recent_sale_min_date: evidence.recent_sale_min_date || null,
        provider_recent_sale_max_date: evidence.recent_sale_max_date || null,
        provider_recent_sale_sources: recentSaleSources,
        provider_listing_status_categories_excluded: Array.isArray(evidence.listing_status_categories_excluded)
            ? evidence.listing_status_categories_excluded
            : [],
        provider_estimated_value_observed: mappedEvidence.estimated_home_value_observed === true
            ? true
            : (mappedEvidence.estimated_home_value_observed === false ? false : null),
        provider_exact_sale_date_observed: mappedEvidence.exact_sale_date_observed === true
            ? true
            : (mappedEvidence.exact_sale_date_observed === false ? false : null),
        provider_listing_status_observed: mappedEvidence.listing_status_observed === true
            ? true
            : (mappedEvidence.listing_status_observed === false ? false : null)
    };
}

function mergeJobScopedEvidence(propertyRawPayload, jobEvidencePayload) {
    const propertyRaw = parseRawPayload(propertyRawPayload);
    const jobEvidence = parseRawPayload(jobEvidencePayload);
    return {
        ...propertyRaw,
        _firstknock: jobEvidence?._firstknock || propertyRaw?._firstknock || {}
    };
}

function normalizeZipList(body) {
    if (Array.isArray(body.zip_codes)) return body.zip_codes.map(String).map(z => z.trim().slice(0, 5)).filter(Boolean);
    if (body.zip_code_filter) return String(body.zip_code_filter).split(',').map(z => z.trim().slice(0, 5)).filter(Boolean);
    return [];
}

function getBoundsFromPolygon(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const lats = polygon.map(p => Number(p.lat)).filter(Number.isFinite);
    const lngs = polygon.map(p => Number(p.lng)).filter(Number.isFinite);
    if (lats.length === 0 || lngs.length === 0) return null;
    return {
        minLat: Math.min(...lats) - POLYGON_BOUNDARY_TOLERANCE_DEGREES,
        maxLat: Math.max(...lats) + POLYGON_BOUNDARY_TOLERANCE_DEGREES,
        minLng: Math.min(...lngs) - POLYGON_BOUNDARY_TOLERANCE_DEGREES,
        maxLng: Math.max(...lngs) + POLYGON_BOUNDARY_TOLERANCE_DEGREES
    };
}

function requestedSoldWindowDays(soldMonths) {
    const months = Number(soldMonths || 1);
    if (Math.abs(months - (1 / 30)) < 0.0001) return 1;
    if (Math.abs(months - (2 / 30)) < 0.0001) return 2;
    if (months === 0.25) return 7;
    if (months === 0.5) return 14;
    if (months === 1) return 30;
    if (months === 3) return 90;
    if (months === 6) return 180;
    if (months === 9) return 270;
    if (months === 12) return 365;
    return Math.max(1, Math.round(months * 30));
}

function routeCandidateSoldWindowDays(soldMonths) {
    return requestedSoldWindowDays(soldMonths);
}

function isoDateDaysAgo(days, referenceMs = Date.now()) {
    const date = new Date(referenceMs - days * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const databaseUrl = Deno.env.get('DATABASE_URL');
        if (!databaseUrl) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const sql = neon(databaseUrl);
        const targetEmail = user.role === 'admin' && body.user_email ? body.user_email : user.email;
        const zipCodes = normalizeZipList(body);
        const polygonBounds = getBoundsFromPolygon(body.polygon);
        const bounds = body.bounds || polygonBounds;
        const limit = Math.min(Math.max(Number(body.limit || 50000), 1), 100000);
        const soldMonths = body.sold_months === 'all' || body.sold_months === null ? null : Number(body.sold_months || 12);
        const fetchJobId = body.fetch_job_id ? String(body.fetch_job_id) : null;
        let referenceMs = Date.now();
        let exactFetchJob = null;
        if (fetchJobId) {
            exactFetchJob = await base44.asServiceRole.entities.FetchJob.get(fetchJobId).catch(() => null);
            // Exact-job membership contains job-scoped provider predicates and
            // owner observations. Never let a caller use another workspace's
            // FetchJob id as a join key, even when the canonical property also
            // exists in the caller's own workspace.
            if (!exactFetchJobBelongsToTarget(exactFetchJob, targetEmail)) {
                return Response.json({ error: 'Fetch job not found' }, { status: 404 });
            }
            const fetchJobTime = exactFetchJob?.created_date || exactFetchJob?.started_at;
            const parsed = fetchJobTime ? new Date(fetchJobTime).getTime() : NaN;
            if (Number.isFinite(parsed)) referenceMs = parsed;
        }
        const excludeAssignedForExactJob = fetchJobId !== null && exactFetchJob?.dry_run_metadata?.route_filters?.excludeAssigned !== false;
        const allowLegacyPointerMembership = fetchJobId !== null &&
            exactFetchJob !== null &&
            exactFetchJob?.dry_run_metadata?.job_membership_contract !== JOB_MEMBERSHIP_CONTRACT;
        const explicitlyReopenedHashes = [
            ...(Array.isArray(exactFetchJob?.dry_run_metadata?.unresolved_followup_hashes_included)
                ? exactFetchJob.dry_run_metadata.unresolved_followup_hashes_included
                : []),
            ...(Array.isArray(exactFetchJob?.dry_run_metadata?.event_released_prior_route_hashes)
                ? exactFetchJob.dry_run_metadata.event_released_prior_route_hashes
                : [])
        ].map(String);
        const soldAfter = soldMonths ? `${isoDateDaysAgo(routeCandidateSoldWindowDays(soldMonths), referenceMs)}T00:00:00.000Z` : null;

        if (body.debug_job === true && fetchJobId) {
            const debugRows = await sql`
                SELECT
                    p.full_address,
                    p.sold_date,
                    p.sale_confidence,
                    p.original_status,
                    p.property_type,
                    p.data_source,
                    p.raw_payload,
                    ps.raw_payload AS job_evidence_payload,
                    wp.route_active,
                    wp.status,
                    wp.fetch_job_id
                FROM workspace_properties wp
                JOIN properties p ON p.id = wp.property_id
                LEFT JOIN property_sources ps
                  ON ps.property_id = p.id
                 AND ps.provider = 'batchdata_job'
                 AND ps.provider_record_id = ${fetchJobId}
                WHERE wp.user_email = ${targetEmail}
                  AND (
                      ps.property_id IS NOT NULL
                      OR (
                          ${allowLegacyPointerMembership}
                          AND
                          wp.fetch_job_id = ${fetchJobId}
                      )
                  )
                  AND (
                      ${!excludeAssignedForExactJob}
                      OR wp.assigned_route_id IS NULL
                      OR p.address_hash = ANY(${explicitlyReopenedHashes})
                  )
                ORDER BY p.updated_at DESC
                LIMIT ${limit}
            `;
            const properties = debugRows.map(row => {
                const raw = mergeJobScopedEvidence(row.raw_payload, row.job_evidence_payload);
                const listingStatus = String(raw?.listing?.status || raw?.listing?.statusCategory || '').toLowerCase();
                const landUseCode = raw?.general?.standardizedLandUseCode || raw?.standardizedLandUseCode || null;
                const reason = row.route_active === true && row.status !== 'REJECTED'
                    ? 'active'
                    : !row.sold_date
                        ? 'missing_or_unmapped_sold_date'
                        : (landUseCode && landUseCode !== 'R2')
                            ? `land_use_${landUseCode}`
                            : (listingStatus === 'active' || listingStatus === 'for sale' || listingStatus === 'off market' || listingStatus === 'pending' || listingStatus === 'withdrawn')
                                ? `listing_${listingStatus}`
                                : 'rejected_by_local_eligibility';
                const rawShape = {
                    top_level: Object.keys(raw || {}).slice(0, 30),
                    intel_keys: Object.keys(raw?.intel || {}).slice(0, 30),
                    sale_keys: Object.keys(raw?.sale || {}).slice(0, 30),
                    last_sale_keys: Object.keys(raw?.lastSale || {}).slice(0, 30),
                    deed_keys: Object.keys(raw?.deed || {}).slice(0, 30),
                    listing_keys: Object.keys(raw?.listing || {}).slice(0, 30)
                };
                const { raw_payload, job_evidence_payload, ...safeRow } = row;
                return { ...safeRow, rejection_reason: reason, batchdata_land_use_code: landUseCode, batchdata_listing_status: listingStatus || null, raw_shape: rawShape };
            });
            const breakdown = properties.reduce((acc, row) => {
                const key = row.rejection_reason || 'unknown';
                acc[key] = (acc[key] || 0) + 1;
                return acc;
            }, {});
            return Response.json({ success: true, user_email: targetEmail, fetch_job_id: fetchJobId, count: properties.length, breakdown, properties });
        }

        const rows = await sql`
            SELECT
                p.id,
                p.address_hash,
                p.legacy_hash,
                p.full_address,
                p.house_number,
                p.street_name,
                p.city,
                p.state,
                p.zip_code,
                p.lat,
                p.lng,
                p.h3_index,
                p.owner_full_name,
                p.beds,
                p.baths,
                p.sqft,
                p.lot_size,
                p.year_built,
                p.price,
                p.sold_date,
                p.sale_type,
                p.property_type,
                p.mls_id,
                p.url,
                p.data_source,
                p.sale_confidence,
                p.original_status,
                p.listing_status,
                p.raw_payload,
                ps.raw_payload AS job_evidence_payload,
                wp.route_active,
                wp.status AS workspace_status,
                wp.status,
                wp.fetch_job_id,
                wp.assigned_route_id,
                p.created_at,
                p.updated_at
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            LEFT JOIN property_sources ps
              ON ps.property_id = p.id
             AND ps.provider = 'batchdata_job'
             AND ps.provider_record_id = CASE
                 WHEN ${fetchJobId !== null} THEN ${fetchJobId}
                 ELSE wp.fetch_job_id
             END
            WHERE wp.user_email = ${targetEmail}
              AND (
                  ${fetchJobId === null}
                  OR ps.property_id IS NOT NULL
                  OR (
                      ${allowLegacyPointerMembership}
                      AND
                      wp.fetch_job_id = ${fetchJobId}
                  )
              )
              AND (
                  ${!excludeAssignedForExactJob}
                  OR wp.assigned_route_id IS NULL
                  OR p.address_hash = ANY(${explicitlyReopenedHashes})
              )
              AND wp.route_active = TRUE
              AND p.lat IS NOT NULL
              AND p.lng IS NOT NULL
              AND COALESCE(wp.status, '') <> 'REJECTED'
              AND (${zipCodes.length === 0} OR p.zip_code = ANY(${zipCodes}))
              AND (${fetchJobId !== null || soldAfter === null} OR p.sold_date IS NULL OR p.sold_date >= ${soldAfter})
              AND (${!bounds?.minLat} OR p.lat >= ${bounds?.minLat || 0})
              AND (${!bounds?.maxLat} OR p.lat <= ${bounds?.maxLat || 0})
              AND (${!bounds?.minLng} OR p.lng >= ${bounds?.minLng || 0})
              AND (${!bounds?.maxLng} OR p.lng <= ${bounds?.maxLng || 0})
            ORDER BY p.sold_date DESC NULLS LAST, p.updated_at DESC
            LIMIT ${limit}
        `;

        let properties = rows.map(row => {
            const rawPayload = mergeJobScopedEvidence(row.raw_payload, row.job_evidence_payload);
            const ownerObservation = applyJobScopedOwnerObservation(row.owner_full_name, row.job_evidence_payload);
            const safeRow = { ...row };
            delete safeRow.raw_payload;
            delete safeRow.job_evidence_payload;
            return {
                ...safeRow,
                ...providerSearchFilterEvidence(rawPayload),
                ...ownerObservation,
                id: String(row.id),
                address_hash: row.address_hash || String(row.id),
                created_date: row.created_at,
                updated_date: row.updated_at
            };
        });

        // Payload reduction: fields='map' returns only what the map pipeline needs
        // (pins, status colors, sold/price/phase filters, dedupe, detail sheet basics).
        // Cuts response size roughly in half vs. the full record.
        if (body.fields === 'map') {
            const MAP_FIELDS = [
                'id', 'address_hash', 'legacy_hash', 'full_address', 'house_number', 'street_name',
                'city', 'state', 'zip_code', 'lat', 'lng', 'owner_full_name', 'beds', 'baths', 'sqft',
                'lot_size', 'year_built', 'price', 'sold_date', 'sale_type', 'property_type', 'mls_id',
                'data_source', 'sale_confidence', 'original_status', 'route_active', 'workspace_status', 'status',
                'provider_estimated_value_min', 'provider_estimated_value_max',
                'provider_estimated_value_observed', 'provider_recent_sale_min_date',
                'provider_recent_sale_max_date', 'provider_recent_sale_sources',
                'provider_exact_sale_date_observed', 'listing_status',
                'provider_owner_name_observed', 'owner_full_name_source',
                'provider_listing_status_observed', 'provider_listing_status_categories_excluded'
            ];
            properties = properties.map(p => {
                const slim = {};
                for (const f of MAP_FIELDS) {
                    if (p[f] !== undefined && p[f] !== null) slim[f] = p[f];
                }
                return slim;
            });
        }

        return Response.json({
            success: true,
            user_email: targetEmail,
            count: properties.length,
            capped: properties.length >= limit,
            limit,
            properties
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});
