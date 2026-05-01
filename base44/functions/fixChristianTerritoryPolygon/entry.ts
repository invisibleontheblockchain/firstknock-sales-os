import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { neon } from 'npm:@neondatabase/serverless@0.9.0';

const RENTCAST_API_KEY = Deno.env.get('RENTCAST_API_KEY');
const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const DATABASE_URL = Deno.env.get('DATABASE_URL');
const LIMIT = 500;
const TARGET_EMAIL = 'christian@nativapest.com';
const TARGET_AREA_SQMI = 300;
const NON_DISCLOSURE_STATES = new Set(['AK', 'ID', 'KS', 'LA', 'MS', 'MO', 'MT', 'NM', 'ND', 'TX', 'UT', 'WY']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function centerOf(points) {
    const list = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    return {
        lat: list.reduce((sum, p) => sum + p.lat, 0) / Math.max(1, list.length),
        lng: list.reduce((sum, p) => sum + p.lng, 0) / Math.max(1, list.length)
    };
}

function project(point, origin) {
    return {
        x: (point.lng - origin.lng) * 69 * Math.cos(origin.lat * Math.PI / 180),
        y: (point.lat - origin.lat) * 69,
        source: point
    };
}

function unproject(point, origin) {
    return {
        lat: Number((origin.lat + point.y / 69).toFixed(6)),
        lng: Number((origin.lng + point.x / (69 * Math.cos(origin.lat * Math.PI / 180))).toFixed(6))
    };
}

function polygonAreaSqMi(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return 0;
    const origin = centerOf(polygon);
    const projected = polygon.map(p => project(p, origin));
    let area = 0;
    for (let i = 0; i < projected.length; i++) {
        const j = (i + 1) % projected.length;
        area += projected[i].x * projected[j].y - projected[j].x * projected[i].y;
    }
    return Math.abs(area) / 2;
}

function bounds(points) {
    const lats = points.map(p => p.lat).filter(Number.isFinite);
    const lngs = points.map(p => p.lng).filter(Number.isFinite);
    return {
        min_lat: Number(Math.min(...lats).toFixed(6)),
        max_lat: Number(Math.max(...lats).toFixed(6)),
        min_lng: Number(Math.min(...lngs).toFixed(6)),
        max_lng: Number(Math.max(...lngs).toFixed(6))
    };
}

function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
    const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
    const lower = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
}

function circleBoundaryPoints(circle, segments = 32) {
    const points = [];
    const latMiles = 1 / 69;
    const lngMiles = 1 / (69 * Math.cos(circle.lat * Math.PI / 180));
    for (let i = 0; i < segments; i++) {
        const angle = (2 * Math.PI * i) / segments;
        points.push({
            lat: circle.lat + Math.sin(angle) * circle.radius * latMiles,
            lng: circle.lng + Math.cos(angle) * circle.radius * lngMiles
        });
    }
    return points;
}

function buildSubCircleHull(subCircles) {
    const boundary = subCircles.flatMap(circle => circleBoundaryPoints(circle));
    const origin = centerOf(boundary);
    const hull = convexHull(boundary.map(p => project(p, origin))).map(p => unproject(p, origin));
    return hull;
}

