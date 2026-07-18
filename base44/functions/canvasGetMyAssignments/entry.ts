import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { verifyCanvasLifecycleSession } from './canvasLifecycleSignature.js';

const MAX_ACTIVE_SESSIONS = 1000;
const MAX_LIFECYCLE_SESSIONS = 10000;
const LIFECYCLE_PAGE_SIZE = 500;
const MAX_RETURNED_DOORS = 10000;

function asArray(value: any) {
  return Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : []);
}

function normalized(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function repSafeDeploymentQa(qa: any) {
  return {
    lifecycle_state: qa?.lifecycle_state || null,
    validator_version: qa?.validator_version ?? null,
    topology_validator: qa?.topology_validator || null,
    server_algorithm_version: qa?.server_algorithm_version || null,
    server_data_version: qa?.server_data_version || null,
    door_coverage_complete: qa?.door_coverage_complete === true,
    connected_zones: qa?.connected_zones === true,
    atomic_work_units: qa?.atomic_work_units === true,
    protected_units_intact: qa?.protected_units_intact === true,
    cul_de_sac_splits: Number(qa?.cul_de_sac_splits) || 0,
    data_quality_status: qa?.data_quality_status || 'unverified',
    door_count: Number(qa?.door_count) || 0,
    zone_count: Number(qa?.zone_count) || 0,
    work_unit_count: Number(qa?.work_unit_count) || 0,
    verified_at: qa?.verified_at || null
  };
}

function deploymentSigningSecret() {
  const secret = Deno.env.get('CANVAS_DEPLOYMENT_SIGNING_SECRET') || '';
  if (secret.length < 32) {
    const error: any = new Error('Canvas assignment verification is not configured.');
    error.status = 503;
    error.code = 'canvas_signing_unavailable';
    throw error;
  }
  return secret;
}

async function resolveAuthenticatedTeamMember(base44: any, user: any) {
  const expectedManagerId = String(user?.team_manager_id || user?.data?.team_manager_id || '').trim();
  if (!expectedManagerId) return null;
  const primary = asArray(await base44.entities.TeamMember.filter({
    user_id: user.id,
    status: 'active'
  }, '-updated_date', 20).catch(() => []));

  let candidates = primary.filter((member) =>
    member.user_id === user.id
    && member.status === 'active'
    && normalized(member.role) === 'rep'
    && member.manager_id === expectedManagerId
  );

  // Legacy email fallback remains tenant-bound and refuses a TeamMember row
  // already linked to a different auth user. New invite redemptions use user_id.
  let resolution = 'user_id';
  if (candidates.length === 0 && user?.email) {
    const email = normalized(user.email);
    const byEmail = asArray(await base44.entities.TeamMember.filter({
      email,
      status: 'active'
    }, '-updated_date', 20).catch(() => []));
    candidates = byEmail.filter((member) =>
      normalized(member.email) === email
      && member.status === 'active'
      && normalized(member.role) === 'rep'
      && (!member.user_id || member.user_id === user.id)
      && member.manager_id === expectedManagerId
    );
    resolution = 'email_fallback';
  }

  const uniqueById = new Map(candidates.map((member) => [member.id, member]));
  if (uniqueById.size === 0) return null;
  if (uniqueById.size > 1) {
    const error: any = new Error('More than one active TeamMember record matches this account. Ask the manager to repair the roster link.');
    error.status = 409;
    error.code = 'ambiguous_team_membership';
    throw error;
  }
  const member: any = [...uniqueById.values()][0];
  if (!member.manager_id) return null;
  return { member, resolution };
}

function activeValidDeployments(validSessions: any[]) {
  const validById = new Map(validSessions.map((session) => [session.id, session]));
  const supersededIds = new Set<string>();
  for (const newer of validSessions) {
    const newerTimestamp = Date.parse(newer.deployed_at || '');
    for (const supersededId of asArray(newer.deployment_qa?.superseded_session_ids)) {
      const older = validById.get(supersededId);
      if (!older || older.id === newer.id || older.manager_id !== newer.manager_id) continue;
      const olderTimestamp = Date.parse(older.deployed_at || '');
      if (Number.isFinite(newerTimestamp) && Number.isFinite(olderTimestamp) && newerTimestamp >= olderTimestamp) {
        supersededIds.add(older.id);
      }
    }
  }
  return {
    active: validSessions.filter((session) => session.status === 'deployed'
      && session.lifecycle_state === 'active'
      && !supersededIds.has(session.id)),
    supersededIds
  };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const membership = await resolveAuthenticatedTeamMember(base44, user);
    if (!membership) {
      return Response.json({ error: 'team_membership_required', message: 'No active linked rep record was found for this account.' }, { status: 403 });
    }
    const { member, resolution } = membership;
    const signingSecret = deploymentSigningSecret();
    const body = await req.json().catch(() => ({}));
    const requestedSessionId = body?.session_id ? String(body.session_id).trim() : null;
    if (requestedSessionId && requestedSessionId.length > 256) {
      return Response.json({ error: 'invalid_session_id' }, { status: 400 });
    }

    // CanvasSession RLS is manager/admin-only so reps cannot query drafts or
    // other reps' zones directly. Service role is used only after exact active
    // TeamMember resolution, and the result remains tenant- and assignee-filtered.
    const lifecycleRows = [];
    for (const status of ['deployed', 'completed', 'recalled']) {
      let skip = 0;
      while (true) {
        const page = asArray(await base44.asServiceRole.entities.CanvasSession.filter({
          manager_id: member.manager_id,
          status
        }, '-deployed_at', LIFECYCLE_PAGE_SIZE, skip));
        lifecycleRows.push(...page);
        if (lifecycleRows.length > MAX_LIFECYCLE_SESSIONS) {
          const error: any = new Error('Canvas lifecycle history exceeds the safe assignment verification limit.');
          error.status = 503;
          error.code = 'canvas_lifecycle_scan_limit';
          throw error;
        }
        if (page.length < LIFECYCLE_PAGE_SIZE) break;
        skip += page.length;
      }
    }
    const allCandidateSessions = [...new Map(lifecycleRows
      .filter((session) => session.manager_id === member.manager_id
        && ['deployed', 'completed', 'recalled'].includes(session.status))
      .map((session) => [session.id, session])).values()];
    const validSessions = [];
    const invalidDeploymentIds = [];
    for (const session of allCandidateSessions) {
      if (!await verifyCanvasLifecycleSession(signingSecret, session)) {
        invalidDeploymentIds.push(session.id);
        continue;
      }
      validSessions.push(session);
    }
    if (invalidDeploymentIds.length) {
      const error: any = new Error('The requested Canvas deployment failed server integrity verification.');
      error.status = 409;
      error.code = 'deployment_signature_invalid';
      throw error;
    }

    const { active: activeSessions, supersededIds } = activeValidDeployments(validSessions);
    if (activeSessions.length > MAX_ACTIVE_SESSIONS) {
      const error: any = new Error('Too many active Canvas sessions exist to verify assignments safely.');
      error.status = 503;
      error.code = 'canvas_assignment_scan_limit';
      throw error;
    }
    const sessions = requestedSessionId
      ? activeSessions.filter((session) => session.id === requestedSessionId)
      : activeSessions;
    const assignments = [];
    let returnedDoorCount = 0;
    for (const session of sessions) {
      const assignedToMember = asArray(session.zones)
        .some((zone) => String(zone?.assigned_team_member_id || '') === String(member.id));
      if (assignedToMember) {
        const bindings = asArray(session.deployment_qa?.verified_team_member_bindings);
        const binding = bindings.find((candidate) => String(candidate?.team_member_id || '') === String(member.id));
        if (!binding
          || String(binding.user_id || '') !== String(user.id || '')
          || normalized(binding.email) !== normalized(user.email)
          || String(member.user_id || '') !== String(user.id || '')) {
          const error: any = new Error('The signed Canvas assignment no longer matches this TeamMember authentication link.');
          error.status = 409;
          error.code = 'deployment_rep_binding_invalid';
          throw error;
        }
      }
      const doorsById = new Map(asArray(session.doors).map((door) => [door?.stable_door_id, door]));
      for (const zone of asArray(session.zones)) {
        if (zone?.assigned_team_member_id !== member.id) continue;
        const doorIds = asArray(zone.stable_door_ids);
        const doors = [];
        for (const doorId of doorIds) {
          if (returnedDoorCount >= MAX_RETURNED_DOORS) break;
          const door = doorsById.get(doorId);
          if (!door) continue;
          doors.push(door);
          returnedDoorCount += 1;
        }
        assignments.push({
          session_id: session.id,
          session_name: session.session_name || 'Canvas Campaign',
          version: Number(session.version || 0),
          plan_hash: session.plan_hash || null,
          planning_method: session.planning_method,
          assignment_basis: session.assignment_basis,
          workload_basis: session.workload_basis,
          deployed_at: session.deployed_at,
          deployment_qa: repSafeDeploymentQa(session.deployment_qa),
          zone: {
            zone_id: zone.zone_id,
            zone_number: zone.zone_number,
            geometry: zone.geometry || null,
            parts: zone.parts || null,
            drop_point: zone.drop_point || null,
            stable_door_ids: doorIds,
            work_unit_ids: asArray(zone.work_unit_ids),
            estimated_minutes: zone.estimated_minutes ?? null,
            assigned_team_member_id: member.id
          },
          doors
        });
      }
      if (returnedDoorCount >= MAX_RETURNED_DOORS) break;
    }

    return Response.json({
      success: true,
      team_member_id: member.id,
      manager_id: member.manager_id,
      membership_resolution: resolution,
      assignments,
      returned_doors: returnedDoorCount,
      truncated: returnedDoorCount >= MAX_RETURNED_DOORS,
      rejected_deployments: invalidDeploymentIds.length,
      superseded_deployments: supersededIds.size,
      server_time: new Date().toISOString()
    });
  } catch (error: any) {
    if (error?.status && error?.code) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    console.error('[canvasGetMyAssignments]', error?.message || error);
    return Response.json({ error: 'canvas_assignments_unavailable', message: 'Canvas assignments could not be loaded.' }, { status: 500 });
  }
});
