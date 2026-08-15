import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const MAX_REQUEST_BYTES = 16_384;
const MAX_SERVICE_RESPONSE_BYTES = 6_000_000;
const MAX_INLINE_RESULT_BYTES = 5_500_000;
const MAX_TILE_IDS = 5_000;
const MAX_REVISION_DEPTH = 500;
const SERVICE_TIMEOUT_MS = 15_000;
const JOB_ID_PATTERN = /^canvas_analysis_job_[a-f0-9]{64}$/;
const EVIDENCE_ID_PATTERN = /^canvas_evidence_[a-f0-9]{64}$/;
const REVISION_ID_PATTERN = /^canvas_revision_[a-f0-9]{64}$/;
const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OVERRIDE_ROLES = new Set(["knock", "transit_only", "excluded", "uncertain"]);

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function normalized(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function serviceString(value: unknown, field: string, maxLength = 256, pattern?: RegExp) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maxLength || (pattern && !pattern.test(result))) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", `Canvas analysis returned an invalid ${field}.`);
  }
  return result;
}

function requestId(value: unknown, field: string, pattern: RegExp) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(result)) throw new HttpError(400, "invalid_analysis_identifier", `A valid Canvas ${field} is required.`);
  return result;
}

function configuration() {
  const rawUrl = String(Deno.env.get("CANVAS_ANALYSIS_SERVICE_URL") || "").trim();
  const token = String(Deno.env.get("CANVAS_ANALYSIS_SERVICE_TOKEN") || "").trim();
  if (!rawUrl || token.length < 32) throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  let url: URL;
  try {
    url = new URL(rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`);
  } catch {
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas residential analysis is not configured.");
  }
  return { url, token };
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value: any) {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value: any) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedJson(response: Response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SERVICE_RESPONSE_BYTES) throw new HttpError(502, "canvas_analysis_service_response_too_large", "Canvas analysis returned an oversized result.");
  if (!response.body) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned no response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SERVICE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(502, "canvas_analysis_service_response_too_large", "Canvas analysis returned an oversized result.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned invalid JSON.");
  }
}

async function fetchServiceResult(config: any, job: any) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(`v1/canvas/analyses/${encodeURIComponent(job.worker_job_id)}/result`, config.url), {
      method: "GET",
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${config.token}`,
        "x-firstknock-job-id": job.job_id,
        "x-firstknock-manager-id": String(job.manager_id),
      },
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error: any) {
    if (error?.name === "AbortError") throw new HttpError(504, "canvas_analysis_service_timeout", "Canvas analysis result timed out. Retry safely.");
    throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas analysis result is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  const payload = await readBoundedJson(response);
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) throw new HttpError(503, "canvas_analysis_service_unavailable", "Canvas analysis result is temporarily unavailable.");
    throw new HttpError(502, "canvas_analysis_service_rejected", "Canvas analysis service rejected the result request.");
  }
  return payload;
}

function validatePoint(point: any, field: string) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", `Canvas analysis returned an invalid ${field}.`);
  }
  return { lat, lng };
}

function snapshotIdentity(snapshot: any) {
  return {
    purpose: "firstknock-canvas-analysis-snapshot-v1",
    schema_version: Number(snapshot.schema_version),
    manager_id: String(snapshot.manager_id),
    created_by_user_id: String(snapshot.created_by_user_id),
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
    result_bytes: Number(snapshot.result_bytes),
    summary: snapshot.summary,
    source_attribution: snapshot.source_attribution,
    production_trusted: snapshot.production_trusted === true,
  };
}

