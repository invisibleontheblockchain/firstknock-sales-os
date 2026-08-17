import { canonicalStringify, sha256Hex } from './canonical.mjs';
import { ServiceError } from './errors.mjs';

const MAX_AREA_SQ_MI = 1_000;
const MAX_AREA_COUNT = 250;
const MAX_RESULT_BYTES = 5_500_000;
const MAX_TILE_COUNT = 5_000;
const JOB_ID_PATTERN = /^canvas_analysis_job_[a-f0-9]{64}$/;

function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(400, 'invalid_request', `${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ServiceError(400, 'invalid_request', `${label} contains unsupported fields.`);
}

function string(value, field, pattern = null, maxLength = 512) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > maxLength || (pattern && !pattern.test(result))) throw new ServiceError(400, 'invalid_request', `${field} is invalid.`);
  return result;
}

function polygon(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 10_000) throw new ServiceError(400, 'invalid_polygon', 'polygon requires 3-10,000 points.');
  const points = value.map((point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new ServiceError(400, 'invalid_polygon', 'polygon contains an invalid coordinate.');
    return { lat, lng };
  });
  if (new Set(points.map((point) => `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`)).size < 3) throw new ServiceError(400, 'invalid_polygon', 'polygon requires three distinct points.');
  return points;
}

function polygonAreaSqMi(points) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({ x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const next = projected[(index + 1) % projected.length];
    sum += projected[index].x * next.y - next.x * projected[index].y;
  }
  return Math.abs(sum) / 2;
}

function publicJob(job) {
  return {
    job_id: job.job_id,
    manager_id: job.manager_id,
    worker_job_id: job.worker_job_id,
    status: job.status,
    provider: job.provider,
    release_id: job.release_id,
    manifest_hash: job.manifest_hash,
    tile_scheme: job.tile_scheme,
    tile_ids: job.tile_ids,
    tile_count: job.tile_count,
    completed_tile_count: job.completed_tile_count,
    failed_tile_count: job.failed_tile_count,
    progress_pct: job.progress_pct,
    worker_status_cursor: job.worker_status_cursor,
    evidence_id: job.evidence_id,
    snapshot_hash: job.snapshot_hash,
    summary: job.summary || {},
    error_code: job.error_code,
    error_message: job.error_message,
    retryable: job.retryable !== false,
  };
}

function presentationRole(role) {
  return { opportunity: 'knock', transit: 'transit_only', uncertain: 'uncertain', excluded: 'excluded' }[role] || 'uncertain';
}

function buildAnalysisResult(job, release, stitched) {
  const roleCounts = { knock: 0, transit_only: 0, uncertain: 0, excluded: 0 };
  const opportunity = { low: 0, expected: 0, high: 0 };
  const classifiedProperties = (stitched.properties || []).map((property) => ({
    ...property,
    confidence_score: property.confidence.score,
    confidence_percent: Math.round(property.confidence.score * 100),
    classification_reasons: property.confidence.reasons,
  }));
  const propertyCounts = classifiedProperties.reduce((counts, property) => {
    counts[property.canvass_eligibility] += 1;
    return counts;
  }, { eligible: 0, excluded: 0, review: 0 });
  const propertyTotal = classifiedProperties.length;
  const propertySummary = {
    ...propertyCounts,
    total: propertyTotal,
    automatically_resolved: propertyCounts.eligible + propertyCounts.excluded,
    automatically_resolved_percent: propertyTotal ? Number((((propertyCounts.eligible + propertyCounts.excluded) / propertyTotal) * 100).toFixed(1)) : 0,
  };
  const eligibleDoorsByWorkUnit = new Map();
  for (const property of classifiedProperties) {
    if (property.canvass_eligibility !== 'eligible') continue;
    eligibleDoorsByWorkUnit.set(property.work_unit_id, (eligibleDoorsByWorkUnit.get(property.work_unit_id) || 0) + property.door_count);
  }
  const propertyWorkloadAuthority = classifiedProperties.length > 0;
  const classified = stitched.work_units.map((unit) => {
    const eligibleDoors = eligibleDoorsByWorkUnit.get(unit.work_unit_id) || 0;
    const role = propertyWorkloadAuthority ? (eligibleDoors ? 'knock' : 'transit_only') : presentationRole(unit.canvas_role);
    roleCounts[role] += 1;
    const range = propertyWorkloadAuthority
      ? (eligibleDoors ? { low: eligibleDoors, expected: eligibleDoors, high: eligibleDoors } : null)
      : unit.opportunity ? { low: unit.opportunity.min, expected: unit.opportunity.expected, high: unit.opportunity.max } : null;
    if (range) {
      opportunity.low += range.low;
      opportunity.expected += range.expected;
      opportunity.high += range.high;
    }
    return {
      ...unit,
      id: unit.work_unit_id,
      street_unit_id: unit.work_unit_id,
      evidence_role: unit.canvas_role,
      canvas_role: role,
      opportunity: range,
      workload_authority: propertyWorkloadAuthority ? 'eligible_properties' : 'street_only_fallback',
    };
  });
  return {
    schema_version: 1,
    release_id: release.release_id,
    requested_area_count: job.area_count,
    boundary: job.polygon,
    classified_street_units: classified,
    classified_properties: classifiedProperties,
    property_classification_summary: propertySummary,
    protected_groups: stitched.protected_groups,
    external_neighbor_ids: stitched.external_neighbor_ids,
    unresolved_unit_count: propertyTotal ? propertyCounts.review : roleCounts.uncertain,
    unresolved_property_count: propertyCounts.review,
    summary: {
      role_counts: roleCounts,
      property_classification: propertySummary,
      workload_authority: propertyWorkloadAuthority ? 'eligible_properties' : 'street_only_fallback',
      opportunity,
      selected_work_unit_count: classified.length,
      protected_group_count: stitched.protected_groups.length,
      external_neighbor_count: stitched.external_neighbor_ids.length,
    },
  };
}

function snapshotIdentity(snapshot) {
  return {
    purpose: 'firstknock-canvas-analysis-snapshot-v1',
    schema_version: snapshot.schema_version,
    manager_id: snapshot.manager_id,
    created_by_user_id: snapshot.created_by_user_id,
    created_at: snapshot.created_at,
    provider: snapshot.provider,
    release_id: snapshot.release_id,
    manifest_hash: snapshot.manifest_hash,
    source_versions: snapshot.source_versions,
    compiler_version: snapshot.compiler_version,
    classifier_version: snapshot.classifier_version,
    polygon: snapshot.polygon,
    tile_ids: snapshot.tile_ids,
    result_hash: snapshot.result_hash,
    result_bytes: snapshot.result_bytes,
    summary: snapshot.summary,
    source_attribution: snapshot.source_attribution,
    production_trusted: snapshot.production_trusted,
  };
}

export function buildSnapshot(job, release, stitched, createdAt) {
  const analysisResult = buildAnalysisResult(job, release, stitched);
  const resultJson = canonicalStringify(analysisResult);
  const resultBytes = Buffer.byteLength(resultJson, 'utf8');
  if (resultBytes > MAX_RESULT_BYTES) throw new ServiceError(413, 'analysis_result_too_large', 'Canvas analysis exceeds the 5.5 MB interactive result limit. Draw a smaller area.');
  const snapshot = {
    schema_version: 1,
    manager_id: job.manager_id,
    created_by_user_id: job.manager_id,
    created_at: createdAt,
    provider: job.provider,
    release_id: job.release_id,
    manifest_hash: job.manifest_hash,
    source_versions: release.source_versions,
    compiler_version: release.manifest.release.compiler_version,
    classifier_version: 'canvas-property-evidence-projection/2',
    polygon: job.polygon,
    tile_ids: [...job.tile_ids].sort(),
    analysis_result: analysisResult,
    result_hash: sha256Hex(resultJson),
    result_bytes: resultBytes,
    summary: analysisResult.summary,
    source_attribution: release.source_attribution,
    production_trusted: true,
  };
  snapshot.snapshot_hash = sha256Hex(canonicalStringify(snapshotIdentity(snapshot)));
  snapshot.evidence_id = `canvas_evidence_${snapshot.snapshot_hash}`;
  return snapshot;
}

export class CanvasAnalysisService {
  constructor({ store, evidenceRepository, clock = () => new Date() }) {
    this.store = store;
    this.evidence = evidenceRepository;
    this.clock = clock;
  }

  async start(input) {
    exactObject(input, new Set(['job_id', 'request_hash', 'manager_id', 'polygon', 'area_count', 'area_sq_mi', 'retry_failed_job']), 'analysis request');
    const managerId = string(input.manager_id, 'manager_id', null, 256);
    const jobId = string(input.job_id, 'job_id', JOB_ID_PATTERN, 96);
    const requestHash = string(input.request_hash, 'request_hash', /^[a-f0-9]{64}$/, 64);
    if (jobId !== `canvas_analysis_job_${requestHash}`) throw new ServiceError(400, 'job_identity_invalid', 'job_id does not match request_hash.');
    const points = polygon(input.polygon);
    const areaCount = Number(input.area_count);
    if (!Number.isInteger(areaCount) || areaCount < 1 || areaCount > MAX_AREA_COUNT) throw new ServiceError(400, 'invalid_area_count', 'area_count must be 1-250.');
    const expectedHash = sha256Hex(canonicalStringify({
      purpose: 'firstknock-canvas-analysis-v1', manager_id: managerId, polygon: points, area_count: areaCount,
    }));
    if (expectedHash !== requestHash) throw new ServiceError(400, 'job_identity_invalid', 'Canvas analysis request hash is invalid.');
    const calculatedArea = polygonAreaSqMi(points);
    if (!Number.isFinite(calculatedArea) || calculatedArea <= 0 || calculatedArea > MAX_AREA_SQ_MI
      || Math.abs(calculatedArea - Number(input.area_sq_mi)) > 0.001) {
      throw new ServiceError(400, 'invalid_polygon', 'Canvas boundary area is invalid or exceeds 1,000 square miles.');
    }
    const existing = await this.store.getJobByJobId(jobId, managerId);
    const retryFailed = input.retry_failed_job === true;
    if (existing && (!retryFailed || !['failed', 'cancelled'].includes(existing.status))) return publicJob(existing);
    if (existing) {
      const retried = await this.store.enqueue({ ...existing, updated_at: this.clock().toISOString() }, { retryFailed: true });
      return publicJob(retried);
    }
    const release = await this.evidence.loadManifest();
    const tiles = this.evidence.selectTiles(release, points);
    if (!tiles.length) throw new ServiceError(422, 'evidence_coverage_missing', 'No signed residential evidence covers this boundary.');
    if (tiles.length > MAX_TILE_COUNT) throw new ServiceError(413, 'analysis_tile_limit_exceeded', 'Canvas boundary intersects too many evidence tiles. Draw a smaller area.');
    const now = this.clock().toISOString();
    const job = await this.store.enqueue({
      job_id: jobId,
      request_hash: requestHash,
      manager_id: managerId,
      worker_job_id: `canvas_worker_${sha256Hex(jobId).slice(0, 48)}`,
      polygon: points,
      area_count: areaCount,
      area_sq_mi: Number(calculatedArea.toFixed(6)),
      provider: release.provider,
      release_id: release.release_id,
      manifest_hash: release.manifest_hash,
      tile_scheme: release.tile_scheme,
      tile_ids: tiles.map((tile) => tile.tile_id).sort(),
      tile_count: tiles.length,
      created_at: now,
      updated_at: now,
    });
    return publicJob(job);
  }

  async status(workerJobId, managerId, jobId) {
    const job = await this.store.getJobByWorkerId(string(workerJobId, 'worker_job_id', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/), string(managerId, 'manager_id', null, 256), string(jobId, 'job_id', JOB_ID_PATTERN, 96));
    if (!job) throw new ServiceError(404, 'analysis_job_not_found', 'Canvas analysis job was not found.');
    return publicJob(job);
  }

  async cancel(workerJobId, input) {
    exactObject(input, new Set(['job_id', 'manager_id']), 'cancel request');
    const managerId = string(input.manager_id, 'manager_id', null, 256);
    const jobId = string(input.job_id, 'job_id', JOB_ID_PATTERN, 96);
    const job = await this.store.cancel(string(workerJobId, 'worker_job_id', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/), managerId, jobId, this.clock().toISOString());
    if (!job) throw new ServiceError(404, 'analysis_job_not_found', 'Canvas analysis job was not found.');
    return publicJob(job);
  }

  async result(workerJobId, managerId, jobId) {
    const job = await this.store.getJobByWorkerId(string(workerJobId, 'worker_job_id', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/), string(managerId, 'manager_id', null, 256), string(jobId, 'job_id', JOB_ID_PATTERN, 96));
    if (!job) throw new ServiceError(404, 'analysis_job_not_found', 'Canvas analysis job was not found.');
    if (job.status !== 'complete' || !job.evidence_id) throw new ServiceError(409, 'analysis_not_complete', 'Canvas analysis is not complete.');
    const result = await this.store.getResultForJob(job.job_id, managerId);
    if (!result || result.evidence_id !== job.evidence_id || result.snapshot_hash !== job.snapshot_hash) throw new ServiceError(409, 'analysis_result_invalid', 'Canvas analysis result is unavailable or inconsistent.');
    return { ...publicJob(job), evidence: result.result_json };
  }

  async processNextJob(workerId = 'canvas-worker', leaseMs = 120_000) {
    const job = await this.store.claimNextJob(workerId, leaseMs);
    if (!job) return null;
    try {
      const release = await this.evidence.loadManifest();
      if (release.release_id !== job.release_id || release.manifest_hash !== job.manifest_hash
        || release.tile_scheme !== job.tile_scheme || release.provider !== job.provider) {
        throw new ServiceError(409, 'evidence_release_changed', 'Pinned Canvas evidence release is no longer available.');
      }
      const selectedEntries = this.evidence.selectTiles(release, job.polygon);
      const selectedIds = selectedEntries.map((entry) => entry.tile_id).sort();
      if (canonicalStringify(selectedIds) !== canonicalStringify([...job.tile_ids].sort())) {
        throw new ServiceError(409, 'evidence_tile_selection_changed', 'Pinned Canvas evidence tile selection changed.');
      }
      const stitched = await this.evidence.analyzeBoundary(
        release,
        job.polygon,
        async (completed, total) => {
          if (!await this.store.updateProgress(job, completed, total)) throw new ServiceError(409, 'analysis_cancelled', 'Canvas analysis was cancelled.');
        },
        () => this.store.isCancelled(job),
      );
      const finalizing = await this.store.markFinalizing(job);
      if (!finalizing) throw new ServiceError(409, 'analysis_cancelled', 'Canvas analysis was cancelled.');
      const snapshot = buildSnapshot(finalizing, release, stitched, this.clock().toISOString());
      const completed = await this.store.completeJob(finalizing, snapshot);
      return { job: publicJob(completed), snapshot };
    } catch (error) {
      const serviceError = error instanceof ServiceError ? error : new ServiceError(500, 'analysis_worker_failed', 'Canvas analysis worker failed.');
      await this.store.failJob(job, serviceError.code, serviceError.message.slice(0, 500), serviceError.retryable).catch(() => {});
      if (serviceError.code === 'analysis_cancelled') return null;
      return { error: serviceError };
    }
  }
}