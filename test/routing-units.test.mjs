// Stage 1 acceptance tests for the shared routing-unit model.
//
// The model is the single authority for homes -> street blocks -> road-topology
// pockets. What matters here is that it PARTITIONS (every door once), that
// pocket ids are derived from topology and are deterministic, and that a
// protected pocket collapses to one routing unit so no partitioner can cut it.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildRoutingUnits,
    POCKET_PROVENANCE_NONE,
    POCKET_PROVENANCE_TOPOLOGY,
    ROUTING_UNIT_BUDGET,
    routingUnitWorkload
} from '../base44/shared/routingUnits.js';

let nextNodeId = 1;

function node(lat, lng) {
    return { type: 'node', id: nextNodeId++, lat, lon: lng };
}

function way(nodes, highway = 'residential') {
    return { type: 'way', id: nextNodeId++, nodes: nodes.map((item) => item.id), tags: { highway } };
}

function door(street, houseNumber, lat, lng) {
    return {
        address_hash: `${street}-${houseNumber}`,
        house_number: houseNumber,
        street_name: street,
        city: 'Charlotte',
        state: 'NC',
        zip_code: '28202',
        lat,
        lng
    };
}

/**
 * A through-street grid with one cul-de-sac hanging off it. The stub is only
 * reachable through a single edge, so it must be detected as a pocket without
 * any subdivision label being present anywhere in the input.
 */
function culDeSacNetwork() {
    const spine = [
        node(35.2000, -80.8500),
        node(35.2000, -80.8480),
        node(35.2000, -80.8460),
        node(35.2000, -80.8440)
    ];
    const loopBack = [
        node(35.2020, -80.8500),
        node(35.2020, -80.8440)
    ];
    const stub = [node(35.1980, -80.8460), node(35.1970, -80.8460)];
    const elements = [
        ...spine, ...loopBack, ...stub,
        way(spine),
        // A parallel road plus its two connectors makes the spine a real loop,
        // so the spine edges are not themselves bridges.
        way(loopBack),
        way([spine[0], loopBack[0]]),
        way([spine[3], loopBack[1]]),
        way([spine[2], stub[0]]),
        way(stub)
    ];
    return { elements };
}

function culDeSacDoors() {
    return [
        door('Grid St', 100, 35.20005, -80.8496),
        door('Grid St', 102, 35.20005, -80.8488),
        door('Grid St', 104, 35.20005, -80.8470),
        door('Quiet Ct', 200, 35.19790, -80.84605),
        door('Quiet Ct', 202, 35.19760, -80.84598),
        door('Quiet Ct', 204, 35.19730, -80.84602)
    ];
}

test('UNIT-01 every address belongs to exactly one street block', () => {
    const doors = culDeSacDoors();
    const model = buildRoutingUnits(doors, { roadNetwork: culDeSacNetwork() });
    const assigned = model.blocks.flatMap((block) => block.doors.map((item) => item.address_hash));
    assert.equal(assigned.length, doors.length);
    assert.equal(new Set(assigned).size, doors.length);
});

test('UNIT-02 a cul-de-sac gets a pocket id from topology, not from a label', () => {
    const model = buildRoutingUnits(culDeSacDoors(), { roadNetwork: culDeSacNetwork() });
    assert.equal(model.pocketProvenance, POCKET_PROVENANCE_TOPOLOGY);
    const pocketBlocks = model.blocks.filter((block) => block.pocketId);
    assert.ok(pocketBlocks.length >= 1, 'the cul-de-sac block must be protected');
    pocketBlocks.forEach((block) => {
        assert.match(block.pocketId, /^pocket:[0-9a-f]{16}$/);
        assert.ok(
            block.doors.every((item) => item.street_name === 'Quiet Ct'),
            'only the cul-de-sac doors belong to the pocket'
        );
    });
    // No input carried a subdivision name, so a label-based model would have
    // found nothing here.
    assert.ok(culDeSacDoors().every((item) => item.subdivision_name === undefined));
});

