import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_POLYGON_POINTS = 800;
const MAX_AREA_SQ_MI = 1_000;
const MAX_ZONES = 250;
const MAX_WORK_UNITS = 10000;
const MAX_SEGMENTS = 50000;
const MAX_JSON_BYTES = 8_000_000;
const MAX_CANVAS_INTERACTIVE_WORK_UNITS = 2_000;
const MAX_CANVAS_INTERACTIVE_COMPLEXITY = 180_000;
const PLANNING_METHODS = new Set(['street_workload', 'preview_only']);
const ASSIGNMENT_BASES = new Set(['street_work_unit_ids', 'legacy_geometry']);
const WORKLOAD_BASES = new Set(['street_length', 'street_length_plus_estimated_doors']);
const DIVISION_MODES = new Set(['selected_reps', 'area_count', 'street_workload_target']);

class HttpError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, message: string, details: any = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function isoInstant(value: unknown) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function betaGrantResolution(user: any) {
  const userId = String(user?.id || '');
  if (!userId) return { present: false, grant: null };
  const encoded = Deno.env.get('BETA_ACCESS_GRANTS');
  if (!encoded) return { present: false, grant: null };
  let document: any;
  try {
    document = JSON.parse(encoded);
  } catch {
    return { present: false, grant: null };
  }
  if (!document || Array.isArray(document) || document.version !== 1
    || !document.grants || Array.isArray(document.grants) || typeof document.grants !== 'object') {
    return { present: false, grant: null };
  }
  if (!Object.prototype.hasOwnProperty.call(document.grants, userId)) return { present: false, grant: null };
  const candidate = document.grants[userId];
  const startsAt = isoInstant(candidate?.starts_at);
  const endsAt = isoInstant(candidate?.ends_at);
  const precisionLimit = Number(candidate?.precision_limit);
  const canvasSeats = Number(candidate?.canvas_seats);
  if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object'
    || typeof candidate.grant_id !== 'string' || !candidate.grant_id.trim() || candidate.grant_id.length > 256
    || candidate.status !== 'active'
    || !Number.isInteger(precisionLimit) || precisionLimit < 1 || precisionLimit > 1_000
    || !Number.isInteger(canvasSeats) || canvasSeats < 1 || canvasSeats > 100
    || startsAt === null || endsAt === null || startsAt >= endsAt) {
    return { present: true, grant: null };
  }
  const now = Date.now();
  if (now < startsAt || now >= endsAt) return { present: true, grant: null };
  return {
    present: true,
    grant: {
      grant_id: candidate.grant_id,
      precision_limit: precisionLimit,
      canvas_seats: canvasSeats,
      starts_at: candidate.starts_at,
      ends_at: candidate.ends_at
    }
  };
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

function hasDraftCanvasEntitlement(user: any) {
  const accountRole = normalized(user?.role || user?.data?.role);
  if (accountRole === 'admin') return true;
  const beta = betaGrantResolution(user);
  if (beta.present) return Boolean(beta.grant);
  if (normalized(user?.subscription_tier) !== 'canvas') return false;
  const status = normalized(user?.subscription_status);
  if (status === 'active') return user?.subscription_paid_confirmed === true;
  return status === 'trialing' && user?.stripe_card_on_file_confirmed === true;
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_plan', `${field} is required or invalid.`);
  return result;
}

function optionalString(value: unknown, maxLength = 512) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value).trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_plan', 'A Canvas plan identifier is invalid.');
  return result;
}

function normalizePoint(point: any, field: string) {
  const lat = Number(point?.lat ?? point?.[0]);
  const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, 'invalid_plan', `${field} contains an invalid coordinate.`);
  }
  return { lat, lng };
}

function samePoint(left: any, right: any) {
  return Math.abs(left.lat - right.lat) < 0.0000001 && Math.abs(left.lng - right.lng) < 0.0000001;
}

function polygonAreaSqMi(points: any[]) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({ x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

function normalizePolygon(input: any, field = 'polygon', maxPoints = MAX_POLYGON_POINTS) {
  if (!Array.isArray(input) || input.length < 3 || input.length > maxPoints) {
    throw new HttpError(400, 'invalid_polygon', `${field} must contain 3-${maxPoints} points.`);
  }
  const points = input.map((point, index) => normalizePoint(point, `${field}[${index}]`));
  if (points.length > 3 && samePoint(points[0], points[points.length - 1])) points.pop();
  if (new Set(points.map((point) => `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`)).size < 3) {
    throw new HttpError(400, 'invalid_polygon', `${field} needs at least three unique points.`);
  }
  return points;
}

function normalizeIdList(value: any, field: string, maxItems = MAX_WORK_UNITS) {
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, 'invalid_plan', `${field} must be an array with at most ${maxItems} items.`);
  const ids = value.map((item, index) => requiredString(item, `${field}[${index}]`, 512));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate_reference', `${field} contains a duplicate identifier.`);
  return ids;
}

function sameIdSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => new Set(right).has(id));
}

