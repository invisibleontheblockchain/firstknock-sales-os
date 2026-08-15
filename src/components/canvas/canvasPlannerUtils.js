const UNVERIFIED_METHODS = new Set(['', 'unknown', 'unverified', 'legacy_unverified']);
const MAX_CANVAS_ZONES = 250;
const MAX_CANVAS_POLYGON_POINTS = 800;
const MAX_CANVAS_AREA_SQ_MI = 1_000;
const CANVAS_COORDINATE_EPSILON = 1e-10;
// 20,000 evidence units × 250 areas is the advertised upper Canvas shape.
// Serialized-byte and segment caps remain the primary memory safeguards.
export const MAX_CANVAS_INTERACTIVE_COMPLEXITY = 5_000_000;
export const MAX_CANVAS_INTERACTIVE_WORK_UNITS = 20_000;
export const MAX_CANVAS_INTERACTIVE_SEGMENTS = 50_000;

function sameCanvasPoint(left, right) {
  return Math.abs(left.lat - right.lat) <= CANVAS_COORDINATE_EPSILON
    && Math.abs(left.lng - right.lng) <= CANVAS_COORDINATE_EPSILON;
}

function canvasOrientation(first, second, third) {
  const value = (second.lng - first.lng) * (third.lat - first.lat) - (second.lat - first.lat) * (third.lng - first.lng);
  if (Math.abs(value) <= CANVAS_COORDINATE_EPSILON) return 0;
  return value > 0 ? 1 : -1;
}

function canvasPointOnSegment(point, start, end) {
  if (canvasOrientation(start, end, point) !== 0) return false;
  return point.lng >= Math.min(start.lng, end.lng) - CANVAS_COORDINATE_EPSILON
    && point.lng <= Math.max(start.lng, end.lng) + CANVAS_COORDINATE_EPSILON
    && point.lat >= Math.min(start.lat, end.lat) - CANVAS_COORDINATE_EPSILON
    && point.lat <= Math.max(start.lat, end.lat) + CANVAS_COORDINATE_EPSILON;
}

function canvasSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = canvasOrientation(firstStart, firstEnd, secondStart);
  const secondOrientation = canvasOrientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = canvasOrientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = canvasOrientation(secondStart, secondEnd, firstEnd);
  if (firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation) return true;
  return canvasPointOnSegment(secondStart, firstStart, firstEnd)
    || canvasPointOnSegment(secondEnd, firstStart, firstEnd)
    || canvasPointOnSegment(firstStart, secondStart, secondEnd)
    || canvasPointOnSegment(firstEnd, secondStart, secondEnd);
}

export function getCanvasBoundaryAreaSqMiles(points = []) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({
    x: (point.lng - origin.lng) * lngScale,
    y: (point.lat - origin.lat) * latScale,
  }));
  const twiceArea = projected.reduce((sum, point, index) => {
    const next = projected[(index + 1) % projected.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(twiceArea) / 2;
}

export function validateCanvasBoundary(rawPolygon) {
  if (!Array.isArray(rawPolygon)) {
    return { valid: false, code: 'INVALID_POLYGON', message: 'Draw a valid Canvas territory boundary.', points: [] };
  }
  if (rawPolygon.length > MAX_CANVAS_POLYGON_POINTS) {
    return {
      valid: false,
      code: 'POLYGON_POINT_LIMIT_EXCEEDED',
      message: `Canvas boundaries support up to ${MAX_CANVAS_POLYGON_POINTS} points. Draw a simpler outline before loading streets.`,
      points: [],
    };
  }
  const parsed = rawPolygon.map((point) => ({
    lat: Number(point?.lat ?? point?.[0]),
    lng: Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]),
  }));
  if (parsed.some((point) => !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
    return { valid: false, code: 'INVALID_COORDINATE', message: 'The Canvas boundary contains an invalid map point. Redraw the area.', points: [] };
  }
  const points = parsed.reduce((result, point) => {
    if (!result.length || !sameCanvasPoint(result[result.length - 1], point)) result.push(point);
    return result;
  }, []);
  if (points.length > 1 && sameCanvasPoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3) {
    return { valid: false, code: 'INVALID_POLYGON', message: 'Draw a Canvas boundary with at least three distinct points.', points };
  }
  for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
    const firstNextIndex = (firstIndex + 1) % points.length;
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
      const secondNextIndex = (secondIndex + 1) % points.length;
      if (firstNextIndex === secondIndex || secondNextIndex === firstIndex) continue;
      if (canvasSegmentsIntersect(points[firstIndex], points[firstNextIndex], points[secondIndex], points[secondNextIndex])) {
        return { valid: false, code: 'SELF_INTERSECTING_POLYGON', message: 'The Canvas boundary crosses or touches itself. Redraw one simple outer boundary.', points };
      }
    }
  }
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.lng * next.lat - next.lng * point.lat;
  }, 0);
  if (Math.abs(twiceArea) <= CANVAS_COORDINATE_EPSILON) {
    return { valid: false, code: 'ZERO_AREA_POLYGON', message: 'The Canvas boundary has no usable area. Redraw a wider territory.', points };
  }
  const areaSqMiles = getCanvasBoundaryAreaSqMiles(points);
  if (!Number.isFinite(areaSqMiles) || areaSqMiles > MAX_CANVAS_AREA_SQ_MI) {
    return {
      valid: false,
      code: 'CANVAS_AREA_TOO_LARGE',
      message: `This Canvas area is about ${Math.round(areaSqMiles).toLocaleString()} sq mi. Draw ${MAX_CANVAS_AREA_SQ_MI.toLocaleString()} sq mi or less before loading streets.`,
      points,
      areaSqMiles,
    };
  }
  return { valid: true, code: 'VALID', message: '', points, areaSqMiles };
}

