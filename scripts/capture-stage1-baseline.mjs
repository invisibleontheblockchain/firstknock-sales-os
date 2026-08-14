// Captures the Stage 1 before/after regression baseline.
//
// Stage 1 replaces four independent street-block / pocket definitions with one
// shared model. That rewiring can legitimately change a generated route, so this
// script freezes the CURRENT output of every path first. After the rewiring the
// same script reproduces the same file, and `test/routing-unit-parity.test.mjs`
// fails on any drift — so a route change has to be explained by the new topology
// model rather than slipping through unnoticed.
//
// Usage:
//   node scripts/capture-stage1-baseline.mjs           # verify (default)
//   node scripts/capture-stage1-baseline.mjs --write   # rewrite the baseline
//
// Baselines recorded per fixture:
//   - block partition of each definition (door-id groups, canonically sorted)
//   - the door order the backend road-aware sweep produces
//   - the route split + order the generation backend produces

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { createServer } from 'vite';

import { buildStreetBlocks, roadAwareStreetSweep } from '../base44/shared/roadAwareStreetSweep.js';
import { buildRoutingUnits } from '../base44/shared/routingUnits.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
export const BASELINE_PATH = resolve(rootDir, 'test/fixtures/stage1-routing-unit-baseline.json');
const BACKEND_PATH = 'base44/functions/generateRoutesBackend/entry.ts';

const FIXTURES = [
    { name: 'mesquite58', file: 'test/fixtures/road-matrix-mesquite58.json' },
    { name: 'charlotte95', file: 'test/fixtures/road-matrix-charlotte95.json' },
    { name: 'anderson183', file: 'test/fixtures/road-matrix-anderson183.json' }
];

const doorId = (door) => String(door?.address_hash || door?.legacy_hash || door?.id || '');

function compareText(left, right) {
    return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

/** Door-id groups, canonically sorted, so a partition compares independently of naming. */
function partitionSignature(groups) {
    return groups
        .map((doors) => doors.map(doorId).sort(compareText).join(','))
        .sort(compareText);
}

function loadFixtureDoors(file) {
    const parsed = JSON.parse(readFileSync(resolve(rootDir, file), 'utf8'));
    const doors = parsed.properties || parsed.doors || [];
    assert.ok(doors.length > 0, `${file} has no properties`);
    return doors;
}

function loadBackendHandler() {
    const source = readFileSync(resolve(rootDir, BACKEND_PATH), 'utf8');
    const transpiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: BACKEND_PATH
    });
    let handler;
    vm.runInNewContext(transpiled.outputText.replace(/^import .*;\s*$/gm, ''), {
        console,
        createClientFromRequest: () => ({ auth: { me: async () => ({ id: 'stage1_baseline_user' }) } }),
        Deno: { serve: (registered) => { handler = registered; } },
        Request,
        Response
    }, { filename: BACKEND_PATH });
    assert.equal(typeof handler, 'function');
    return handler;
}

async function backendRoutes(handler, doors, housesPerRoute) {
    const response = await handler(new Request('https://app.example.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties: doors, houses_per_route: housesPerRoute })
    }));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return (result.routes || []).map((route) => (route.properties || []).map(doorId));
}

export async function captureBaseline() {
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    try {
        const { routeRoadContextInternals } = await vite.ssrLoadModule(
            '/src/components/logic/routeRoadContext.js'
        );
        const { routeOptimizerInternals } = await vite.ssrLoadModule(
            '/src/components/logic/routeOptimizer.jsx'
        );
        const handler = loadBackendHandler();
        const fixtures = {};

        for (const { name, file } of FIXTURES) {
            const doors = loadFixtureDoors(file);
            const shared = buildRoutingUnits(doors);

            // Cost-only plan groups doors by its own street key.
            const costOnlyPlan = routeRoadContextInternals.buildCostOnlyBlockPlan(doors);
            const costOnlyGroups = new Map();
            doors.forEach((door, index) => {
                const key = costOnlyPlan.streetKeyByIdentity.get(
                    routeRoadContextInternals.propertyIdentity(door, index)
                ) || `__unkeyed__${index}`;
                if (!costOnlyGroups.has(key)) costOnlyGroups.set(key, []);
                costOnlyGroups.get(key).push(door);
            });

            fixtures[name] = {
                doorCount: doors.length,
                blocks: {
                    shared: partitionSignature(buildStreetBlocks(doors).map((block) => block.doors)),
                    frontendSweep: partitionSignature(
                        routeOptimizerInternals.buildStreetSweepBlocks(doors)
                            .map((block) => block.variants[0])
                    ),
                    costOnly: partitionSignature([...costOnlyGroups.values()])
                },
                routingUnits: {
                    unitCount: shared.unitCount,
                    protectedUnitCount: shared.units.filter((unit) => unit.protected).length,
                    pocketProvenance: shared.pocketProvenance
                },
                sweepOrder: roadAwareStreetSweep(doors).map(doorId),
                backendRoutes: await backendRoutes(handler, doors, doors.length)
            };
        }

        return { capturedFor: 'stage1-shared-routing-unit-model', fixtures };
    } finally {
        await vite.close();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    const captured = await captureBaseline();
    if (process.argv.includes('--write')) {
        writeFileSync(BASELINE_PATH, `${JSON.stringify(captured, null, 1)}\n`);
        console.log(`wrote ${BASELINE_PATH}`);
    } else {
        const existing = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
        assert.deepEqual(captured, existing, 'captured output differs from the frozen baseline');
        console.log('baseline matches');
    }
}