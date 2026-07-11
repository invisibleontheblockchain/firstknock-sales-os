import { polygonIdentity } from '../components/map/polygonIdentity.js';

function validPolygon(polygon) {
  return Array.isArray(polygon) && polygonIdentity(polygon) ? polygon : null;
}

/**
 * Resolve the only polygon that may be used for a route build.
 *
 * Once a BatchData job is active, its submitted polygon is authoritative. A
 * different polygon on the canvas is an error, never permission to fall back
 * to an account-wide/unscoped candidate query.
 */
export function resolvePrecisionGenerationArea({ jobId = null, jobPolygon = null, uiPolygon = null } = {}) {
  const normalizedUiPolygon = validPolygon(uiPolygon);
  if (!jobId) {
    return {
      exactJob: false,
      jobId: null,
      polygon: normalizedUiPolygon,
      polygonKey: normalizedUiPolygon ? polygonIdentity(normalizedUiPolygon) : null,
      error: null
    };
  }

  const normalizedJobPolygon = validPolygon(jobPolygon);
  if (!normalizedJobPolygon) {
    return {
      exactJob: true,
      jobId,
      polygon: null,
      polygonKey: null,
      error: 'missing_job_polygon'
    };
  }

  const jobPolygonKey = polygonIdentity(normalizedJobPolygon);
  const uiPolygonKey = normalizedUiPolygon ? polygonIdentity(normalizedUiPolygon) : null;
  if (uiPolygonKey && uiPolygonKey !== jobPolygonKey) {
    return {
      exactJob: true,
      jobId,
      polygon: normalizedJobPolygon,
      polygonKey: jobPolygonKey,
      uiPolygonKey,
      error: 'job_polygon_mismatch'
    };
  }

  return {
    exactJob: true,
    jobId,
    polygon: normalizedJobPolygon,
    polygonKey: jobPolygonKey,
    uiPolygonKey,
    error: null
  };
}

function entryTimestamp(entry) {
  if (!entry) return Number.NEGATIVE_INFINITY;
  const value = entry.last_pull_date || entry.date || entry.updated_at || entry.updated_date || entry.created_date;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Keep the newest metadata when saved routes, jobs, and browser history share a polygon. */
export function newestPrecisionAreaEntry(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;
  return entryTimestamp(candidate) > entryTimestamp(existing) ? candidate : existing;
}

/**
 * Return the history identity to render, unless the active draw layer already
 * owns the exact same canonical polygon.
 */
export function visiblePrecisionHistoryKey(historyPolygon, currentPolygon = null) {
  const historyKey = polygonIdentity(historyPolygon);
  if (!historyKey) return null;

  const currentKey = polygonIdentity(currentPolygon);
  return currentKey && currentKey === historyKey ? null : historyKey;
}

/** Clear a history selection after that polygon becomes the active draw layer. */
export function reconcilePrecisionHistorySelection(selectedKey, currentPolygon = null) {
  if (!selectedKey) return null;
  const currentKey = polygonIdentity(currentPolygon);
  return currentKey && currentKey === selectedKey ? null : selectedKey;
}