async function assertStoredSnapshotIntegrity(snapshot: any, managerId: string) {
  if (!snapshot || String(snapshot.manager_id) !== managerId || !snapshot.analysis_result || typeof snapshot.analysis_result !== "object") {
    throw new HttpError(409, "analysis_snapshot_invalid", "Stored Canvas evidence failed integrity verification.");
  }
  const resultJson = canonicalJson(snapshot.analysis_result);
  const resultBytes = new TextEncoder().encode(resultJson).byteLength;
  const resultHash = await sha256(resultJson);
  const snapshotHash = await sha256(snapshotIdentity(snapshot));
  if (resultBytes > MAX_INLINE_RESULT_BYTES
    || resultBytes !== Number(snapshot.result_bytes)
    || resultHash !== snapshot.result_hash
    || snapshotHash !== snapshot.snapshot_hash
    || snapshot.evidence_id !== `canvas_evidence_${snapshotHash}`) {
    throw new HttpError(409, "analysis_snapshot_invalid", "Stored Canvas evidence failed integrity verification.");
  }
}

function canonicalRole(value: unknown) {
  const role = normalized(value).replaceAll("-", "_").replaceAll(" ", "_");
  const aliases: Record<string, string> = {
    opportunity: "knock",
    likely: "knock",
    residential: "knock",
    knock: "knock",
    transit: "transit_only",
    connector: "transit_only",
    transit_only: "transit_only",
    excluded: "excluded",
    commercial: "excluded",
    non_residential: "excluded",
    uncertain: "uncertain",
    unknown: "uncertain",
    amber: "uncertain",
  };
  const result = aliases[role];
  if (!result) throw new HttpError(409, "analysis_snapshot_invalid", "Canvas evidence contains an unsupported street classification.");
  return result;
}

function unitId(unit: any) {
  const result = String(unit?.id || unit?.unit_id || unit?.street_unit_id || unit?.work_unit_id || "").trim();
  if (!UNIT_ID_PATTERN.test(result)) throw new HttpError(409, "analysis_snapshot_invalid", "Canvas evidence contains an invalid street-unit identifier.");
  return result;
}

function finiteOpportunity(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function opportunityRange(unit: any) {
  const source = unit?.opportunity || unit?.residential_opportunity || {};
  const expected = finiteOpportunity(unit?.opportunity_expected ?? source.expected ?? source.expected_units);
  const low = finiteOpportunity(unit?.opportunity_low ?? source.low ?? source.min ?? source.low_units ?? expected);
  const high = finiteOpportunity(unit?.opportunity_high ?? source.high ?? source.max ?? source.high_units ?? expected);
  return {
    opportunity_low: low,
    opportunity_expected: expected,
    opportunity_high: high,
  };
}

function originalClassification(unit: any) {
  return {
    street_unit_id: unitId(unit),
    canvas_role: canonicalRole(unit?.canvas_role || unit?.role || unit?.classification || unit?.opportunity_classification),
    ...opportunityRange(unit),
  };
}

function classifiedUnits(result: any) {
  for (const key of ["classified_street_units", "classified_work_units", "street_units"]) {
    if (Array.isArray(result?.[key])) return { key, units: result[key] };
  }
  throw new HttpError(409, "analysis_snapshot_invalid", "Canvas evidence has no complete classified street-unit collection.");
}

function cloneJson(value: any) {
  return JSON.parse(JSON.stringify(value));
}

function revisionIdentity(revision: any) {
  return {
    purpose: "firstknock-canvas-classification-revision-v1",
    schema_version: 1,
    manager_id: String(revision.manager_id),
    evidence_id: String(revision.evidence_id),
    parent_revision_id: revision.parent_revision_id ? String(revision.parent_revision_id) : null,
    street_unit_ids: revision.street_unit_ids,
    original_classifications: revision.original_classifications,
    override_canvas_role: revision.override_canvas_role,
    opportunity_low: Number(revision.opportunity_low),
    opportunity_expected: Number(revision.opportunity_expected),
    opportunity_high: Number(revision.opportunity_high),
    override_reason: revision.override_reason,
    created_by_user_id: String(revision.created_by_user_id),
  };
}

function validateRevisionShape(revision: any, managerId: string, evidenceId: string) {
  if (!revision || String(revision.manager_id) !== managerId || revision.evidence_id !== evidenceId
    || String(revision.created_by_user_id) !== managerId
    || Number(revision.schema_version) !== 1 || !REVISION_ID_PATTERN.test(String(revision.revision_id || ""))
    || !/^[a-f0-9]{64}$/.test(String(revision.revision_hash || ""))) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision failed integrity verification.");
  }
  const rawIds = asArray(revision.street_unit_ids);
  const ids = rawIds.map(String);
  if (!ids.length || ids.length > 250 || new Set(ids).size !== ids.length
    || rawIds.some((id: unknown, index: number) => typeof id !== "string" || id !== ids[index])
    || ids.some((id) => !UNIT_ID_PATTERN.test(id)) || canonicalJson(ids) !== canonicalJson([...ids].sort())) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision has invalid street ownership.");
  }
  if (!OVERRIDE_ROLES.has(revision.override_canvas_role)
    || (ids.length > 1 && !["transit_only", "excluded"].includes(revision.override_canvas_role))) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision has an invalid role.");
  }
  const reason = typeof revision.override_reason === "string" ? revision.override_reason : "";
  const createdAt = new Date(revision.created_at);
  if (reason !== reason.trim() || reason.length < 10 || reason.length > 1_000
    || !Number.isFinite(createdAt.valueOf()) || createdAt.toISOString() !== revision.created_at) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision has invalid audit metadata.");
  }
  const originals = asArray(revision.original_classifications);
  if (originals.length !== ids.length || originals.some((item: any, index: number) => item?.street_unit_id !== ids[index])) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision has incomplete original classifications.");
  }
  for (const original of originals) {
    const originalRange = [original.opportunity_low, original.opportunity_expected, original.opportunity_high].map(Number);
    if (!OVERRIDE_ROLES.has(original.canvas_role) || originalRange.some((value) => !Number.isFinite(value) || value < 0)
      || originalRange[0] > originalRange[1] || originalRange[1] > originalRange[2]) {
      throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision has invalid original classifications.");
    }
  }
  const range = [revision.opportunity_low, revision.opportunity_expected, revision.opportunity_high].map(Number);
  if (range.some((value) => !Number.isFinite(value) || value < 0)
    || range[0] > range[1] || range[1] > range[2]
    || (revision.override_canvas_role === "knock" && (ids.length !== 1 || !Number.isSafeInteger(range[1]) || range[1] <= 0 || range.some((value) => value !== range[1])))
    || (revision.override_canvas_role !== "knock" && range.some((value) => value !== 0))) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision has invalid opportunity counts.");
  }
}