export function getCanvasTeamMemberEligibility(teamMembers = []) {
  if (!Array.isArray(teamMembers)) return { eligible: [], excluded: { missing_id: 0, inactive: 0, non_rep: 0, unlinked: 0, duplicate: 0 } };
  const seen = new Set();
  const excluded = { missing_id: 0, inactive: 0, non_rep: 0, unlinked: 0, duplicate: 0 };
  const eligible = teamMembers.filter((member) => {
    const id = String(member?.id || '').trim();
    const status = String(member?.status || '').toLowerCase();
    const role = String(member?.role || '').toLowerCase();
    if (!id) { excluded.missing_id += 1; return false; }
    if (seen.has(id)) { excluded.duplicate += 1; return false; }
    seen.add(id);
    if (status !== 'active') { excluded.inactive += 1; return false; }
    if (role !== 'rep') { excluded.non_rep += 1; return false; }
    if (!member?.user_id) { excluded.unlinked += 1; return false; }
    return true;
  });
  return { eligible, excluded };
}

export function getActiveCanvasTeamMembers(teamMembers = []) {
  return getCanvasTeamMemberEligibility(teamMembers).eligible;
}

export function getCanvasPlannerFailureMessage(result) {
  if (!result || result.ok !== false) return '';
  const message = String(result.message || '').trim();
  if (message) return message;
  const code = String(result.code || '').trim();
  return code
    ? `Canvas could not create connected street territories (${code}). Change the division settings and try again.`
    : 'Canvas could not create connected street territories. Change the division settings and try again.';
}

export function formatCanvasOverlapConfirmation(details = {}) {
  const conflicts = Array.isArray(details?.conflicts) ? details.conflicts : [];
  const conflictIds = details?.required_supersede_session_ids || details?.conflicting_session_ids || [];
  const count = Math.max(conflicts.length, Array.isArray(conflictIds) ? conflictIds.length : 0);
  const heading = `This global area overlaps ${count || 'one or more'} active Canvas campaign${count === 1 ? '' : 's'}. Confirming removes each entire conflicting campaign from every rep.`;
  const lines = conflicts.slice(0, 8).map((conflict, index) => {
    const name = String(conflict?.session_name || `Campaign ${index + 1}`).trim().slice(0, 100);
    const workUnits = Math.max(0, Number(conflict?.work_unit_id_count) || 0);
    const zones = Math.max(0, Number(conflict?.zone_count) || 0);
    return `• ${name}: ${workUnits} overlapping street unit${workUnits === 1 ? '' : 's'}${zones ? ` across ${zones} territor${zones === 1 ? 'y' : 'ies'}` : ''}`;
  });
  const omitted = conflicts.length > lines.length ? `\n• ${conflicts.length - lines.length} more conflicting campaign${conflicts.length - lines.length === 1 ? '' : 's'}` : '';
  return `${heading}${lines.length ? `\n\n${lines.join('\n')}${omitted}` : ''}\n\nReplace these campaigns for reps?`;
}

