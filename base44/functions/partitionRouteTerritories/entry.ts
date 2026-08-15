// Live K-way route splitting: membership from road topology, order from the
// frozen Precision optimizer.
//
// This endpoint produces MEMBERSHIPS and nothing else — it writes no routes. The
// caller decides whether to persist the result, exactly as it does with the
// existing preview-then-create flow, so a split can be inspected and rejected.
//
// The frozen solver is used unmodified: each produced route is sequenced by
// `sequenceBestDecomposition` (the frozen Precision entry point) on its own homes,
// and then measured INDEPENDENTLY by `measureRoadPath`. The partitioner selects
// its winner on those measured miles, so no candidate can be chosen on its own
// estimate. Only the frozen baseline decomposition runs per route: a full
// portfolio per route would multiply K by the portfolio size, and the baseline is
// the production default the freeze record designates.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
import { partitionRouteTerritories } from '../../shared/routeTerritoryPartitioner.js';
import {
    DEFAULT_DECOMPOSITION_PORTFOLIO,
    sequenceBestDecomposition
} from '../../shared/roadDecompositionPortfolio.js';
import { measureRoadPath } from '../../shared/roadPathMeasure.js';
import { DEFAULT_OSRM_BASE_URL } from '../../shared/roadMatrix.js';
import { MAX_HOMES_PER_ROUTE } from '../../shared/routingBudgets.js';
import { isValidPoint } from '../../shared/routeContinuityOptimizer.js';

// Product ceiling on requested routes. Beyond 100 a 1,000-home territory averages
// under ten homes a route, which is not a canvassing day.
const MAX_SPLIT_ROUTES = 100;

// Above this many routes only ONE partition candidate is verified: verification
// costs K frozen-solver runs plus K measurements, so a large K must not multiply
// that by the number of finalists.
const SINGLE_FINALIST_ROUTE_COUNT = 20;

function readSecret(name: string): string {
    try {
        const value = secrets.get(name);
        return value ? String(value).trim() : '';
    } catch {
        return '';
    }
}

const propertyIdentity = (property) => String(property?.address_hash || property?.id || '');

export default async function (req: Request): Promise<Response> {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const properties = Array.isArray(body.properties) ? body.properties : [];
        const routeCount = Math.floor(Number(body.route_count));
        const profile = body.profile === 'walking' ? 'walking' : 'driving';
        const timeoutMs = Number.isFinite(Number(body.timeout_ms))
            ? Math.min(Math.max(Math.floor(Number(body.timeout_ms)), 50), 25000)
            : 20000;

        if (properties.length < 2) {
            return Response.json({
                error: 'Splitting needs at least two homes.',
                code: 'TOO_FEW_PROPERTIES'
            }, { status: 400 });
        }
        if (properties.length > MAX_HOMES_PER_ROUTE) {
            return Response.json({
                error: `A territory of more than ${MAX_HOMES_PER_ROUTE} homes cannot be split in one pass.`,
                code: 'TOO_MANY_PROPERTIES'
            }, { status: 400 });
        }
        if (!Number.isFinite(routeCount) || routeCount < 2 || routeCount > MAX_SPLIT_ROUTES) {
            return Response.json({
                error: `Choose between 2 and ${MAX_SPLIT_ROUTES} routes.`,
                code: 'INVALID_ROUTE_COUNT'
            }, { status: 400 });
        }
        if (routeCount > properties.length) {
            return Response.json({
                error: `This territory has only ${properties.length} homes.`,
                code: 'ROUTE_COUNT_EXCEEDS_PROPERTIES'
            }, { status: 400 });
        }
        const invalidIndex = properties.findIndex((property) => !isValidPoint(property) || !propertyIdentity(property));
        if (invalidIndex >= 0) {
            return Response.json({
                error: 'Every home needs an identity and a valid map coordinate before a split.',
                code: 'INVALID_PROPERTY_COORDINATES',
                invalid_property_index: invalidIndex
            }, { status: 400 });
        }
        if (new Set(properties.map(propertyIdentity)).size !== properties.length) {
            return Response.json({
                error: 'The submitted territory contains duplicate homes.',
                code: 'DUPLICATE_PROPERTIES'
            }, { status: 400 });
        }

        const baseUrl = readSecret('OSRM_BASE_URL') || DEFAULT_OSRM_BASE_URL;
        const roadOptions = { baseUrl, profile, timeoutMs };
        // The frozen baseline decomposition, taken from the frozen portfolio
        // rather than restated here, so this path cannot drift from production.
        const frozenBaseline = DEFAULT_DECOMPOSITION_PORTFOLIO.filter((candidate) => candidate.mandatory);
        const portfolio = frozenBaseline.length > 0 ? frozenBaseline : DEFAULT_DECOMPOSITION_PORTFOLIO.slice(0, 1);

        const optimizeRoute = async (doors) => {
            // A one-home route has exactly one order and nothing to sequence.
            if (doors.length < 2) return { order: [...doors] };
            const sequenced = await sequenceBestDecomposition(doors, {
                ...roadOptions,
                portfolio,
                measurePath: measureRoadPath
            });
            if (!sequenced.ok || !Array.isArray(sequenced.order)) {
                return { order: null, metadata: { code: sequenced.code || 'FROZEN_SOLVER_FAILED' } };
            }
            return {
                order: sequenced.order,
                metadata: {
                    decomposition: sequenced.best?.id || null,
                    solver_verified_road_miles: sequenced.best?.verified_road_miles ?? null,
                    degraded: sequenced.telemetry?.degraded ?? null
                }
            };
        };

        const measurePath = async (order) => {
            if (order.length < 2) return { ok: true, totalMiles: 0 };
            return measureRoadPath(order, roadOptions);
        };

        const result = await partitionRouteTerritories(properties, routeCount, {
            ...roadOptions,
            roadNetwork: body.road_network || null,
            territoryPolygon: Array.isArray(body.polygon) ? body.polygon : null,
            optimizeRoute,
            measurePath,
            verifyCandidates: routeCount > SINGLE_FINALIST_ROUTE_COUNT ? 1 : 2,
            ...(Number.isFinite(Number(body.balance_tolerance))
                ? { balanceTolerance: Number(body.balance_tolerance) }
                : {})
        });

        if (!result.ok) {
            // No partial splits, ever: the caller keeps the route it has.
            return Response.json({
                error: 'FirstKnock could not divide this territory on the road network. Nothing was changed.',
                code: result.code,
                details: result.report || result.candidates || null
            }, { status: 422 });
        }

        return Response.json({
            success: true,
            partitioner_version: result.partitioner_version,
            selected_candidate: result.selected_candidate,
            route_count: result.routes.length,
            routes: result.routes.map((route, index) => ({
                route_number: index + 1,
                house_count: route.doorCount,
                property_hashes: route.order.map(propertyIdentity),
                verified_road_miles: Math.round(route.verifiedRoadMiles * 1000) / 1000,
                optimizer: route.optimizerMetadata || null
            })),
            report: result.report
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}