function finiteNumber(value: any, field: string, minimum = 0, nullable = false) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) throw new HttpError(400, 'invalid_plan', `${field} must be a number of at least ${minimum}.`);
  return result;
}

function normalizeSegments(value: any, field: string) {
  if (!Array.isArray(value) || value.length < 1) throw new HttpError(400, 'invalid_plan', `${field} must contain road segments.`);
  return value.map((segment, index) => ({
    edge_id: optionalString(segment?.edge_id ?? segment?.edgeId, 512),
    start: normalizePoint(segment?.start, `${field}[${index}].start`),
    end: normalizePoint(segment?.end, `${field}[${index}].end`),
    street_names: normalizeIdList(segment?.street_names ?? segment?.streetNames ?? [], `${field}[${index}].street_names`, 25),
    length_meters: finiteNumber(segment?.length_meters ?? segment?.lengthMeters, `${field}[${index}].length_meters`)
  }));
}

function normalizeWorkUnits(input: any) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_WORK_UNITS) {
    throw new HttpError(400, 'invalid_plan', `work_units must contain 1-${MAX_WORK_UNITS} records.`);
  }
  let segmentCount = 0;
  const ids = new Set<string>();
  const units = input.map((unit, index) => {
    const id = requiredString(unit?.id ?? unit?.work_unit_id, `work_units[${index}].id`, 512);
    if (ids.has(id)) throw new HttpError(400, 'duplicate_work_unit', `Work unit ${id} appears more than once.`);
    ids.add(id);
    const segments = normalizeSegments(unit?.segments, `work_units[${index}].segments`);
    segmentCount += segments.length;
    return {
      id,
      kind: optionalString(unit?.kind, 128),
      protected: unit?.protected === true,
      street_names: normalizeIdList(unit?.street_names ?? unit?.streetNames ?? [], `work_units[${index}].street_names`, 100),
      neighbor_ids: normalizeIdList(unit?.neighbor_ids ?? unit?.neighborIds ?? [], `work_units[${index}].neighbor_ids`, MAX_WORK_UNITS),
      street_length_meters: finiteNumber(unit?.street_length_meters ?? unit?.streetLengthMeters, `work_units[${index}].street_length_meters`),
      segments
    };
  });
  if (segmentCount > MAX_SEGMENTS) throw new HttpError(413, 'plan_too_large', `work_units may contain at most ${MAX_SEGMENTS} road segments.`);
  for (const unit of units) {
    const unknown = unit.neighbor_ids.filter((id) => !ids.has(id));
    if (unknown.length) throw new HttpError(400, 'invalid_work_unit_graph', `Work unit ${unit.id} references an unknown neighbor.`);
  }
  return units;
}

function normalizeZoneParts(zone: any, index: number) {
  const rawParts = Array.isArray(zone?.parts) && zone.parts.length ? zone.parts : [zone?.geometry];
  const parts = rawParts.map((part, partIndex) => normalizePolygon(part, `zones[${index}].parts[${partIndex}]`, 5000));
  const geometry = normalizePolygon(zone?.geometry || parts[0], `zones[${index}].geometry`, 5000);
  return { geometry, parts };
}

