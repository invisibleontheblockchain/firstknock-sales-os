import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_ASSIGNMENTS = 250;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function asArray(value: any) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
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
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_assignment_request', `${field} is required or invalid.`);
  return result;
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

function storedPlanForHash(session: any) {
  return {
    session_name: session?.session_name || 'Canvas Campaign', territory_model: session?.territory_model || 'street_territory_v1',
    polygon: asArray(session?.polygon), rep_count: Number(session?.rep_count || 0), planning_method: session?.planning_method,
    assignment_basis: session?.assignment_basis, workload_basis: session?.workload_basis, division_mode: session?.division_mode,
    target_workload: session?.target_workload === null || session?.target_workload === undefined ? null : Number(session.target_workload),
    ...(Array.isArray(session?.selected_team_member_ids) ? { selected_team_member_ids: session.selected_team_member_ids } : {}),
    zones: asArray(session?.zones), work_units: asArray(session?.work_units), qa: session?.qa || {},
    algorithm_version: session?.algorithm_version || null, data_version: session?.data_version || null,
    ...(session?.territory_model === 'residential_street_territory_v2' ? {
      evidence_id: session?.evidence_id, revision_id: session?.revision_id || null, snapshot_hash: session?.snapshot_hash,
      evidence_schema_version: Number(session?.evidence_schema_version), unresolved_unit_count: Number(session?.unresolved_unit_count || 0),
      assignment_version: Number(session?.assignment_version || 0)
    } : {}),
    manager_id: session?.manager_id, version: Number(session?.version)
  };
}

async function validateTeamMembers(base44: any, managerId: string, memberIds: string[]) {
  const requested = [...new Set(memberIds.map(String))];
  if (!requested.length) return [];
  const rows = [];
  for (let index = 0; index < requested.length; index += 100) {
    const ids = requested.slice(index, index + 100);
    rows.push(...asArray(await base44.asServiceRole.entities.TeamMember.filter({ manager_id: managerId, id: { $in: ids } }, null, ids.length, 0)));
  }
  const byId = new Map(rows.map((member: any) => [String(member?.id || ''), member]));
  if (byId.size !== requested.length || rows.length !== requested.length) throw new HttpError(422, 'invalid_team_assignment', 'One or more assigned reps are outside this manager tenant.');
  const members = requested.map((id) => byId.get(id));
  for (const member of members) {
    if (!member || member.manager_id !== managerId || member.status !== 'active' || normalized(member.role) !== 'rep' || !String(member.user_id || '').trim()) {
      throw new HttpError(422, 'invalid_team_assignment', `Team member ${member?.id || 'unknown'} is not an active linked rep owned by this manager.`);
    }
  }
  const userIds = members.map((member: any) => String(member.user_id));
  if (new Set(userIds).size !== userIds.length) throw new HttpError(422, 'unverified_team_link', 'Each Canvas rep must map to a distinct authenticated user.');
  const users = [];
  for (let index = 0; index < userIds.length; index += 100) {
    const ids = userIds.slice(index, index + 100);
    users.push(...asArray(await base44.asServiceRole.entities.User.filter({ team_manager_id: managerId, id: { $in: ids } }, null, ids.length, 0)));
  }
  const usersById = new Map(users.map((repUser: any) => [String(repUser?.id || ''), repUser]));
  for (const member of members) {
    const repUser: any = usersById.get(String(member.user_id));
    if (!repUser || repUser.team_manager_id !== managerId || normalized(repUser.email) !== normalized(member.email)) throw new HttpError(422, 'unverified_team_link', `Team member ${member.id} is not linked to an authenticated user in this manager tenant.`);
  }
  return members;
}

function normalizedAssignments(body: any) {
  const raw = body?.assignments ?? body?.zone_assignments;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ASSIGNMENTS) throw new HttpError(400, 'invalid_assignment_request', `assignments must contain 1-${MAX_ASSIGNMENTS} records.`);
  const zoneIds = new Set<string>();
  return raw.map((assignment, index) => {
    const zoneId = requiredString(assignment?.zone_id, `assignments[${index}].zone_id`, 512);
    if (zoneIds.has(zoneId)) throw new HttpError(400, 'duplicate_zone_assignment', `Zone ${zoneId} appears more than once.`);
    zoneIds.add(zoneId);
    const rawMemberId = assignment?.assigned_team_member_id ?? assignment?.team_member_id;
    const memberId = rawMemberId === undefined || rawMemberId === null || rawMemberId === '' ? null : requiredString(rawMemberId, `assignments[${index}].assigned_team_member_id`);
    return { zone_id: zoneId, assigned_team_member_id: memberId };
  });
}

