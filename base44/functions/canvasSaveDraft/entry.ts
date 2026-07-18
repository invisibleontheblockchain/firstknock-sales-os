import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_POLYGON_POINTS = 800;
const MAX_AREA_SQ_MI = 300;
const MAX_ZONES = 250;
const MAX_DOORS = 10000;
const MAX_JSON_BYTES = 8_000_000;
const PLANNING_METHODS = new Set(['street_work_units', 'preview_only']);
const ASSIGNMENT_BASES = new Set(['stable_door_ids', 'legacy_geometry']);
const WORKLOAD_BASES = new Set(['selected_reps', 'homes_per_area']);

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

function normalizedRole(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalizedRole(user?.app_role || user?.data?.app_role);
  const accountRole = normalizedRole(user?.role || user?.data?.role);
  return user?.is_owner === true || ['manager', 'admin'].includes(appRole) || ['manager', 'admin'].includes(accountRole);
}

// Saving a draft uses the server-authenticated billing cache. Production
// deployment performs a fresh Stripe verification in canvasDeployCampaign.
function hasDraftCanvasEntitlement(user: any) {
  const accountRole = normalizedRole(user?.role || user?.data?.role);
  if (accountRole === 'admin') return true;
  if (normalizedRole(user?.subscription_tier) !== 'canvas') return false;
  const status = normalizedRole(user?.subscription_status);
  if (status === 'active') return user?.subscription_paid_confirmed === true;
  return status === 'trialing' && user?.stripe_card_on_file_confirmed === true;
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || '').trim();
  if (!result) throw new HttpError(400, 'invalid_plan', `${field} is required.`);
  if (result.length > maxLength) throw new HttpError(400, 'invalid_plan', `${field} is too long.`);
  return result;
}

function optionalString(value: unknown, maxLength = 512) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value).trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_plan', 'A plan identifier is invalid.');
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

function polygonAreaSqMi(points: Array<{ lat: number; lng: number }>) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({
    x: (point.lng - origin.lng) * lngScale,
    y: (point.lat - origin.lat) * latScale
  }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

function normalizePolygon(input: any) {
  if (!Array.isArray(input) || input.length < 3 || input.length > MAX_POLYGON_POINTS) {
    throw new HttpError(400, 'invalid_polygon', `polygon must contain 3-${MAX_POLYGON_POINTS} points.`);
  }
  const points = input.map((point, index) => normalizePoint(point, `polygon[${index}]`));
  if (points.length > 3 && samePoint(points[0], points[points.length - 1])) points.pop();
  const unique = new Set(points.map((point) => `${point.lat.toFixed(7)}:${point.lng.toFixed(7)}`));
  if (unique.size < 3) throw new HttpError(400, 'invalid_polygon', 'polygon needs at least three unique points.');
  const areaSqMi = polygonAreaSqMi(points);
  if (!Number.isFinite(areaSqMi) || areaSqMi <= 0 || areaSqMi > MAX_AREA_SQ_MI) {
    throw new HttpError(400, 'invalid_polygon', `polygon area must be greater than zero and at most ${MAX_AREA_SQ_MI} square miles.`);
  }
  return { points, areaSqMi };
}

function safeJson(value: any, field: string, maxBytes = 1_000_000) {
  if (value === undefined || value === null) return null;
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new HttpError(400, 'invalid_plan', `${field} must be valid JSON.`);
  }
  if (encoded.length > maxBytes) throw new HttpError(413, 'plan_too_large', `${field} is too large.`);
  return JSON.parse(encoded);
}

function normalizeIdList(value: any, field: string) {
  if (!Array.isArray(value)) throw new HttpError(400, 'invalid_plan', `${field} must be an array.`);
  const ids = value.map((item, index) => requiredString(item, `${field}[${index}]`, 512));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate_door_reference', `${field} contains a duplicate identifier.`);
  return ids;
}

function sameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function normalizeDoors(input: any, planningMethod: string) {
  if (!Array.isArray(input) || input.length > MAX_DOORS) {
    throw new HttpError(400, 'invalid_plan', `doors must contain at most ${MAX_DOORS} records.`);
  }
  const seen = new Set<string>();
  return input.map((door, index) => {
    const stableDoorId = requiredString(door?.stable_door_id, `doors[${index}].stable_door_id`, 512);
    if (seen.has(stableDoorId)) throw new HttpError(400, 'duplicate_stable_door_id', `Door ${stableDoorId} appears more than once in doors.`);
    seen.add(stableDoorId);
    const location = normalizePoint(door, `doors[${index}]`);
    const workUnitId = optionalString(door?.work_unit_id, 512);
    if (planningMethod === 'street_work_units' && !workUnitId) {
      throw new HttpError(400, 'invalid_plan', `doors[${index}].work_unit_id is required for street_work_units.`);
    }
    return {
      stable_door_id: stableDoorId,
      address_hash: optionalString(door?.address_hash, 512),
      full_address: optionalString(door?.full_address, 1000),
      lat: location.lat,
      lng: location.lng,
      work_unit_id: workUnitId,
      zone_id: optionalString(door?.zone_id, 512),
      data_source: optionalString(door?.data_source, 128)
    };
  });
}

