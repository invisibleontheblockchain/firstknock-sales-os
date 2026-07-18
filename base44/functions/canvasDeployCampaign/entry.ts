import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { Client } from 'npm:@neondatabase/serverless@0.9.0';
import Stripe from 'npm:stripe@14.14.0';
import { canvasRepTeamMemberIds, canvasStoredPlanForHash, signCanvasLifecycle, verifyCanvasLifecycleSession } from './canvasLifecycleSignature.js';
import { planCanvasTerritories } from './canvasStreetTerritoryPlanner.js';

const CANVAS_PRICE_FLOOR_CENTS = 1900;
const MAX_DOORS = 10000;
const MAX_ZONES = 250;
const MAX_CONFLICT_SCAN_SESSIONS = 1000;
const MAX_LIFECYCLE_SCAN_SESSIONS = 10000;
const LIFECYCLE_PAGE_SIZE = 500;
const MAX_OSM_JSON_BYTES = 20_000_000;
const MAX_OSM_ELEMENTS = 250_000;
const OVERPASS_TIMEOUT_MS = 15_000;
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const CANVAS_HIGHWAY_FILTER = 'primary|secondary|tertiary|unclassified|residential|living_street';
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

async function withManagerDeploymentLock(managerId: string, action: () => Promise<any>) {
  const databaseUrl = Deno.env.get('DATABASE_URL');
  if (!databaseUrl) {
    throw new HttpError(503, 'canvas_deployment_lock_unavailable', 'Canvas deployment locking is unavailable. Nothing was deployed.');
  }
  const client = new Client(databaseUrl);
  let began = false;
  try {
    await client.connect();
    await client.query('BEGIN');
    began = true;
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
      [`canvas-deploy:${managerId}`]
    );
    if (lockResult?.rows?.[0]?.acquired !== true) {
      throw new HttpError(409, 'canvas_deployment_in_progress', 'Another Canvas deployment is committing for this manager. Retry after it finishes.');
    }
    const result = await action();
    await client.query('COMMIT');
    began = false;
    return result;
  } catch (error: any) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'canvas_deployment_lock_unavailable', 'Canvas deployment locking failed. Nothing was deployed.');
  } finally {
    await client.end().catch(() => {});
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

function isPrivileged(user: any) {
  return normalized(user?.role || user?.data?.role) === 'admin';
}

function stripeResourceId(value: any) {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id || null;
}

function subscriptionPriceCents(subscription: any) {
  return Math.max(0, ...(subscription?.items?.data || []).map((item: any) => Number(item?.price?.unit_amount || 0)));
}

function subscriptionTier(subscription: any) {
  const priceTier = (subscription?.items?.data || [])
    .map((item: any) => normalized(item?.price?.metadata?.subscription_tier))
    .find(Boolean);
  return priceTier || normalized(subscription?.metadata?.subscription_tier);
}

function subscriptionSeats(subscription: any) {
  return Math.max(0, (subscription?.items?.data || []).reduce((sum: number, item: any) => {
    const itemTier = normalized(item?.price?.metadata?.subscription_tier) || subscriptionTier(subscription);
    return sum + (itemTier === 'canvas' ? Math.max(0, Math.floor(Number(item?.quantity || 1))) : 0);
  }, 0));
}

function invoiceCoversCurrentPeriod(subscription: any, invoice: any) {
  const periodStart = Number(subscription?.current_period_start);
  if (!Number.isFinite(periodStart) || periodStart <= 0) return false;
  if ((invoice?.lines?.data || []).some((line: any) => {
    const lineSubscription = stripeResourceId(line?.subscription);
    const start = Number(line?.period?.start);
    const end = Number(line?.period?.end);
    return (!lineSubscription || lineSubscription === subscription.id)
      && Number.isFinite(start) && Number.isFinite(end)
      && start <= periodStart && periodStart < end;
  })) return true;
  const start = Number(invoice?.period_start);
  const end = Number(invoice?.period_end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= periodStart && periodStart < end;
}

function hasPaidCurrentInvoice(subscription: any) {
  const invoice = subscription?.latest_invoice;
  if (!invoice || typeof invoice === 'string') return false;
  const invoiceSubscription = stripeResourceId(invoice.subscription);
  return invoice.status === 'paid'
    && Number(invoice.amount_paid || 0) > 0
    && (!invoiceSubscription || invoiceSubscription === subscription.id)
    && invoiceCoversCurrentPeriod(subscription, invoice);
}

function ownedCanvasSubscription(subscription: any, user: any) {
  return subscription
    && String(subscription?.metadata?.base44_user_id || '') === String(user.id)
    && subscriptionTier(subscription) === 'canvas'
    && subscriptionPriceCents(subscription) >= CANVAS_PRICE_FLOOR_CENTS;
}

async function retrieveSubscription(stripe: any, id: string) {
  try {
    return await stripe.subscriptions.retrieve(id, {
      expand: ['latest_invoice', 'default_payment_method', 'customer.invoice_settings.default_payment_method']
    });
  } catch (error: any) {
    if (error?.raw?.code === 'resource_missing' || error?.code === 'resource_missing') return null;
    throw error;
  }
}

async function trialHasLivePaymentMethod(stripe: any, subscription: any, user: any) {
  if (stripeResourceId(subscription?.default_payment_method)) return true;
  const customer = typeof subscription?.customer === 'object'
    ? subscription.customer
    : await stripe.customers.retrieve(stripeResourceId(subscription?.customer));
  if (!customer || customer.deleted) return false;
  if (customer.metadata?.base44_user_id && String(customer.metadata.base44_user_id) !== String(user.id)) return false;
  return Boolean(stripeResourceId(customer?.invoice_settings?.default_payment_method));
}

async function resolveCanvasEntitlement(user: any) {
  if (isPrivileged(user)) return { kind: 'privileged', seats: Number.POSITIVE_INFINITY, subscription_id: null };
  const secret = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secret) throw new HttpError(503, 'canvas_billing_unavailable', 'Canvas billing verification is unavailable. Deployment was not changed.');
  const stripe = new Stripe(secret);
  const candidates = new Map<string, any>();

  if (user?.subscription_id) {
    const direct = await retrieveSubscription(stripe, String(user.subscription_id));
    if (direct) candidates.set(direct.id, direct);
  }
  if (user?.stripe_customer_id) {
    const listed = await stripe.subscriptions.list({
      customer: String(user.stripe_customer_id),
      status: 'all',
      limit: 20,
      expand: ['data.latest_invoice', 'data.default_payment_method', 'data.customer.invoice_settings.default_payment_method']
    });
    for (const subscription of listed.data || []) candidates.set(subscription.id, subscription);
  }
  if (typeof stripe.subscriptions.search === 'function') {
    const escapedUserId = String(user.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const found = await stripe.subscriptions.search({
      query: `metadata['base44_user_id']:'${escapedUserId}'`,
      limit: 20,
      expand: ['data.latest_invoice', 'data.default_payment_method', 'data.customer.invoice_settings.default_payment_method']
    });
    for (const subscription of found.data || []) candidates.set(subscription.id, subscription);
  }

  const ordered = [...candidates.values()].sort((left, right) =>
    Number(right.current_period_start || right.created || 0) - Number(left.current_period_start || left.created || 0)
    || String(left.id).localeCompare(String(right.id))
  );
  for (const subscription of ordered) {
    if (!ownedCanvasSubscription(subscription, user)) continue;
    const seats = subscriptionSeats(subscription);
    if (subscription.status === 'active' && hasPaidCurrentInvoice(subscription)) {
      return { kind: 'paid', seats, subscription_id: subscription.id };
    }
    const trialEndsAt = Number(subscription.trial_end || 0) * 1000;
    if (subscription.status === 'trialing' && trialEndsAt > Date.now() && await trialHasLivePaymentMethod(stripe, subscription, user)) {
      return { kind: 'trial', seats, subscription_id: subscription.id };
    }
  }
  throw new HttpError(403, 'canvas_entitlement_required', 'A live paid or card-backed trial Canvas subscription is required to deploy.');
}

function requiredString(value: unknown, field: string, maxLength = 512) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength) throw new HttpError(400, 'invalid_deploy_request', `${field} is required or invalid.`);
  return result;
}

