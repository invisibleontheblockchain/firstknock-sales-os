import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const MAX_REQUEST_BYTES = 96_000;
const MAX_INLINE_RESULT_BYTES = 5_500_000;
const MAX_GROUP_UNITS = 250;
const MAX_REVISION_DEPTH = 500;
const EVIDENCE_ID_PATTERN = /^canvas_evidence_[a-f0-9]{64}$/;
const REVISION_ID_PATTERN = /^canvas_revision_[a-f0-9]{64}$/;
const UNIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OVERRIDE_ROLES = new Set(["knock", "transit_only", "excluded", "uncertain"]);

class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
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

function requestId(value: unknown, field: string, pattern: RegExp, required = true) {
  if (!required && (value === undefined || value === null || value === "")) return null;
  const result = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(result)) throw new HttpError(400, "invalid_classification_override", `A valid ${field} is required.`);
  return result;
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
  if (!snapshot || String(snapshot.manager_id) !== managerId || !snapshot.analysis_result || typeof snapshot.analysis_result !== "object" || Array.isArray(snapshot.analysis_result)) {
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
  if (!ids.length || ids.length > MAX_GROUP_UNITS || new Set(ids).size !== ids.length
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
    ? {
      low: classification.opportunity_low,
      expected: classification.opportunity_expected,
      high: classification.opportunity_high,
    }
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
  const summary = {
    ...(result.summary && typeof result.summary === "object" && !Array.isArray(result.summary) ? result.summary : {}),
    canvas_role_counts: counts,
    role_counts: counts,
    opportunity_low: opportunity.low,
    opportunity_expected: opportunity.expected,
    opportunity_high: opportunity.high,
    opportunity_summary: opportunity,
    unresolved_unit_count: counts.uncertain,
  };
  return { counts, opportunity, summary };
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

async function loadHead(base44: any, managerId: string, evidenceId: string, headKey: string) {
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

async function ensureHead(base44: any, managerId: string, evidenceId: string, headKey: string, userId: string) {
  let head = await loadHead(base44, managerId, evidenceId, headKey);
  if (head) return head;
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.CanvasClassificationRevisionHead.create({
    head_key: headKey,
    manager_id: managerId,
    evidence_id: evidenceId,
    version: 0,
    updated_at: now,
    updated_by_user_id: userId,
  });
  head = await loadHead(base44, managerId, evidenceId, headKey);
  if (!head) throw new HttpError(503, "classification_revision_head_commit_unverified", "Canvas could not verify its classification history. Retry safely.");
  return head;
}

async function ensureRevision(base44: any, record: any, managerId: string, evidenceId: string) {
  const existingRows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({
    revision_id: record.revision_id,
    manager_id: managerId,
    evidence_id: evidenceId,
  }, "-created_at", 2));
  if (existingRows.length > 1) throw new HttpError(409, "duplicate_classification_revision", "Canvas classification history requires support review.");
  if (existingRows[0]) {
    await assertRevisionIntegrity(existingRows[0], managerId, evidenceId);
    if (canonicalJson(revisionIdentity(existingRows[0])) !== canonicalJson(revisionIdentity(record))) {
      throw new HttpError(409, "classification_revision_conflict", "Canvas classification revision identity is inconsistent.");
    }
    return existingRows[0];
  }
  const saved = await base44.asServiceRole.entities.CanvasClassificationRevision.create(record);
  if (!saved || saved.revision_id !== record.revision_id || String(saved.manager_id) !== managerId || saved.evidence_id !== evidenceId) {
    throw new HttpError(503, "classification_revision_commit_unverified", "Canvas could not verify the saved classification revision. Retry safely.");
  }
  await assertRevisionIntegrity(saved, managerId, evidenceId);
  const duplicates = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({
    revision_id: record.revision_id,
    manager_id: managerId,
    evidence_id: evidenceId,
  }, "-created_at", 2));
  if (duplicates.length !== 1) throw new HttpError(409, "duplicate_classification_revision", "Canvas classification history requires support review.");
  return saved;
}

function revisionResponse(revision: any, head: any, analysis: any, idempotent: boolean) {
  return {
    success: true,
    idempotent,
    evidence_id: revision.evidence_id,
    revision_id: revision.revision_id,
    revision_hash: revision.revision_hash,
    parent_revision_id: revision.parent_revision_id || null,
    head_version: Number(head.version),
    street_unit_ids: revision.street_unit_ids,
    override_canvas_role: revision.override_canvas_role,
    original_classifications: revision.original_classifications,
    summary: analysis.summary || {},
    unresolved_unit_count: Number(analysis.unresolved_unit_count || 0),
  };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "unauthorized", message: "Authentication required." }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: "manager_access_required", message: "Manager access required." }, { status: 403 });
    const managerId = String(user.id);
    const declaredLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new HttpError(413, "classification_override_too_large", "Canvas classification override is too large.");
    const body = await req.json().catch(() => ({}));
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, "classification_override_too_large", "Canvas classification override is too large.");
    const allowed = new Set(["evidence_id", "parent_revision_id", "street_unit_ids", "override_canvas_role", "opportunity_count", "override_reason"]);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) {
      throw new HttpError(400, "invalid_classification_override", "Canvas classification override contains unsupported fields.");
    }
    const evidenceId = requestId(body.evidence_id, "Canvas evidence ID", EVIDENCE_ID_PATTERN) as string;
    const parentRevisionId = requestId(body.parent_revision_id, "parent revision ID", REVISION_ID_PATTERN, false);
    const ids = (Array.isArray(body.street_unit_ids) ? body.street_unit_ids : []).map((value) => String(value || "").trim()).sort();
    if (!ids.length || ids.length > MAX_GROUP_UNITS || new Set(ids).size !== ids.length || ids.some((id) => !UNIT_ID_PATTERN.test(id))) {
      throw new HttpError(400, "invalid_classification_override", "Choose between 1 and 250 distinct Canvas street units.");
    }
    const role = normalized(body.override_canvas_role).replaceAll("-", "_");
    if (!OVERRIDE_ROLES.has(role) || (ids.length > 1 && !["transit_only", "excluded"].includes(role))) {
      throw new HttpError(400, "invalid_classification_override", "Audited groups may only be marked transit-only or excluded.");
    }
    const reason = typeof body.override_reason === "string" ? body.override_reason.trim() : "";
    if (reason.length < 10 || reason.length > 1_000 || /\u0000/.test(reason)) {
      throw new HttpError(400, "invalid_classification_override", "Override reason must contain 10 to 1,000 characters.");
    }
    const suppliedCount = body.opportunity_count;
    if (role === "knock" && (ids.length !== 1 || !Number.isSafeInteger(suppliedCount) || suppliedCount <= 0)) {
      throw new HttpError(400, "invalid_classification_override", "A single knockable street requires an explicit positive whole-number opportunity count.");
    }
    if (role !== "knock" && suppliedCount !== undefined && suppliedCount !== 0) {
      throw new HttpError(400, "invalid_classification_override", "Transit, excluded, and uncertain streets must use zero opportunity workload.");
    }
    const opportunityCount = role === "knock" ? suppliedCount : 0;

    const snapshots = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({
      evidence_id: evidenceId,
      manager_id: user.id,
    }, "-created_at", 2));
    if (snapshots.length > 1) throw new HttpError(409, "duplicate_analysis_snapshot", "Canvas evidence requires support review before it can be revised.");
    const snapshot = snapshots[0];
    if (!snapshot) throw new HttpError(404, "analysis_not_found", "Canvas residential evidence was not found.");
    await assertStoredSnapshotIntegrity(snapshot, managerId);

    const parentChain = await loadRevisionChain(base44, managerId, evidenceId, parentRevisionId);
    const parentAnalysis = await replayChain(snapshot, parentChain);
    const collection = classifiedUnits(parentAnalysis);
    const unitsById = new Map(collection.units.map((unit: any) => [unitId(unit), unit]));
    const originals = ids.map((id) => {
      const unit = unitsById.get(id);
      if (!unit) throw new HttpError(400, "classification_override_unit_not_found", "A selected street unit is not part of this evidence snapshot.", { street_unit_id: id });
      return originalClassification(unit);
    });
    const identity = {
      purpose: "firstknock-canvas-classification-revision-v1",
      schema_version: 1,
      manager_id: managerId,
      evidence_id: evidenceId,
      parent_revision_id: parentRevisionId,
      street_unit_ids: ids,
      original_classifications: originals,
      override_canvas_role: role,
      opportunity_low: opportunityCount,
      opportunity_expected: opportunityCount,
      opportunity_high: opportunityCount,
      override_reason: reason,
      created_by_user_id: managerId,
    };
    const revisionHash = await sha256(identity);
    const revisionId = `canvas_revision_${revisionHash}`;
    const record = {
      revision_id: revisionId,
      revision_hash: revisionHash,
      schema_version: 1,
      manager_id: managerId,
      evidence_id: evidenceId,
      ...(parentRevisionId ? { parent_revision_id: parentRevisionId } : {}),
      street_unit_ids: ids,
      original_classifications: originals,
      override_canvas_role: role,
      opportunity_low: opportunityCount,
      opportunity_expected: opportunityCount,
      opportunity_high: opportunityCount,
      override_reason: reason,
      created_by_user_id: managerId,
      created_at: new Date().toISOString(),
    };

    const headKey = await expectedHeadKey(managerId, evidenceId);
    let head = await ensureHead(base44, managerId, evidenceId, headKey, managerId);
    const currentRevisionId = head.head_revision_id ? String(head.head_revision_id) : null;
    if (currentRevisionId !== parentRevisionId) {
      if (currentRevisionId === revisionId) {
        const existing = await loadRevision(base44, managerId, evidenceId, revisionId);
        if (canonicalJson(revisionIdentity(existing)) === canonicalJson(identity)) {
          const analysis = replayRevision(parentAnalysis, existing);
          return Response.json(revisionResponse(existing, head, analysis, true));
        }
      }
      throw new HttpError(409, "classification_revision_stale_parent", "Canvas classifications changed. Reload the latest review before saving.", {
        expected_parent_revision_id: currentRevisionId,
        head_version: Number(head.version),
      });
    }

    const savedRevision = await ensureRevision(base44, record, managerId, evidenceId);
    const expectedHeadVersion = Number(head.version);
    const nextHeadVersion = expectedHeadVersion + 1;
    const now = new Date().toISOString();
    const mutation = await base44.asServiceRole.entities.CanvasClassificationRevisionHead.updateMany({
      id: head.id,
      head_key: headKey,
      manager_id: user.id,
      evidence_id: evidenceId,
      version: expectedHeadVersion,
    }, { $set: {
      head_revision_id: revisionId,
      version: nextHeadVersion,
      updated_at: now,
      updated_by_user_id: managerId,
    } });
    if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
      head = await loadHead(base44, managerId, evidenceId, headKey);
      if (head?.head_revision_id === revisionId) {
        const analysis = replayRevision(parentAnalysis, savedRevision);
        return Response.json(revisionResponse(savedRevision, head, analysis, true));
      }
      throw new HttpError(409, "classification_revision_stale_head", "Canvas classifications changed while saving. Reload the latest review.");
    }
    const committedHead = await base44.asServiceRole.entities.CanvasClassificationRevisionHead.get(head.id).catch(() => null);
    if (!committedHead || committedHead.head_key !== headKey || String(committedHead.manager_id) !== managerId
      || committedHead.evidence_id !== evidenceId || committedHead.head_revision_id !== revisionId || Number(committedHead.version) !== nextHeadVersion) {
      throw new HttpError(503, "classification_revision_head_commit_unverified", "Canvas could not verify the updated classification history. Retry safely.");
    }
    const analysis = replayRevision(parentAnalysis, savedRevision);
    return Response.json(revisionResponse(savedRevision, committedHead, analysis, false));
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    console.error("[canvasApplyClassificationOverride]", error?.name || "unexpected_error");
    return Response.json({ error: "canvas_classification_override_failed", message: "Canvas classification could not be revised." }, { status: 500 });
  }
});
