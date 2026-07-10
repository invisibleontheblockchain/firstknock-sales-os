import { polygonIdentity } from '../components/map/polygonIdentity.js';

export function normalizePrecisionPolygon(value) {
  if (!Array.isArray(value)) return [];
  let points = value;
  if (Array.isArray(points[0]) && Array.isArray(points[0][0])) points = points[0];
  return points.map((point) => {
    if (Array.isArray(point)) {
      const lng = Number(point[0]);
      const lat = Number(point[1]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }
    const lat = Number(point?.lat ?? point?.latitude);
    const lng = Number(point?.lng ?? point?.lon ?? point?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }).filter(Boolean);
}

function validPolygon(polygon) {
  const normalized = normalizePrecisionPolygon(polygon);
  return polygonIdentity(normalized) ? normalized : null;
}

export function precisionFetchJobId(job = {}) {
  return job?.job_id || job?.fetch_job_id || job?.id || job?.jobId || null;
}

export function precisionFetchJobPolygon(job = {}) {
  const candidates = [
    job?.polygon,
    job?.submitted_polygon,
    job?.metadata?.polygon,
    job?.dry_run_metadata?.submitted_polygon,
    job?.request?.polygon,
    job?.request_payload?.polygon,
    job?.input?.polygon,
    job?.searchCriteria?.address?.geoLocationPolygon?.geoPoints,
    job?.request?.searchCriteria?.address?.geoLocationPolygon?.geoPoints,
    job?.request_payload?.searchCriteria?.address?.geoLocationPolygon?.geoPoints
  ];
  for (const candidate of candidates) {
    const normalized = validPolygon(candidate);
    if (normalized) return normalized;
  }
  return [];
}

/**
 * Resolve immutable geometry for one completed pull. A status response may be
 * rollout-skewed and omit polygon, so an exact, owner-matched FetchJob entity
 * is an allowed recovery source. Mutable canvas geometry is never accepted.
 */
export function resolveCompletedPrecisionPullContext({ status = {}, exactJob = null, expectedUserEmail = null } = {}) {
  const jobId = precisionFetchJobId(status);
  if (!jobId) return { jobId: null, polygon: [], polygonHash: null, source: null, error: 'missing_job_id' };

  const statusPolygon = precisionFetchJobPolygon(status);
  if (statusPolygon.length >= 3) {
    return {
      jobId: String(jobId),
      polygon: statusPolygon,
      polygonHash: status?.polygon_hash || null,
      source: 'status_response',
      error: null
    };
  }

  if (!exactJob) {
    return {
      jobId: String(jobId),
      polygon: [],
      polygonHash: status?.polygon_hash || null,
      source: null,
      error: 'missing_job_polygon'
    };
  }

  const exactJobId = precisionFetchJobId(exactJob);
  if (!exactJobId || String(exactJobId) !== String(jobId)) {
    return { jobId: String(jobId), polygon: [], polygonHash: null, source: null, error: 'job_id_mismatch' };
  }

  const expectedEmail = String(expectedUserEmail || '').trim().toLowerCase();
  const jobEmail = String(exactJob?.user_email || exactJob?.created_by || '').trim().toLowerCase();
  if (expectedEmail && jobEmail !== expectedEmail) {
    return { jobId: String(jobId), polygon: [], polygonHash: null, source: null, error: 'job_owner_mismatch' };
  }

  const statusHash = String(status?.polygon_hash || '').trim().toLowerCase();
  const entityHash = String(exactJob?.polygon_hash || '').trim().toLowerCase();
  if (statusHash && entityHash && statusHash !== entityHash) {
    return { jobId: String(jobId), polygon: [], polygonHash: null, source: null, error: 'job_polygon_hash_mismatch' };
  }

  const entityPolygon = precisionFetchJobPolygon(exactJob);
  if (entityPolygon.length < 3) {
    return {
      jobId: String(jobId),
      polygon: [],
      polygonHash: statusHash || entityHash || null,
      source: null,
      error: 'missing_job_polygon'
    };
  }

  return {
    jobId: String(jobId),
    polygon: entityPolygon,
    polygonHash: statusHash || entityHash || null,
    source: 'exact_fetch_job',
    error: null
  };
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
