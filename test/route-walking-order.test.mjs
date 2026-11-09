import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  KEPT_ON_FILE_STATUSES,
  isKeptOnFileStatus,
  splitWalkingOrder,
  walkingStopNumbers,
  walkingStops
} from '../src/components/logic/routeWalkingOrder.js';

const readSource = (relativePath) => fs.readFileSync(path.resolve(relativePath), 'utf8');
const stop = (hash, effective_status = 'ELIGIBLE') => ({ address_hash: hash, effective_status, lat: 30, lng: -81 });
const keyOf = (property) => property.address_hash;

// Field request (Flotilla, Nov 2026): Not Qualified doors stay on the route for
// the record but no longer clutter the middle of the walking order.
test('only Not Qualified is kept on file', () => {
  assert.deepEqual([...KEPT_ON_FILE_STATUSES], ['NOT_QUALIFIED']);
  assert.equal(isKeptOnFileStatus('NOT_QUALIFIED'), true);
  for (const status of ['ELIGIBLE', 'NO_ANSWER', 'CALLBACK', 'HARD_NO', 'SOLD', 'NOT_MOVED_IN', 'DM_NOT_HOME', 'QUALIFIED', undefined]) {
    assert.equal(isKeptOnFileStatus(status), false, String(status));
  }
});

test('the split keeps every stop and the saved order within each group', () => {
  const route = [
    stop('a'), stop('b', 'NOT_QUALIFIED'), stop('c', 'NO_ANSWER'),
    stop('d', 'NOT_QUALIFIED'), stop('e', 'HARD_NO'), stop('f', 'SOLD')
  ];
  const { walking, keptOnFile } = splitWalkingOrder(route);

  assert.deepEqual(walking.map(keyOf), ['a', 'c', 'e', 'f']);
  assert.deepEqual(keptOnFile.map(keyOf), ['b', 'd']);
  // Nothing is dropped from the route record.
  assert.equal(walking.length + keptOnFile.length, route.length);
});

test('stop numbers follow the walking order and skip kept-on-file doors', () => {
  const route = [stop('a'), stop('b', 'NOT_QUALIFIED'), stop('c'), stop('d', 'NOT_QUALIFIED'), stop('e')];
  const numbers = walkingStopNumbers(route, keyOf);

  assert.deepEqual([...numbers.entries()], [['a', 1], ['c', 2], ['e', 3]]);
  assert.equal(numbers.has('b'), false);
  assert.equal(numbers.has('d'), false);
});

test('a custom status reader drives the split (checklist statuses come from logs)', () => {
  const route = [stop('a'), stop('b'), stop('c')];
  const statuses = { b: 'NOT_QUALIFIED' };
  const numbers = walkingStopNumbers(route, keyOf, (property) => statuses[property.address_hash]);

  assert.deepEqual([...numbers.entries()], [['a', 1], ['c', 2]]);
  assert.deepEqual(walkingStops(route, (property) => statuses[property.address_hash]).map(keyOf), ['a', 'c']);
});

test('a door moved back to Todo rejoins the walking order', () => {
  // A cleared or bulk-moved decision changes the effective status, so the door
  // is walked again without any separate unpark step.
  const route = [stop('a'), stop('b', 'ELIGIBLE'), stop('c')];
  assert.deepEqual([...walkingStopNumbers(route, keyOf).keys()], ['a', 'b', 'c']);
});

test('missing and malformed input is safe', () => {
  assert.deepEqual(splitWalkingOrder(undefined), { walking: [], keptOnFile: [] });
  assert.deepEqual(splitWalkingOrder([null, undefined]), { walking: [], keptOnFile: [] });
  assert.equal(walkingStopNumbers([{ effective_status: 'ELIGIBLE' }], keyOf).size, 0);
});

test('Run Route lists kept-on-file doors in their own section without a stop number', () => {
  const repHome = readSource('src/pages/RepHome.jsx');
  const card = readSource('src/components/rep/PropertyCard.jsx');
  const map = readSource('src/components/rep/RepMapView.jsx');

  assert.match(repHome, /walkingStopNumbers\(routeProperties, getPropertySelectionKey\)/);
  assert.match(repHome, /splitWalkingOrder\(filteredProperties\)/);
  assert.match(repHome, /listedStops\.walking\.map\(/);
  assert.match(repHome, /listedStops\.keptOnFile\.map\(/);
  assert.match(repHome, /Not Qualified — kept on file \(\{listedStops\.keptOnFile\.length\}\)/);
  assert.match(repHome, /index=\{null\}/);
  // The stop sheet counts and numbers only the walking order.
  assert.match(repHome, /totalStops=\{walkingStopCount\}/);
  assert.match(repHome, /routePosition=\{selectedProperty \? walkingStopNumberByKey\.get\(/);
  // The next stop after a decision is never a kept-on-file door.
  assert.match(repHome, /if \(!walkingStopNumberByKey\.has\(getPropertySelectionKey\(routeProperties\[index\]\)\)\) continue;/);
  // Start Route already sends only open doors to Maps.
  assert.match(repHome, /const remainingNavigationStops = routeProperties\.filter\(\s*\(property\) => matchesTodoRouteFilters\(property, todoRouteTypes\)/);

  assert.match(card, /const hasStopNumber = Number\.isInteger\(index\) && index >= 0/);
  assert.match(map, /walkingStops\(properties \|\| \[\]\)\.filter\(isRoutePoint\)/);
});

test('the map checklist and manager map follow the same walking order', () => {
  const checklist = readSource('src/components/routes/RouteChecklist.jsx');
  const layers = readSource('src/components/map/ManagerMapLayers.jsx');

  assert.match(checklist, /const routePositionByHash = useMemo\(\(\) => walkingStopNumbers\(/);
  assert.match(checklist, /splitWalkingOrder\(filteredProperties, \(property\) => propertyStatuses\[property\.address_hash\]\)/);
  assert.match(checklist, /Not Qualified — kept on file \(\{listedStops\.keptOnFile\.length\}\)/);
  assert.match(checklist, /if \(!routePositionByHash\.has\(nextProperty\.address_hash \|\| nextProperty\.id\)\) continue;/);

  // The route line and stop numbers skip kept-on-file doors; their pins remain.
  assert.match(layers, /const doors = walkingStops\(properties \|\| \[\]\)\.filter\(isRenderableMapPoint\)/);
  assert.match(layers, /const walkingNumbers = walkingStopNumbers\(routePoints, pinKey\)/);
  assert.match(layers, /stopLabel: showLabel \? \{ text: stopNumber,/);
});