function asArray(value: any) {
  return Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : []);
}

function optionalUniqueIdList(value: any, field: string, maxItems = MAX_CONFLICT_SCAN_SESSIONS) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, 'invalid_deploy_request', `${field} must be an array with at most ${maxItems} identifiers.`);
  }
  const ids = value.map((id, index) => requiredString(id, `${field}[${index}]`, 256));
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(400, 'invalid_deploy_request', `${field} cannot contain duplicate identifiers.`);
  }
  return ids;
}

function sameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: any) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deploymentSigningSecret() {
  const secret = Deno.env.get('CANVAS_DEPLOYMENT_SIGNING_SECRET') || '';
  if (secret.length < 32) {
    throw new HttpError(503, 'canvas_signing_unavailable', 'Canvas deployment signing is not configured. The draft was not changed.');
  }
  return secret;
}

function validatePlan(session: any) {
  if (session.status !== 'draft') throw new HttpError(409, 'invalid_plan_status', 'Only a draft Canvas plan can be deployed.');
  if (session.planning_method !== 'street_work_units') {
    throw new HttpError(422, 'preview_not_deployable', 'Canvas deployment requires the street_work_units planning method.');
  }
  if (session.assignment_basis !== 'stable_door_ids') {
    throw new HttpError(422, 'unstable_assignment_basis', 'Canvas deployment requires stable door identity assignments.');
  }
  if (!WORKLOAD_BASES.has(session.workload_basis)) {
    throw new HttpError(422, 'invalid_workload_basis', 'Canvas workload basis is missing or invalid.');
  }
  if (!String(session.algorithm_version || '').trim() || !String(session.data_version || '').trim()) {
    throw new HttpError(422, 'unversioned_plan', 'Canvas algorithm_version and data_version are required for deployment.');
  }

  const doors = asArray(session.doors);
  const zones = asArray(session.zones);
  if (doors.length < 1 || doors.length > MAX_DOORS || zones.length < 1 || zones.length > MAX_ZONES) {
    throw new HttpError(422, 'invalid_plan_size', 'Canvas deployment requires at least one door and zone within supported limits.');
  }
  const doorById = new Map<string, any>();
  for (const door of doors) {
    const id = requiredString(door?.stable_door_id, 'stable_door_id');
    if (doorById.has(id)) throw new HttpError(422, 'duplicate_stable_door_id', `Door ${id} is duplicated in the plan snapshot.`);
    if (!String(door?.work_unit_id || '').trim()) throw new HttpError(422, 'missing_work_unit', `Door ${id} has no street work unit.`);
    doorById.set(id, door);
  }
  if (Number(session.target_homes) !== doorById.size) {
    throw new HttpError(422, 'target_home_mismatch', 'target_homes does not equal the unique door snapshot count.');
  }

  const zoneById = new Map<string, any>();
  const doorZoneCounts = new Map<string, number>();
  const doorZoneById = new Map<string, string>();
  const workUnitZoneCounts = new Map<string, number>();
  const workUnitZoneById = new Map<string, string>();
  const assignedRepIds = new Set<string>();
  const zoneAssigneeIds: string[] = [];
  for (const zone of zones) {
    const zoneId = requiredString(zone?.zone_id, 'zone_id');
    if (zoneById.has(zoneId)) throw new HttpError(422, 'duplicate_zone', `Zone ${zoneId} is duplicated.`);
    zoneById.set(zoneId, zone);
    const repId = requiredString(zone?.assigned_team_member_id, `Zone ${zoneId} assigned_team_member_id`, 256);
    assignedRepIds.add(repId);
    zoneAssigneeIds.push(repId);

    const zoneDoorIds = asArray(zone?.stable_door_ids).map((id) => requiredString(id, `Zone ${zoneId} stable_door_ids`));
    if (new Set(zoneDoorIds).size !== zoneDoorIds.length) throw new HttpError(422, 'duplicate_door_assignment', `Zone ${zoneId} repeats a door.`);
    for (const doorId of zoneDoorIds) {
      doorZoneCounts.set(doorId, (doorZoneCounts.get(doorId) || 0) + 1);
      if (!doorZoneById.has(doorId)) doorZoneById.set(doorId, zoneId);
    }

    const zoneWorkUnitIds = asArray(zone?.work_unit_ids).map((id) => requiredString(id, `Zone ${zoneId} work_unit_ids`));
    if (new Set(zoneWorkUnitIds).size !== zoneWorkUnitIds.length) throw new HttpError(422, 'duplicate_work_unit_reference', `Zone ${zoneId} repeats a work unit.`);
    for (const unitId of zoneWorkUnitIds) {
      workUnitZoneCounts.set(unitId, (workUnitZoneCounts.get(unitId) || 0) + 1);
      if (!workUnitZoneById.has(unitId)) workUnitZoneById.set(unitId, zoneId);
    }
  }

  const missingDoorIds = [...doorById.keys()].filter((id) => !doorZoneCounts.has(id));
  const duplicateDoorIds = [...doorZoneCounts].filter(([, count]) => count !== 1).map(([id]) => id);
  const extraDoorIds = [...doorZoneCounts.keys()].filter((id) => !doorById.has(id));
  if (missingDoorIds.length || duplicateDoorIds.length || extraDoorIds.length) {
    throw new HttpError(422, 'door_coverage_failed', 'Every target door must appear in exactly one zone.', {
      missing_door_ids: missingDoorIds.slice(0, 100),
      duplicate_door_ids: duplicateDoorIds.slice(0, 100),
      extra_door_ids: extraDoorIds.slice(0, 100)
    });
  }

  const doorWorkUnitIds = new Set([...doorById.values()].map((door) => String(door.work_unit_id).trim()));
  const missingWorkUnitIds = [...doorWorkUnitIds].filter((id) => !workUnitZoneCounts.has(id));
  const duplicateWorkUnitIds = [...workUnitZoneCounts].filter(([, count]) => count !== 1).map(([id]) => id);
  const extraWorkUnitIds = [...workUnitZoneCounts.keys()].filter((id) => !doorWorkUnitIds.has(id));
  const mismatchedDoorIds = [...doorById].filter(([doorId, door]) => {
    const assignedZoneId = doorZoneById.get(doorId);
    const unitZoneId = workUnitZoneById.get(String(door.work_unit_id).trim());
    return !assignedZoneId || assignedZoneId !== unitZoneId || (door.zone_id && door.zone_id !== assignedZoneId);
  }).map(([doorId]) => doorId);
  if (missingWorkUnitIds.length || duplicateWorkUnitIds.length || extraWorkUnitIds.length || mismatchedDoorIds.length) {
    throw new HttpError(422, 'work_unit_integrity_failed', 'Street work units must be complete, exclusive, and assigned with all of their doors.', {
      missing_work_unit_ids: missingWorkUnitIds.slice(0, 100),
      duplicate_work_unit_ids: duplicateWorkUnitIds.slice(0, 100),
      extra_work_unit_ids: extraWorkUnitIds.slice(0, 100),
      mismatched_door_ids: mismatchedDoorIds.slice(0, 100)
    });
  }

  const selectedTeamMemberIds = asArray(session.selected_team_member_ids)
    .map((id, index) => requiredString(id, `selected_team_member_ids[${index}]`, 256));
  if (new Set(selectedTeamMemberIds).size !== selectedTeamMemberIds.length) {
    throw new HttpError(422, 'selected_rep_contract_failed', 'selected_team_member_ids contains a duplicate TeamMember ID.');
  }
  if (session.workload_basis === 'selected_reps') {
    const oneToOne = selectedTeamMemberIds.length > 0
      && zones.length === selectedTeamMemberIds.length
      && zoneAssigneeIds.length === zones.length
      && new Set(zoneAssigneeIds).size === zoneAssigneeIds.length
      && sameIdSet(selectedTeamMemberIds, zoneAssigneeIds);
    if (!oneToOne) {
      throw new HttpError(422, 'selected_rep_contract_failed', 'Selected-reps deployments require exactly one zone per selected TeamMember with no omitted, duplicate, or extra assignees.', {
        selected_team_member_ids: selectedTeamMemberIds,
        zone_assignee_ids: zoneAssigneeIds,
        zone_count: zones.length
      });
    }
  }

  return {
    doors,
    zones,
    assignedRepIds: [...assignedRepIds],
    workUnitCount: doorWorkUnitIds.size,
    deploymentQa: {
      identity_validator_version: 1,
      stable_door_ids_unique: true,
      door_coverage_complete: true,
      work_units_complete_and_exclusive: true,
      selected_reps_one_to_one: session.workload_basis === 'selected_reps' ? true : null,
      door_count: doors.length,
      zone_count: zones.length,
      work_unit_count: doorWorkUnitIds.size
    }
  };
}

