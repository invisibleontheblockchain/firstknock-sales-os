/**
 * Precision Generation product contract: up to 1,000 properties = ONE route.
 *
 * The routing-unit / street-block / matrix-tier work exists to make that single
 * route road-aligned, NOT to hand the user several routes. These tests pin both
 * halves of that: the route count stays at one, and the optimizer still bounds
 * the road matrix with block representatives instead of attempting a
 * 1,000 x 1,000 door matrix.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';

import {
    planTieredRoadMatrix,
    predictMatrixTier,
    TIER_BLOCK,
    TIER_DOOR,
} from '../base44/shared/roadMatrixTiers.js';

let vite;
let generateOptimizedRoutes;
let createRouteContinuityContext;

before(async () => {
    vite = await createServer({
        server: { middlewareMode: true },
        appType: 'custom',
        logLevel: 'silent',
    });
    ({ generateOptimizedRoutes } = await vite.ssrLoadModule(
        '/src/components/logic/routeOptimizer.jsx',
    ));
    ({ createRouteContinuityContext } = await vite.ssrLoadModule(
        '/src/components/logic/routeRoadContext.js',
    ));
});

after(async () => {
    await vite?.close();
});

const NEIGHBORHOODS = ['Ashbrook', 'Bellhaven', 'Cypress Grove', 'Dunwood', 'Eastfield'];
const STREETS = ['Oak Dr', 'Maple Ln', 'Cedar Ct', 'Willow Way', 'Birch Rd'];
const DOORS_PER_STREET = 40;

/**
 * 1,000 doors laid out the way a drawn Precision territory actually looks:
 * five separated neighborhoods, five streets each, doors on both sides of every
 * street. Cedar Ct is a cul-de-sac — a compact pocket off its neighborhood.
 */
function buildPrecisionTerritory() {
    const doors = [];
    NEIGHBORHOODS.forEach((subdivision, neighborhoodIndex) => {
        const baseLng = -112 + neighborhoodIndex * 0.05;
        STREETS.forEach((streetSuffix, streetIndex) => {
            // Real neighborhoods do not share street names, and the road matrix
            // groups blocks by canonical street name — so the fixture keeps them
            // distinct rather than collapsing five neighborhoods into one block.
            const street = `${subdivision} ${streetSuffix}`;
            const baseLat = 33.45 + streetIndex * 0.003;
            for (let doorIndex = 0; doorIndex < DOORS_PER_STREET; doorIndex += 1) {
                const evenSide = doorIndex % 2 === 1;
                const alongStreet = Math.floor(doorIndex / 2) * 0.00035;
                doors.push({
                    id: `${subdivision}-${street}-${doorIndex}`,
                    address_hash: `${subdivision}-${street}-${doorIndex}`,
                    street_name: street,
                    house_number: 100 + doorIndex,
                    city: 'Phoenix',
                    state: 'AZ',
                    zip_code: '85001',
                    subdivision_name: subdivision,
                    lat: baseLat + (evenSide ? 0.0004 : 0),
                    lng: streetSuffix === 'Cedar Ct'
                        ? baseLng + 0.001 + alongStreet * 0.4
                        : baseLng + alongStreet,
                    effective_status: 'ELIGIBLE',
                    price: 350000,
                });
            }
        });
    });
    return doors;
}