async function assertRevisionIntegrity(revision: any, managerId: string, evidenceId: string) {
  validateRevisionShape(revision, managerId, evidenceId);
  const hash = await sha256(revisionIdentity(revision));
  if (revision.revision_hash !== hash || revision.revision_id !== `canvas_revision_${hash}`) {
    throw new HttpError(409, "classification_revision_invalid", "Stored Canvas classification revision failed integrity verification.");
  }
  return revision;
}

async function loadRevision(base44: any, managerId: string, evidenceId: string, revisionId: string) {
  const rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({
    revision_id: revisionId,
    manager_id: managerId,
    evidence_id: evidenceId,
  }, "-created_at", 2));
  if (rows.length > 1) throw new HttpError(409, "duplicate_classification_revision", "Canvas classification history requires support review.");
  if (!rows[0]) throw new HttpError(404, "classification_revision_not_found", "Canvas classification revision was not found.");
  return assertRevisionIntegrity(rows[0], managerId, evidenceId);
}

async function loadRevisionChain(base44: any, managerId: string, evidenceId: string, targetRevisionId: string | null) {
  const reversed: any[] = [];
  const seen = new Set<string>();
  let cursor = targetRevisionId;
  while (cursor) {
    if (seen.has(cursor) || reversed.length >= MAX_REVISION_DEPTH) {
      throw new HttpError(409, "classification_revision_chain_invalid", "Canvas classification history is cyclic or too deep to verify.");
    }
    seen.add(cursor);
    const revision = await loadRevision(base44, managerId, evidenceId, cursor);
    reversed.push(revision);
    cursor = revision.parent_revision_id ? String(revision.parent_revision_id) : null;
  }
  return reversed.reverse();
}