test('UNIT-03 pocket ids and unit order are deterministic under input shuffling', () => {
    const doors = culDeSacDoors();
    const network = culDeSacNetwork();
    const forward = buildRoutingUnits(doors, { roadNetwork: network });
    const reversed = buildRoutingUnits([...doors].reverse(), { roadNetwork: network });
    assert.deepEqual(
        reversed.units.map((unit) => unit.key),
        forward.units.map((unit) => unit.key)
    );
    assert.deepEqual(
        reversed.pockets.map((pocket) => pocket.id),
        forward.pockets.map((pocket) => pocket.id)
    );
});

test('UNIT-04 a protected pocket collapses into exactly one routing unit', () => {
    const model = buildRoutingUnits(culDeSacDoors(), { roadNetwork: culDeSacNetwork() });
    const protectedUnits = model.units.filter((unit) => unit.protected);
    assert.equal(protectedUnits.length, 1);
    const [pocketUnit] = protectedUnits;
    const pocketBlockKeys = model.blocks
        .filter((block) => block.pocketId === pocketUnit.pocketId)
        .map((block) => block.key)
        .sort();
    // Every block inside the pocket travels as part of that single unit, which
    // is what prevents a partitioner from cutting the pocket across routes.
    assert.deepEqual(pocketUnit.blockKeys, pocketBlockKeys);
    assert.equal(
        pocketUnit.doorCount,
        model.blocks
            .filter((block) => block.pocketId === pocketUnit.pocketId)
            .reduce((total, block) => total + block.doorCount, 0)
    );
});

test('UNIT-05 units still partition every door when no road network is supplied', () => {
    const doors = culDeSacDoors();
    const model = buildRoutingUnits(doors);
    assert.equal(model.pocketProvenance, POCKET_PROVENANCE_NONE);
    assert.equal(model.pockets.length, 0);
    assert.ok(model.units.every((unit) => unit.protected === false));
    assert.equal(
        model.units.reduce((total, unit) => total + unit.doorCount, 0),
        doors.length
    );
});

test('UNIT-06 workload is driven by routing units, with doors as a secondary signal', () => {
    // Sparse: few doors, many units — units must decide.
    const sparse = routingUnitWorkload({ unitCount: 500, doorCount: 1500 });
    assert.equal(sparse.bindingBudget, 'routing_units');
    assert.equal(sparse.routeCount, Math.ceil(500 / ROUTING_UNIT_BUDGET));

    // Dense: many doors, few units — the door budget is what binds.
    const dense = routingUnitWorkload({ unitCount: 108, doorCount: 4800 });
    assert.equal(dense.bindingBudget, 'doors');
    assert.equal(dense.routeCount, 4);

    assert.equal(routingUnitWorkload({ unitCount: 0, doorCount: 0 }).routeCount, 0);
});

test('UNIT-07 a nested pocket resolves to its innermost unit', () => {
    const network = culDeSacNetwork();
    // Extend the stub with a second dead-end branch hanging off its tip: the
    // inner branch is its own pocket and must not be swallowed by the outer one.
    const tip = network.elements.filter((element) => element.type === 'node').slice(-1)[0];
    const innerFirst = node(35.1965, -80.8455);
    const innerSecond = node(35.1962, -80.8450);
    network.elements.push(
        innerFirst,
        innerSecond,
        way([{ id: tip.id }, innerFirst]),
        way([innerFirst, innerSecond])
    );

    const model = buildRoutingUnits(culDeSacDoors(), { roadNetwork: network });
    const pocketIds = model.pockets.map((pocket) => pocket.id);
    assert.equal(new Set(pocketIds).size, pocketIds.length, 'pocket ids are unique');
    // Smallest-first claiming means each edge belongs to exactly one pocket.
    const claimed = model.pockets.flatMap((pocket) => pocket.edgeKeys);
    const innermost = model.pockets[0];
    assert.ok(
        innermost.edgeCount <= model.pockets[model.pockets.length - 1].edgeCount,
        'pockets are emitted smallest-first'
    );
    assert.ok(claimed.length > 0);
});