async function validateTeamMembers(base44: any, managerId: string, memberIds: string[]) {
  const members = [];
  for (const memberId of memberIds) {
    const member = await base44.entities.TeamMember.get(memberId).catch(() => null);
    if (!member || member.manager_id !== managerId || member.status !== 'active' || !member.user_id) {
      throw new HttpError(422, 'invalid_team_assignment', `Team member ${memberId} is not an active linked rep owned by this manager.`);
    }
    if (normalized(member.role) !== 'rep') {
      throw new HttpError(422, 'invalid_team_assignment', `Team member ${memberId} is not an active rep.`);
    }
    // This service-role lookup occurs only after manager authentication,
    // live entitlement, CanvasSession RLS, and explicit tenant ownership.
    // It proves the roster row and private auth User agree on the team link.
    const repUser = await base44.asServiceRole.entities.User.get(member.user_id).catch(() => null);
    if (!repUser
      || repUser.id !== member.user_id
      || repUser.team_manager_id !== managerId
      || normalized(repUser.email) !== normalized(member.email)) {
      throw new HttpError(422, 'unverified_team_link', `Team member ${memberId} is not linked to an authenticated user in this manager's tenant.`);
    }
    members.push(member);
  }
  return members;
}

function sessionStableDoorIds(session: any) {
  return new Set(asArray(session?.doors).map((door) => String(door?.stable_door_id || '').trim()).filter(Boolean));
}

