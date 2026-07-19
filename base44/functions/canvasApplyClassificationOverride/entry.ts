import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ROLES = new Set(['knock', 'transit_only', 'excluded', 'uncertain']);
const OPPORTUNITY_CLASSIFICATIONS = new Set(['likely', 'none', 'uncertain']);
const ACCESS_CLASSIFICATIONS = new Set(['permitted', 'restricted', 'uncertain']);
const GROUP_OVERRIDE_ROLES = new Set(['transit_only', 'excluded']);
const MAX_GROUP_OVERRIDE_UNITS = 250;
const MAX_REVISIONS = 500;
const ANALYSIS_IDENTITY_LEASE_MS = 60_000;
const ANALYSIS_IDENTITY_LEASE_WAIT_MS = 2_000;

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

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_override', `${field} is required or invalid.`);
  return result;
}

function optionalString(value: unknown, maxLength = 256) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value).trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_override', 'An override field is invalid.');
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

function mutationCommitted(mutation: any) {
  return mutation?.success === true && Number(mutation?.updated) === 1 && mutation?.has_more !== true;
}

function randomToken() {
  return `canvas_analysis_identity_${crypto.randomUUID().replaceAll('-', '')}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireAnalysisIdentityLease(base44: any, managerId: string) {
  const deadline = Date.now() + ANALYSIS_IDENTITY_LEASE_WAIT_MS;
  do {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const token = randomToken();
    const expiresAt = new Date(now + ANALYSIS_IDENTITY_LEASE_MS).toISOString();
    const mutation = await base44.asServiceRole.entities.User.updateMany({
      id: managerId,
      $or: [
        { canvas_analysis_identity_lock_token: '' },
        { canvas_analysis_identity_lock_token: null },
        { canvas_analysis_identity_lock_token: { $exists: false } },
        { canvas_analysis_identity_lock_expires_at: { $lte: nowIso } }
      ]
    }, { $set: {
      canvas_analysis_identity_lock_token: token,
      canvas_analysis_identity_lock_acquired_at: nowIso,
      canvas_analysis_identity_lock_expires_at: expiresAt
    } });
    if (mutationCommitted(mutation)) {
      const lockedUser = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
      if (!lockedUser || String(lockedUser.canvas_analysis_identity_lock_token || '') !== token
        || String(lockedUser.canvas_analysis_identity_lock_expires_at || '') !== expiresAt) {
        throw new HttpError(503, 'canvas_analysis_identity_lease_unverified', 'Canvas could not verify its tenant identity lease. No revision was committed.');
      }
      return { token };
    }
    if (Date.now() >= deadline) break;
    await sleep(50);
  } while (Date.now() <= deadline);
  throw new HttpError(409, 'canvas_analysis_identity_in_progress', 'Another Canvas classification identity is committing for this manager. Retry in a moment.');
}

async function releaseAnalysisIdentityLease(base44: any, managerId: string, lease: any) {
  if (!lease) return;
  await base44.asServiceRole.entities.User.updateMany({ id: managerId, canvas_analysis_identity_lock_token: lease.token }, {
    $unset: {
      canvas_analysis_identity_lock_token: '',
      canvas_analysis_identity_lock_acquired_at: '',
      canvas_analysis_identity_lock_expires_at: ''
    }
  }).catch(() => null);
}

function snapshotContent(snapshot: any) {
  return {
    schema_version: Number(snapshot?.schema_version), manager_id: snapshot?.manager_id, provider: snapshot?.provider,
    source_version: snapshot?.source_version, extraction_version: snapshot?.extraction_version, classifier_version: snapshot?.classifier_version,
    polygon: asArray(snapshot?.polygon), raw_evidence: snapshot?.raw_evidence || {}, analysis_result: snapshot?.analysis_result || {},
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
    schema_version: Number(revision.schema_version), manager_id: revision.manager_id, evidence_id: revision.evidence_id,
    parent_revision_id: revision.parent_revision_id || null, street_unit_id: revision.street_unit_id,
    original_opportunity_classification: revision.original_opportunity_classification || null,
    original_access_classification: revision.original_access_classification || null,
    override_opportunity_classification: revision.override_opportunity_classification || null,
    override_access_classification: revision.override_access_classification || null, override_canvas_role: revision.override_canvas_role,
    opportunity_low: Number(revision.opportunity_low || 0), opportunity_expected: Number(revision.opportunity_expected || 0), opportunity_high: Number(revision.opportunity_high || 0),
    opportunity_source: revision.opportunity_source || null, confidence: revision.confidence || null,
    override_reason: revision.override_reason, created_by_user_id: revision.created_by_user_id
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

async function loadOwnedSnapshot(base44: any, managerId: string, evidenceId: string) {
  const rows = asArray(await base44.asServiceRole.entities.CanvasAnalysisSnapshot.filter({ evidence_id: evidenceId, manager_id: managerId }, null, 2, 0));
  if (rows.length !== 1 || rows[0].manager_id !== managerId || rows[0].status !== 'complete') throw new HttpError(404, 'analysis_not_found', 'The Canvas evidence snapshot was not found in this manager tenant.');
  const calculated = await sha256(snapshotContent(rows[0]));
  if (rows[0].snapshot_hash !== calculated || rows[0].evidence_id !== `canvas_evidence_${calculated}`) throw new HttpError(409, 'evidence_integrity_failed', 'The Canvas evidence snapshot failed canonical content verification.');
  return rows[0];
}

async function loadParentChain(base44: any, managerId: string, evidenceId: string, revisionId: string | null) {
  const chain = [];
  const seen = new Set<string>();
  let cursor = revisionId;
  while (cursor) {
    if (seen.has(cursor) || chain.length >= MAX_REVISIONS) throw new HttpError(409, 'revision_chain_invalid', 'The parent revision chain is cyclic or exceeds its safe limit.');
    seen.add(cursor);
    const rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({ revision_id: cursor, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
    if (rows.length !== 1) throw new HttpError(404, 'parent_revision_not_found', 'The parent classification revision was not found in this manager tenant.');
    const calculated = await sha256(revisionContent(rows[0]));
    if (rows[0].revision_hash !== calculated || rows[0].revision_id !== `canvas_revision_${calculated}`) throw new HttpError(409, 'revision_integrity_failed', 'The parent classification revision failed canonical content verification.');
    revisionTargetUnitIds(rows[0]);
    chain.push(rows[0]);
    cursor = rows[0].parent_revision_id ? String(rows[0].parent_revision_id) : null;
  }
  return chain.reverse();
}

async function loadOrCreateRevisionHead(base44: any, managerId: string, evidenceId: string) {
  const headKey = `${managerId}:${evidenceId}`;
  let rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({ head_key: headKey, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
  if (!rows.length) {
    await base44.asServiceRole.entities.CanvasClassificationRevisionHead.create({ head_key: headKey, manager_id: managerId, evidence_id: evidenceId, head_revision_id: null, version: 0, updated_at: new Date().toISOString(), updated_by_user_id: managerId });
    rows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({ head_key: headKey, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
  }
  if (rows.length !== 1 || rows[0].manager_id !== managerId || rows[0].evidence_id !== evidenceId) throw new HttpError(409, 'revision_head_ambiguous', 'The classification revision head could not be resolved safely.');
  return rows[0];
}

function effectiveUnits(snapshot: any, revisions: any[]) {
  const units = asArray(snapshot?.analysis_result?.street_units).map((unit) => ({ ...unit }));
  const byId = new Map(units.map((unit) => [String(unit?.unit_id || unit?.id || ''), unit]));
  for (const revision of revisions) {
    for (const streetUnitId of revisionTargetUnitIds(revision)) {
      const unit: any = byId.get(streetUnitId);
      if (!unit) throw new HttpError(409, 'revision_unit_missing', 'A revision references a street unit outside the evidence snapshot.');
      unit.canvas_role = revision.override_canvas_role;
      unit.opportunity_classification = revision.override_opportunity_classification;
      unit.access_classification = revision.override_access_classification;
      unit.opportunity_low = Number(revision.opportunity_low || 0);
      unit.opportunity_expected = Number(revision.opportunity_expected || 0);
      unit.opportunity_high = Number(revision.opportunity_high || 0);
    }
  }
  return units;
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'manager_access_required' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const managerId = String(user.id);
    const evidenceId = requiredString(body?.evidence_id, 'evidence_id');
    const parentRevisionId = optionalString(body?.parent_revision_id);
    if (body?.street_unit_ids !== undefined && !Array.isArray(body.street_unit_ids)) throw new HttpError(400, 'invalid_override', 'street_unit_ids must be an array.');
    const requestedTargetIds = Array.isArray(body?.street_unit_ids) && body.street_unit_ids.length
      ? body.street_unit_ids.map((value: unknown) => requiredString(value, 'street_unit_ids', 512))
      : [requiredString(body?.street_unit_id, 'street_unit_id', 512)];
    const targetUnitIds = [...new Set(requestedTargetIds)].sort();
    if (targetUnitIds.length !== requestedTargetIds.length) throw new HttpError(400, 'duplicate_override_target', 'An atomic classification group cannot contain duplicate street units.');
    if (targetUnitIds.length > MAX_GROUP_OVERRIDE_UNITS) throw new HttpError(413, 'override_group_too_large', `An audited group may contain at most ${MAX_GROUP_OVERRIDE_UNITS} street units.`);
    const streetUnitId = targetUnitIds[0];
    if (body?.street_unit_id && !targetUnitIds.includes(String(body.street_unit_id).trim())) throw new HttpError(400, 'invalid_override', 'street_unit_id must be one of the atomic group targets.');
    const role = requiredString(body?.override_canvas_role, 'override_canvas_role', 64);
    const reason = requiredString(body?.override_reason, 'override_reason', 1000);
    if (!ROLES.has(role)) throw new HttpError(400, 'invalid_override', 'override_canvas_role is invalid.');
    const grouped = targetUnitIds.length > 1;
    if (grouped && !GROUP_OVERRIDE_ROLES.has(role)) throw new HttpError(422, 'group_override_role_invalid', 'Only Transit or Exclude decisions may be applied to an audited street group. Residential decisions require one explicit home count per street unit.');
    const snapshot = await loadOwnedSnapshot(base44, managerId, evidenceId);
    const identityLease = await acquireAnalysisIdentityLease(base44, managerId);
    try {
      const head = await loadOrCreateRevisionHead(base44, managerId, evidenceId);
      const parentChain = await loadParentChain(base44, managerId, evidenceId, parentRevisionId);
    if (parentChain.length >= MAX_REVISIONS) throw new HttpError(409, 'revision_chain_limit', 'This evidence snapshot has reached its classification revision limit. Start a new analysis before applying more decisions.');
    const unitsBefore = effectiveUnits(snapshot, parentChain);
    const byUnitId = new Map(unitsBefore.map((unit) => [String(unit?.unit_id || unit?.id || ''), unit]));
    const baseUnits = targetUnitIds.map((unitId) => byUnitId.get(unitId));
    if (baseUnits.some((unit) => !unit)) throw new HttpError(404, 'street_unit_not_found', 'A street unit does not belong to this evidence snapshot.');
    if (grouped && baseUnits.some((unit: any) => unit?.canvas_role !== 'uncertain')) throw new HttpError(422, 'group_override_requires_uncertain_units', 'Every target in an audited group must still be an unresolved amber street unit. Reload analysis before reviewing this group.');
    const baseUnit: any = baseUnits[0];
    const opportunityClassification = optionalString(body?.override_opportunity_classification, 64) || (role === 'knock' ? 'likely' : role === 'uncertain' ? 'uncertain' : 'none');
    const accessClassification = optionalString(body?.override_access_classification, 64) || (role === 'excluded' ? 'restricted' : role === 'uncertain' ? 'uncertain' : 'permitted');
    if (!OPPORTUNITY_CLASSIFICATIONS.has(opportunityClassification) || !ACCESS_CLASSIFICATIONS.has(accessClassification)) throw new HttpError(400, 'invalid_override', 'Opportunity or access classification is invalid.');
    const combinationAllowed = role === 'knock' && opportunityClassification === 'likely' && accessClassification === 'permitted'
      || role === 'transit_only' && opportunityClassification === 'none' && accessClassification === 'permitted'
      || role === 'excluded' && opportunityClassification === 'none' && ['permitted', 'restricted'].includes(accessClassification)
      || role === 'uncertain' && (opportunityClassification === 'uncertain' || accessClassification === 'uncertain');
    if (!combinationAllowed) throw new HttpError(422, 'invalid_classification_combination', 'The requested opportunity/access classifications cannot derive the requested Canvas role.');
    const suppliedExpected = body?.opportunity_count ?? body?.opportunity_expected;
    const expected = suppliedExpected === undefined || suppliedExpected === null || suppliedExpected === '' ? 0 : Number(suppliedExpected);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > 100_000 || role === 'knock' && expected < 1) {
      throw new HttpError(422, 'explicit_opportunity_required', 'A knock override requires an explicit positive whole-number opportunity count.');
    }
    const low = role === 'knock' ? Number(body?.opportunity_low ?? expected) : 0;
    const high = role === 'knock' ? Number(body?.opportunity_high ?? expected) : 0;
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low < 0 || low > expected || high < expected || high > 100_000) throw new HttpError(400, 'invalid_override', 'Opportunity range must satisfy 0 ≤ low ≤ expected ≤ high.');
    const originalClassifications = baseUnits.map((unit: any, index) => ({
      street_unit_id: targetUnitIds[index],
      opportunity_classification: unit?.opportunity_classification || null,
      access_classification: unit?.access_classification || null,
      canvas_role: unit?.canvas_role || null
    }));
    const content = revisionContent({
      schema_version: grouped ? 2 : 1, manager_id: managerId, evidence_id: evidenceId, parent_revision_id: parentRevisionId,
      street_unit_id: streetUnitId,
      ...(grouped ? { street_unit_ids: targetUnitIds, original_classifications: originalClassifications } : {}),
      original_opportunity_classification: baseUnit.opportunity_classification || null,
      original_access_classification: baseUnit.access_classification || null,
      override_opportunity_classification: opportunityClassification, override_access_classification: accessClassification,
      override_canvas_role: role, opportunity_low: low, opportunity_expected: expected, opportunity_high: high,
      opportunity_source: role === 'knock' ? 'manager_explicit' : 'manager_override', confidence: 'manager_explicit',
      override_reason: reason, created_by_user_id: managerId
    });
    const revisionHash = await sha256(content);
    const revisionId = `canvas_revision_${revisionHash}`;
    const currentHeadRevisionId = String(head.head_revision_id || '');
    if (currentHeadRevisionId !== String(parentRevisionId || '') && currentHeadRevisionId !== revisionId) {
      throw new HttpError(409, 'revision_head_conflict', 'The classification revision head changed. Reload analysis before applying this override.');
    }
    const existingRows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevision.filter({ revision_id: revisionId, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
    let idempotent = currentHeadRevisionId === revisionId;
    if (existingRows.length) {
      if (existingRows.length !== 1 || existingRows[0].revision_hash !== revisionHash) throw new HttpError(409, 'revision_identity_collision', 'A classification revision identifier collision was detected.');
      idempotent = true;
    } else {
      const created = await base44.asServiceRole.entities.CanvasClassificationRevision.create({ ...content, revision_id: revisionId, revision_hash: revisionHash, created_at: new Date().toISOString() });
      if (!created || created.revision_id !== revisionId || created.revision_hash !== revisionHash || created.manager_id !== managerId || created.evidence_id !== evidenceId) throw new HttpError(503, 'revision_commit_unverified', 'The classification revision could not be verified after creation.');
    }
    if (String(head.head_revision_id || '') !== revisionId) {
      const mutation = await base44.asServiceRole.entities.CanvasClassificationRevisionHead.updateMany({ id: head.id, head_key: head.head_key, manager_id: managerId, evidence_id: evidenceId, version: Number(head.version || 0) }, { $set: { head_revision_id: revisionId, version: Number(head.version || 0) + 1, updated_at: new Date().toISOString(), updated_by_user_id: managerId } });
      if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
        const latestRows = asArray(await base44.asServiceRole.entities.CanvasClassificationRevisionHead.filter({ head_key: head.head_key, manager_id: managerId, evidence_id: evidenceId }, null, 2, 0));
        if (latestRows.length !== 1 || latestRows[0].head_revision_id !== revisionId) throw new HttpError(409, 'revision_head_conflict', 'The classification revision head changed before this override committed. Reload analysis.');
        idempotent = true;
      }
    }
    const unitsAfter = effectiveUnits(snapshot, [...parentChain, { ...content, revision_id: revisionId }]);
    const unresolvedUnitCount = unitsAfter.filter((unit) => unit.canvas_role === 'uncertain').length;
    return Response.json({ success: true, idempotent, revision_id: revisionId, revision_hash: revisionHash, evidence_id: evidenceId, street_unit_id: streetUnitId, street_unit_ids: targetUnitIds, target_count: targetUnitIds.length, unresolved_unit_count: unresolvedUnitCount });
    } finally {
      await releaseAnalysisIdentityLease(base44, managerId, identityLease);
    }
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error('[canvasApplyClassificationOverride]', error?.message || error);
    return Response.json({ error: 'canvas_override_failed', message: 'The Canvas classification override was not saved.' }, { status: 503 });
  }
});
