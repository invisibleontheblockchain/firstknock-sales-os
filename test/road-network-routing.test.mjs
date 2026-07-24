import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createRoadNetworkRoutingContext,
    roadNetworkRoutingInternals,
} from '../src/components/logic/roadNetworkRouting.js';

function node(id, lat, lon) {
    return { type: 'node', id, lat, lon };
}

function way(id, nodes, name, tags = {}) {
    return {
        type: 'way',
        id,
        nodes,
        tags: {
            highway: 'residential',
            name,
            ...tags,
        },
    };
}

function aerialMiles(left, right) {
    const radians = (degrees) => degrees * Math.PI / 180;
    const latitudeDelta = radians(right.lat - left.lat);
    const longitudeDelta = radians(right.lng - left.lng);
    const leftLatitude = radians(left.lat);
    const rightLatitude = radians(right.lat);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 3958.7613 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

const accessAreaElements = [
    node('entrance', -0.01, 0),
    node('inside-a', 0, 0),
    node('inside-c', 0, 0.003),
    node('outside-turn', -0.01, 0.001),
    node('outside-b', 0.0005, 0.001),
    way('inside-way', ['entrance', 'inside-a', 'inside-c'], 'Inside Lane'),
    way('outside-way', ['entrance', 'outside-turn', 'outside-b'], 'Outside Road'),
];

const insideA = {
    id: 'A',
    lat: 0,
    lng: 0,
    street_name: 'Inside Ln',
};
const insideC = {
    id: 'C',
    lat: 0,
    lng: 0.003,
    street_name: 'Inside Lane',
};
const outsideB = {
    id: 'B',
    lat: 0.0005,
    lng: 0.001,
    street_name: 'Outside Rd',
};

test('road distance keeps stops in the same access area together when aerial distance is tempting', () => {
    const routing = createRoadNetworkRoutingContext({
        elements: accessAreaElements,
        properties: [insideA, insideC, outsideB],
    });

    assert.equal(routing.status, 'ready');
    assert.ok(
        aerialMiles(insideA, outsideB) < aerialMiles(insideA, insideC),
        'the outside stop must look closer to an aerial-distance optimizer',
    );
    assert.ok(
        routing.distanceBetween(insideA, insideC) < routing.distanceBetween(insideA, outsideB),
        'the road graph must recognize that the inside stops are cheaper to visit together',
    );
    assert.equal(
        routing.diagnostics.dijkstraRunCount,
        1,
        'multiple destinations from one source must reuse one shortest-path tree',
    );
    assert.equal(routing.diagnostics.cachedSourceTreeCount, 1);
    assert.equal(routing.routeBetween(insideA, outsideB).usedFallback, false);
    assert.equal(routing.streetSegmentKey(insideA), routing.streetSegmentKey(insideC));
    assert.notEqual(routing.streetSegmentKey(insideA), routing.streetSegmentKey(outsideB));
    assert.equal(routing.roadComponentKey(insideA), routing.roadComponentKey(outsideB));

    const path = routing.pathBetween(insideA, outsideB);
    assert.ok(path.length >= 4);
    assert.deepEqual(path[0], { lat: insideA.lat, lng: insideA.lng });
    assert.deepEqual(path.at(-1), { lat: outsideB.lat, lng: outsideB.lng });
    assert.ok(path.some(({ lat, lng }) => lat === -0.01 && lng === 0));
});

test('grade-separated ways do not connect merely because they reuse a crossing node ID', () => {
    const elements = [
        node('ground-west', 0, -0.001),
        node('crossing', 0, 0),
        node('ground-east', 0, 0.001),
        node('bridge-south', -0.001, 0),
        node('bridge-north', 0.001, 0),
        way('ground', ['ground-west', 'crossing', 'ground-east'], 'Ground Street'),
        way('bridge', ['bridge-south', 'crossing', 'bridge-north'], 'Bridge Avenue', {
            bridge: 'yes',
            layer: '1',
        }),
    ];
    const groundStop = { lat: 0, lng: -0.0008, street_name: 'Ground St' };
    const bridgeStop = { lat: -0.0008, lng: 0, street_name: 'Bridge Ave' };
    const routing = createRoadNetworkRoutingContext({
        elements,
        properties: [groundStop, bridgeStop],
    });

    assert.notEqual(routing.roadComponentKey(groundStop), routing.roadComponentKey(bridgeStop));
    const route = routing.routeBetween(groundStop, bridgeStop);
    assert.equal(route.usedFallback, true);
    assert.equal(route.reason, 'DISCONNECTED_ROAD_COMPONENTS');
});

test('a bridge remains connected to surface streets at its tagged endpoint', () => {
    const elements = [
        node('surface-start', 0, 0),
        node('bridge-start', 0, 0.001),
        node('bridge-end', 0, 0.002),
        way('surface', ['surface-start', 'bridge-start'], 'Approach Road'),
        way('bridge', ['bridge-start', 'bridge-end'], 'Approach Road', {
            bridge: 'yes',
            layer: '1',
        }),
    ];
    const left = { lat: 0, lng: 0.0002, street_name: 'Approach Rd' };
    const right = { lat: 0, lng: 0.0018, street_name: 'Approach Road' };
    const routing = createRoadNetworkRoutingContext({ elements });

    assert.equal(routing.roadComponentKey(left), routing.roadComponentKey(right));
    assert.equal(routing.routeBetween(left, right).usedFallback, false);
    assert.equal(routing.streetSegmentKey(left), routing.streetSegmentKey(right));
});

test('street-name snapping wins over a slightly nearer parallel road', () => {
    const elements = [
        node('close-left', 0, 0),
        node('close-right', 0, 0.002),
        node('named-left', 0.0005, 0),
        node('named-right', 0.0005, 0.002),
        way('close', ['close-left', 'close-right'], 'Close Road'),
        way('named', ['named-left', 'named-right'], 'Named Street'),
    ];
    const property = { lat: 0.0001, lng: 0.001, street_name: 'Named St' };
    const routing = createRoadNetworkRoutingContext({
        elements,
        maxStreetNameDetourMeters: 100,
    });
    const snap = routing.snapFor(property);

    assert.equal(snap.wayId, 'named');
    assert.equal(snap.basis, 'street_name');
    assert.ok(snap.distanceMeters > 40 && snap.distanceMeters < 50);
});

test('one-way direction is respected while a deterministic fallback remains finite', () => {
    const elements = [
        node('one', 0, 0),
        node('two', 0, 0.001),
        node('three', 0, 0.002),
        way('one-way', ['one', 'two', 'three'], 'One Way', { oneway: 'yes' }),
    ];
    const left = { lat: 0, lng: 0, street_name: 'One Way' };
    const right = { lat: 0, lng: 0.002, street_name: 'One Way' };
    const routing = createRoadNetworkRoutingContext({ elements });

    assert.equal(routing.routeBetween(left, right).usedFallback, false);
    const reverse = routing.routeBetween(right, left);
    assert.equal(reverse.usedFallback, true);
    assert.equal(reverse.reason, 'NO_DIRECTED_PATH');
    assert.ok(Number.isFinite(reverse.distanceMiles));
});

test('stable segment and component identities do not depend on element order', () => {
    const forward = createRoadNetworkRoutingContext({ elements: accessAreaElements });
    const reversed = createRoadNetworkRoutingContext({ elements: [...accessAreaElements].reverse() });

    assert.deepEqual(forward.snapFor(insideA), reversed.snapFor(insideA));
    assert.equal(forward.streetSegmentKey(insideA), reversed.streetSegmentKey(insideA));
    assert.equal(forward.roadComponentKey(outsideB), reversed.roadComponentKey(outsideB));
    assert.equal(
        forward.distanceBetween(insideA, outsideB),
        reversed.distanceBetween(insideA, outsideB),
    );
    assert.equal(
        roadNetworkRoutingInternals.edgeIdFor('9', '2'),
        'edge:2:9',
        'edge IDs remain compatible with Canvas topology IDs',
    );
});

test('spatial snapping is exactly equivalent to exhaustive snapping with fewer segment evaluations', () => {
    const elements = [];
    const roadCount = 50;
    const segmentsPerRoad = 50;
    for (let row = 0; row < roadCount; row += 1) {
        const nodeIds = [];
        for (let column = 0; column <= segmentsPerRoad; column += 1) {
            const id = `grid-${row}-${column}`;
            nodeIds.push(id);
            elements.push(node(id, 35 + row * 0.001, -112 + column * 0.0002));
        }
        elements.push(way(`row-${row}`, nodeIds, `Grid Road ${row}`));
    }
    elements.push(way(
        'grid-spine',
        Array.from({ length: roadCount }, (_, row) => `grid-${row}-0`),
        'Grid Spine',
    ));
    const properties = Array.from({ length: 80 }, (_, index) => {
        const row = (index * 7) % roadCount;
        const column = (index * 11) % segmentsPerRoad;
        return {
            id: `grid-property-${index}`,
            lat: 35 + row * 0.001 + (index % 2 ? 0.00004 : -0.00004),
            lng: -112 + (column + 0.35) * 0.0002 + index * 0.00000001,
            street_name: index % 5 === 0 ? '' : `Grid Road ${row}`,
        };
    });
    const indexed = createRoadNetworkRoutingContext({
        elements,
        properties,
        spatialCellDegrees: 0.002,
    });
    const exhaustive = createRoadNetworkRoutingContext({
        elements,
        properties,
        useSpatialIndex: false,
    });

    properties.forEach((property) => {
        assert.deepEqual(indexed.snapFor(property), exhaustive.snapFor(property));
        assert.equal(indexed.streetSegmentKey(property), exhaustive.streetSegmentKey(property));
        assert.equal(indexed.roadComponentKey(property), exhaustive.roadComponentKey(property));
    });
    [[0, 17], [9, 62], [31, 79]].forEach(([left, right]) => {
        assert.equal(
            indexed.distanceBetween(properties[left], properties[right]),
            exhaustive.distanceBetween(properties[left], properties[right]),
        );
        assert.deepEqual(
            indexed.pathBetween(properties[left], properties[right]),
            exhaustive.pathBetween(properties[left], properties[right]),
        );
    });
    assert.equal(
        exhaustive.diagnostics.snapCandidateEvaluationCount,
        properties.length * indexed.diagnostics.routableSegmentCount,
    );
    assert.ok(
        indexed.diagnostics.snapCandidateEvaluationCount
            < exhaustive.diagnostics.snapCandidateEvaluationCount / 3,
    );
    assert.equal(indexed.diagnostics.spatialIndexQueryCount, properties.length);
});

test('missing road data degrades to a deterministic aerial distance instead of failing', () => {
    const routing = createRoadNetworkRoutingContext({
        elements: [],
        properties: [insideA, insideC],
        fallbackRoadFactor: 1.4,
    });
    const first = routing.routeBetween(insideA, insideC);
    const second = routing.routeBetween(insideA, insideC);

    assert.equal(routing.status, 'unavailable');
    assert.equal(first.usedFallback, true);
    assert.equal(first.reason, 'NO_ROAD_NETWORK');
    assert.ok(Number.isFinite(first.distanceMiles));
    assert.ok(Math.abs(first.distanceMiles - aerialMiles(insideA, insideC) * 1.4) < 1e-8);
    assert.deepEqual(first, second);
    assert.equal(routing.roadComponentKey(insideA), null);
});