function sessionWorkUnitIds(session: any) {
  return new Set(asArray(session?.doors).map((door) => String(door?.work_unit_id || '').trim()).filter(Boolean));
}

function intersection(left: Set<string>, right: Set<string>) {
  return [...left].filter((id) => right.has(id)).sort();
}

async function isValidStoredDeployment(session: any, signingSecret: string) {
  return verifyCanvasLifecycleSession(signingSecret, session);
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
  return validSessions.filter((session) => session.status === 'deployed'
    && session.lifecycle_state === 'active'
    && !supersededIds.has(session.id));
}

async function loadActiveValidDeployments(base44: any, managerId: string, signingSecret: string) {
  const results = [];
  for (const status of ['deployed', 'completed', 'recalled']) {
    let skip = 0;
    while (true) {
      const page = asArray(await base44.entities.CanvasSession.filter({
        manager_id: managerId,
        status
      }, '-deployed_at', LIFECYCLE_PAGE_SIZE, skip));
      results.push(...page);
      if (results.length > MAX_LIFECYCLE_SCAN_SESSIONS) {
        throw new HttpError(503, 'canvas_lifecycle_scan_limit', 'Canvas lifecycle history exceeds the safe verification limit. No deployment was changed.');
      }
      if (page.length < LIFECYCLE_PAGE_SIZE) break;
      skip += page.length;
    }
  }
  const candidates = [...new Map(results
    .filter((session) => session.manager_id === managerId && ['deployed', 'completed', 'recalled'].includes(session.status))
    .map((session) => [session.id, session])).values()];
  const valid = [];
  const invalidSessionIds = [];
  for (const candidate of candidates) {
    if (await isValidStoredDeployment(candidate, signingSecret)) valid.push(candidate);
    else invalidSessionIds.push(candidate.id);
  }
  if (invalidSessionIds.length) {
    throw new HttpError(409, 'canvas_lifecycle_integrity_failed', 'Existing Canvas lifecycle history failed signature verification. No deployment was changed.', {
      invalid_session_ids: invalidSessionIds.slice(0, 100),
      details_truncated: invalidSessionIds.length > 100
    });
  }
  const active = activeValidDeployments(valid);
  if (active.length > MAX_CONFLICT_SCAN_SESSIONS) {
    throw new HttpError(503, 'canvas_conflict_scan_limit', 'Too many active Canvas sessions exist to verify overlap safely. No deployment was changed.');
  }
  return active;
}

function deploymentOverlapConflicts(session: any, activeDeployments: any[]) {
  const incomingDoorIds = sessionStableDoorIds(session);
  const incomingWorkUnitIds = sessionWorkUnitIds(session);
  return activeDeployments
    .filter((candidate) => candidate.id !== session.id)
    .map((candidate) => {
      const stableDoorIds = intersection(incomingDoorIds, sessionStableDoorIds(candidate));
      const workUnitIds = intersection(incomingWorkUnitIds, sessionWorkUnitIds(candidate));
      return {
        session_id: candidate.id,
        session_name: candidate.session_name || 'Canvas Campaign',
        deployed_at: candidate.deployed_at,
        stable_door_id_count: stableDoorIds.length,
        work_unit_id_count: workUnitIds.length,
        stable_door_ids: stableDoorIds.slice(0, 100),
        work_unit_ids: workUnitIds.slice(0, 100),
        details_truncated: stableDoorIds.length > 100 || workUnitIds.length > 100
      };
    })
    .filter((conflict) => conflict.stable_door_id_count > 0 || conflict.work_unit_id_count > 0)
    .sort((left, right) => String(left.session_id).localeCompare(String(right.session_id)));
}

function requireExactSupersedeConfirmation(providedIds: string[], conflicts: any[]) {
  const requiredIds = conflicts.map((conflict) => conflict.session_id).sort();
  const provided = [...providedIds].sort();
  if (sameIdSet(provided, requiredIds)) return requiredIds;
  const requiredSet = new Set(requiredIds);
  const providedSet = new Set(provided);
  throw new HttpError(409, 'canvas_deployment_overlap', 'This draft overlaps active Canvas deployments. Confirm the exact conflicting session IDs to replace them.', {
    required_supersede_session_ids: requiredIds,
    provided_supersede_session_ids: provided,
    missing_supersede_session_ids: requiredIds.filter((id) => !providedSet.has(id)),
    unexpected_supersede_session_ids: provided.filter((id) => !requiredSet.has(id)),
    conflicts
  });
}

function functionPayload(result: any) {
  return result?.data && typeof result.data === 'object' ? result.data : result;
}