function normalizeZones(input: any) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_ZONES) {
    throw new HttpError(400, 'invalid_plan', `zones must contain 1-${MAX_ZONES} records.`);
  }
  const zoneIds = new Set<string>();
  const zoneNumbers = new Set<number>();
  return input.map((zone, index) => {
    const zoneId = requiredString(zone?.zone_id, `zones[${index}].zone_id`, 512);
    const zoneNumber = Number(zone?.zone_number ?? index + 1);
    if (!Number.isInteger(zoneNumber) || zoneNumber < 1 || zoneIds.has(zoneId) || zoneNumbers.has(zoneNumber)) {
      throw new HttpError(400, 'duplicate_zone', 'Every zone needs a unique ID and positive zone number.');
    }
    zoneIds.add(zoneId);
    zoneNumbers.add(zoneNumber);
    const { geometry, parts } = normalizeZoneParts(zone, index);
    const workUnitIds = normalizeIdList(zone?.work_unit_ids ?? zone?.street_work_unit_ids ?? [], `zones[${index}].work_unit_ids`);
    return {
      zone_id: zoneId,
      zone_number: zoneNumber,
      name: optionalString(zone?.name, 200) || `Area ${zoneNumber}`,
      color: optionalString(zone?.color, 64),
      geometry,
      parts,
      center: zone?.center ? normalizePoint(zone.center, `zones[${index}].center`) : null,
      drop_point: zone?.drop_point ? normalizePoint(zone.drop_point, `zones[${index}].drop_point`) : null,
      assigned_team_member_id: optionalString(zone?.assigned_team_member_id, 256),
      work_unit_ids: workUnitIds,
      street_work_unit_ids: workUnitIds,
      street_length_meters: finiteNumber(zone?.street_length_meters ?? zone?.street_length_m, `zones[${index}].street_length_meters`),
      estimated_doors: finiteNumber(zone?.estimated_doors, `zones[${index}].estimated_doors`, 0, true),
      estimated_minutes: finiteNumber(zone?.estimated_minutes, `zones[${index}].estimated_minutes`, 0, true),
      workload_score: finiteNumber(zone?.workload_score ?? zone?.street_length_meters ?? zone?.street_length_m, `zones[${index}].workload_score`),
      workload_share: finiteNumber(zone?.workload_share, `zones[${index}].workload_share`, 0, true),
      protected_unit_over_target: zone?.protected_unit_over_target === true
    };
  });
}