function normalizedUnit(unit: any) {
  const classification = originalClassification(unit);
  const role = classification.canvas_role;
  const range = role === "knock"
    ? { low: classification.opportunity_low, expected: classification.opportunity_expected, high: classification.opportunity_high }
    : { low: 0, expected: 0, high: 0 };
  return {
    ...unit,
    id: unitId(unit),
    canvas_role: role,
    opportunity: role === "knock" ? range : null,
    opportunity_low: range.low,
    opportunity_expected: range.expected,
    opportunity_high: range.high,
  };
}

function summarizeAnalysis(result: any, units: any[]) {
  const counts = { knock: 0, transit_only: 0, excluded: 0, uncertain: 0 };
  const opportunity = { low: 0, expected: 0, high: 0 };
  for (const unit of units) {
    counts[unit.canvas_role as keyof typeof counts] += 1;
    if (unit.canvas_role === "knock") {
      opportunity.low += Number(unit.opportunity_low || 0);
      opportunity.expected += Number(unit.opportunity_expected || 0);
      opportunity.high += Number(unit.opportunity_high || 0);
    }
  }
  return {
    counts,
    summary: {
      ...(result.summary && typeof result.summary === "object" && !Array.isArray(result.summary) ? result.summary : {}),
      canvas_role_counts: counts,
      role_counts: counts,
      opportunity_low: opportunity.low,
      opportunity_expected: opportunity.expected,
      opportunity_high: opportunity.high,
      opportunity_summary: opportunity,
      unresolved_unit_count: counts.uncertain,
    },
  };
}

function replayRevision(result: any, revision: any) {
  const replayed = cloneJson(result);
  const collection = classifiedUnits(replayed);
  const units = collection.units.map(normalizedUnit);
  const byId = new Map(units.map((unit: any) => [unit.id, unit]));
  const actualOriginals = revision.street_unit_ids.map((id: string) => {
    const unit = byId.get(id);
    if (!unit) throw new HttpError(409, "classification_revision_target_missing", "A revised street unit is absent from its immutable evidence snapshot.");
    return originalClassification(unit);
  });
  if (canonicalJson(actualOriginals) !== canonicalJson(revision.original_classifications)) {
    throw new HttpError(409, "classification_revision_parent_mismatch", "Canvas classification history no longer matches its audited parent.");
  }
  for (const id of revision.street_unit_ids) {
    const unit: any = byId.get(id);
    unit.canvas_role = revision.override_canvas_role;
    unit.opportunity_low = Number(revision.opportunity_low);
    unit.opportunity_expected = Number(revision.opportunity_expected);
    unit.opportunity_high = Number(revision.opportunity_high);
    unit.opportunity = revision.override_canvas_role === "knock"
      ? { low: unit.opportunity_low, expected: unit.opportunity_expected, high: unit.opportunity_high }
      : null;
    unit.classification_revision_id = revision.revision_id;
  }
  replayed[collection.key] = units;
  replayed.classified_street_units = units;
  replayed.work_units = units.filter((unit: any) => unit.canvas_role === "knock");
  replayed.context_street_units = units.filter((unit: any) => unit.canvas_role !== "knock");
  replayed.uncertain_street_units = units.filter((unit: any) => unit.canvas_role === "uncertain");
  replayed.excluded_street_units = units.filter((unit: any) => unit.canvas_role === "excluded");
  replayed.transit_street_units = units.filter((unit: any) => unit.canvas_role === "transit_only");
  replayed.shared_transit_unit_ids = replayed.transit_street_units.map((unit: any) => unit.id).sort();
  replayed.opportunity_by_street_unit = Object.fromEntries(units.map((unit: any) => [unit.id, {
    low: unit.opportunity_low,
    expected: unit.opportunity_expected,
    high: unit.opportunity_high,
  }]));
  const summary = summarizeAnalysis(replayed, units);
  const structurallyReady = replayed.ok !== false && replayed.partition?.ok !== false;
  replayed.summary = summary.summary;
  replayed.unresolved_unit_count = summary.counts.uncertain;
  replayed.status = summary.counts.uncertain || !structurallyReady ? "needs_review" : "ready";
  replayed.deployable = structurallyReady && summary.counts.uncertain === 0;
  replayed.revision_id = revision.revision_id;
  return replayed;
}