export function getCanvasZoneAssignmentIds(zone) {
  const raw = zone?.assigned_team_member_ids || zone?.assignments || [];
  const values = Array.isArray(raw) ? raw : [raw];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function memberLabel(member) {
  return member?.name || member?.full_name || member?.email || 'Team member';
}

export function assignCanvasZonesRoundRobin(zones = [], selectedTeamMemberIds = [], teamMembers = []) {
  const membersById = new Map(getActiveCanvasTeamMembers(teamMembers).map((member) => [String(member.id), member]));
  const validIds = [...new Set(selectedTeamMemberIds.map((id) => String(id || '').trim()).filter((id) => membersById.has(id)))];
  if (!validIds.length) return zones.map((zone) => ({ ...zone, assignments: [], assigned_team_member_ids: [], assigned_team_member_id: null, assigned_to: null, assigned_to_name: '' }));
  return zones.map((zone, index) => {
    const teamMemberId = validIds[index % validIds.length];
    return {
      ...zone,
      assignments: [teamMemberId],
      assigned_team_member_ids: [teamMemberId],
      assigned_team_member_id: teamMemberId,
      assigned_to: teamMemberId,
      assigned_to_name: memberLabel(membersById.get(teamMemberId)),
    };
  });
}

export function updateCanvasZoneAssignment(zone, teamMemberId, teamMembers = []) {
  const membersById = new Map(getActiveCanvasTeamMembers(teamMembers).map((member) => [String(member.id), member]));
  const id = String(teamMemberId || '').trim();
  if (!id || !membersById.has(id)) {
    return { ...zone, assignments: [], assigned_team_member_ids: [], assigned_team_member_id: null, assigned_to: null, assigned_to_name: '' };
  }
  return {
    ...zone,
    assignments: [id],
    assigned_team_member_ids: [id],
    assigned_team_member_id: id,
    assigned_to: id,
    assigned_to_name: memberLabel(membersById.get(id)),
  };
}

export function reconcileCanvasPlanWithEligibleTeam(plan, teamMembers = []) {
  if (!plan || typeof plan !== 'object') {
    return { plan, changed: false, removedSelectedIds: [], clearedZoneIds: [], requiresRegeneration: false };
  }
  const eligibleIds = new Set(getActiveCanvasTeamMembers(teamMembers).map((member) => String(member.id)));
  const originalSelectedIds = [...new Set((plan.selected_team_member_ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const selectedTeamMemberIds = originalSelectedIds.filter((id) => eligibleIds.has(id));
  const removedSelectedIds = originalSelectedIds.filter((id) => !eligibleIds.has(id));
  const clearedZoneIds = [];
  const zones = (Array.isArray(plan.zones) ? plan.zones : []).map((zone, index) => {
    const assignedId = String(zone?.assigned_team_member_id || '').trim();
    if (!assignedId || eligibleIds.has(assignedId)) return zone;
    clearedZoneIds.push(String(zone?.zone_id || zone?.id || zone?.zone_number || index + 1));
    return updateCanvasZoneAssignment(zone, null, []);
  });
  const changed = removedSelectedIds.length > 0 || clearedZoneIds.length > 0;
  if (!changed) return { plan, changed: false, removedSelectedIds, clearedZoneIds, requiresRegeneration: false };
  const warning = 'The active Canvas roster changed; removed reps were cleared from this territory plan.';
  const selectedRepMode = plan.division_mode === 'selected_reps' || plan.division_basis === 'selected_reps';
  return {
    plan: {
      ...plan,
      selected_team_member_ids: selectedTeamMemberIds,
      zones,
      qa: { ...(plan.qa || {}), deployable: false, warnings: [...new Set([...(plan.qa?.warnings || []), warning])] },
    },
    changed: true,
    removedSelectedIds,
    clearedZoneIds,
    requiresRegeneration: selectedRepMode && removedSelectedIds.length > 0,
  };
}

export function getCanvasWorkloadDeviation(plan = {}) {
  const zones = Array.isArray(plan?.zones) ? plan.zones : [];
  const zoneScores = zones.map((zone) => Number(zone?.workload_score ?? zone?.street_length_meters));
  if (zoneScores.length > 0 && zoneScores.every((score) => Number.isFinite(score) && score >= 0)) {
    const average = zoneScores.reduce((sum, score) => sum + score, 0) / zoneScores.length;
    if (average > 0) {
      return {
        verified: true,
        value: Math.round(Math.max(...zoneScores.map((score) => Math.abs(score - average) / average)) * 100),
        source: 'zone_workload_scores',
        scores: zoneScores,
      };
    }
  }
  if (zones.length > 0) return { verified: false, value: null, source: 'unavailable', scores: [] };

  const supplied = plan?.qa?.max_workload_deviation_percent ?? plan?.diagnostics?.max_workload_deviation_percent;
  const parsed = supplied === null || supplied === undefined || supplied === '' ? Number.NaN : Number(supplied);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return { verified: true, value: Math.round(parsed), source: 'planner_qa', scores: [] };
  }
  return { verified: false, value: null, source: 'unavailable', scores: [] };
}

export function getCanvasPlanComplexityStatus(plan = {}) {
  const zoneCount = Array.isArray(plan?.zones) ? plan.zones.length : 0;
  const workUnitCount = Array.isArray(plan?.work_units) ? plan.work_units.length : 0;
  const segmentCount = (Array.isArray(plan?.work_units) ? plan.work_units : [])
    .reduce((sum, unit) => sum + (Array.isArray(unit?.segments) ? unit.segments.length : 0), 0);
  const complexity = zoneCount * workUnitCount;
  const supported = zoneCount > 0
    && zoneCount <= MAX_CANVAS_ZONES
    && workUnitCount > 0
    && workUnitCount <= MAX_CANVAS_INTERACTIVE_WORK_UNITS
    && segmentCount <= MAX_CANVAS_INTERACTIVE_SEGMENTS
    && complexity <= MAX_CANVAS_INTERACTIVE_COMPLEXITY;
  return {
    supported,
    zoneCount,
    workUnitCount,
    segmentCount,
    complexity,
    message: supported
      ? ''
      : `This street plan exceeds the supported street-unit, segment, or area-by-unit limit. Reduce the boundary or area count that exceeded its limit, then create the preview again.`,
  };
}

export function getCanvasCrewAssignmentStatus(plan = {}, selectedTeamMemberIds = []) {
  const zones = Array.isArray(plan?.zones) ? plan.zones : [];
  const divisionMode = plan?.division_mode || plan?.division_basis || 'selected_reps';
  const selectedIds = [...new Set((selectedTeamMemberIds || []).map(String).filter(Boolean))];
  const assignedIds = zones.map((zone) => String(zone?.assigned_team_member_id || '')).filter(Boolean);
  const uniqueAssignedIds = [...new Set(assignedIds)];
  const everyZoneAssigned = zones.length > 0 && assignedIds.length === zones.length;
  const selectedSet = new Set(selectedIds);
  const selectionMatchesAssignments = selectedIds.length === uniqueAssignedIds.length
    && uniqueAssignedIds.every((id) => selectedSet.has(id));
  const oneToOneMode = divisionMode === 'selected_reps';
  const oneToOne = everyZoneAssigned
    && uniqueAssignedIds.length === zones.length
    && selectedIds.length === zones.length
    && selectionMatchesAssignments;
  const valid = selectedIds.length > 0
    && everyZoneAssigned
    && selectionMatchesAssignments
    && (!oneToOneMode || oneToOne);

  let message = '';
  if (!zones.length) message = 'Create the territory preview before choosing the crew.';
  else if (!selectedIds.length) message = 'Choose the reps who should receive this work.';
  else if (oneToOneMode && selectedIds.length !== zones.length) message = `Choose exactly ${zones.length} rep${zones.length === 1 ? '' : 's'} so every selected rep receives one territory.`;
  else if (!everyZoneAssigned) message = 'Assign every territory before sending.';
  else if (oneToOneMode && !oneToOne) message = 'Each selected rep must receive exactly one territory.';
  else if (!selectionMatchesAssignments) message = 'Every selected rep must receive work, with no unselected rep assigned.';

  return {
    valid,
    message,
    divisionMode,
    selectedIds,
    assignedIds,
    uniqueAssignedIds,
    everyZoneAssigned,
    selectionMatchesAssignments,
    oneToOne,
  };
}

export function restoreCanvasDraftPlan(campaign, teamMembers = []) {
  if (!campaign || String(campaign.stored_status || campaign.status || '') !== 'draft') {
    throw new Error('Only a saved Canvas draft can be resumed in the planner.');
  }
  const zones = Array.isArray(campaign.zones) ? campaign.zones : [];
  const workUnits = Array.isArray(campaign.work_units) ? campaign.work_units : [];
  if (!zones.length || !workUnits.length) throw new Error('This Canvas draft is missing its saved street plan.');
  const membersById = new Map((Array.isArray(teamMembers) ? teamMembers : []).map((member) => [String(member?.id || ''), member]));
  const restoredZones = zones.map((zone, index) => {
    const assignmentId = String(zone?.assigned_team_member_id || '');
    return {
      ...zone,
      zone_number: Number(zone?.zone_number) || index + 1,
      assignments: assignmentId ? [assignmentId] : [],
      assigned_team_member_ids: assignmentId ? [assignmentId] : [],
      assigned_to: assignmentId || null,
      assigned_to_name: assignmentId ? memberLabel(membersById.get(assignmentId)) : '',
    };
  });
  const qa = normalizedQa(campaign.qa || {});
  const divisionMode = String(campaign.division_mode || 'area_count');
  const savedSelectedIds = [...new Set((campaign.selected_team_member_ids || []).map(String).filter(Boolean))];
  const assignedIds = [...new Set(restoredZones.map((zone) => String(zone.assigned_team_member_id || '')).filter(Boolean))];
  const selectedIds = savedSelectedIds.length ? savedSelectedIds : assignedIds;
  return {
    ok: true,
    status: qa.warnings.length ? 'degraded' : 'ready',
    deployable: qa.deployable,
    territory_model: campaign.territory_model || 'street_territory_v1',
    planning_method: campaign.planning_method || 'street_workload',
    assignment_basis: campaign.assignment_basis || 'street_work_unit_ids',
    workload_basis: campaign.workload_basis || 'street_length',
    division_mode: divisionMode,
    division_basis: divisionMode,
    target_workload: campaign.target_workload ?? null,
    selected_team_member_ids: selectedIds,
    algorithm_version: campaign.algorithm_version || '',
    data_version: campaign.data_version || '',
    evidence_id: campaign.evidence_id || null,
    evidence_release_id: campaign.evidence_release_id || null,
    snapshot_hash: campaign.snapshot_hash || null,
    revision_id: campaign.revision_id || null,
    evidence_schema_version: Number(campaign.evidence_schema_version || 1),
    unresolved_unit_count: Math.max(0, Number(campaign.unresolved_unit_count || 0)),
    zones: restoredZones,
    work_units: workUnits,
    qa,
  };
}

function normalizeIssueList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((issue) => typeof issue === 'string' ? issue : issue?.message).filter(Boolean);
}

function normalizedQa(qa = {}) {
  return {
    ...qa,
    deployable: qa.deployable === true,
    street_coverage_complete: qa.street_coverage_complete === true || qa.coverage_complete === true,
    no_duplicate_work_units: qa.no_duplicate_work_units === true,
    no_missing_work_units: qa.no_missing_work_units === true,
    connected_zones: qa.connected_zones === true,
    atomic_work_units: qa.atomic_work_units === true,
    cul_de_sac_splits: Math.max(0, Number(qa.cul_de_sac_splits) || 0),
    protected_units_intact: qa.protected_units_intact === true,
    data_quality_status: qa.data_quality_status || 'unverified',
    warnings: normalizeIssueList(qa.warnings),
  };
}

export function normalizeCanvasPlannerResult(result, context = {}) {
  const zones = Array.isArray(result?.zones) ? result.zones : [];
  const qa = normalizedQa(result?.qa || {});
  const diagnostics = result?.diagnostics || {};
  const rawMethod = String(result?.method || result?.planning_method || diagnostics?.method || 'legacy_unverified').toLowerCase();
  const methodVerified = !UNVERIFIED_METHODS.has(rawMethod);
  const requestedZoneCount = Math.max(1, Number(context.requestedZoneCount) || zones.length || 1);
  const workloadScores = zones.map((zone) => Math.max(0, Number(zone?.workload_score ?? zone?.street_length_meters) || 0));
  const average = workloadScores.length ? workloadScores.reduce((sum, value) => sum + value, 0) / workloadScores.length : 0;
  const maxImbalancePercent = average > 0
    ? Math.round(Math.max(...workloadScores.map((value) => Math.abs(value - average) / average)) * 100)
    : null;
  const blockingIssues = [
    ...(zones.length ? [] : ['No usable territories were generated.']),
    ...(zones.some((zone) => {
      const hasDisplayGeometry = Array.isArray(zone?.geometry) && zone.geometry.length >= 3;
      const hasStreetOwnership = zone?.geometry_role === 'display_only'
        && Array.isArray(zone?.work_unit_ids)
        && zone.work_unit_ids.length > 0;
      return !hasDisplayGeometry && !hasStreetOwnership;
    }) ? ['At least one territory has neither display geometry nor street ownership.'] : []),
  ];
  const degradedIssues = [
    ...normalizeIssueList(diagnostics?.warnings || result?.warnings),
    ...(context.roadFetchStatus === 'ready' ? [] : ['The street network was not ready for this draft.']),
    ...(methodVerified ? [] : ['The planner did not provide verifiable method diagnostics.']),
    ...(zones.length !== requestedZoneCount ? [`Requested ${requestedZoneCount} territories; generated ${zones.length}.`] : []),
    ...(maxImbalancePercent !== null && maxImbalancePercent > 25 ? [`Street-workload imbalance reaches ${maxImbalancePercent}%.`] : []),
  ];
  return {
    zones,
    method: rawMethod,
    methodVerified,
    roadAligned: result?.road_aligned === true || result?.street_aligned === true,
    culdesacIntegrity: result?.culdesac_integrity === true || (qa.protected_units_intact && qa.cul_de_sac_splits === 0),
    blockingIssues: [...new Set(blockingIssues)],
    degradedIssues: [...new Set(degradedIssues)],
    maxImbalancePercent,
    requestedZoneCount,
    status: blockingIssues.length ? 'blocked' : degradedIssues.length ? 'degraded' : 'ready',
    rawDiagnostics: diagnostics,
  };
}

export function isVerifiedCanvasPlannerResult(result) {
  if (!result || Array.isArray(result)) return false;
  const qa = normalizedQa(result.qa || {});
  return result.ok === true
    && result.deployable === true
    && ['ready', 'degraded'].includes(result.status)
    && result.planning_method === 'street_workload'
    && result.assignment_basis === 'street_work_unit_ids'
    && Boolean(String(result.algorithm_version || '').trim())
    && Boolean(String(result.data_version || '').trim())
    && Array.isArray(result.work_units)
    && result.work_units.length > 0
    && qa.deployable
    && qa.street_coverage_complete
    && qa.no_duplicate_work_units
    && qa.no_missing_work_units
    && qa.connected_zones
    && qa.atomic_work_units
    && qa.cul_de_sac_splits === 0
    && qa.protected_units_intact
    && qa.data_quality_status === 'verified';
}

export function getCanvasGenerationBlockers({
  polygon,
  divisionMode = 'selected_reps',
  selectedTeamMemberIds = [],
  teamMembers = [],
  requestedAreaCount = 1,
  roadFetchStatus,
}) {
  const blockers = [];
  const boundary = validateCanvasBoundary(polygon);
  const activeMemberIds = new Set(getActiveCanvasTeamMembers(teamMembers).map((member) => String(member.id)));
  const validSelectedIds = [...new Set(selectedTeamMemberIds.map(String).filter((id) => activeMemberIds.has(id)))];
  if (!boundary.valid) blockers.push(boundary.message);
  if (roadFetchStatus === 'loading') blockers.push('Wait for the street network to finish loading.');
  else if (roadFetchStatus !== 'ready') blockers.push('Street data is required before Canvas can divide this area.');
  if (divisionMode === 'selected_reps' && !validSelectedIds.length) blockers.push('Select at least one active rep.');
  if (divisionMode === 'selected_reps' && validSelectedIds.length > MAX_CANVAS_ZONES) blockers.push(`Canvas supports at most ${MAX_CANVAS_ZONES} selected reps.`);
  if (divisionMode !== 'selected_reps' && (!Number.isInteger(Number(requestedAreaCount)) || Number(requestedAreaCount) < 1 || Number(requestedAreaCount) > MAX_CANVAS_ZONES)) blockers.push(`Choose between 1 and ${MAX_CANVAS_ZONES} territories.`);
  return [...new Set(blockers)];
}

export function isCanvasPlanDeployable(plan = {}) {
  const qa = normalizedQa(plan.qa || plan.diagnostics?.qa);
  const workUnits = Array.isArray(plan.work_units) ? plan.work_units : [];
  const residentialV2 = plan.territory_model === 'residential_street_territory_v2';
  const ownershipUnits = residentialV2 ? workUnits.filter((unit) => unit?.canvas_role === 'knock') : workUnits;
  const zones = Array.isArray(plan.zones) ? plan.zones : [];
  const crewAssignment = getCanvasCrewAssignmentStatus(plan, plan.selected_team_member_ids || []);
  const ownedUnitIds = zones.flatMap((zone) => Array.isArray(zone?.work_unit_ids) ? zone.work_unit_ids : []);
  return plan.planning_method === 'street_workload'
    && plan.assignment_basis === 'street_work_unit_ids'
    && Boolean(String(plan.algorithm_version || '').trim())
    && Boolean(String(plan.data_version || '').trim())
    && ownershipUnits.length > 0
    && zones.length > 0
    && zones.every((zone) => zone?.assigned_team_member_id && Array.isArray(zone?.work_unit_ids) && zone.work_unit_ids.length > 0)
    && ownedUnitIds.length === ownershipUnits.length
    && new Set(ownedUnitIds).size === ownershipUnits.length
    && (!residentialV2 || (Boolean(plan.evidence_id) && Boolean(plan.snapshot_hash) && Number(plan.unresolved_unit_count || 0) === 0))
    && crewAssignment.valid
    && qa.deployable
    && qa.street_coverage_complete
    && qa.no_duplicate_work_units
    && qa.no_missing_work_units
    && qa.connected_zones
    && qa.atomic_work_units
    && qa.cul_de_sac_splits === 0
    && qa.protected_units_intact
    && qa.data_quality_status === 'verified';
}

function normalizeWorkUnit(unit) {
  const opportunity = unit?.opportunity || {};
  return {
    id: String(unit?.id || unit?.work_unit_id || ''),
    kind: unit?.kind || null,
    protected: unit?.protected === true,
    protected_group_id: unit?.protected_group_id || null,
    protected_group_ids: Array.isArray(unit?.protected_group_ids) ? unit.protected_group_ids : [],
    canvas_role: unit?.canvas_role || null,
    confidence: unit?.confidence || null,
    opportunity_low: Number(unit?.opportunity_low ?? opportunity.min ?? opportunity.low ?? 0),
    opportunity_expected: Number(unit?.opportunity_expected ?? opportunity.expected ?? 0),
    opportunity_high: Number(unit?.opportunity_high ?? opportunity.max ?? opportunity.high ?? 0),
    street_names: unit?.street_names || unit?.streetNames || [],
    neighbor_ids: unit?.neighbor_ids || unit?.neighborIds || [],
    street_length_meters: Number(unit?.street_length_meters ?? unit?.streetLengthMeters ?? 0),
    segments: (Array.isArray(unit?.segments) ? unit.segments : []).map((segment) => ({
      edge_id: segment?.edge_id ?? segment?.edgeId ?? null,
      start: segment?.start,
      end: segment?.end,
      street_names: segment?.street_names || segment?.streetNames || [],
      length_meters: Number(segment?.length_meters ?? segment?.lengthMeters ?? 0),
    })),
  };
}

export function buildCanvasDraftPayload({ sessionId, expectedVersion, sessionName, polygon, plan }) {
  const qa = { ...normalizedQa(plan?.qa || plan?.diagnostics?.qa), deployable: isCanvasPlanDeployable(plan || {}) };
  const planningMethod = plan?.planning_method === 'street_workload' ? 'street_workload' : 'preview_only';
  const assignmentBasis = plan?.assignment_basis === 'street_work_unit_ids' ? 'street_work_unit_ids' : 'legacy_geometry';
  const divisionMode = plan?.division_mode || plan?.division_basis || 'selected_reps';
  const workloadBasis = ['street_length', 'estimated_doors', 'street_length_plus_estimated_doors', 'residential_opportunity'].includes(plan?.workload_basis)
    ? plan.workload_basis
    : 'street_length';
  const zones = (Array.isArray(plan?.zones) ? plan.zones : []).map((zone, index) => ({
    zone_id: String(zone.zone_id || zone.id || `canvas_zone_${Number(zone.zone_number) || index + 1}`),
    zone_number: Number(zone.zone_number) || index + 1,
    name: zone.name || `Area ${Number(zone.zone_number) || index + 1}`,
    color: zone.color || null,
    geometry: zone.geometry || null,
    parts: Array.isArray(zone.parts) ? zone.parts : undefined,
    geometry_role: zone.geometry_role || 'display_only',
    center: zone.center || null,
    drop_point: zone.drop_point || null,
    assigned_team_member_id: zone.assigned_team_member_id || getCanvasZoneAssignmentIds(zone)[0] || null,
    work_unit_ids: Array.isArray(zone.work_unit_ids) ? [...new Set(zone.work_unit_ids.filter(Boolean))] : [],
    street_work_unit_ids: Array.isArray(zone.work_unit_ids) ? [...new Set(zone.work_unit_ids.filter(Boolean))] : [],
    street_length_meters: Number(zone.street_length_meters ?? zone.street_length_m ?? 0),
    estimated_doors: zone.estimated_doors !== null && zone.estimated_doors !== undefined && zone.estimated_doors !== '' && Number.isFinite(Number(zone.estimated_doors)) ? Number(zone.estimated_doors) : null,
    estimated_minutes: Number.isFinite(Number(zone.estimated_minutes)) ? Number(zone.estimated_minutes) : null,
    workload_score: Number(zone.workload_score ?? zone.street_length_meters ?? 0),
    workload_share: Number.isFinite(Number(zone.workload_share)) ? Number(zone.workload_share) : null,
    protected_unit_over_target: zone.protected_unit_over_target === true,
  }));
  const assignedTeamMemberIds = [...new Set(zones.map((zone) => String(zone.assigned_team_member_id || '')).filter(Boolean))];
  const managerSelectedTeamMemberIds = [...new Set((plan?.selected_team_member_ids || []).map(String).filter(Boolean))];
  const selectedTeamMemberIds = managerSelectedTeamMemberIds.length ? managerSelectedTeamMemberIds : assignedTeamMemberIds;
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(expectedVersion !== undefined && expectedVersion !== null ? { expected_version: expectedVersion } : {}),
    session_name: String(sessionName || 'Canvas Territory Draft').trim() || 'Canvas Territory Draft',
    territory_model: plan?.territory_model === 'residential_street_territory_v2'
      ? 'residential_street_territory_v2'
      : 'street_territory_v1',
    polygon,
    planning_method: planningMethod,
    assignment_basis: assignmentBasis,
    division_mode: divisionMode,
    workload_basis: workloadBasis,
    selected_team_member_ids: selectedTeamMemberIds,
    target_workload: plan?.target_workload !== null && plan?.target_workload !== undefined && plan?.target_workload !== '' && Number.isFinite(Number(plan.target_workload)) ? Number(plan.target_workload) : null,
    ...(plan?.algorithm_version ? { algorithm_version: plan.algorithm_version } : {}),
    ...(plan?.data_version ? { data_version: plan.data_version } : {}),
    ...(plan?.evidence_id ? { evidence_id: plan.evidence_id } : {}),
    ...(plan?.evidence_release_id ? { evidence_release_id: plan.evidence_release_id } : {}),
    ...(plan?.snapshot_hash ? { snapshot_hash: plan.snapshot_hash } : {}),
    ...(plan?.revision_id ? { revision_id: plan.revision_id } : {}),
    ...(plan?.evidence_schema_version ? { evidence_schema_version: plan.evidence_schema_version } : {}),
    unresolved_unit_count: Math.max(0, Number(plan?.unresolved_unit_count || 0)),
    zones,
    work_units: (Array.isArray(plan?.work_units) ? plan.work_units : []).map(normalizeWorkUnit),
    qa,
  };
}

// Areas the manager pinned, plus a just-merged area that does not exist in the
// current plan yet. Any pinned area overlapping the merge is dropped, because
// the partitioner rejects overlapping locks rather than picking a winner.
export function lockedZonesFromPlan(plan, lockedZoneIds, mergedOverride = null) {
  const locked = (plan?.zones || [])
    .filter((zone) => lockedZoneIds?.has?.(String(zone?.zone_id)))
    .map((zone) => ({ zone_id: String(zone.zone_id), work_unit_ids: [...(zone.work_unit_ids || [])] }));
  if (!mergedOverride) return locked;
  const mergedUnits = new Set(mergedOverride.work_unit_ids || []);
  return [
    mergedOverride,
    ...locked.filter((zone) => String(zone.zone_id) !== String(mergedOverride.zone_id)
      && !zone.work_unit_ids.some((id) => mergedUnits.has(id))),
  ];
}
