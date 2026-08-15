// Stage 2 step 2 acceptance tests for the shared territory partitioner.
//
// What must hold: cuts land on routing-unit boundaries (pockets stay whole),
// every emitted partition is inside BOTH the home ceiling and the block ceiling,
// the tier is decided from the real block count, coverage is exactly-once across
// the WHOLE set, and the result is deterministic.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    OVERRIDE_UNIT_EXCEEDS_HOMES,
    partitionTerritory
} from '../base44/shared/territoryPartitioner.js';
import { MAX_BLOCKS_PER_ROUTE, MAX_HOMES_PER_ROUTE } from '../base44/shared/routingBudgets.js';
import { TIER_BLOCK, TIER_DOOR } from '../base44/shared/roadMatrixTiers.js';

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
 * A territory of `streetCount` short streets, `doorsPerStreet` doors each, laid
 * out on a grid. Sparse streets make BLOCK count bind before door count, which
 * is the case the old unit-denominated budget got wrong.
 */
function gridTerritory(streetCount, doorsPerStreet) {
    const doors = [];
    const columns = Math.ceil(Math.sqrt(streetCount));
    for (let street = 0; street < streetCount; street += 1) {
        const row = Math.floor(street / columns);
        const column = street % columns;
        for (let house = 0; house < doorsPerStreet; house += 1) {
            doors.push(door(
                `Street ${street}`,
                100 + house * 2,
                35.2 + row * 0.004,
                -80.85 + column * 0.004 + house * 0.0002
            ));
        }
    }
    return doors;
}