async function replayChain(snapshot: any, revisions: any[]) {
  let result = cloneJson(snapshot.analysis_result);
  result.summary = {
    ...(snapshot.summary && typeof snapshot.summary === "object" && !Array.isArray(snapshot.summary) ? snapshot.summary : {}),
    ...(result.summary && typeof result.summary === "object" && !Array.isArray(result.summary) ? result.summary : {}),
  };
  for (const revision of revisions) result = replayRevision(result, revision);
  return result;
}

async function expectedHeadKey(managerId: string, evidenceId: string) {
  return `canvas_revision_head_${await sha256({
    purpose: "firstknock-canvas-classification-revision-head-v1",
    manager_id: managerId,
    evidence_id: evidenceId,
  })}`;
}

async function loadHead(base44: any, managerId: string, evidenceId: string) {
  const headKey = await expectedHeadKey(managerId, evidenceId);
  const rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({
    head_key: headKey,
    manager_id: managerId,
    evidence_id: evidenceId,
  }, "-updated_at", 2));
  if (rows.length > 1) throw new HttpError(409, "duplicate_classification_revision_head", "Canvas classification history requires support review.");
  const head = rows[0] || null;
  if (head && (!Number.isSafeInteger(Number(head.version)) || Number(head.version) < 0
    || (head.head_revision_id && !REVISION_ID_PATTERN.test(String(head.head_revision_id))))) {
    throw new HttpError(409, "classification_revision_head_invalid", "Canvas classification history failed integrity verification.");
  }
  return head;
}

async function resolveRevisionReplay(base44: any, snapshot: any, managerId: string, explicitRevisionId: string | null, useRevisionHead: boolean) {
  let targetRevisionId = explicitRevisionId;
  let headVersion: number | null = null;
  if (!targetRevisionId && useRevisionHead) {
    const head = await loadHead(base44, managerId, snapshot.evidence_id);
    targetRevisionId = head?.head_revision_id ? String(head.head_revision_id) : null;
    headVersion = head ? Number(head.version) : null;
  }
  if (!targetRevisionId) return null;
  const revisions = await loadRevisionChain(base44, managerId, snapshot.evidence_id, targetRevisionId);
  const analysisResult = await replayChain(snapshot, revisions);
  return {
    analysisResult,
    revisions,
    revision: revisions[revisions.length - 1],
    replayedResultHash: await sha256(canonicalJson(analysisResult)),
    headVersion,
  };
}

