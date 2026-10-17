import test from 'node:test';
import assert from 'node:assert/strict';
import { waypointOnRoad } from '../base44/shared/roadNameMatch.js';
import { roadNetworkRoutingInternals } from '../base44/shared/roadNetworkRouting.js';

const key = value => roadNetworkRoutingInternals.normalizeStreetName(value);

test('a /route junction label names every road meeting there; any of them is the expected road', () => {
    // Live: /nearest says "Broad Birch Drive"; /route at the same point says both.
    assert.equal(waypointOnRoad('Broad Birch Drive / Copper Pne Lane', 'Broad Birch Drive', key), true);
    assert.equal(waypointOnRoad('Broad Birch Drive / Copper Pne Lane', 'Copper Pne Ln', key), true);
    assert.equal(waypointOnRoad('Broad Birch Drive', 'Broad Birch Dr', key), true);
});

test('a different road, an empty label or an unnamed expectation is still rejected', () => {
    assert.equal(waypointOnRoad('Broad Birch Drive / Copper Pne Lane', 'Main Street', key), false);
    assert.equal(waypointOnRoad('', 'Broad Birch Drive', key), false);
    assert.equal(waypointOnRoad('Broad Birch Drive', '', key), false);
    // A slash inside a name without spaces is not a junction separator.
    assert.equal(waypointOnRoad('NC 16/Business', 'Business', key), false);
});
