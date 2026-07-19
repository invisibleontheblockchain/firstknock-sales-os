import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_REVISIONS = 500;
const MAX_GROUP_OVERRIDE_UNITS = 250;
const GROUP_OVERRIDE_ROLES = new Set(['transit_only', 'excluded']);

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function requiredId(value: unknown, field: string) {
  const result = String(value || '').trim();
  if (!result || result.length > 256 || !/^[A-Za-z0-9:_-]+$/.test(result)) throw new HttpError(400, 'invalid_analysis_request', `${field} is invalid.`);
  return result;
}

function asArray(value: any) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonicalize(value))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function snapshotContent(snapshot: any) {
  return {
    schema_version: Number(snapshot?.schema_version),
    manager_id: snapshot?.manager_id,
    provider: snapshot?.provider,
    source_version: snapshot?.source_version,
    extraction_version: snapshot?.extraction_version,
    classifier_version: snapshot?.classifier_version,
    polygon: asArray(snapshot?.polygon),
    raw_evidence: snapshot?.raw_evidence || {},
    analysis_result: snapshot?.analysis_result || {},
    source_attribution: snapshot?.source_attribution || '© OpenStreetMap contributors'
  };
}

function canonicalRevisionTargetIds(revision: any) {
  const source = Number(revision?.schema_version) >= 2 ? asArray(revision?.street_unit_ids) : [revision?.street_unit_id];
  return [...new Set(source.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function canonicalOriginalClassifications(revision: any) {
  return asArray(revision?.original_classifications).map((entry) => ({
    street_unit_id: String(entry?.street_unit_id || '').trim(),
    opportunity_classification: entry?.opportunity_classification || null,
    access_classification: entry?.access_classification || null,
    canvas_role: entry?.canvas_role || null
  })).filter((entry) => entry.street_unit_id).sort((left, right) => left.street_unit_id === right.street_unit_id ? 0 : left.street_unit_id < right.street_unit_id ? -1 : 1);
}

function revisionContent(revision: any) {
  const content: any = {
    schema_version: Number(revision?.schema_version),
    manager_id: revision?.manager_id,
    evidence_id: revision?.evidence_id,
    parent_revision_id: revision?.parent_revision_id || null,
    street_unit_id: revision?.street_unit_id,
    original_opportunity_classification: revision?.original_opportunity_classification || null,
    original_access_classification: revision?.original_access_classification || null,
    override_opportunity_classification: revision?.override_opportunity_classification || null,
    override_access_classification: revision?.override_access_classification || null,
    override_canvas_role: revision?.override_canvas_role,
    opportunity_low: Number(revision?.opportunity_low || 0),
    opportunity_expected: Number(revision?.opportunity_expected || 0),
    opportunity_high: Number(revision?.opportunity_high || 0),
    opportunity_source: revision?.opportunity_source || null,
    confidence: revision?.confidence || null,
    override_reason: revision?.override_reason,
    created_by_user_id: revision?.created_by_user_id
  };
  if (Number(revision?.schema_version) >= 2) {
    content.street_unit_ids = canonicalRevisionTargetIds(revision);
    content.original_classifications = canonicalOriginalClassifications(revision);
  }
  return content;
}

function revisionTargetUnitIds(revision: any) {
  const ids = canonicalRevisionTargetIds(revision);
  if (Number(revision?.schema_version) < 2) {
    if (ids.length !== 1 || ids[0] !== String(revision?.street_unit_id || '')) throw new HttpError(409, 'revision_targets_invalid', 'A single-unit classification revision has an invalid target.');
    return ids;
  }
  const originals = canonicalOriginalClassifications(revision);
  if (ids.length < 2 || ids.length > MAX_GROUP_OVERRIDE_UNITS || revision?.street_unit_id !== ids[0]
    || !GROUP_OVERRIDE_ROLES.has(String(revision?.override_canvas_role || ''))
    || originals.length !== ids.length
    || originals.some((entry, index) => entry.street_unit_id !== ids[index])) {
    throw new HttpError(409, 'revision_targets_invalid', 'An atomic classification group revision has invalid targets or audit metadata.');
  }
  return ids;
}

async function ownedSnapshot(base44: any, managerId: string, evidenceId: string) {
  const rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: managerId }, null, 2, 0));
  if (rows.length !== 1 || rows[0].manager_id !== managerId || rows[0].evidence_id !== evidenceId || rows[0].status !== 'complete') {
    throw new HttpError(404, 'analysis_not_found', 'The requested Canvas evidence snapshot was not found in this manager tenant.');
  }
  const snapshot = rows[0];
  const calculatedHash = await sha256(snapshotContent(snapshot));
  if (calculatedHash !== snapshot.snapshot_hash || snapshot.evidence_id !== `canvas_evidence_${calculatedHash}`) {
    throw new HttpError(409, 'evidence_integrity_failed', 'The Canvas evidence snapshot failed canonical content verification.');
  }
  return snapshot;
}