async function normalizeSnapshot(payload: any, job: any) {
  const envelope = payload?.job && typeof payload.job === "object" ? payload.job : payload;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned an invalid result envelope.");
  const returnedJobId = serviceString(envelope.job_id, "job ID", 96, JOB_ID_PATTERN);
  const returnedManagerId = serviceString(envelope.manager_id, "manager ID", 256);
  const returnedWorkerId = serviceString(envelope.worker_job_id, "worker job ID", 256, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
  if (returnedJobId !== job.job_id || returnedManagerId !== String(job.manager_id) || returnedWorkerId !== job.worker_job_id || envelope.status !== "complete") {
    throw new HttpError(502, "canvas_analysis_service_scope_mismatch", "Canvas analysis returned a result outside this workspace.");
  }
  const source = envelope.evidence && typeof envelope.evidence === "object" ? envelope.evidence : envelope.snapshot;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned no evidence snapshot.");
  const evidenceId = serviceString(source.evidence_id, "evidence ID", 96, EVIDENCE_ID_PATTERN);
  const snapshotHash = serviceString(source.snapshot_hash, "snapshot hash", 64, /^[a-f0-9]{64}$/);
  if (evidenceId !== job.evidence_id || snapshotHash !== job.snapshot_hash) throw new HttpError(502, "canvas_analysis_service_evidence_changed", "Canvas evidence changed after completion.");
  const provider = serviceString(source.provider, "provider", 128);
  const releaseId = serviceString(source.release_id, "release ID", 72, /^cer1_[a-f0-9]{64}$/);
  const manifestHash = serviceString(source.manifest_hash, "manifest hash", 64, /^[a-f0-9]{64}$/);
  if (provider !== job.provider || releaseId !== job.release_id || manifestHash !== job.manifest_hash) {
    throw new HttpError(502, "canvas_analysis_service_evidence_changed", "Canvas evidence source changed after the job started.");
  }
  const schemaVersion = Number(source.schema_version);
  if (schemaVersion !== 1) throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis returned an unsupported evidence schema.");
  const polygon = asArray(source.polygon).map((point: any, index: number) => validatePoint(point, `polygon point ${index}`));
  if (polygon.length < 3 || canonicalJson(polygon) !== canonicalJson(job.polygon)) throw new HttpError(502, "canvas_analysis_service_scope_mismatch", "Canvas analysis returned evidence for a different boundary.");
  const tileIds = asArray(source.tile_ids).map((id: unknown) => serviceString(id, "tile ID", 72, /^cet1_[a-f0-9]{64}$/)).sort();
  if (tileIds.length < 1 || tileIds.length > MAX_TILE_IDS || new Set(tileIds).size !== tileIds.length || canonicalJson(tileIds) !== canonicalJson([...job.tile_ids].sort())) {
    throw new HttpError(502, "canvas_analysis_service_evidence_changed", "Canvas analysis returned a different evidence tile set.");
  }
  if (!source.analysis_result || typeof source.analysis_result !== "object" || Array.isArray(source.analysis_result)) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas analysis did not return an inline classified result.");
  }
  const analysisResult = source.analysis_result;
  const resultJson = canonicalJson(analysisResult);
  const resultBytes = new TextEncoder().encode(resultJson).byteLength;
  if (resultBytes > MAX_INLINE_RESULT_BYTES || Number(source.result_bytes) !== resultBytes) {
    throw new HttpError(502, "canvas_analysis_service_response_too_large", "Canvas analysis returned an invalid or oversized classified result.");
  }
  const resultHash = serviceString(source.result_hash, "result hash", 64, /^[a-f0-9]{64}$/);
  if (await sha256(resultJson) !== resultHash) throw new HttpError(502, "canvas_analysis_service_digest_mismatch", "Canvas classified result failed integrity verification.");
  if (!source.source_versions || typeof source.source_versions !== "object" || Array.isArray(source.source_versions)
    || !source.summary || typeof source.summary !== "object" || Array.isArray(source.summary)) {
    throw new HttpError(502, "canvas_analysis_service_invalid_response", "Canvas evidence metadata is incomplete.");
  }
  const snapshot = {
    evidence_id: evidenceId,
    snapshot_hash: snapshotHash,
    schema_version: schemaVersion,
    manager_id: String(job.manager_id),
    created_by_user_id: String(job.created_by_user_id),
    created_at: serviceString(source.created_at, "creation time", 64),
    provider,
    release_id: releaseId,
    manifest_hash: manifestHash,
    source_versions: source.source_versions,
    compiler_version: serviceString(source.compiler_version, "compiler version", 128),
    classifier_version: serviceString(source.classifier_version, "classifier version", 128),
    polygon,
    tile_ids: tileIds,
    analysis_result: analysisResult,
    result_hash: resultHash,
    result_bytes: resultBytes,
    summary: source.summary,
    source_attribution: serviceString(source.source_attribution, "source attribution", 1_000),
    production_trusted: source.production_trusted === true,
  };
  const calculatedSnapshotHash = await sha256(snapshotIdentity(snapshot));
  if (calculatedSnapshotHash !== snapshot.snapshot_hash || snapshot.evidence_id !== `canvas_evidence_${calculatedSnapshotHash}`) {
    throw new HttpError(502, "canvas_analysis_service_digest_mismatch", "Canvas evidence snapshot failed integrity verification.");
  }
  return snapshot;
}

