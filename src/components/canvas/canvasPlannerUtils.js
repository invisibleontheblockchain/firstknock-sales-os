const UNVERIFIED_METHODS = new Set(['', 'unknown', 'unverified', 'legacy_unverified']);
const MAX_CANVAS_ZONES = 250;
const CANVAS_COORDINATE_EPSILON = 1e-10;

const asFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

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

export function validateCanvasBoundary(rawPolygon) {
  if (!Array.isArray(rawPolygon)) {
    return { valid: false, code: 'INVALID_POLYGON', message: 'Draw a valid Canvas territory boundary.', points: [] };
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
  return { valid: true, code: 'VALID', message: '', points };
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

export function getStableOpportunityPoints(analysis) {
  const opportunities = Array.isArray(analysis?.opportunities) ? analysis.opportunities : [];
  return opportunities.map((opportunity) => {
    const id = String(opportunity?.id || opportunity?.opportunity_id || '').trim();
    const lat = asFiniteNumber(opportunity?.lat ?? opportunity?.latitude);
    const lng = asFiniteNumber(opportunity?.lng ?? opportunity?.longitude);
    if (!id || lat === null || lng === null) return null;
    return { ...opportunity, id, lat, lng };
  }).filter(Boolean);
}

export function getCanvasSplitTarget({
  splitBasis,
  selectedTeamMemberIds = [],
  homesPerArea = 100,
  totalHomes = 0,
}) {
  const safeHomes = Math.max(0, Math.floor(Number(totalHomes) || 0));
  if (splitBasis === 'homes_per_area') {
    const targetHomesPerArea = Math.max(1, Math.floor(Number(homesPerArea) || 1));
    return {
      requestedZoneCount: Math.max(1, Math.ceil(safeHomes / targetHomesPerArea)),
      targetHomesPerArea,
      basisLabel: `${targetHomesPerArea} homes per area`,
    };
  }

  const requestedZoneCount = Math.max(1, new Set(selectedTeamMemberIds.filter(Boolean)).size);
  return {
    requestedZoneCount,
    targetHomesPerArea: Math.max(1, Math.ceil(safeHomes / requestedZoneCount)),
    basisLabel: `${requestedZoneCount} selected rep${requestedZoneCount === 1 ? '' : 's'}`,
  };
}

export function getCanvasPlannerFailureMessage(result) {
  if (!result || result.ok !== false) return '';
  const message = String(result.message || '').trim();
  if (message) return message;
  const code = String(result.code || '').trim();
  return code ? `Canvas could not create safe street areas (${code}). Change the split settings and try again.` : 'Canvas could not create safe street areas. Change the split settings and try again.';
}

export function formatCanvasOverlapConfirmation(details = {}) {
  const conflicts = Array.isArray(details?.conflicts) ? details.conflicts : [];
  const conflictIds = details?.required_supersede_session_ids || details?.conflicting_session_ids || [];
  const count = Math.max(conflicts.length, Array.isArray(conflictIds) ? conflictIds.length : 0);
  const heading = `This area overlaps ${count || 'one or more'} active Canvas campaign${count === 1 ? '' : 's'}. Confirming removes each entire conflicting campaign from every rep.`;
  const lines = conflicts.slice(0, 8).map((conflict, index) => {
    const name = String(conflict?.session_name || `Campaign ${index + 1}`).trim().slice(0, 100);
    const homes = Math.max(0, Number(conflict?.stable_door_id_count) || 0);
    const workUnits = Math.max(0, Number(conflict?.work_unit_id_count) || 0);
    return `• ${name}: ${homes} overlapping home${homes === 1 ? '' : 's'}, ${workUnits} street unit${workUnits === 1 ? '' : 's'}`;
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
  if (!changed) {
    return { plan, changed: false, removedSelectedIds, clearedZoneIds, requiresRegeneration: false };
  }
  const warning = 'The active Canvas roster changed; removed reps were cleared from this plan.';
  return {
    plan: {
      ...plan,
      selected_team_member_ids: selectedTeamMemberIds,
      zones,
      qa: {
        ...(plan.qa || {}),
        deployable: false,
        warnings: [...new Set([...(plan.qa?.warnings || []), warning])],
      },
    },
    changed: true,
    removedSelectedIds,
    clearedZoneIds,
    requiresRegeneration: plan.workload_basis === 'selected_reps' && removedSelectedIds.length > 0,
  };
}

function normalizeIssueList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((issue) => typeof issue === 'string' ? issue : issue?.message).filter(Boolean);
}

export function normalizeCanvasPlannerResult(result, context = {}) {
  const zones = Array.isArray(result) ? result : Array.isArray(result?.zones) ? result.zones : [];
  const qa = Array.isArray(result) ? {} : (result?.qa || {});
  const diagnostics = Array.isArray(result) ? {} : (result?.diagnostics || {});
  const rawMethod = String(result?.method || result?.planning_method || result?.generation_method || diagnostics?.method || diagnostics?.generation_method || 'legacy_unverified').toLowerCase();
  const methodVerified = !UNVERIFIED_METHODS.has(rawMethod);
  const explicitRoadAligned = result?.road_aligned ?? result?.street_aligned ?? diagnostics?.road_aligned ?? diagnostics?.street_aligned;
  const explicitCuldesac = result?.culdesac_integrity
    ?? result?.cul_de_sac_integrity
    ?? diagnostics?.culdesac_integrity
    ?? diagnostics?.cul_de_sac_integrity
    ?? (qa?.protected_units_intact === true && Number(qa?.cul_de_sac_splits) === 0);
  const requestedZoneCount = Math.max(1, Number(context.requestedZoneCount) || 1);
  const doorCounts = zones.map((zone) => Math.max(0, Number(zone?.estimated_doors) || zone?.stable_door_ids?.length || 0));
  const averageDoors = doorCounts.length ? doorCounts.reduce((sum, count) => sum + count, 0) / doorCounts.length : 0;
  const maxImbalancePercent = averageDoors > 0
    ? Math.round(Math.max(...doorCounts.map((count) => Math.abs(count - averageDoors) / averageDoors)) * 100)
    : null;

  const blockingIssues = [
    ...normalizeIssueList(diagnostics?.blocking || result?.blocking),
    ...(zones.length ? [] : ['No usable areas were generated.']),
    ...(zones.some((zone) => !Array.isArray(zone?.geometry) || zone.geometry.length < 3) ? ['At least one generated area has invalid geometry.'] : []),
  ];
  const degradedIssues = [
    ...normalizeIssueList(diagnostics?.warnings || diagnostics?.degraded || result?.warnings),
    ...(context.roadFetchStatus === 'ready' ? [] : ['The road network was not ready for this draft.']),
    ...(methodVerified ? [] : ['The generator did not provide verifiable method diagnostics.']),
    ...(result?.planning_method === 'street_work_units' && !String(result?.algorithm_version || '').trim() ? ['The planner did not provide an algorithm version.'] : []),
    ...(result?.planning_method === 'street_work_units' && !String(result?.data_version || '').trim() ? ['The planner did not provide a road-data version.'] : []),
    ...(explicitRoadAligned === true ? [] : ['Street-boundary alignment was not explicitly verified.']),
    ...((explicitCuldesac === true || explicitCuldesac === 'passed') ? [] : ['Cul-de-sac integrity was not explicitly verified.']),
    ...(zones.length !== requestedZoneCount ? [`Requested ${requestedZoneCount} areas; generated ${zones.length}.`] : []),
    ...(maxImbalancePercent !== null && maxImbalancePercent > 25 ? [`Home-count imbalance reaches ${maxImbalancePercent}%.`] : []),
  ];

  return {
    zones,
    method: rawMethod,
    methodVerified,
    roadAligned: explicitRoadAligned === true,
    culdesacIntegrity: explicitCuldesac === true || explicitCuldesac === 'passed',
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
  const qa = result.qa || {};
  return result.ok === true
    && result.deployable === true
    && (result.status === 'ready' || result.status === 'degraded')
    && result.planning_method === 'street_work_units'
    && result.assignment_basis === 'stable_door_ids'
    && Boolean(String(result.algorithm_version || '').trim())
    && Boolean(String(result.data_version || '').trim())
    && qa.deployable === true
    && qa.coverage_complete === true
    && qa.no_duplicate_doors === true
    && qa.no_missing_doors === true
    && qa.connected_zones === true
    && qa.atomic_work_units === true
    && Number(qa.cul_de_sac_splits) === 0
    && qa.protected_units_intact === true
    && qa.data_quality_status === 'verified';
}

export function getCanvasGenerationBlockers({
  polygon,
  splitBasis,
  selectedTeamMemberIds = [],
  teamMembers = [],
  homesPerArea,
  analysis,
  roadFetchStatus,
}) {
  const blockers = [];
  const activeMemberIds = new Set(getActiveCanvasTeamMembers(teamMembers).map((member) => String(member.id)));
  const validSelectedIds = [...new Set(selectedTeamMemberIds.map((id) => String(id || '')).filter((id) => activeMemberIds.has(id)))];
  const opportunities = getStableOpportunityPoints(analysis);
  const totalOpportunities = Math.max(0, Number(analysis?.totalOpportunities) || 0);

  if (!Array.isArray(polygon) || polygon.length < 3) blockers.push('Draw the cold-knocking territory.');
  if (roadFetchStatus === 'loading') blockers.push('Wait for the street network to finish loading.');
  else if (roadFetchStatus !== 'ready') blockers.push('Street data is required; redraw or retry when the road network is available.');
  if (!analysis?.analysisId) blockers.push('Analyze the territory to discover stable home opportunities.');
  else if (!opportunities.length) blockers.push('The analysis did not return usable home opportunities.');
  if (totalOpportunities > opportunities.length) blockers.push(`Analysis returned ${opportunities.length} of ${totalOpportunities} homes; full coverage is required before dividing the territory.`);
  if (splitBasis === 'homes_per_area') {
    if (!Number.isFinite(Number(homesPerArea)) || Number(homesPerArea) < 1) blockers.push('Set a valid homes-per-area target.');
    else if (Math.ceil(opportunities.length / Math.max(1, Number(homesPerArea))) > MAX_CANVAS_ZONES) blockers.push(`Canvas supports at most ${MAX_CANVAS_ZONES} areas in one campaign. Increase the homes-per-area target.`);
  } else if (!validSelectedIds.length) {
    blockers.push('Select at least one active team member.');
  } else if (validSelectedIds.length > MAX_CANVAS_ZONES) {
    blockers.push(`Canvas supports at most ${MAX_CANVAS_ZONES} selected reps in one campaign.`);
  }

  return [...new Set(blockers)];
}

function pointInRing(point, ring = []) {
  if (!point || ring.length < 3) return false;
  let inside = false;
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = ring[index];
    const previous = ring[previousIndex];
    const intersects = ((current.lat > point.lat) !== (previous.lat > point.lat))
      && (point.lng < ((previous.lng - current.lng) * (point.lat - current.lat)) / ((previous.lat - current.lat) || Number.EPSILON) + current.lng);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function attachStableDoorsToCanvasZones(zones = [], opportunityPoints = []) {
  const normalizedZones = zones.map((zone, index) => ({
    ...zone,
    zone_id: String(zone?.zone_id || zone?.id || `canvas_zone_${Number(zone?.zone_number) || index + 1}`),
    stable_door_ids: [],
  }));
  const doors = [];
  const missingDoorIds = [];

  opportunityPoints.forEach((opportunity) => {
    const stableDoorId = String(opportunity?.stable_door_id || opportunity?.id || opportunity?.opportunity_id || '').trim();
    if (!stableDoorId) return;
    const matchingZone = normalizedZones.find((zone) => (zone.parts || [zone.geometry]).some((part) => pointInRing(opportunity, part)));
    if (!matchingZone) {
      missingDoorIds.push(stableDoorId);
      return;
    }
    matchingZone.stable_door_ids.push(stableDoorId);
    doors.push({
      stable_door_id: stableDoorId,
      address_hash: opportunity.address_hash || opportunity.addressHash || null,
      lat: Number(opportunity.lat),
      lng: Number(opportunity.lng),
      work_unit_id: opportunity.work_unit_id || opportunity.workUnitId || null,
      zone_id: matchingZone.zone_id,
    });
  });

  return { zones: normalizedZones, doors, missingDoorIds };
}

function normalizedQa(qa = {}) {
  return {
    deployable: qa.deployable === true,
    coverage_complete: qa.coverage_complete === true,
    no_duplicate_doors: qa.no_duplicate_doors === true,
    no_missing_doors: qa.no_missing_doors === true,
    connected_zones: qa.connected_zones === true,
    atomic_work_units: qa.atomic_work_units === true,
    cul_de_sac_splits: Math.max(0, Number(qa.cul_de_sac_splits) || 0),
    protected_units_intact: qa.protected_units_intact === true,
    data_quality_status: qa.data_quality_status || 'unverified',
    warnings: normalizeIssueList(qa.warnings),
  };
}

export function isCanvasPlanDeployable(plan = {}) {
  const qa = normalizedQa(plan.qa || plan.diagnostics?.qa);
  const doors = Array.isArray(plan.doors) ? plan.doors : [];
  const zones = Array.isArray(plan.zones) ? plan.zones : [];
  const selectedRepCount = new Set((plan.selected_team_member_ids || []).filter(Boolean)).size;
  const selectedRepIds = new Set((plan.selected_team_member_ids || []).map(String).filter(Boolean));
  const assignedRepIds = zones.map((zone) => String(zone?.assigned_team_member_id || '')).filter(Boolean);
  const selectedRepAssignmentsExact = plan.workload_basis !== 'selected_reps'
    || (selectedRepIds.size === zones.length
      && new Set(assignedRepIds).size === assignedRepIds.length
      && assignedRepIds.length === zones.length
      && assignedRepIds.every((id) => selectedRepIds.has(id)));
  return plan.planning_method === 'street_work_units'
    && plan.assignment_basis === 'stable_door_ids'
    && (plan.workload_basis === 'selected_reps' || plan.workload_basis === 'homes_per_area')
    && Boolean(String(plan.algorithm_version || '').trim())
    && Boolean(String(plan.data_version || '').trim())
    && doors.length > 0
    && doors.every((door) => door?.stable_door_id && door?.work_unit_id)
    && zones.length > 0
    && (plan.workload_basis !== 'selected_reps' || selectedRepCount === 0 || zones.length === selectedRepCount)
    && selectedRepAssignmentsExact
    && zones.every((zone) => zone?.assigned_team_member_id && Array.isArray(zone?.stable_door_ids))
    && qa.deployable
    && qa.coverage_complete
    && qa.no_duplicate_doors
    && qa.no_missing_doors
    && qa.connected_zones
    && qa.atomic_work_units
    && qa.cul_de_sac_splits === 0
    && qa.protected_units_intact
    && qa.data_quality_status === 'verified';
}

export function buildCanvasDraftPayload({
  sessionId,
  expectedVersion,
  sessionName,
  polygon,
  analysisId,
  plan,
}) {
  const qa = {
    ...normalizedQa(plan?.qa || plan?.diagnostics?.qa),
    deployable: isCanvasPlanDeployable(plan || {}),
  };
  const planningMethod = plan?.planning_method === 'street_work_units' ? 'street_work_units' : 'preview_only';
  const assignmentBasis = plan?.assignment_basis === 'stable_door_ids' ? 'stable_door_ids' : 'legacy_geometry';
  const workloadBasis = plan?.workload_basis === 'homes_per_area' ? 'homes_per_area' : 'selected_reps';
  const doors = (Array.isArray(plan?.doors) ? plan.doors : []).map((door) => ({
    stable_door_id: String(door.stable_door_id || door.id || ''),
    address_hash: door.address_hash || null,
    lat: Number(door.lat),
    lng: Number(door.lng),
    work_unit_id: door.work_unit_id || null,
    zone_id: door.zone_id || null,
  })).filter((door) => door.stable_door_id && Number.isFinite(door.lat) && Number.isFinite(door.lng));
  const zones = (Array.isArray(plan?.zones) ? plan.zones : []).map((zone, index) => ({
    zone_id: String(zone.zone_id || zone.id || `canvas_zone_${Number(zone.zone_number) || index + 1}`),
    zone_number: Number(zone.zone_number) || index + 1,
    geometry: zone.geometry || null,
    parts: Array.isArray(zone.parts) ? zone.parts : undefined,
    drop_point: zone.drop_point || null,
    assigned_team_member_id: zone.assigned_team_member_id || getCanvasZoneAssignmentIds(zone)[0] || null,
    stable_door_ids: Array.isArray(zone.stable_door_ids) ? [...new Set(zone.stable_door_ids.filter(Boolean))] : [],
    work_unit_ids: Array.isArray(zone.work_unit_ids) ? [...new Set(zone.work_unit_ids.filter(Boolean))] : [],
    estimated_minutes: Number.isFinite(Number(zone.estimated_minutes)) ? Number(zone.estimated_minutes) : undefined,
  }));

  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(expectedVersion !== undefined && expectedVersion !== null ? { expected_version: expectedVersion } : {}),
    session_name: String(sessionName || 'Canvas Draft Preview').trim() || 'Canvas Draft Preview',
    polygon,
    planning_method: planningMethod,
    assignment_basis: assignmentBasis,
    workload_basis: workloadBasis,
    selected_team_member_ids: [...new Set((plan?.selected_team_member_ids || []).map(String).filter(Boolean))],
    target_homes: doors.length,
    ...(analysisId && planningMethod === 'street_work_units' ? { analysis_id: analysisId } : {}),
    ...(plan?.algorithm_version ? { algorithm_version: plan.algorithm_version } : {}),
    ...(plan?.data_version ? { data_version: plan.data_version } : {}),
    zones,
    doors,
    qa,
  };
}