function deriveQa(workUnits: any[], zones: any[], suppliedQa: any) {
  let clientQa: any = {};
  try {
    clientQa = JSON.parse(JSON.stringify(suppliedQa || {}));
  } catch {
    throw new HttpError(400, 'invalid_plan', 'qa must be valid JSON.');
  }
  const expectedIds = new Set(workUnits.map((unit) => unit.id));
  const counts = new Map<string, number>();
  for (const zone of zones) for (const id of zone.work_unit_ids) counts.set(id, (counts.get(id) || 0) + 1);
  const missingIds = [...expectedIds].filter((id) => !counts.has(id));
  const duplicateIds = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  const extraIds = [...counts.keys()].filter((id) => !expectedIds.has(id));
  const protectedIds = new Set(workUnits.filter((unit) => unit.protected).map((unit) => unit.id));
  const protectedUnitsIntact = [...protectedIds].every((id) => counts.get(id) === 1);
  const streetCoverageComplete = missingIds.length === 0 && extraIds.length === 0;
  const noDuplicateWorkUnits = duplicateIds.length === 0;
  const connectedZones = clientQa.connected_zones === true;
  const atomicWorkUnits = clientQa.atomic_work_units === true && streetCoverageComplete && noDuplicateWorkUnits;
  const culDeSacSplits = Math.max(0, Number(clientQa.cul_de_sac_splits) || 0);
  const workloadScores = zones.map((zone) => Number(zone.workload_score));
  const averageWorkload = workloadScores.length
    && workloadScores.every((score) => Number.isFinite(score) && score >= 0)
    ? workloadScores.reduce((sum, score) => sum + score, 0) / workloadScores.length
    : 0;
  const maxWorkloadDeviationPercent = averageWorkload > 0
    ? Math.round(Math.max(...workloadScores.map((score) => Math.abs(score - averageWorkload) / averageWorkload)) * 100)
    : null;
  return {
    ...clientQa,
    territory_source: 'street_work_units',
    street_coverage_complete: streetCoverageComplete,
    no_duplicate_work_units: noDuplicateWorkUnits,
    connected_zones: connectedZones,
    atomic_work_units: atomicWorkUnits,
    protected_units_intact: protectedUnitsIntact && clientQa.protected_units_intact === true,
    cul_de_sac_splits: culDeSacSplits,
    missing_work_unit_ids: missingIds.slice(0, 100),
    duplicate_work_unit_ids: duplicateIds.slice(0, 100),
    extra_work_unit_ids: extraIds.slice(0, 100),
    work_unit_count: workUnits.length,
    zone_count: zones.length,
    total_street_length_meters: Number(workUnits.reduce((sum, unit) => sum + unit.street_length_meters, 0).toFixed(2)),
    max_workload_deviation_percent: maxWorkloadDeviationPercent,
    deployable: streetCoverageComplete
      && noDuplicateWorkUnits
      && connectedZones
      && atomicWorkUnits
      && protectedUnitsIntact
      && clientQa.protected_units_intact === true
      && culDeSacSplits === 0
      && zones.length > 0
  };
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const data = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'Only managers can save Canvas drafts.' }, { status: 403 });
    if (!hasDraftCanvasEntitlement(user)) {
      return Response.json({ error: 'canvas_entitlement_required', message: 'An active or card-backed trial Canvas plan is required.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    if (JSON.stringify(body).length > MAX_JSON_BYTES) throw new HttpError(413, 'plan_too_large', 'Canvas draft payload is too large.');

    const sessionId = optionalString(body?.session_id, 256);
    let existing = null;
    let version = 1;
    if (sessionId) {
      existing = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
      if (!existing) throw new HttpError(404, 'session_not_found', 'Canvas session not found.');
      if (String(existing.manager_id || '') !== String(user.id || '')) throw new HttpError(403, 'forbidden', 'This Canvas session belongs to another manager.');
      if (existing.status !== 'draft') throw new HttpError(409, 'campaign_immutable', 'Active or closed Canvas campaigns are immutable. Create a new draft to rebalance.');
      const expectedVersion = Number(body?.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version || 1)) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed. Reload it before saving again.');
      }
      version = expectedVersion + 1;
    }

    const rawPlanningMethod = requiredString(body?.planning_method, 'planning_method', 64);
    const planningMethod = rawPlanningMethod === 'street_work_units' ? 'street_workload' : rawPlanningMethod;
    const assignmentBasis = requiredString(body?.assignment_basis, 'assignment_basis', 64);
    const legacySizingMode = body?.workload_basis === 'selected_reps' || body?.workload_basis === 'homes_per_area'
      ? body.workload_basis
      : null;
    const requestedDivisionMode = body?.division_mode === 'workload_size' ? 'street_workload_target' : body?.division_mode;
    const divisionMode = requiredString(requestedDivisionMode || (legacySizingMode === 'homes_per_area' ? 'area_count' : 'selected_reps'), 'division_mode', 64);
    const rawWorkloadBasis = legacySizingMode ? 'street_length' : requiredString(body?.workload_basis || 'street_length', 'workload_basis', 64);
    const workloadBasis = rawWorkloadBasis === 'estimated_doors' ? 'street_length_plus_estimated_doors' : rawWorkloadBasis;
    if (!PLANNING_METHODS.has(planningMethod) || !ASSIGNMENT_BASES.has(assignmentBasis)
      || !WORKLOAD_BASES.has(workloadBasis) || !DIVISION_MODES.has(divisionMode)) {
      throw new HttpError(400, 'invalid_plan', 'Unsupported Canvas planning method, assignment basis, division mode, or workload basis.');
    }

    const polygon = normalizePolygon(body?.polygon);
    const areaSqMi = polygonAreaSqMi(polygon);
    if (!Number.isFinite(areaSqMi) || areaSqMi <= 0 || areaSqMi > MAX_AREA_SQ_MI) {
      throw new HttpError(400, 'invalid_polygon', `polygon area must be greater than zero and at most ${MAX_AREA_SQ_MI} square miles.`);
    }
    const workUnits = normalizeWorkUnits(body?.work_units);
    const zones = normalizeZones(body?.zones);
    if (workUnits.length > MAX_CANVAS_INTERACTIVE_WORK_UNITS || zones.length * workUnits.length > MAX_CANVAS_INTERACTIVE_COMPLEXITY) {
      throw new HttpError(413, 'plan_too_complex', 'This street plan is too complex to save as one Canvas campaign. Draw a smaller work area or use fewer territories.');
    }
    const zoneAssigneeIds = zones.map((zone) => zone.assigned_team_member_id).filter(Boolean);
    const uniqueAssigneeIds = [...new Set(zoneAssigneeIds)];
    const suppliedTeamMemberIds = normalizeIdList(body?.selected_team_member_ids || [], 'selected_team_member_ids', MAX_ZONES);
    const selectedTeamMemberIds = suppliedTeamMemberIds.length ? suppliedTeamMemberIds : uniqueAssigneeIds;
    const everyZoneAssigned = zoneAssigneeIds.length === zones.length;
    const selectionMatches = everyZoneAssigned && sameIdSet(selectedTeamMemberIds, uniqueAssigneeIds);
    const oneToOneRequired = divisionMode === 'selected_reps';
    const selectedRepsOneToOne = oneToOneRequired
      ? zones.length === selectedTeamMemberIds.length && uniqueAssigneeIds.length === zones.length && selectionMatches
      : null;
    const assignmentContractSatisfied = oneToOneRequired ? selectedRepsOneToOne === true : selectionMatches;
    const suppliedTargetWorkload = finiteNumber(body?.target_workload, 'target_workload', 0, true);
    if (divisionMode === 'street_workload_target' && !(Number(suppliedTargetWorkload) > 0)) {
      throw new HttpError(400, 'invalid_plan', 'target_workload must be positive class-weighted street meters for street_workload_target planning.');
    }
    const targetWorkload = divisionMode === 'street_workload_target' ? suppliedTargetWorkload : null;
    const now = new Date().toISOString();
    const qa = {
      ...deriveQa(workUnits, zones, body?.qa),
      every_zone_assigned: everyZoneAssigned,
      selected_reps_one_to_one: selectedRepsOneToOne,
    };
    const workloadExceptionRequired = qa.max_workload_deviation_percent === null
      || Number(qa.max_workload_deviation_percent) > 25;
    const managerWorkloadExceptionAcknowledged = Number(qa.max_workload_deviation_percent) > 25
      && body?.qa?.manager_workload_exception_acknowledged === true;
    qa.manager_workload_exception_acknowledged = managerWorkloadExceptionAcknowledged;
    qa.manager_workload_exception_deviation_percent = qa.max_workload_deviation_percent;
    qa.manager_workload_exception_acknowledged_at = managerWorkloadExceptionAcknowledged ? now : null;
    qa.manager_workload_exception_acknowledged_by_user_id = managerWorkloadExceptionAcknowledged ? user.id : null;
    qa.deployable = qa.deployable
      && planningMethod === 'street_workload'
      && assignmentBasis === 'street_work_unit_ids'
      && workloadBasis === 'street_length'
      && everyZoneAssigned
      && selectionMatches
      && assignmentContractSatisfied
      && (!workloadExceptionRequired || managerWorkloadExceptionAcknowledged);

    const normalizedPlan = {
      session_name: optionalString(body?.session_name, 200) || 'Canvas Campaign',
      territory_model: 'street_territory_v1',
      polygon,
      rep_count: uniqueAssigneeIds.length,
      planning_method: planningMethod,
      assignment_basis: assignmentBasis,
      workload_basis: workloadBasis,
      division_mode: divisionMode,
      target_workload: targetWorkload,
      selected_team_member_ids: selectedTeamMemberIds,
      zones,
      work_units: workUnits,
      qa,
      algorithm_version: optionalString(body?.algorithm_version, 128),
      data_version: optionalString(body?.data_version, 256),
      manager_id: user.id,
      version
    };
    const planHash = await sha256(normalizedPlan);
    const record = {
      ...normalizedPlan,
      plan_hash: planHash,
      status: 'draft',
      draft_saved_at: now,
      deployed_at: null,
      deployed_by_user_id: null,
      deployment_idempotency_key: null,
      deployment_signature: null,
      deployment_qa: null,
      deployment_plan_version: null,
      lifecycle_state: null,
      lifecycle_evidence: null,
      closed_at: null,
      closed_by_user_id: null,
      close_action: null,
      close_idempotency_key: null
    };

    let saved;
    if (existing) {
      const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
        id: existing.id,
        manager_id: user.id,
        status: 'draft',
        version: Number(body.expected_version),
        plan_hash: existing.plan_hash
      }, { $set: record });
      if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed. Reload it before saving again.');
      }
      saved = await base44.entities.CanvasSession.get(existing.id).catch(() => null);
      if (!saved || saved.manager_id !== user.id || saved.plan_hash !== planHash || Number(saved.version) !== version) {
        throw new HttpError(503, 'canvas_draft_commit_unverified', 'The Canvas draft update could not be confirmed. Reload before retrying.');
      }
    } else {
      saved = await base44.asServiceRole.entities.CanvasSession.create(record);
    }

    return Response.json({
      success: true,
      session_id: saved.id,
      version,
      status: 'draft',
      plan_hash: planHash,
      area_sq_mi: Number(areaSqMi.toFixed(3)),
      qa
    });
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    console.error('[canvasSaveDraft]', error?.message || error);
    return Response.json({ error: 'canvas_draft_save_failed', message: 'Canvas draft could not be saved.' }, { status: 500 });
  }
});