function publicSnapshot(snapshot: any, replay: any = null) {
  const publicSafeValue = (value: any): any => {
    if (Array.isArray(value)) return value.map(publicSafeValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(?:token|secret|credential|authorization|api.?key|provider.?url|manifest.?url|service.?url)/i.test(key))
      .map(([key, child]) => [key, publicSafeValue(child)]));
  };
  const analysisResult = replay?.analysisResult || snapshot.analysis_result;
  const summary = replay?.analysisResult?.summary || snapshot.summary || {};
  const evidence = {
    evidence_id: snapshot.evidence_id,
    snapshot_hash: snapshot.snapshot_hash,
    schema_version: Number(snapshot.schema_version),
    release_id: snapshot.release_id,
    analysis_result: publicSafeValue(analysisResult),
    summary: publicSafeValue(summary),
    source_attribution: snapshot.source_attribution || "",
    production_trusted: snapshot.production_trusted === true,
    ...(replay ? {
      revision_id: replay.revision.revision_id,
      revision_hash: replay.revision.revision_hash,
      parent_revision_id: replay.revision.parent_revision_id || null,
      revision_depth: replay.revisions.length,
      replayed_result_hash: replay.replayedResultHash,
      base_result_hash: snapshot.result_hash,
    } : {}),
  };
  return {
    success: true,
    status: "complete",
    evidence_id: evidence.evidence_id,
    snapshot_hash: evidence.snapshot_hash,
    release_id: evidence.release_id,
    evidence_schema_version: evidence.schema_version,
    production_trusted: evidence.production_trusted,
    source_attribution: evidence.source_attribution,
    analysis_result: evidence.analysis_result,
    summary: evidence.summary,
    ...(replay ? {
      revision_id: replay.revision.revision_id,
      revision_hash: replay.revision.revision_hash,
      parent_revision_id: replay.revision.parent_revision_id || null,
      revision_depth: replay.revisions.length,
      head_version: replay.headVersion,
      replayed_result_hash: replay.replayedResultHash,
      unresolved_unit_count: Number(replay.analysisResult.unresolved_unit_count || 0),
    } : {}),
    evidence,
  };
}

