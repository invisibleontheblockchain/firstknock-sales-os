// Level 3 of the road-aware hierarchy, as an endpoint: what does this exact
// stop order actually cost on the road network?
//
// The optimizer approximates in order to search 1,000 doors affordably. This
// measures a FIXED order instead of searching, so its cost is linear in stops
// and its answer is real driving distance rather than a mixed aerial/road score.
// It is also how a before/after comparison is produced for a stored route: the
// stored order and a proposed order are both measured the same way.
//
// Measurement only — it never reorders and never writes.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
import { isValidPoint } from '../../shared/routeContinuityOptimizer.js';
import { DEFAULT_OSRM_BASE_URL } from '../../shared/roadMatrix.js';
import { measureRoadPath } from '../../shared/roadPathMeasure.js';

// A measurement is one request per 49 legs, so this is bounded by how much work
// fits in a function invocation rather than by matrix cost.
const MAX_MEASURED_STOPS = 1200;

function readSecret(name: string) {
    try {
        const value = secrets.get(name);
        return value ? String(value).trim() : '';
    } catch {
        return '';
    }
}

export default async function (req: Request): Promise<Response> {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const stops = Array.isArray(body.stops) ? body.stops : [];
        const profile = body.profile === 'walking' ? 'walking' : 'driving';
        const includeGeometry = body.include_geometry === true;

        if (stops.length < 2) {
            return Response.json({
                error: 'A road path measurement needs at least two stops.',
                code: 'TOO_FEW_STOPS'
            }, { status: 400 });
        }
        if (stops.length > MAX_MEASURED_STOPS) {
            return Response.json({
                error: `Road path measurement is limited to ${MAX_MEASURED_STOPS} stops per request.`,
                code: 'TOO_MANY_STOPS'
            }, { status: 400 });
        }
        const invalidIndex = stops.findIndex((stop: unknown) => !isValidPoint(stop));
        if (invalidIndex >= 0) {
            return Response.json({
                error: 'Every stop requires a valid map coordinate.',
                code: 'INVALID_STOP_COORDINATES',
                invalid_stop_index: invalidIndex
            }, { status: 400 });
        }

        const startedAt = Date.now();
        const measured = await measureRoadPath(stops, {
            baseUrl: readSecret('OSRM_BASE_URL') || DEFAULT_OSRM_BASE_URL,
            profile,
            timeoutMs: 25000
        });
        if (!measured.ok) {
            return Response.json({
                success: false,
                code: 'ROAD_PATH_UNMEASURED',
                error: measured.error,
                measure_ms: Date.now() - startedAt
            });
        }

        const round = (value: number) => Math.round(value * 1000) / 1000;
        // Leg index i is the drive from stop i+1 to stop i+2, 1-based for humans.
        const longestLeg = {
            from_stop: measured.longestLegIndex + 1,
            to_stop: measured.longestLegIndex + 2,
            miles: round(measured.longestLegMiles)
        };

        return Response.json({
            success: true,
            stop_count: stops.length,
            leg_count: measured.legMiles.length,
            total_road_miles: round(measured.totalMiles),
            longest_road_leg: longestLeg,
            leg_miles: measured.legMiles.map(round),
            routing_profile: profile,
            osrm_request_count: measured.requestCount,
            geometry_point_count: measured.geometry.length,
            ...(includeGeometry ? { geometry: measured.geometry } : {}),
            measure_ms: Date.now() - startedAt
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}