function normalizeZones(input: any) {
  if (!Array.isArray(input) || input.length > MAX_ZONES) {
    throw new HttpError(400, 'invalid_plan', `zones must contain at most ${MAX_ZONES} records.`);
  }
  const zoneIds = new Set<string>();
  const zoneNumbers = new Set<number>();
  return input.map((zone, index) => {
    const zoneId = requiredString(zone?.zone_id, `zones[${index}].zone_id`, 512);
    const zoneNumber = Number(zone?.zone_number ?? index + 1);
    if (!Number.isInteger(zoneNumber) || zoneNumber < 1) {
      throw new HttpError(400, 'invalid_plan', `zones[${index}].zone_number must be a positive integer.`);
    }
    if (zoneIds.has(zoneId) || zoneNumbers.has(zoneNumber)) {
      throw new HttpError(400, 'duplicate_zone', 'zone_id and zone_number must be unique within a plan.');
    }
    zoneIds.add(zoneId);
    zoneNumbers.add(zoneNumber);
    const estimatedMinutes = zone?.estimated_minutes === undefined || zone?.estimated_minutes === null
      ? null
      : Number(zone.estimated_minutes);
    if (estimatedMinutes !== null && (!Number.isFinite(estimatedMinutes) || estimatedMinutes < 0)) {
      throw new HttpError(400, 'invalid_plan', `zones[${index}].estimated_minutes must be non-negative.`);
    }
    return {
      zone_id: zoneId,
      zone_number: zoneNumber,
      geometry: safeJson(zone?.geometry, `zones[${index}].geometry`),
      parts: safeJson(zone?.parts, `zones[${index}].parts`),
      drop_point: zone?.drop_point ? normalizePoint(zone.drop_point, `zones[${index}].drop_point`) : null,
      assigned_team_member_id: optionalString(zone?.assigned_team_member_id, 256),
      stable_door_ids: normalizeIdList(zone?.stable_door_ids || [], `zones[${index}].stable_door_ids`),
      work_unit_ids: normalizeIdList(zone?.work_unit_ids || [], `zones[${index}].work_unit_ids`),
      estimated_minutes: estimatedMinutes
    };
  });
}