async function responseForSnapshot(base44: any, snapshot: any, managerId: string, revisionId: string | null, useRevisionHead: boolean) {
  await assertStoredSnapshotIntegrity(snapshot, managerId);
  const replay = await resolveRevisionReplay(base44, snapshot, managerId, revisionId, useRevisionHead);
  return Response.json(publicSnapshot(snapshot, replay));
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "unauthorized", message: "Authentication required." }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: "manager_access_required", message: "Manager access required." }, { status: 403 });
    const declaredLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new HttpError(413, "analysis_request_too_large", "Canvas analysis request is too large.");
    const body = await req.json().catch(() => ({}));
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, "analysis_request_too_large", "Canvas analysis request is too large.");
    const allowed = new Set(["job_id", "evidence_id", "revision_id", "use_revision_head"]);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) {
      throw new HttpError(400, "invalid_analysis_request", "Canvas analysis retrieval accepts only evidence or job identifiers.");
    }
    const revisionId = body.revision_id !== undefined && body.revision_id !== null && body.revision_id !== ""
      ? requestId(body.revision_id, "classification revision ID", REVISION_ID_PATTERN)
      : null;
    if (body.use_revision_head !== undefined && typeof body.use_revision_head !== "boolean") {
      throw new HttpError(400, "invalid_analysis_request", "use_revision_head must be true or false.");
    }
    const useRevisionHead = body.use_revision_head !== false;
    const suppliedEvidenceId = body.evidence_id ? requestId(body.evidence_id, "evidence ID", EVIDENCE_ID_PATTERN) : null;
    const suppliedJobId = body.job_id ? requestId(body.job_id, "analysis job ID", JOB_ID_PATTERN) : null;
    if ((suppliedEvidenceId ? 1 : 0) + (suppliedJobId ? 1 : 0) !== 1) {
      throw new HttpError(400, "invalid_analysis_request", "Supply exactly one Canvas evidence ID or analysis job ID.");
    }

    if (suppliedEvidenceId) {
      const snapshots = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({
        evidence_id: suppliedEvidenceId,
        manager_id: user.id,
      }, "-created_at", 2));
      if (snapshots.length > 1) throw new HttpError(409, "duplicate_analysis_snapshot", "Canvas evidence requires support review before it can be used.");
      if (snapshots[0]) {
        return await responseForSnapshot(base44, snapshots[0], String(user.id), revisionId, useRevisionHead);
      }
    }

    const jobFilter = suppliedJobId
      ? { job_id: suppliedJobId, manager_id: user.id }
      : { evidence_id: suppliedEvidenceId, manager_id: user.id };
    const jobs = asArray(await base44.asServiceRole.entities.CanvasAnalysisJob.filter(jobFilter, "-created_at", 2));
    if (jobs.length > 1) throw new HttpError(409, "duplicate_analysis_job", "Canvas analysis requires support review before it can continue.");
    const job = jobs[0];
    if (!job) throw new HttpError(404, "analysis_not_found", "Canvas residential evidence was not found.");
    if (job.status !== "complete" || !job.evidence_id || !job.snapshot_hash) {
      throw new HttpError(409, "analysis_not_complete", "Canvas residential evidence is not complete yet.");
    }
    if (suppliedEvidenceId && suppliedEvidenceId !== job.evidence_id) throw new HttpError(404, "analysis_not_found", "Canvas residential evidence was not found.");
    const locallyStored = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({
      evidence_id: job.evidence_id,
      manager_id: user.id,
    }, "-created_at", 2));
    if (locallyStored.length > 1) throw new HttpError(409, "duplicate_analysis_snapshot", "Canvas evidence requires support review before it can be used.");
    if (locallyStored[0]) {
      if (locallyStored[0].snapshot_hash !== job.snapshot_hash) throw new HttpError(409, "analysis_snapshot_conflict", "Canvas evidence identity is inconsistent and cannot be used.");
      return await responseForSnapshot(base44, locallyStored[0], String(user.id), revisionId, useRevisionHead);
    }
    if (!job.worker_job_id) throw new HttpError(503, "analysis_job_invalid", "Canvas analysis is missing its worker receipt.");
    const config = configuration();
    const snapshot = await normalizeSnapshot(await fetchServiceResult(config, job), job);
    const existingSnapshots = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({
      evidence_id: snapshot.evidence_id,
      manager_id: user.id,
    }, "-created_at", 2));
    if (existingSnapshots.length > 1) throw new HttpError(409, "duplicate_analysis_snapshot", "Canvas evidence requires support review before it can be used.");
    let saved = existingSnapshots[0] || null;
    if (saved && saved.snapshot_hash !== snapshot.snapshot_hash) throw new HttpError(409, "analysis_snapshot_conflict", "Canvas evidence identity is inconsistent and cannot be used.");
    if (!saved) saved = await base44.asServiceRole.entities.CanvasAnalysisSnapshot.create(snapshot);
    if (!saved || saved.evidence_id !== snapshot.evidence_id || saved.snapshot_hash !== snapshot.snapshot_hash || String(saved.manager_id) !== String(user.id)) {
      throw new HttpError(503, "analysis_snapshot_commit_unverified", "Canvas evidence could not be verified after saving. Retry safely.");
    }
    const duplicates = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({
      evidence_id: snapshot.evidence_id,
      manager_id: user.id,
    }, "-created_at", 2));
    if (duplicates.length !== 1) throw new HttpError(409, "duplicate_analysis_snapshot", "Canvas evidence requires support review before it can be used.");
    return await responseForSnapshot(base44, saved, String(user.id), revisionId, useRevisionHead);
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error("[canvasGetAnalysis]", error?.name || "unexpected_error");
    return Response.json({ error: "canvas_analysis_load_failed", message: "Canvas residential evidence could not be loaded." }, { status: 500 });
  }
});
