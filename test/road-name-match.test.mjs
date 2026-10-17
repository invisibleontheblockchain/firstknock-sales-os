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

test('spelling variants of one road match; different roads and highway systems do not', async () => {
    const { sameStreet } = await import('../base44/shared/roadNameMatch.js');
    for (const [left, right, same] of [
        ['Saddle Tree Rd', 'SADDLETREE RD', true],
        ['Saddle Tree Rd', 'Saddletree Road', true],
        ['Nc Highway 90 W', 'STATE HWY 90', true],
        ['Nc Highway 90 W', 'NC 90', true],
        ['Highway 90', 'NC 90', true],
        ['US Highway 421', 'US 421', true],
        ['State Road 1102', 'SR 1102', true],
        ['Nc Highway 90 W', 'NC 16', false],
        ['Nc Highway 90 W', 'US 90', false],
        ['US 421', 'NC 421', false],
        ['SR 1102', 'NC 1102', false],
        ['Main St', 'Maine St', false],
        ['N Main St', 'Main St', false],
        ['Rd 90', 'NC 90', false],
    ]) assert.equal(sameStreet(left, right, key), same, `${left} | ${right}`);
});