function culDeSacNetwork() {
    const spine = [
        node(35.2000, -80.8500),
        node(35.2000, -80.8480),
        node(35.2000, -80.8460),
        node(35.2000, -80.8440)
    ];
    const loopBack = [node(35.2020, -80.8500), node(35.2020, -80.8440)];
    const stub = [node(35.1980, -80.8460), node(35.1970, -80.8460)];
    return {
        elements: [
            ...spine, ...loopBack, ...stub,
            way(spine),
            way(loopBack),
            way([spine[0], loopBack[0]]),
            way([spine[3], loopBack[1]]),
            way([spine[2], stub[0]]),
            way(stub)
        ]
    };
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

test('PART-01 every door lands in exactly one partition across the whole set', () => {
    const doors = gridTerritory(300, 8);
    const result = partitionTerritory(doors);
    assert.equal(result.validation.ok, true);
    assert.equal(result.validation.assignedDoorCount, doors.length);
    const identities = result.partitions.flatMap((partition) => partition.doors.map((item) => item.address_hash));
    assert.equal(identities.length, doors.length);
    assert.equal(new Set(identities).size, doors.length);
});

test('PART-02 no partition exceeds the 1,000-home product ceiling', () => {
    // 2,400 doors: the home budget binds, and the old 1,200 default would have
    // produced 2 partitions of 1,200 — above the product cap.
    const result = partitionTerritory(gridTerritory(300, 8));
    assert.ok(result.partitions.length >= 3, 'a 2,400-home territory needs at least 3 routes');
    result.partitions.forEach((partition) => {
        assert.ok(
            partition.doorCount <= MAX_HOMES_PER_ROUTE,
            `partition ${partition.index} has ${partition.doorCount} homes`
        );
    });
    assert.equal(result.stats.maxHomesPerPartition <= MAX_HOMES_PER_ROUTE, true);
});

test('PART-03 the block ceiling binds on sparse territories, not the home count', () => {
    // 1,200 doors over 600 two-door streets: only 1.2 routes' worth of homes,
    // but 600 blocks — far past what one road matrix can carry.
    const result = partitionTerritory(gridTerritory(600, 2));
    assert.ok(result.stats.blockCount > MAX_BLOCKS_PER_ROUTE);
    assert.ok(
        result.partitions.length >= Math.ceil(result.stats.blockCount / MAX_BLOCKS_PER_ROUTE),
        'sparse territories must be cut by blocks even when homes would fit'
    );
    result.partitions.forEach((partition) => {
        assert.ok(
            partition.blockCount <= MAX_BLOCKS_PER_ROUTE,
            `partition ${partition.index} has ${partition.blockCount} blocks`
        );
    });
});

test('PART-04 every partition is validated to block tier or better before proceeding', () => {
    const result = partitionTerritory(gridTerritory(600, 2));
    result.partitions.forEach((partition) => {
        assert.equal(partition.matrixTierOk, true);
        assert.ok(
            [TIER_DOOR, TIER_BLOCK].includes(partition.matrixTier),
            `partition ${partition.index} predicted ${partition.matrixTier}`
        );
        assert.equal(partition.roadReady, true);
    });
    assert.equal(result.stats.roadReadyPartitions, result.partitions.length);
});

test('PART-05 a protected pocket is never cut across partitions', () => {
    const doors = culDeSacDoors();
    // Force a cut with a budget far below the territory size: the pocket must
    // still travel as one unit.
    const result = partitionTerritory(doors, { roadNetwork: culDeSacNetwork(), maxHomes: 3 });
    assert.ok(result.partitions.length > 1, 'the tiny budget must force a cut');
    const pocketUnit = result.units.find((unit) => unit.protected);
    assert.ok(pocketUnit, 'the cul-de-sac must be detected as a pocket');
    const owners = result.partitions.filter((partition) => partition.unitKeys.includes(pocketUnit.key));
    assert.equal(owners.length, 1, 'the pocket unit belongs to exactly one partition');
    const pocketDoors = new Set(pocketUnit.doors.map((item) => item.address_hash));
    result.partitions.forEach((partition) => {
        const held = partition.doors.filter((item) => pocketDoors.has(item.address_hash)).length;
        assert.ok(held === 0 || held === pocketDoors.size, 'pocket doors are never split');
    });
    assert.equal(result.validation.ok, true);
});

test('PART-06 an atomic unit that cannot fit records an explicit override', () => {
    // The pocket holds 3 doors, so a 2-home budget cannot cut it. Keeping it
    // whole is the right call, but it must be reported, not hidden.
    const result = partitionTerritory(culDeSacDoors(), {
        roadNetwork: culDeSacNetwork(),
        maxHomes: 2
    });
    const overflowing = result.partitions.filter((partition) => partition.overrides.length > 0);
    assert.ok(overflowing.length >= 1, 'the oversized pocket must surface an override');
    overflowing.forEach((partition) => {
        assert.equal(partition.unitCount, 1, 'only an atomic unit may exceed budget');
        assert.equal(partition.withinBudget, false);
        assert.equal(partition.overrides[0].code, OVERRIDE_UNIT_EXCEEDS_HOMES);
        assert.ok(partition.overrides[0].reason.length > 0);
    });
    assert.equal(result.overrides.length, overflowing.length);
    // Coverage still holds: an override changes sizing, never membership.
    assert.equal(result.validation.ok, true);
});

test('PART-07 partitioning is deterministic under input shuffling', () => {
    const doors = gridTerritory(120, 6);
    const forward = partitionTerritory(doors);
    const reversed = partitionTerritory([...doors].reverse());
    assert.deepEqual(
        reversed.partitions.map((partition) => partition.signature),
        forward.partitions.map((partition) => partition.signature)
    );
    assert.deepEqual(
        reversed.partitions.map((partition) => partition.unitKeys),
        forward.partitions.map((partition) => partition.unitKeys)
    );
    assert.deepEqual(
        reversed.partitions.map((partition) => partition.doorCount),
        forward.partitions.map((partition) => partition.doorCount)
    );
});

test('PART-08 a territory that already fits stays a single partition', () => {
    const result = partitionTerritory(gridTerritory(20, 6));
    assert.equal(result.partitions.length, 1);
    assert.equal(result.partitions[0].withinBudget, true);
    assert.equal(result.partitions[0].matrixTier, TIER_DOOR);
    assert.equal(result.overrides.length, 0);
    assert.equal(partitionTerritory([]).partitions.length, 0);
});