function normalizedPolygonPoints(input: any) {
  if (!Array.isArray(input)) return [];
  const points = input.map((point) => {
    const lat = Number(point?.lat ?? point?.[0]);
    const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }).filter(Boolean);
  if (points.length > 3) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.abs(first.lat - last.lat) < 0.00000001 && Math.abs(first.lng - last.lng) < 0.00000001) points.pop();
  }
  return points;
}

function canonicalPolygonKey(input: any) {
  const points = normalizedPolygonPoints(input);
  if (points.length < 3) return '';
  const encoded = points.map((point) => `${point.lat.toFixed(8)},${point.lng.toFixed(8)}`);
  const candidates: string[] = [];
  for (const sequence of [encoded, [...encoded].reverse()]) {
    for (let index = 0; index < sequence.length; index += 1) {
      candidates.push([...sequence.slice(index), ...sequence.slice(0, index)].join('|'));
    }
  }
  return candidates.sort()[0] || '';
}

async function loadOwnedAnalysisDoorUniverse(base44: any, session: any) {
  const analysisId = requiredString(session.analysis_id, 'analysis_id', 256);
  let invoked;
  try {
    invoked = await base44.functions.invoke('canvasGetAnalysis', { analysisId });
  } catch {
    throw new HttpError(503, 'canvas_topology_analysis_unavailable', 'The owned Canvas analysis could not be reloaded for server topology verification. Nothing was deployed.');
  }
  const payload = functionPayload(invoked);
  if (!payload?.success || !payload?.analysis || !Array.isArray(payload?.opportunities)) {
    throw new HttpError(422, 'canvas_topology_analysis_invalid', 'The Canvas analysis is unavailable or is not owned by this manager.');
  }
  if (String(payload.analysis.manager_id || '') !== String(session.manager_id || '')) {
    throw new HttpError(403, 'analysis_not_owned', 'The Canvas analysis belongs to another manager.');
  }
  if (canonicalPolygonKey(payload.analysis.polygon) !== canonicalPolygonKey(session.polygon)) {
    throw new HttpError(422, 'analysis_polygon_mismatch', 'The saved Canvas polygon does not match the owned analysis polygon. Re-analyze this exact boundary.');
  }

  const totalOpportunities = Number(payload.analysis.total_opportunities);
  if (!Number.isInteger(totalOpportunities)
    || totalOpportunities < 1
    || payload.opportunities.length !== totalOpportunities) {
    throw new HttpError(422, 'analysis_truncated', 'The complete owned analysis door universe is required for server topology verification.');
  }
  const analysisById = new Map<string, any>();
  for (const opportunity of payload.opportunities) {
    const stableDoorId = String(opportunity?.stableDoorId || opportunity?.stable_door_id || opportunity?.id || '').trim();
    const lat = Number(opportunity?.lat);
    const lng = Number(opportunity?.lng);
    if (!stableDoorId || !Number.isFinite(lat) || !Number.isFinite(lng) || analysisById.has(stableDoorId)) {
      throw new HttpError(422, 'analysis_door_universe_invalid', 'The owned analysis contains an invalid or duplicate stable door identity.');
    }
    analysisById.set(stableDoorId, { ...opportunity, id: stableDoorId, stable_door_id: stableDoorId, lat, lng });
  }

  const submittedDoors = asArray(session.doors);
  const submittedIds = new Set(submittedDoors.map((door) => String(door?.stable_door_id || '').trim()).filter(Boolean));
  const missingIds = [...analysisById.keys()].filter((id) => !submittedIds.has(id));
  const extraIds = [...submittedIds].filter((id) => !analysisById.has(id));
  const coordinateMismatchIds = submittedDoors.filter((door) => {
    const opportunity = analysisById.get(String(door?.stable_door_id || '').trim());
    return opportunity && (Math.abs(Number(door?.lat) - opportunity.lat) > 0.00005
      || Math.abs(Number(door?.lng) - opportunity.lng) > 0.00005);
  }).map((door) => String(door.stable_door_id));
  if (missingIds.length || extraIds.length || coordinateMismatchIds.length || submittedDoors.length !== analysisById.size) {
    throw new HttpError(422, 'analysis_door_mismatch', 'The deployed door snapshot must exactly match the current owned analysis.', {
      missing_door_ids: missingIds.slice(0, 100),
      extra_door_ids: extraIds.slice(0, 100),
      coordinate_mismatch_door_ids: coordinateMismatchIds.slice(0, 100)
    });
  }
  return [...analysisById.values()];
}

function polygonToOverpassPoly(polygon: any) {
  return normalizedPolygonPoints(polygon)
    .map((point) => `${point.lat.toFixed(6)} ${point.lng.toFixed(6)}`)
    .join(' ');
}

function buildOverpassRoadQuery(polygon: any) {
  const poly = polygonToOverpassPoly(polygon);
  return `[out:json][timeout:25];
(
  way["highway"~"^(${CANVAS_HIGHWAY_FILTER})$"]["bridge"!="yes"]["tunnel"!="yes"](poly:"${poly}");
);
out body;
>;
out body qt;`;
}

