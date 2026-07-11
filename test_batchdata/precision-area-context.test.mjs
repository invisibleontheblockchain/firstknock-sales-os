import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newestPrecisionAreaEntry,
  resolvePrecisionGenerationArea
} from '../src/lib/precisionAreaContext.js';

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