function deriveQa(doors: any[], zones: any[], targetHomes: number, suppliedQa: any) {
  const doorIds = new Set(doors.map((door) => door.stable_door_id));
  const counts = new Map<string, number>();
  for (const zone of zones) {
    for (const doorId of zone.stable_door_ids) counts.set(doorId, (counts.get(doorId) || 0) + 1);
  }
  const missingDoorIds = [...doorIds].filter((doorId) => !counts.has(doorId));
  const duplicateDoorIds = [...counts].filter(([, count]) => count > 1).map(([doorId]) => doorId);
  const extraDoorIds = [...counts.keys()].filter((doorId) => !doorIds.has(doorId));
  const zoneMismatchDoorIds = doors
    .filter((door) => door.zone_id && !zones.some((zone) => zone.zone_id === door.zone_id && zone.stable_door_ids.includes(door.stable_door_id)))
    .map((door) => door.stable_door_id);
  const doorUnitIds = new Set(doors.map((door) => door.work_unit_id).filter(Boolean));
  const unitZoneCounts = new Map<string, number>();
  const unitZoneById = new Map<string, string>();
  for (const zone of zones) {
    for (const unitId of zone.work_unit_ids) {
      unitZoneCounts.set(unitId, (unitZoneCounts.get(unitId) || 0) + 1);
      if (!unitZoneById.has(unitId)) unitZoneById.set(unitId, zone.zone_id);
    }
  }
  const missingWorkUnitIds = [...doorUnitIds].filter((unitId) => !unitZoneCounts.has(unitId));
  const duplicateWorkUnitIds = [...unitZoneCounts].filter(([, count]) => count !== 1).map(([unitId]) => unitId);
  const extraWorkUnitIds = [...unitZoneCounts.keys()].filter((unitId) => !doorUnitIds.has(unitId));
  const doorZoneById = new Map<string, string>();
  for (const zone of zones) for (const doorId of zone.stable_door_ids) doorZoneById.set(doorId, zone.zone_id);
  const workUnitZoneMismatchDoorIds = doors
    .filter((door) => door.work_unit_id && doorZoneById.get(door.stable_door_id) !== unitZoneById.get(door.work_unit_id))
    .map((door) => door.stable_door_id);
  const clientQa = safeJson(suppliedQa || {}, 'qa', 250_000) || {};
  const coverageComplete = missingDoorIds.length === 0 && extraDoorIds.length === 0 && zoneMismatchDoorIds.length === 0;
  const noDuplicateDoors = duplicateDoorIds.length === 0;
  const targetMatches = targetHomes === doors.length;
  const workUnitsIntact = missingWorkUnitIds.length === 0
    && duplicateWorkUnitIds.length === 0
    && extraWorkUnitIds.length === 0
    && workUnitZoneMismatchDoorIds.length === 0;
  const requiredGeneratorGates = clientQa.connected_zones === true
    && clientQa.atomic_work_units === true
    && clientQa.data_quality_status === 'verified';
  return {
    ...clientQa,
    coverage_complete: coverageComplete,
    no_missing_doors: missingDoorIds.length === 0,
    no_duplicate_doors: noDuplicateDoors,
    target_matches: targetMatches,
    work_units_intact: workUnitsIntact,
    missing_door_ids: missingDoorIds.slice(0, 100),
    duplicate_door_ids: duplicateDoorIds.slice(0, 100),
    extra_door_ids: extraDoorIds.slice(0, 100),
    zone_mismatch_door_ids: zoneMismatchDoorIds.slice(0, 100),
    missing_work_unit_ids: missingWorkUnitIds.slice(0, 100),
    duplicate_work_unit_ids: duplicateWorkUnitIds.slice(0, 100),
    extra_work_unit_ids: extraWorkUnitIds.slice(0, 100),
    work_unit_zone_mismatch_door_ids: workUnitZoneMismatchDoorIds.slice(0, 100),
    deployable: coverageComplete && noDuplicateDoors && targetMatches && workUnitsIntact && doors.length > 0 && zones.length > 0 && requiredGeneratorGates
  };
}

function functionPayload(result: any) {
  return result?.data && typeof result.data === 'object' ? result.data : result;
}