function contiguousRuns(values) {
    return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function assertNoReentry(values, label) {
    const runs = contiguousRuns(values);
    assert.equal(
        new Set(runs).size,
        runs.length,
        `a ${label} was left and re-entered: ${runs.join(' -> ')}`,
    );
}

function generateSinglePrecisionRoute(doors) {
    const routingContext = createRouteContinuityContext(doors);
    return {
        routingContext,
        routes: generateOptimizedRoutes(
            doors,
            // The user's Precision allowance IS the route size.
            1000,
            null,
            [],
            { routingContext },
        ),
    };
}

test('1,000 Precision properties come back as exactly one route holding all of them', () => {
    const doors = buildPrecisionTerritory();
    assert.equal(doors.length, 1000);

    const { routes } = generateSinglePrecisionRoute(doors);

    assert.equal(routes.length, 1, 'the 1,000-home allowance must remain ONE route');
    const routed = routes[0].properties;
    assert.equal(routed.length, 1000);
    assert.equal(routes[0].houseCount, 1000);
    assert.deepEqual(
        routed.map(({ id }) => id).sort(),
        doors.map(({ id }) => id).sort(),
        'every property must appear exactly once in the single route',
    );
});

test('the single 1,000-home route stays geographically coherent instead of bouncing', () => {
    const doors = buildPrecisionTerritory();
    const { routes } = generateSinglePrecisionRoute(doors);
    const routed = routes[0].properties;

    // Requirement: street blocks, access groups and pockets shape the ORDER.
    assertNoReentry(routed.map((door) => door.subdivision_name), 'neighborhood');
    assertNoReentry(
        routed.map((door) => `${door.subdivision_name}|${door.street_name}`),
        'street block',
    );
    // Cedar Ct is the pocket in each neighborhood: it must be swept in one visit.
    assert.equal(
        contiguousRuns(routed.map((door) => (
            door.street_name.endsWith('Cedar Ct') ? `${door.subdivision_name}-pocket` : ''
        ))).filter((value) => value.endsWith('-pocket')).length,
        NEIGHBORHOODS.length,
        'each cul-de-sac pocket must be entered once, not revisited',
    );
});

test('the road matrix represents the 1,000-door route with blocks, never 1,000 door points', () => {
    const doors = buildPrecisionTerritory();
    const { routes } = generateSinglePrecisionRoute(doors);
    const routed = routes[0].properties;

    // Anchored trip: a start and a finish are priced alongside the doors.
    const plan = planTieredRoadMatrix(routed, [
        { lat: 33.44, lng: -112.02 },
        { lat: 33.47, lng: -111.79 },
    ]);

    assert.equal(plan.ok, true, 'a 1,000-door route must still be road-optimizable');
    assert.equal(plan.tier, TIER_BLOCK, 'a 1,000-door route is priced at block tier');
    assert.equal(plan.doorCount, 1000);
    assert.ok(
        plan.matrixPoints.length < 300,
        `expected a bounded matrix, got ${plan.matrixPoints.length} points`,
    );
    assert.ok(plan.blockCount >= NEIGHBORHOODS.length * STREETS.length);

    // The tier is an implementation detail of HOW the route is priced — it is
    // never a verdict that the route was too big to optimize.
    const prediction = predictMatrixTier({
        doorCount: 1000,
        blockCount: plan.blockCount,
        anchorCount: 2,
    });
    assert.equal(prediction.ok, true);
    assert.notEqual(prediction.tier, TIER_DOOR);
});

test('generation and the Optimize action share one road/topology pipeline, with no silent aerial route', async () => {
    const generationSource = await readFile(
        new URL('../src/lib/roadMatrixRouteGeneration.js', import.meta.url),
        'utf8',
    );
    const optimizeActionSource = await readFile(
        new URL('../src/lib/reoptimizeRouteAction.js', import.meta.url),
        'utf8',
    );
    const roadMatrixSource = await readFile(
        new URL('../src/lib/roadMatrixOptimize.js', import.meta.url),
        'utf8',
    );
    const optimizerSource = await readFile(
        new URL('../src/components/logic/routeOptimizer.jsx', import.meta.url),
        'utf8',
    );

    // Requirement 7 + 10: initial generation and the later Optimize action both
    // price the route through the same backend road matrix.
    for (const [label, source] of [['generation', generationSource], ['optimize', optimizeActionSource]]) {
        assert.match(
            source,
            /import \{ tryRoadMatrixOptimize \} from '@\/lib\/roadMatrixOptimize'/,
            `${label} must run the shared road-matrix optimizer`,
        );
        assert.match(source, /tryRoadMatrixOptimize\(/, `${label} must call the shared road optimizer`);
    }

    // Requirement 8: an unmeasured aerial fallback order is never adopted.
    assert.match(
        roadMatrixSource,
        /data\.routing_metadata\?\.fallback === true/,
        'an aerial fallback order must be rejected rather than shipped as optimized',
    );

    // Requirement 9: block/cluster representation must not become a route split.
    assert.match(
        optimizerSource,
        /maxBlocks: Number\.POSITIVE_INFINITY/,
        'street-block count must never partition the user\'s route',
    );
});