function pointInPolygon(point, polygon) {
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

function normalizeAddress(address) {
    if (!address) return '';
    let norm = String(address).toUpperCase().trim();
    norm = norm.replace(/[.,#]/g, '').replace(/\s+/g, ' ');
    const abbreviations = {
        STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', LANE: 'LN', ROAD: 'RD', COURT: 'CT', CIRCLE: 'CIR',
        PLACE: 'PL', TERRACE: 'TER', WAY: 'WAY', TRAIL: 'TRL', PARKWAY: 'PKWY', HIGHWAY: 'HWY', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W'
    };
    for (const [full, abbr] of Object.entries(abbreviations)) norm = norm.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
    return norm;
}

function addressHash(p) {
    const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : '');
    return `${normalizeAddress(addressLine)}|${String(p.zipCode || '00000').trim().slice(0, 5)}`;
}

function isValidSoldProperty(p) {
    if (!p.lastSaleDate) return false;
    const isNonDisclosure = p.state && NON_DISCLOSURE_STATES.has(String(p.state).toUpperCase());
    if (!isNonDisclosure) {
        if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice < 10000) return false;
        if (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.15) return false;
    } else if (p.lastSalePrice !== null && p.lastSalePrice !== undefined && p.lastSalePrice > 0 && p.lastSalePrice < 1000) {
        return false;
    }
    return !(['Commercial', 'Industrial', 'Vacant Land', 'Agricultural'].includes(p.propertyType));
}

function mapRentCastProperty(p) {
    const addressLine = p.addressLine1 || (p.formattedAddress ? p.formattedAddress.split(',')[0] : '');
    const addressMatch = addressLine.match(/^(\d+)\s+(.*)$/);
    const houseNumber = addressMatch ? parseInt(addressMatch[1], 10) : 0;
    const streetName = addressMatch ? addressMatch[2] : (addressLine || 'Unknown');
    const corporate = p.owner?.names?.some(name => /LLC|INC|TRUST|HOLDINGS|BANK|PROPERTIES|CORP|COMPANY/i.test(name)) || false;
    return {
        address_hash: addressHash(p),
        full_address: p.formattedAddress || addressLine,
        house_number: houseNumber,
        street_name: streetName,
        city: p.city || '',
        state: p.state || '',
        zip_code: p.zipCode || '00000',
        lat: p.latitude,
        lng: p.longitude,
        original_status: 'SOLD',
        beds: p.bedrooms || 0,
        baths: p.bathrooms || 0,
        sqft: p.squareFootage || 0,
        lot_size: p.lotSize || 0,
        year_built: p.yearBuilt || 0,
        price: p.lastSalePrice || 0,
        sold_date: p.lastSaleDate || null,
        sale_type: corporate ? 'Corporate' : 'Deed',
        property_type: p.propertyType || 'Single Family',
        data_source: 'rentcast',
        sale_confidence: corporate || (p.assessedValue && p.assessedValue > 0 && p.lastSalePrice < p.assessedValue * 0.5) ? 'medium' : 'high',
        route_active: true,
        raw_payload: JSON.stringify(p)
    };
}

function directionFromCenter(point, center) {
    const ns = point.lat >= center.lat ? 'N' : 'S';
    const ew = point.lng >= center.lng ? 'E' : 'W';
    const dLat = Math.abs(point.lat - center.lat);
    const dLng = Math.abs(point.lng - center.lng);
    if (dLat > dLng * 1.7) return ns;
    if (dLng > dLat * 1.7) return ew;
    return `${ns}${ew}`;
}

async function fetchCircleRecords(circle, saleDateRange) {
    let offset = 0;
    let totalHeader = null;
    const records = [];
    let apiCalls = 0;
    let hitCap = false;
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
        const response = await fetch(`${RENTCAST_BASE}/properties?${params}`, { headers: { accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
        apiCalls++;
        if (!response.ok) {
            const error = await response.text().catch(() => '');
            return { records, apiCalls, totalHeader, hitCap, error: `${response.status}: ${error.slice(0, 180)}` };
        }
        const total = response.headers.get('X-Total-Count');
        if (total && totalHeader === null) totalHeader = Number(total);
        const batch = await response.json();
        const arr = Array.isArray(batch) ? batch : [];
        records.push(...arr);
        if (arr.length < LIMIT) break;
        offset += LIMIT;
        if (apiCalls >= 20) {
            hitCap = true;
            break;
        }
        await sleep(125);
    }
    return { records, apiCalls, totalHeader, hitCap, error: null };
}

async function writeProperties(sql, properties, jobId, userEmail) {
    let inserted = 0;
    let existed = 0;
    let updated = 0;
    for (const p of properties) {
        const soldDate = p.sold_date ? new Date(p.sold_date).toISOString() : null;
        const existing = await sql`SELECT id, sold_date, sale_confidence, original_status FROM properties WHERE address_hash = ${p.address_hash} LIMIT 1`;
        let propertyId;
        if (existing.length === 0) {
            const created = await sql`
                INSERT INTO properties (
                    address_hash, full_address, house_number, street_name, city, state, zip_code, lat, lng,
                    beds, baths, sqft, lot_size, year_built, price, sold_date, sale_type, property_type,
                    data_source, sale_confidence, original_status, raw_payload, updated_at
                ) VALUES (
                    ${p.address_hash}, ${p.full_address}, ${p.house_number || null}, ${p.street_name}, ${p.city}, ${p.state}, ${p.zip_code}, ${p.lat}, ${p.lng},
                    ${p.beds || null}, ${p.baths || null}, ${p.sqft || null}, ${p.lot_size || null}, ${p.year_built || null}, ${p.price || null}, ${soldDate}, ${p.sale_type}, ${p.property_type},
                    ${p.data_source}, ${p.sale_confidence}, ${p.original_status}, ${p.raw_payload}, NOW()
                ) RETURNING id
            `;
            propertyId = created[0].id;
            inserted++;
        } else {
            propertyId = existing[0].id;
            existed++;
            const existingDate = existing[0].sold_date ? new Date(existing[0].sold_date) : new Date(0);
            const incomingDate = soldDate ? new Date(soldDate) : new Date(0);
            if (incomingDate > existingDate || p.sale_confidence !== existing[0].sale_confidence || p.original_status !== existing[0].original_status) {
                await sql`
                    UPDATE properties SET
                        full_address = COALESCE(${p.full_address}, full_address), city = COALESCE(${p.city}, city), state = COALESCE(${p.state}, state), zip_code = COALESCE(${p.zip_code}, zip_code),
                        lat = COALESCE(${p.lat}, lat), lng = COALESCE(${p.lng}, lng), beds = COALESCE(${p.beds || null}, beds), baths = COALESCE(${p.baths || null}, baths),
                        sqft = COALESCE(${p.sqft || null}, sqft), lot_size = COALESCE(${p.lot_size || null}, lot_size), year_built = COALESCE(${p.year_built || null}, year_built),
                        price = COALESCE(${p.price || null}, price), sold_date = COALESCE(${soldDate}, sold_date), sale_type = COALESCE(${p.sale_type}, sale_type),
                        property_type = COALESCE(${p.property_type}, property_type), data_source = COALESCE(${p.data_source}, data_source), sale_confidence = ${p.sale_confidence},
                        original_status = ${p.original_status}, raw_payload = ${p.raw_payload}, updated_at = NOW()
                    WHERE id = ${propertyId}
                `;
                updated++;
            }
        }
        await sql`
            INSERT INTO workspace_properties (property_id, user_email, fetch_job_id, route_active, status, updated_at)
            VALUES (${propertyId}, ${userEmail}, ${jobId}, TRUE, ${p.original_status}, NOW())
            ON CONFLICT (property_id, user_email)
            DO UPDATE SET fetch_job_id = EXCLUDED.fetch_job_id, route_active = TRUE, status = EXCLUDED.status, updated_at = NOW()
        `;
    }
    return { inserted, existed, updated };
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (user?.role !== 'admin') return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        if (!RENTCAST_API_KEY) return Response.json({ error: 'RENTCAST_API_KEY is not configured' }, { status: 500 });
        if (!DATABASE_URL) return Response.json({ error: 'DATABASE_URL is not configured' }, { status: 500 });

        const body = await req.json().catch(() => ({}));
        const action = body.action || 'audit';
        const targetEmail = body.user_email || TARGET_EMAIL;
        const jobId = body.job_id || null;
        const jobsRaw = jobId
            ? await base44.asServiceRole.entities.FetchJob.filter({ id: jobId }, null, 1)
            : await base44.asServiceRole.entities.FetchJob.filter({ user_email: targetEmail, status: 'completed' }, '-completed_at', 1);
        const jobs = Array.isArray(jobsRaw) ? jobsRaw : (jobsRaw?.items || []);
        const job = jobs[0];
        if (!job) return Response.json({ error: `No completed FetchJob found for ${targetEmail}` }, { status: 404 });

        const subCircles = Array.isArray(job.sub_circles) && job.sub_circles.length > 0 ? job.sub_circles : [{ lat: job.latitude, lng: job.longitude, radius: job.radius }];
        const currentPolygon = Array.isArray(job.polygon) ? job.polygon : [];
        const correctedPolygon = buildSubCircleHull(subCircles);
        const currentArea = polygonAreaSqMi(currentPolygon);
        const correctedArea = polygonAreaSqMi(correctedPolygon);
        const territoryCenter = centerOf(subCircles.map(c => ({ lat: c.lat, lng: c.lng })));
        const monthsBack = Number(job.sold_months || 12);
        const phase1End = job.completed_at ? new Date(job.completed_at) : new Date();
        const phase1Start = new Date(phase1End);
        phase1Start.setMonth(phase1Start.getMonth() - monthsBack);
        const saleDateRange = Math.min(Math.ceil((phase1End.getTime() - phase1Start.getTime()) / (1000 * 3600 * 24)) + 1, 730);

        const perSubCircle = [];
        const excludedDirections = {};
        const globalHashes = new Set();
        const recoverable = [];
        let rawTotal = 0;
        let currentOutside = 0;
        let correctedOutside = 0;
        let currentEligible = 0;
        let correctedEligible = 0;
        let filterRejected = 0;
        let totalApiCalls = 0;
        let anyHitCap = false;

        for (let i = 0; i < subCircles.length; i++) {
            const circle = subCircles[i];
            const fetched = await fetchCircleRecords(circle, saleDateRange);
            totalApiCalls += fetched.apiCalls;
            anyHitCap = anyHitCap || fetched.hitCap;
            rawTotal += fetched.records.length;
            const row = {
                index: i + 1,
                center: { lat: circle.lat, lng: circle.lng },
                radius: circle.radius,
                rentcast_raw: fetched.records.length,
                rentcast_total_header: fetched.totalHeader,
                api_calls: fetched.apiCalls,
                hit_cap: fetched.hitCap,
                current_polygon_rejects: 0,
                corrected_polygon_rejects: 0,
                corrected_unique_recoverable: 0,
                error: fetched.error
            };
            for (const p of fetched.records) {
                if (!p.latitude || !p.longitude) {
                    filterRejected++;
                    continue;
                }
                const inCurrent = pointInPolygon({ lat: p.latitude, lng: p.longitude }, currentPolygon);
                const inCorrected = pointInPolygon({ lat: p.latitude, lng: p.longitude }, correctedPolygon);
                if (!inCurrent) {
                    currentOutside++;
                    row.current_polygon_rejects++;
                    const direction = directionFromCenter({ lat: p.latitude, lng: p.longitude }, territoryCenter);
                    excludedDirections[direction] = (excludedDirections[direction] || 0) + 1;
                }
                if (!inCorrected) {
                    correctedOutside++;
                    row.corrected_polygon_rejects++;
                }
                if (!isValidSoldProperty(p)) {
                    filterRejected++;
                    continue;
                }
                const saleDate = new Date(p.lastSaleDate);
                if (Number.isNaN(saleDate.getTime()) || saleDate < phase1Start || saleDate > phase1End) {
                    filterRejected++;
                    continue;
                }
                if (inCurrent) currentEligible++;
                if (inCorrected) {
                    correctedEligible++;
                    const hash = addressHash(p);
                    if (!globalHashes.has(hash)) {
                        globalHashes.add(hash);
                        recoverable.push(mapRentCastProperty(p));
                        row.corrected_unique_recoverable++;
                    }
                }
            }
            perSubCircle.push(row);
            await sleep(175);
        }

        const sql = neon(DATABASE_URL);
        let writeResult = null;
        const expansionIsSafe = correctedArea <= 350;
        if ((action === 'apply_polygon' || action === 'recover_properties') && !expansionIsSafe) {
            return Response.json({
                error: 'unsafe_polygon_expansion_blocked',
                message: 'Blocked: the sub-circle hull is far larger than the intended 300 sq mi territory. Current polygon is already near 300 sq mi, so expanding to the full sub-circle hull would incorrectly include outside territory.',
                current_area_sq_mi: Number(currentArea.toFixed(2)),
                requested_sub_circle_hull_area_sq_mi: Number(correctedArea.toFixed(2)),
                target_area_sq_mi: TARGET_AREA_SQMI
            }, { status: 409 });
        }
        if (action === 'apply_polygon' || action === 'recover_properties') {
            await base44.asServiceRole.entities.FetchJob.update(job.id, { polygon: correctedPolygon });
        }
        if (action === 'recover_properties') {
            writeResult = await writeProperties(sql, recoverable, job.id, targetEmail);
            await base44.asServiceRole.entities.FetchJob.update(job.id, {
                total_fetched: Math.max(job.total_fetched || 0, rawTotal),
                total_inserted: (job.total_inserted || 0) + writeResult.inserted,
                total_existed: Math.max(job.total_existed || 0, writeResult.existed),
                total_updated: (job.total_updated || 0) + writeResult.updated,
                error_log: [...(job.error_log || []), `[${new Date().toISOString()}] Corrected territory polygon and recovered ${writeResult.inserted} new / ${writeResult.existed} existing valid deed records without route regeneration.`].slice(-50)
            });
        }

        const storedCounts = await sql`
            SELECT
                COUNT(*)::int AS final_stored_total,
                COUNT(*) FILTER (WHERE wp.route_active = TRUE)::int AS final_stored_active
            FROM workspace_properties wp
            JOIN properties p ON p.id = wp.property_id
            WHERE wp.user_email = ${targetEmail}
        `;

        const includePoints = body.include_points === true;
        const result = {
            success: true,
            action,
            user_email: targetEmail,
            job_id: job.id,
            creation_inference: 'This FetchJob stores a frontend-supplied polygon; fetchAreaProperties then generated the 16 RentCast sub-circles from that polygon\'s bounding circle. The sub-circles were derived from the polygon, not vice versa, which explains the mismatch.',
            current_polygon: {
                points: currentPolygon,
                point_count: currentPolygon.length,
                area_sq_mi: Number(currentArea.toFixed(2)),
                area_vs_target_pct: Number(((currentArea / TARGET_AREA_SQMI) * 100).toFixed(1)),
                bounds: currentPolygon.length ? bounds(currentPolygon) : null
            },
            corrected_polygon: {
                points: correctedPolygon,
                point_count: correctedPolygon.length,
                area_sq_mi: Number(correctedArea.toFixed(2)),
                area_vs_target_pct: Number(((correctedArea / TARGET_AREA_SQMI) * 100).toFixed(1)),
                bounds: bounds(correctedPolygon),
                definition: 'Convex hull around the outer perimeter of all 16 RentCast 5-mile sub-circles. This is diagnostic only unless area remains within the paid territory safety limit.'
            },
            comparison: {
                raw_rentcast_records: rawTotal,
                current_outside_polygon: currentOutside,
                corrected_outside_polygon: correctedOutside,
                current_eligible_records_before_global_dedup: currentEligible,
                corrected_eligible_records_before_global_dedup: correctedEligible,
                corrected_unique_recoverable_records: recoverable.length,
                safe_to_apply_corrected_polygon: expansionIsSafe,
                safety_verdict: expansionIsSafe ? 'safe_to_apply' : 'blocked_sub_circle_hull_exceeds_300_sqmi_target',
                excluded_area_direction_counts: excludedDirections
            },
            rentcast_fetch_cap_scan: {
                page_limit: LIMIT,
                sub_circles_queried_independently: subCircles.length,
                total_api_calls: totalApiCalls,
                any_sub_circle_hit_10000_record_safety_cap: anyHitCap,
                per_sub_circle: perSubCircle
            },
            write_result: writeResult,
            stored_counts_after_action: storedCounts[0]
        };
        if (!includePoints) {
            delete result.current_polygon.points;
            delete result.corrected_polygon.points;
        }
        return Response.json(result);
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});