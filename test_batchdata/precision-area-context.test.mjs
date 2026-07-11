import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newestPrecisionAreaEntry,
  reconcilePrecisionHistorySelection,
  resolvePrecisionGenerationArea,
  visiblePrecisionHistoryKey
} from '../src/lib/precisionAreaContext.js';
import { polygonIdentity } from '../src/components/map/polygonIdentity.js';

const square = [
  { lat: 33.45, lng: -112.08 },
  { lat: 33.45, lng: -112.04 },
  { lat: 33.49, lng: -112.04 },
  { lat: 33.49, lng: -112.08 }
];

test('a BatchData job owns the generation polygon when the UI polygon is absent', () => {
  const result = resolvePrecisionGenerationArea({ jobId: 'job-a', jobPolygon: square });
  assert.equal(result.error, null);
  assert.equal(result.exactJob, true);
  assert.equal(result.jobId, 'job-a');
  assert.deepEqual(result.polygon, square);
});

test('equivalent rotated UI geometry matches the immutable job polygon', () => {
  const rotated = [square[2], square[3], square[0], square[1]];
  const result = resolvePrecisionGenerationArea({
    jobId: 'job-a',
    jobPolygon: square,
    uiPolygon: rotated
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.polygon, square);
});

test('a different UI polygon fails closed instead of unscoping the job', () => {
  const different = square.map((point, index) => index === 1 ? { ...point, lng: -112.02 } : point);
  const result = resolvePrecisionGenerationArea({
    jobId: 'job-a',
    jobPolygon: square,
    uiPolygon: different
  });
  assert.equal(result.error, 'job_polygon_mismatch');
  assert.equal(result.exactJob, true);
  assert.deepEqual(result.polygon, square);
});

test('an active job without immutable geometry fails closed', () => {
  const result = resolvePrecisionGenerationArea({ jobId: 'job-a', uiPolygon: square });
  assert.equal(result.error, 'missing_job_polygon');
  assert.equal(result.polygon, null);
});

test('a non-job route may use the current UI polygon', () => {
  const result = resolvePrecisionGenerationArea({ uiPolygon: square });
  assert.equal(result.error, null);
  assert.equal(result.exactJob, false);
  assert.deepEqual(result.polygon, square);
});

test('newest area metadata wins regardless of input iteration order', () => {
  const older = { id: 'old', last_pull_date: '2026-07-01T12:00:00.000Z' };
  const newer = { id: 'new', last_pull_date: '2026-07-09T12:00:00.000Z' };
  assert.equal(newestPrecisionAreaEntry(newer, older).id, 'new');
  assert.equal(newestPrecisionAreaEntry(older, newer).id, 'new');
});

test('history omits canonical copies of the active polygon', () => {
  const rotated = [square[2], square[3], square[0], square[1]];
  const reversedAndClosed = [...square].reverse();
  reversedAndClosed.push(reversedAndClosed[0]);

  assert.equal(visiblePrecisionHistoryKey(square, rotated), null);
  assert.equal(visiblePrecisionHistoryKey(square, reversedAndClosed), null);
});

test('same-size distinct and partially overlapping history polygons remain visible', () => {
  const sameSizeDistinct = square.map((point) => ({ ...point, lng: point.lng + 0.08 }));
  const partialOverlap = square.map((point) => ({ ...point, lng: point.lng + 0.02 }));

  assert.equal(visiblePrecisionHistoryKey(sameSizeDistinct, square), polygonIdentity(sameSizeDistinct));
  assert.equal(visiblePrecisionHistoryKey(partialOverlap, square), polygonIdentity(partialOverlap));
});

test('history remains visible without an active polygon', () => {
  assert.equal(visiblePrecisionHistoryKey(square, null), polygonIdentity(square));
});

test('a selected history key clears when that polygon becomes current', () => {
  const selectedKey = polygonIdentity(square);
  const rotated = [square[1], square[2], square[3], square[0]];
  const other = square.map((point) => ({ ...point, lat: point.lat + 0.1 }));

  assert.equal(reconcilePrecisionHistorySelection(selectedKey, rotated), null);
  assert.equal(reconcilePrecisionHistorySelection(selectedKey, other), selectedKey);
  assert.equal(reconcilePrecisionHistorySelection(selectedKey, null), selectedKey);
});

test('changing the active polygon restores the old history area and hides the new one', () => {
  const nextPolygon = square.map((point) => ({ ...point, lat: point.lat + 0.1 }));

  assert.equal(visiblePrecisionHistoryKey(square, square), null);
  assert.equal(visiblePrecisionHistoryKey(nextPolygon, square), polygonIdentity(nextPolygon));
  assert.equal(visiblePrecisionHistoryKey(square, nextPolygon), polygonIdentity(square));
  assert.equal(visiblePrecisionHistoryKey(nextPolygon, nextPolygon), null);
});