async function verifyAnalysisDoorUniverse(base44: any, analysisId: string | null, doors: any[], required: boolean) {
  if (!analysisId) {
    if (required) throw new HttpError(422, 'analysis_required', 'street_work_units drafts require an owned Canvas analysis.');
    return null;
  }
  const invoked = await base44.functions.invoke('canvasGetAnalysis', { analysisId }).catch(() => null);
  const payload = functionPayload(invoked);
  if (!payload?.success || !payload?.analysis || !Array.isArray(payload?.opportunities)) {
    throw new HttpError(403, 'analysis_not_owned', 'The selected Canvas analysis is unavailable to this manager.');
  }
  const totalOpportunities = Number(payload.analysis.total_opportunities);
  if (!Number.isInteger(totalOpportunities) || totalOpportunities < 0 || payload.opportunities.length !== totalOpportunities) {
    throw new HttpError(422, 'analysis_truncated', 'The Canvas analysis did not return its complete opportunity set and cannot be used for deployment.');
  }
  const analysisById = new Map(payload.opportunities.map((opportunity: any) => [String(opportunity.id), opportunity]));
  const doorIds = new Set(doors.map((door) => door.stable_door_id));
  const missingIds = [...analysisById.keys()].filter((id) => !doorIds.has(id));
  const extraIds = [...doorIds].filter((id) => !analysisById.has(id));
  const coordinateMismatchIds = doors.filter((door) => {
    const opportunity: any = analysisById.get(door.stable_door_id);
    return opportunity && (Math.abs(Number(opportunity.lat) - door.lat) > 0.00005 || Math.abs(Number(opportunity.lng) - door.lng) > 0.00005);
  }).map((door) => door.stable_door_id);
  if (missingIds.length || extraIds.length || coordinateMismatchIds.length) {
    throw new HttpError(422, 'analysis_door_mismatch', 'The draft door universe must exactly match its owned Canvas analysis.', {
      missing_door_ids: missingIds.slice(0, 100),
      extra_door_ids: extraIds.slice(0, 100),
      coordinate_mismatch_door_ids: coordinateMismatchIds.slice(0, 100)
    });
  }
  return { analysis_id: analysisId, opportunity_count: totalOpportunities, coordinates_verified: true };
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
      if (existing.manager_id !== user.id) throw new HttpError(403, 'forbidden', 'This Canvas session belongs to another manager.');
      if (existing.status !== 'draft') throw new HttpError(409, 'campaign_immutable', 'Active or closed Canvas campaigns are immutable. Create a new draft to rebalance.');
      const expectedVersion = Number(body?.expected_version);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version || 1)) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed. Reload it before saving again.');
      }
      version = expectedVersion + 1;
    }

    const planningMethod = requiredString(body?.planning_method, 'planning_method', 64);
    const ambiguousAlias = optionalString(body?.split_basis, 64);
    const assignmentBasis = requiredString(
      body?.assignment_basis || (ASSIGNMENT_BASES.has(ambiguousAlias) ? ambiguousAlias : ''),
      'assignment_basis',
      64
    );
    const workloadBasis = requiredString(
      body?.workload_basis || (WORKLOAD_BASES.has(ambiguousAlias) ? ambiguousAlias : ''),
      'workload_basis',
      64
    );
    if (!PLANNING_METHODS.has(planningMethod) || !ASSIGNMENT_BASES.has(assignmentBasis) || !WORKLOAD_BASES.has(workloadBasis)) {
      throw new HttpError(400, 'invalid_plan', 'Unsupported Canvas planning method, assignment basis, or workload basis.');
    }
    const polygon = normalizePolygon(body?.polygon);
    const doors = normalizeDoors(body?.doors, planningMethod);
    const zones = normalizeZones(body?.zones);
    const selectedTeamMemberIds = normalizeIdList(body?.selected_team_member_ids || [], 'selected_team_member_ids');
    if (selectedTeamMemberIds.length > MAX_ZONES) {
      throw new HttpError(400, 'invalid_plan', `selected_team_member_ids must contain at most ${MAX_ZONES} records.`);
    }
    if (planningMethod === 'street_work_units' && workloadBasis === 'selected_reps' && selectedTeamMemberIds.length === 0) {
      throw new HttpError(400, 'selected_reps_required', 'selected_team_member_ids is required for a production selected-reps plan.');
    }
    const targetHomes = body?.target_homes === undefined ? doors.length : Number(body.target_homes);
    if (!Number.isInteger(targetHomes) || targetHomes < 0 || targetHomes > MAX_DOORS) {
      throw new HttpError(400, 'invalid_plan', `target_homes must be an integer from 0-${MAX_DOORS}.`);
    }
    const analysisId = optionalString(body?.analysis_id, 256);
    const analysisVerification = await verifyAnalysisDoorUniverse(base44, analysisId, doors, planningMethod === 'street_work_units');
    const derivedQa = deriveQa(doors, zones, targetHomes, body?.qa);
    const zoneAssigneeIds = zones.map((zone) => zone.assigned_team_member_id).filter(Boolean);
    const selectedRepsOneToOne = workloadBasis !== 'selected_reps'
      || (zones.length === selectedTeamMemberIds.length
        && zoneAssigneeIds.length === zones.length
        && new Set(zoneAssigneeIds).size === zoneAssigneeIds.length
        && sameIdSet(selectedTeamMemberIds, zoneAssigneeIds));
    const qa = {
      ...derivedQa,
      analysis_coverage_complete: analysisVerification !== null,
      analysis_opportunity_count: analysisVerification?.opportunity_count ?? null,
      analysis_coordinates_verified: analysisVerification?.coordinates_verified === true,
      selected_reps_one_to_one: selectedRepsOneToOne,
      deployable: derivedQa.deployable
        && planningMethod === 'street_work_units'
        && assignmentBasis === 'stable_door_ids'
        && analysisVerification?.coordinates_verified === true
        && selectedRepsOneToOne
    };

    const normalizedPlan = {
      session_name: optionalString(body?.session_name, 200) || 'Canvas Campaign',
      polygon: polygon.points,
      rep_count: new Set(zones.map((zone) => zone.assigned_team_member_id).filter(Boolean)).size,
      planning_method: planningMethod,
      assignment_basis: assignmentBasis,
      workload_basis: workloadBasis,
      target_homes: targetHomes,
      selected_team_member_ids: selectedTeamMemberIds,
      doors,
      zones,
      qa,
      analysis_id: analysisId,
      algorithm_version: optionalString(body?.algorithm_version, 128),
      data_version: optionalString(body?.data_version, 256),
      manager_id: user.id,
      version
    };
    const planHash = await sha256(normalizedPlan);
    const now = new Date().toISOString();
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
      area_sq_mi: Number(polygon.areaSqMi.toFixed(3)),
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