async function fetchOverpassEndpoint(url: string, query: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'FirstKnock-Canvas-Server-Topology/1.0'
      },
      body: new URLSearchParams({ data: query }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const encoded = await response.text();
    if (encoded.length > MAX_OSM_JSON_BYTES) throw new Error('response exceeds the supported size');
    const parsed = JSON.parse(encoded);
    if (!Array.isArray(parsed?.elements)
      || parsed.elements.length < 1
      || parsed.elements.length > MAX_OSM_ELEMENTS) {
      throw new Error('response has an invalid element count');
    }
    return { roadNetwork: parsed, endpoint: new URL(url).hostname };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchServerRoadNetwork(polygon: any) {
  const query = buildOverpassRoadQuery(polygon);
  const failures = [];
  for (const url of OVERPASS_URLS) {
    try {
      return await fetchOverpassEndpoint(url, query);
    } catch (error: any) {
      failures.push(`${new URL(url).hostname}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  throw new HttpError(503, 'canvas_topology_source_unavailable', 'Server-owned OSM road verification is unavailable. Nothing was deployed.', {
    sources_attempted: OVERPASS_URLS.map((url) => new URL(url).hostname),
    failures
  });
}

function canonicalWayNodes(nodes: any) {
  if (!Array.isArray(nodes)) return null;
  const forward = nodes.map(String);
  const reverse = [...forward].reverse();
  return forward.join('|').localeCompare(reverse.join('|')) <= 0 ? forward : reverse;
}

function canonicalRoadSnapshot(roadNetwork: any) {
  return asArray(roadNetwork?.elements).map((element) => ({
    type: element?.type || null,
    id: element?.id ?? null,
    lat: Number.isFinite(Number(element?.lat)) ? Number(Number(element.lat).toFixed(8)) : null,
    lon: Number.isFinite(Number(element?.lon)) ? Number(Number(element.lon).toFixed(8)) : null,
    nodes: canonicalWayNodes(element?.nodes),
    tags: element?.tags || {}
  })).sort((left, right) => String(`${left.type}:${left.id}`).localeCompare(String(`${right.type}:${right.id}`), 'en', { numeric: true }));
}

function sortedUniqueIds(value: any) {
  return [...new Set(asArray(value).map((id) => String(id || '').trim()).filter(Boolean))].sort();
}

function zoneTopologySignature(zone: any) {
  return JSON.stringify({
    stable_door_ids: sortedUniqueIds(zone?.stable_door_ids),
    work_unit_ids: sortedUniqueIds(zone?.work_unit_ids)
  });
}

function canonicalDisplayPoint(point: any) {
  const lat = Number(point?.lat ?? point?.[0]);
  const lng = Number(point?.lng ?? point?.lon ?? point?.longitude ?? point?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [Number(lat.toFixed(8)), Number(lng.toFixed(8))];
}

function canonicalDisplayPointSequence(value: any) {
  if (!Array.isArray(value)) return null;
  const points = value.map(canonicalDisplayPoint);
  return points.some((point) => point === null) ? null : points;
}

function canonicalZoneDisplaySnapshot(zone: any) {
  return {
    geometry: canonicalDisplayPointSequence(zone?.geometry),
    parts: Array.isArray(zone?.parts) ? zone.parts.map(canonicalDisplayPointSequence) : null,
    drop_point: zone?.drop_point ? canonicalDisplayPoint(zone.drop_point) : null
  };
}

async function verifyServerTopology(base44: any, session: any) {
  const authoritativeDoors = await loadOwnedAnalysisDoorUniverse(base44, session);
  const { roadNetwork, endpoint } = await fetchServerRoadNetwork(session.polygon);
  const serverPlan = planCanvasTerritories({
    polygon: session.polygon,
    roadNetwork,
    doors: authoritativeDoors,
    workload_basis: session.workload_basis,
    zoneCount: asArray(session.zones).length,
    requested_zone_count: asArray(session.zones).length,
    selected_team_member_ids: asArray(session.selected_team_member_ids),
    analysis_id: session.analysis_id
  });
  if (!serverPlan?.ok || serverPlan?.deployable !== true) {
    throw new HttpError(422, 'server_topology_verification_failed', 'The server could not reproduce a deployable street topology for this draft.', {
      topology_code: serverPlan?.code || 'TOPOLOGY_BLOCKED',
      topology_status: serverPlan?.status || 'blocked',
      topology_message: serverPlan?.message || 'Street topology verification failed.'
    });
  }
  if (String(session.algorithm_version || '') !== String(serverPlan.algorithm_version || '')) {
    throw new HttpError(409, 'topology_algorithm_version_mismatch', 'This draft was generated by a different topology algorithm version. Regenerate it before deployment.', {
      submitted_algorithm_version: session.algorithm_version || null,
      required_algorithm_version: serverPlan.algorithm_version || null
    });
  }
  if (String(session.data_version || '') !== String(serverPlan.data_version || '')) {
    throw new HttpError(409, 'topology_data_version_mismatch', 'The authoritative OSM topology changed or does not match this draft. Regenerate it before deployment.', {
      submitted_data_version: session.data_version || null,
      server_data_version: serverPlan.data_version || null
    });
  }

  const expectedDoorById = new Map(asArray(serverPlan.doors).map((door) => [String(door.stable_door_id), door]));
  const workUnitMismatchDoorIds = asArray(session.doors).filter((door) => {
    const expected = expectedDoorById.get(String(door?.stable_door_id || ''));
    return !expected || String(door?.work_unit_id || '') !== String(expected?.work_unit_id || '');
  }).map((door) => String(door?.stable_door_id || '')).filter(Boolean);
  if (workUnitMismatchDoorIds.length || expectedDoorById.size !== asArray(session.doors).length) {
    throw new HttpError(422, 'server_work_unit_ownership_mismatch', 'Submitted door work-unit ownership does not match the server-recomputed street topology.', {
      mismatch_door_ids: workUnitMismatchDoorIds.slice(0, 100)
    });
  }

  const expectedZoneSignatures = asArray(serverPlan.zones).map(zoneTopologySignature).sort();
  const submittedZoneSignatures = asArray(session.zones).map(zoneTopologySignature).sort();
  if (JSON.stringify(expectedZoneSignatures) !== JSON.stringify(submittedZoneSignatures)) {
    throw new HttpError(422, 'server_zone_topology_mismatch', 'Submitted zones do not match the connected atomic street partition recomputed by the server.', {
      expected_zone_count: expectedZoneSignatures.length,
      submitted_zone_count: submittedZoneSignatures.length
    });
  }

  const expectedZoneBySignature = new Map(asArray(serverPlan.zones)
    .map((zone) => [zoneTopologySignature(zone), zone]));
  const displayMismatchZoneIds = asArray(session.zones).filter((zone) => {
    const expected = expectedZoneBySignature.get(zoneTopologySignature(zone));
    return !expected
      || String(zone?.zone_id || '') !== String(expected?.zone_id || '')
      || JSON.stringify(canonicalZoneDisplaySnapshot(zone)) !== JSON.stringify(canonicalZoneDisplaySnapshot(expected));
  }).map((zone) => String(zone?.zone_id || '')).filter(Boolean);
  if (displayMismatchZoneIds.length) {
    throw new HttpError(422, 'server_zone_geometry_mismatch', 'Submitted zone boundaries, parts, or drop points do not match the server-recomputed street display geometry.', {
      mismatch_zone_ids: displayMismatchZoneIds.slice(0, 100)
    });
  }

  const roadSnapshotSha256 = await sha256(canonicalRoadSnapshot(roadNetwork));
  const zoneDisplaySha256 = await sha256(asArray(serverPlan.zones).map((zone) => ({
    topology_signature: zoneTopologySignature(zone),
    zone_id: zone.zone_id,
    display: canonicalZoneDisplaySnapshot(zone)
  })).sort((left, right) => left.topology_signature.localeCompare(right.topology_signature)));
  return {
    validator_version: 2,
    topology_validator: 'server_osm_recompute_v1',
    server_topology_verified: true,
    server_algorithm_version: serverPlan.algorithm_version,
    server_data_version: serverPlan.data_version,
    road_snapshot_sha256: roadSnapshotSha256,
    road_source: endpoint,
    road_element_count: asArray(roadNetwork.elements).length,
    zone_display_sha256: zoneDisplaySha256,
    door_work_unit_ownership_verified: true,
    zone_partition_verified: true,
    zone_display_geometry_verified: true,
    zone_identifiers_verified: true,
    analysis_coverage_complete: true,
    analysis_coordinates_verified: true,
    connected_zones: serverPlan.qa?.connected_zones === true,
    atomic_work_units: serverPlan.qa?.atomic_work_units === true,
    protected_units_intact: serverPlan.qa?.protected_units_intact === true,
    cul_de_sac_splits: Number(serverPlan.qa?.cul_de_sac_splits) || 0,
    data_quality_status: serverPlan.qa?.data_quality_status,
    protected_terminal_branch_count: Number(serverPlan.qa?.protected_terminal_branch_count) || 0,
    server_work_unit_count: Number(serverPlan.qa?.work_unit_count) || 0
  };
}

Deno.serve(async (req: Request) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageCanvas(user)) return Response.json({ error: 'Only managers can deploy Canvas campaigns.' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const sessionId = requiredString(body?.session_id, 'session_id', 256);
    const idempotencyKey = requiredString(body?.idempotency_key, 'idempotency_key', 128);
    if (idempotencyKey.length < 8 || !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)) {
      throw new HttpError(400, 'invalid_deploy_request', 'idempotency_key must be 8-128 letters, numbers, colons, underscores, or hyphens.');
    }

    // Caller-scoped reads preserve CanvasSession RLS; no service-role bypass is used.
    const session = await base44.entities.CanvasSession.get(sessionId).catch(() => null);
    if (!session) throw new HttpError(404, 'session_not_found', 'Canvas session not found.');
    if (session.manager_id !== user.id) throw new HttpError(403, 'forbidden', 'This Canvas session belongs to another manager.');

    if (session.status === 'deployed') {
      const signingSecret = deploymentSigningSecret();
      if (session.deployment_idempotency_key !== idempotencyKey) {
        throw new HttpError(409, 'already_deployed', 'This Canvas campaign is already deployed.');
      }
      const repIds = canvasRepTeamMemberIds(session);
      if (!await verifyCanvasLifecycleSession(signingSecret, session, 'active')) {
        throw new HttpError(409, 'deployment_signature_invalid', 'The deployed Canvas snapshot failed server signature verification.');
      }
      return Response.json({
        success: true,
        idempotent: true,
        session_id: session.id,
        version: Number(session.version),
        status: 'deployed',
        deployed_at: session.deployed_at,
        delivery_count: Number(session.rep_count || 0),
        rep_team_member_ids: repIds,
        superseded_session_ids: asArray(session.deployment_qa?.superseded_session_ids)
      });
    }
    if (session.status === 'completed' || session.status === 'recalled') {
      const signingSecret = deploymentSigningSecret();
      if (!await verifyCanvasLifecycleSession(signingSecret, session, session.status)) {
        throw new HttpError(409, 'lifecycle_signature_invalid', 'The closed Canvas campaign failed lifecycle signature verification.');
      }
      throw new HttpError(409, 'campaign_closed', 'This Canvas campaign is closed and cannot be deployed again. Create a new draft.');
    }

    // A committed same-key retry returns only after verifying the signed stored
    // result above. Fresh billing is required for unresolved draft mutations.
    const entitlement = await resolveCanvasEntitlement(user);
    const signingSecret = deploymentSigningSecret();

    const expectedVersion = Number(body?.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(session.version)) {
      throw new HttpError(409, 'version_conflict', 'The Canvas draft changed. Reload it before deploying.');
    }
    const expectedHash = await sha256(canvasStoredPlanForHash(session));
    if (!session.plan_hash || session.plan_hash !== expectedHash) {
      throw new HttpError(409, 'plan_hash_mismatch', 'The Canvas draft bypassed the trusted save flow or changed after validation. Save it again before deploying.');
    }

    const validation = validatePlan(session);
    const members = await validateTeamMembers(base44, user.id, validation.assignedRepIds);
    if (Number.isFinite(entitlement.seats) && members.length > entitlement.seats) {
      throw new HttpError(403, 'canvas_seat_limit_exceeded', `This deployment assigns ${members.length} reps, but the verified Canvas subscription has ${entitlement.seats} seats.`);
    }
    const topologyVerification = await verifyServerTopology(base44, session);
    const providedSupersedeSessionIds = optionalUniqueIdList(body?.supersede_session_ids, 'supersede_session_ids');
    return await withManagerDeploymentLock(user.id, async () => {
      const lockedSession = await base44.entities.CanvasSession.get(session.id).catch(() => null);
      if (!lockedSession || lockedSession.manager_id !== user.id) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed before the deployment lock was acquired.');
      }
      const lockedExpectedHash = await sha256(canvasStoredPlanForHash(lockedSession));
      if (lockedSession.status !== 'draft'
        || Number(lockedSession.version) !== expectedVersion
        || lockedSession.plan_hash !== session.plan_hash
        || lockedSession.plan_hash !== lockedExpectedHash) {
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed before deployment committed. Reload before retrying.');
      }

      const activeDeployments = await loadActiveValidDeployments(base44, user.id, signingSecret);
      const overlapConflicts = deploymentOverlapConflicts(lockedSession, activeDeployments);
      const supersededSessionIds = requireExactSupersedeConfirmation(providedSupersedeSessionIds, overlapConflicts);

      const deployedAt = new Date().toISOString();
      const deploymentPlanVersion = Number(lockedSession.version);
      const lifecycleEvidence = {
        schema_version: 1,
        state: 'active',
        transition: 'deploy',
        transitioned_at: deployedAt,
        transitioned_by_user_id: user.id,
        idempotency_key: idempotencyKey,
        from_version: deploymentPlanVersion,
        to_version: deploymentPlanVersion,
        previous_signature: null
      };
      const deploymentQa = {
        ...validation.deploymentQa,
        ...topologyVerification,
        verified_team_member_ids: members.map((member) => member.id),
        verified_team_member_bindings: members.map((member) => ({
          team_member_id: String(member.id),
          user_id: String(member.user_id),
          email: normalized(member.email)
        })).sort((left, right) => left.team_member_id.localeCompare(right.team_member_id)),
        entitlement_kind: entitlement.kind,
        entitlement_subscription_id: entitlement.subscription_id,
        superseded_session_ids: supersededSessionIds,
        overlap_conflict_count: overlapConflicts.length,
        verified_at: deployedAt,
        lifecycle_state: 'active',
        lifecycle_transition: 'deploy',
        lifecycle_transitioned_at: deployedAt,
        lifecycle_transitioned_by_user_id: user.id
      };
      const lifecycleUpdate = {
        status: 'deployed',
        deployment_plan_version: deploymentPlanVersion,
        deployed_at: deployedAt,
        deployed_by_user_id: user.id,
        deployment_idempotency_key: idempotencyKey,
        deployment_qa: deploymentQa,
        lifecycle_state: 'active',
        lifecycle_evidence: lifecycleEvidence,
        closed_at: null,
        closed_by_user_id: null,
        close_action: null,
        close_idempotency_key: null
      };
      const signedSession = { ...lockedSession, ...lifecycleUpdate };
      const deploymentSignature = await signCanvasLifecycle(signingSecret, signedSession, members.map((member) => member.id));
      const mutation = await base44.asServiceRole.entities.CanvasSession.updateMany({
        id: lockedSession.id,
        manager_id: user.id,
        status: 'draft',
        version: Number(lockedSession.version),
        plan_hash: lockedSession.plan_hash
      }, { $set: {
        ...lifecycleUpdate,
        deployment_signature: deploymentSignature
      } });
      if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) {
        const latest = await base44.entities.CanvasSession.get(lockedSession.id).catch(() => null);
        if (latest?.manager_id === user.id
          && latest?.status === 'deployed'
          && latest?.deployment_idempotency_key === idempotencyKey
          && await verifyCanvasLifecycleSession(signingSecret, latest, 'active')) {
          const latestRepIds = canvasRepTeamMemberIds(latest);
          return Response.json({
            success: true,
            idempotent: true,
            session_id: latest.id,
            version: Number(latest.version),
            status: 'deployed',
            deployed_at: latest.deployed_at,
            delivery_count: Number(latest.rep_count || 0),
            rep_team_member_ids: latestRepIds,
            superseded_session_ids: asArray(latest.deployment_qa?.superseded_session_ids)
          });
        }
        throw new HttpError(409, 'version_conflict', 'The Canvas draft changed before deployment committed. Reload before retrying.');
      }
      const updated = await base44.entities.CanvasSession.get(lockedSession.id).catch(() => null);
      if (!updated || !await verifyCanvasLifecycleSession(signingSecret, updated, 'active')) {
        throw new HttpError(503, 'canvas_deploy_commit_unverified', 'The Canvas deployment commit could not be verified. Reload before retrying.');
      }

      return Response.json({
        success: true,
        idempotent: false,
        session_id: updated.id,
        version: Number(updated.version),
        status: 'deployed',
        deployed_at: deployedAt,
        delivery_count: members.length,
        rep_team_member_ids: members.map((member) => member.id),
        superseded_session_ids: supersededSessionIds,
        deployment_qa: updated.deployment_qa
      });
    });
  } catch (error: any) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    console.error('[canvasDeployCampaign]', error?.message || error);
    return Response.json({
      error: 'canvas_deploy_failed',
      message: 'Canvas deployment could not be verified. The draft was not changed.'
    }, { status: 503 });
  }
});
