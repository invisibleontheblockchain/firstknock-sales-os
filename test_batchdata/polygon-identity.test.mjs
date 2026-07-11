import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalPolygonVertices, polygonIdentity } from '../src/components/map/polygonIdentity.js';

const square = [
  { lat: 33.45, lng: -112.08 },
  { lat: 33.45, lng: -112.04 },
  { lat: 33.49, lng: -112.04 },
  { lat: 33.49, lng: -112.08 }
];

test('polygon identity ignores an explicit closing duplicate', () => {
  assert.equal(polygonIdentity(square), polygonIdentity([...square, square[0]]));
});

test('polygon identity is invariant to the starting vertex', () => {
  const rotated = [square[2], square[3], square[0], square[1]];
  assert.equal(polygonIdentity(square), polygonIdentity(rotated));
});

test('polygon identity is invariant to winding direction', () => {
  const reversedAndRotated = [square[1], square[0], square[3], square[2]];
  assert.equal(polygonIdentity(square), polygonIdentity(reversedAndRotated));
});

test('different polygons sharing their first point and vertex count have different identities', () => {
  const changedShape = [
    square[0],
    { lat: 33.45, lng: -112.02 },
    { lat: 33.49, lng: -112.02 },
    square[3]
  ];

  assert.notEqual(polygonIdentity(square), polygonIdentity(changedShape));
});

test('polygon identity accepts GeoJSON coordinate pairs and coordinate aliases', () => {
  const geoJsonRing = square.map(point => [point.lng, point.lat]);
  const aliased = square.map(point => ({ latitude: String(point.lat), longitude: String(point.lng) }));

  assert.equal(polygonIdentity(square), polygonIdentity(geoJsonRing));
  assert.equal(polygonIdentity(square), polygonIdentity(aliased));
});

test('canonicalization removes consecutive duplicate vertices and rejects invalid rings', () => {
  const withDuplicate = [square[0], square[1], square[1], square[2], square[3]];
  assert.deepEqual(canonicalPolygonVertices(square), canonicalPolygonVertices(withDuplicate));
  assert.equal(polygonIdentity([square[0], square[0], square[1]]), '');
});