function assignmentReadiness(session: any, zones: any[]) {
  const assignees = zones.map((zone) => String(zone?.assigned_team_member_id || '').trim()).filter(Boolean);
  const uniqueAssignees = [...new Set(assignees)].sort();
  const everyZoneAssigned = zones.length > 0 && assignees.length === zones.length;
  const selectedRepContract = session.division_mode !== 'selected_reps'
    || zones.length === uniqueAssignees.length && new Set(assignees).size === zones.length;
  const qa = {
    ...(session.qa || {}),
    every_zone_assigned: everyZoneAssigned,
    selected_reps_one_to_one: session.division_mode === 'selected_reps' ? selectedRepContract : null
  };
  const partitionReady = qa.street_coverage_complete === true && qa.no_duplicate_work_units === true
    && qa.no_missing_work_units === true
    && qa.connected_zones === true && qa.atomic_work_units === true && qa.protected_units_intact === true
    && Number(qa.cul_de_sac_splits || 0) === 0;
  const workloadExceptionReady = !(Number(qa.max_workload_deviation_percent) > 25) || qa.manager_workload_exception_acknowledged === true;
  const trustedEvidence = qa.evidence_trust === 'trusted' && qa.trusted_evidence === true;
  qa.trusted_evidence = trustedEvidence;
  qa.deployable = partitionReady && everyZoneAssigned && selectedRepContract
    && Number(session.unresolved_unit_count || 0) === 0 && workloadExceptionReady && trustedEvidence;
  const lifecycleState = uniqueAssignees.length === 0
    ? 'saved_unassigned'
    : qa.deployable ? 'ready_to_send' : 'partially_assigned';
  return { assignees: uniqueAssignees, qa, lifecycleState };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'manager_access_required' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const sessionId = requiredString(body?.session_id, 'session_id');
    const expectedVersion = Number(body?.expected_version);
    const expectedAssignmentVersion = Number(body?.expected_assignment_version);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(expectedAssignmentVersion) || expectedAssignmentVersion < 0) throw new HttpError(400, 'invalid_assignment_request', 'Expected plan and assignment versions are required.');
    const session = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
    if (!session) throw new HttpError(404, 'session_not_found', 'Canvas session not found.');
    if (String(session.manager_id || '') !== String(user.id || '')) throw new HttpError(403, 'forbidden', 'This Canvas session belongs to another manager tenant.');
    if (session.status !== 'draft' || session.territory_model !== 'residential_street_territory_v2') throw new HttpError(409, 'assignment_state_invalid', 'Only a saved residential Canvas v2 draft can be assigned.');
    if (Number(session.version) !== expectedVersion || Number(session.assignment_version || 0) !== expectedAssignmentVersion) throw new HttpError(409, 'version_conflict', 'The Canvas assignment changed. Reload before saving.');
    if (await sha256(storedPlanForHash(session)) !== session.plan_hash) throw new HttpError(409, 'plan_hash_mismatch', 'The Canvas draft failed canonical plan verification.');
    const assignments = normalizedAssignments(body);
    const assignmentByZoneId = new Map(assignments.map((assignment) => [assignment.zone_id, assignment.assigned_team_member_id]));
    const existingZoneIds = new Set(asArray(session.zones).map((zone) => String(zone?.zone_id || '')));
    for (const zoneId of assignmentByZoneId.keys()) if (!existingZoneIds.has(zoneId)) throw new HttpError(404, 'zone_not_found', `Zone ${zoneId} does not belong to this Canvas draft.`);
    const zones = asArray(session.zones).map((zone) => assignmentByZoneId.has(String(zone.zone_id)) ? { ...zone, assigned_team_member_id: assignmentByZoneId.get(String(zone.zone_id)) } : zone);
    const readiness = assignmentReadiness(session, zones);
    await validateTeamMembers(base44, String(user.id), readiness.assignees);
    const nextVersion = expectedVersion + 1;
    const nextAssignmentVersion = expectedAssignmentVersion + 1;
    const nextPlan = {
      ...session,
      zones,
      selected_team_member_ids: readiness.assignees,
      rep_count: readiness.assignees.length,
      qa: readiness.qa,
      lifecycle_state: readiness.lifecycleState,
      version: nextVersion,
      assignment_version: nextAssignmentVersion,
      draft_saved_at: new Date().toISOString()
    };
    const planHash = await sha256(storedPlanForHash(nextPlan));
    const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({ id: session.id, manager_id: user.id, status: 'draft', territory_model: 'residential_street_territory_v2', version: expectedVersion, assignment_version: expectedAssignmentVersion, plan_hash: session.plan_hash }, { $set: { zones, selected_team_member_ids: readiness.assignees, rep_count: readiness.assignees.length, qa: readiness.qa, lifecycle_state: readiness.lifecycleState, version: nextVersion, assignment_version: nextAssignmentVersion, plan_hash: planHash, draft_saved_at: nextPlan.draft_saved_at } });
    if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) throw new HttpError(409, 'version_conflict', 'The Canvas assignment changed before it committed.');
    const saved = await base44.entities.CanvasSession.get(session.id).catch(() => null);
    if (!saved || saved.manager_id !== user.id || saved.plan_hash !== planHash || Number(saved.version) !== nextVersion || Number(saved.assignment_version) !== nextAssignmentVersion) throw new HttpError(503, 'assignment_commit_unverified', 'The Canvas assignment could not be verified after saving.');
    return Response.json({ success: true, session_id: saved.id, status: saved.status, lifecycle_state: saved.lifecycle_state, version: nextVersion, assignment_version: nextAssignmentVersion, plan_hash: planHash, assigned_zone_count: zones.filter((zone) => zone.assigned_team_member_id).length, zone_count: zones.length, rep_team_member_ids: readiness.assignees, unresolved_unit_count: Number(saved.unresolved_unit_count || 0), ready_to_send: saved.lifecycle_state === 'ready_to_send' });
  } catch (error: any) {
    if (error instanceof HttpError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
    console.error('[canvasAssignTerritories]', error?.message || error);
    return Response.json({ error: 'canvas_assignment_failed', message: 'Canvas assignments could not be saved.' }, { status: 503 });
  }
});