async function revisionChain(base44: any, managerId: string, evidenceId: string, headRevisionId: string | null) {
  if (!headRevisionId) return [];
  const chain: any[] = [];
  const seen = new Set<string>();
  let revisionId: string | null = headRevisionId;
  while (revisionId) {
    if (seen.has(revisionId) || chain.length >= MAX_REVISIONS) throw new HttpError(409, 'revision_chain_invalid', 'The Canvas classification revision chain is cyclic or exceeds its safe limit.');
    seen.add(revisionId);
    const rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({ revision_id: revisionId, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
    if (rows.length !== 1) throw new HttpError(404, 'revision_not_found', 'A pinned Canvas classification revision was not found in this manager tenant.');
    const revision = rows[0];
    const calculatedHash = await sha256(revisionContent(revision));
    if (calculatedHash !== revision.revision_hash || revision.revision_id !== `canvas_revision_${calculatedHash}` || revision.manager_id !== managerId || revision.evidence_id !== evidenceId) {
      throw new HttpError(409, 'revision_integrity_failed', 'A Canvas classification revision failed canonical content verification.');
    }
    revisionTargetUnitIds(revision);
    chain.push(revision);
    revisionId = revision.parent_revision_id ? String(revision.parent_revision_id) : null;
  }
  return chain.reverse();
}

async function latestRevisionId(base44: any, managerId: string, evidenceId: string) {
  const headKey = `${managerId}:${evidenceId}`;
  const rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({
    head_key: headKey,
    manager_id: managerId,
    evidence_id: evidenceId,
  }, null, 2, 0));
  if (rows.length > 1) throw new HttpError(409, 'revision_head_ambiguous', 'The Canvas classification revision head is ambiguous.');
  if (!rows.length) return null;
  if (rows[0].head_key !== headKey || rows[0].manager_id !== managerId || rows[0].evidence_id !== evidenceId) {
    throw new HttpError(409, 'revision_head_invalid', 'The Canvas classification revision head failed tenant verification.');
  }
  return rows[0].head_revision_id ? requiredId(rows[0].head_revision_id, 'head_revision_id') : null;
}

function applyRevisions(analysisResult: any, revisions: any[]) {
  const units = asArray(analysisResult?.street_units).map((unit) => ({ ...unit }));
  const byId = new Map(units.map((unit) => [String(unit?.unit_id || unit?.id || ''), unit]));
  for (const revision of revisions) {
    for (const streetUnitId of revisionTargetUnitIds(revision)) {
      const unit = byId.get(streetUnitId);
      if (!unit) throw new HttpError(409, 'revision_unit_missing', 'A classification revision references a street unit outside its evidence snapshot.');
      unit.opportunity_classification = revision.override_opportunity_classification || unit.opportunity_classification;
      unit.access_classification = revision.override_access_classification || unit.access_classification;
      unit.canvas_role = revision.override_canvas_role;
      unit.opportunity_low = Number(revision.opportunity_low || 0);
      unit.opportunity_expected = Number(revision.opportunity_expected || 0);
      unit.opportunity_high = Number(revision.opportunity_high || 0);
      unit.opportunity_source = revision.opportunity_source || unit.opportunity_source;
      unit.confidence = revision.confidence || unit.confidence;
      unit.revision_id = revision.revision_id;
    }
  }
  return {
    ...analysisResult,
    street_units: units,
    unresolved_unit_count: units.filter((unit) => unit.canvas_role === 'uncertain').length,
    opportunity_total_expected: units.reduce((sum, unit) => sum + Number(unit.opportunity_expected || 0), 0)
  };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'manager_access_required' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const evidenceId = requiredId(body?.evidence_id, 'evidence_id');
    const requestedRevisionId = body?.revision_id ? requiredId(body.revision_id, 'revision_id') : null;
    const revisionId = requestedRevisionId || body?.use_revision_head === false
      ? requestedRevisionId
      : await latestRevisionId(base44, String(user.id), evidenceId);
    const snapshot = await ownedSnapshot(base44, String(user.id), evidenceId);
    const revisions = await revisionChain(base44, String(user.id), evidenceId, revisionId);
    const effectiveAnalysis = applyRevisions(snapshot.analysis_result, revisions);
    return Response.json({
      success: true,
      evidence: {
        evidence_id: snapshot.evidence_id,
        snapshot_hash: snapshot.snapshot_hash,
        schema_version: Number(snapshot.schema_version),
        status: snapshot.status,
        provider: snapshot.provider,
        source_version: snapshot.source_version,
        extraction_version: snapshot.extraction_version,
        classifier_version: snapshot.classifier_version,
        polygon: snapshot.polygon,
        source_attribution: snapshot.source_attribution,
        analysis_result: effectiveAnalysis,
        ...(body?.include_raw_evidence === true ? { raw_evidence: snapshot.raw_evidence } : {})
      },
      revision_id: revisionId,
      revision_source: requestedRevisionId ? 'explicit' : body?.use_revision_head === false ? 'pinned_raw' : 'latest_head',
      revision_chain: revisions.map((revision) => ({ revision_id: revision.revision_id, parent_revision_id: revision.parent_revision_id || null, street_unit_id: revision.street_unit_id, street_unit_ids: revisionTargetUnitIds(revision), target_count: revisionTargetUnitIds(revision).length, override_canvas_role: revision.override_canvas_role, created_at: revision.created_at }))
    });
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error('[canvasGetAnalysis]', error?.message || error);
    return Response.json({ error: 'canvas_analysis_unavailable', message: 'Canvas analysis could not be loaded.' }, { status: 503 });
  }
});
