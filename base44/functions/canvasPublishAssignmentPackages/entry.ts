import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { Client } from "npm:@neondatabase/serverless@0.9.0";

const PACKAGE_SCHEMA = "firstknock.canvas-field-package";
const PACKAGE_SCHEMA_VERSION = 1;
const MAX_ZONES = 250;
const MAX_SUPERSEDED_CAMPAIGNS = 1_000;
const MAX_WORK_UNITS = 20_000;
const MAX_SEGMENTS = 100_000;
const TEAM_BATCH_SIZE = 100;
const OWNERSHIP_BATCH_SIZE = 500;
const MAX_ARTIFACT_BYTES = 2_000_000;
const ARTIFACT_TARGET_BYTES = 1_500_000;
const MAX_PACKAGE_BYTES = 24_000_000;
const MAX_PUBLICATION_BYTES = 192_000_000;
const MAX_PINS = 100_000;
const MAX_RELEVANT_DNC_ROWS = 100_000;
const DEFAULT_VALID_HOURS = 7 * 24;
const MAX_VALID_HOURS = 30 * 24;
const json = (body: unknown, status = 200) => Response.json(body, { status });

class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : Array.isArray((value as any)?.items) ? (value as any).items : [];
}

function normalized(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_publication", `${field} is required or invalid.`);
  return result;
}

function canonicalize(value: any): any {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(422, "non_canonical_package_value", "Canvas package data contains a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") throw new HttpError(422, "non_canonical_package_value", "Canvas package data contains an unsupported value.");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new HttpError(422, "non_canonical_package_value", "Canvas package data contains an undefined value.");
    result[key] = canonicalize(value[key]);
  }
  return result;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function bytes(value: unknown) {
  return new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
}

function hex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (let index = 0; index < value.byteLength; index += 1) binary += String.fromCharCode(value[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Standard(value: Uint8Array) {
  let binary = "";
  for (let index = 0; index < value.byteLength; index += 1) binary += String.fromCharCode(value[index]);
  return btoa(binary);
}

function decodeBase64(value: string) {
  const normalizedValue = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const binary = atob(normalizedValue.padEnd(Math.ceil(normalizedValue.length / 4) * 4, "="));
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function pemBytes(value: string, label: string) {
  const compact = value
    .replace(new RegExp(`-----BEGIN ${label}-----`, "g"), "")
    .replace(new RegExp(`-----END ${label}-----`, "g"), "")
    .replace(/\s/g, "");
  return decodeBase64(compact);
}

async function sha256Bytes(value: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

async function sha256(value: unknown) {
  return sha256Bytes(bytes(value));
}

function rows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function signingConfiguration() {
  const privateValue = Deno.env.get("CANVAS_PACKAGE_SIGNING_PRIVATE_KEY") || "";
  const publicValue = Deno.env.get("CANVAS_PACKAGE_SIGNING_PUBLIC_KEY") || "";
  const keyId = Deno.env.get("CANVAS_PACKAGE_SIGNING_KEY_ID") || "";
  const privateFormat = normalized(Deno.env.get("CANVAS_PACKAGE_SIGNING_PRIVATE_KEY_FORMAT") || "pkcs8");
  const publicFormat = normalized(Deno.env.get("CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT") || "raw");
  if (!privateValue || !publicValue || !/^[A-Za-z0-9._:-]{3,128}$/.test(keyId)) {
    throw new HttpError(503, "canvas_package_signing_unavailable", "Canvas package signing is not fully configured.");
  }
  return { privateValue, publicValue, keyId, privateFormat, publicFormat };
}

async function importPrivateKey(configuration: any) {
  try {
    if (configuration.privateFormat === "jwk" || configuration.privateValue.trim().startsWith("{")) {
      return await crypto.subtle.importKey("jwk", JSON.parse(configuration.privateValue), { name: "Ed25519" }, false, ["sign"]);
    }
    const data = configuration.privateValue.includes("BEGIN PRIVATE KEY")
      ? pemBytes(configuration.privateValue, "PRIVATE KEY")
      : decodeBase64(configuration.privateValue);
    return await crypto.subtle.importKey("pkcs8", data, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    throw new HttpError(503, "canvas_package_private_key_invalid", "The Canvas package private key could not be imported.");
  }
}

async function importPublicKey(configuration: any) {
  try {
    if (configuration.publicFormat === "jwk" || configuration.publicValue.trim().startsWith("{")) {
      return await crypto.subtle.importKey("jwk", JSON.parse(configuration.publicValue), { name: "Ed25519" }, false, ["verify"]);
    }
    const isPem = configuration.publicValue.includes("BEGIN PUBLIC KEY");
    const format = isPem ? "spki" : configuration.publicFormat;
    if (!["raw", "spki"].includes(format)) throw new Error("format");
    const data = isPem ? pemBytes(configuration.publicValue, "PUBLIC KEY") : decodeBase64(configuration.publicValue);
    return await crypto.subtle.importKey(format, data, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new HttpError(503, "canvas_package_public_key_invalid", "The Canvas package public key could not be imported.");
  }
}

function publicKeyDescriptor(configuration: any) {
  if (configuration.publicValue.trim().startsWith("{")) {
    return { algorithm: "Ed25519", key_id: configuration.keyId, format: "jwk", keyData: JSON.parse(configuration.publicValue) };
  }
  return {
    algorithm: "Ed25519",
    key_id: configuration.keyId,
    format: configuration.publicValue.includes("BEGIN PUBLIC KEY") ? "spki" : configuration.publicFormat,
    keyData: configuration.publicValue
  };
}

async function verifiedSigningKeys() {
  const configuration = signingConfiguration();
  const [privateKey, publicKey] = await Promise.all([importPrivateKey(configuration), importPublicKey(configuration)]);
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, challenge));
  if (!await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, challenge)) {
    throw new HttpError(503, "canvas_package_key_pair_mismatch", "The configured Canvas package signing keys do not match.");
  }
  return { configuration, privateKey, publicKey: publicKeyDescriptor(configuration) };
}

function canvasRepTeamMemberIds(session: any) {
  return [...new Set(asArray(session?.zones).map((zone) => String(zone?.assigned_team_member_id || "").trim()).filter(Boolean))].sort();
}

function canvasStoredPlanForHash(session: any) {
  const deploymentPlanVersion = Number(session?.deployment_plan_version);
  const planVersion = Number.isInteger(deploymentPlanVersion) && deploymentPlanVersion > 0 ? deploymentPlanVersion : Number(session?.version);
  return {
    session_name: session?.session_name || "Canvas Campaign",
    territory_model: session?.territory_model || "street_territory_v1",
    polygon: asArray(session?.polygon),
    rep_count: Number(session?.rep_count || 0),
    planning_method: session?.planning_method,
    assignment_basis: session?.assignment_basis,
    workload_basis: session?.workload_basis,
    division_mode: session?.division_mode,
    target_workload: session?.target_workload === null || session?.target_workload === undefined ? null : Number(session.target_workload),
    ...(Array.isArray(session?.selected_team_member_ids) ? { selected_team_member_ids: session.selected_team_member_ids } : {}),
    zones: asArray(session?.zones),
    work_units: asArray(session?.work_units),
    qa: session?.qa || {},
    algorithm_version: session?.algorithm_version || null,
    data_version: session?.data_version || null,
    ...(session?.territory_model === "residential_street_territory_v2" ? {
      evidence_id: session?.evidence_id,
      evidence_release_id: session?.evidence_release_id || null,
      revision_id: session?.revision_id || null,
      snapshot_hash: session?.snapshot_hash,
      evidence_schema_version: Number(session?.evidence_schema_version),
      unresolved_unit_count: Number(session?.unresolved_unit_count || 0),
      assignment_version: Number(session?.assignment_version || 0)
    } : {}),
    manager_id: session?.manager_id,
    version: planVersion
  };
}

function lifecyclePayload(session: any) {
  return {
    purpose: "firstknock-canvas-lifecycle-v2",
    session_id: session?.id,
    manager_id: session?.manager_id,
    status: session?.status,
    version: Number(session?.version),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: session?.plan_hash,
    deployed_at: session?.deployed_at,
    deployed_by_user_id: session?.deployed_by_user_id,
    deployment_idempotency_key: session?.deployment_idempotency_key,
    rep_team_member_ids: canvasRepTeamMemberIds(session),
    lifecycle_state: session?.lifecycle_state || null,
    lifecycle_evidence: session?.lifecycle_evidence || null,
    closed_at: session?.closed_at || null,
    closed_by_user_id: session?.closed_by_user_id || null,
    close_action: session?.close_action || null,
    close_idempotency_key: session?.close_idempotency_key || null,
    deployment_qa: session?.deployment_qa || null
  };
}

async function verifyLifecycleSignature(session: any) {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) throw new HttpError(503, "canvas_lifecycle_signing_unavailable", "Canvas lifecycle verification is not configured.");
  if (!session?.plan_hash || !session?.deployment_signature
    || await sha256(canvasStoredPlanForHash(session)) !== session.plan_hash) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(lifecyclePayload(session)))));
  return expected === session.deployment_signature;
}

async function verifyActiveLifecycle(session: any) {
  const qa = session?.deployment_qa || {};
  const evidence = session?.lifecycle_evidence || {};
  if (session?.status !== "deployed" || session?.lifecycle_state !== "active"
    || qa.lifecycle_state !== "active" || evidence.state !== "active"
    || evidence.transition !== "deploy" || Number(evidence.schema_version) !== 1
    || String(evidence.transitioned_at || "") !== String(session?.deployed_at || "")
    || String(evidence.transitioned_by_user_id || "") !== String(session?.deployed_by_user_id || "")
    || String(evidence.idempotency_key || "") !== String(session?.deployment_idempotency_key || "")
    || Number(evidence.to_version) !== Number(session?.version)
    || Number(evidence.from_version) !== Number(session?.version)
    || evidence.previous_signature !== null || session?.closed_at || session?.close_action) return false;
  return verifyLifecycleSignature(session);
}

async function filterRowsByIds(entity: any, ids: string[], extraFilter: any) {
  const result = [];
  for (let index = 0; index < ids.length; index += TEAM_BATCH_SIZE) {
    const chunk = ids.slice(index, index + TEAM_BATCH_SIZE);
    result.push(...asArray(await entity.filter({ ...extraFilter, id: { $in: chunk } }, null, chunk.length, 0)));
  }
  return result;
}

async function verifiedOperationalPredecessors(base44: any, session: any) {
  const rawIds = asArray(session?.deployment_qa?.superseded_session_ids);
  const ids = [...new Set(rawIds.map((value) => requiredString(value, "superseded_session_id", 256)))].sort();
  if (ids.length !== rawIds.length || ids.length > MAX_SUPERSEDED_CAMPAIGNS || ids.includes(String(session.id))) {
    throw new HttpError(409, "canvas_supersession_integrity_failed", "The signed Canvas replacement list is invalid.");
  }
  if (!ids.length) return [];
  const candidates = await filterRowsByIds(base44.asServiceRole.entities.CanvasSession, ids, { manager_id: session.manager_id });
  const byId = new Map(candidates.map((candidate: any) => [String(candidate.id), candidate]));
  const operational = [];
  for (const id of ids) {
    const predecessor: any = byId.get(id);
    if (!predecessor || String(predecessor.manager_id) !== String(session.manager_id)
      || !await verifyLifecycleSignature(predecessor)) {
      throw new HttpError(409, "canvas_supersession_integrity_failed", "A signed predecessor campaign is missing or failed lifecycle verification.");
    }
    if (String(predecessor.territory_model || "") !== "residential_street_territory_v2") continue;
    if (["completed", "recalled"].includes(String(predecessor.status || ""))) continue;
    if (predecessor.status !== "deployed" || predecessor.lifecycle_state !== "active") {
      throw new HttpError(409, "canvas_supersession_integrity_failed", "A residential predecessor campaign has an invalid lifecycle state.");
    }
    operational.push(predecessor);
  }
  return operational;
}

async function verifiedTeamBindings(base44: any, session: any) {
  const memberIds = canvasRepTeamMemberIds(session);
  if (!memberIds.length || memberIds.length > MAX_ZONES) throw new HttpError(422, "invalid_canvas_roster", "The deployed Canvas campaign has no supported rep roster.");
  const members = await filterRowsByIds(base44.asServiceRole.entities.TeamMember, memberIds, { manager_id: session.manager_id });
  const byId = new Map(members.map((member: any) => [String(member.id), member]));
  const signedBindings = new Map(asArray(session?.deployment_qa?.verified_team_member_bindings).map((binding) => [String(binding?.team_member_id || ""), binding]));
  if (byId.size !== memberIds.length || signedBindings.size !== memberIds.length) throw new HttpError(409, "canvas_roster_binding_changed", "The signed Canvas roster is unavailable or ambiguous.");
  const userIds = [];
  for (const memberId of memberIds) {
    const member: any = byId.get(memberId);
    const signed: any = signedBindings.get(memberId);
    if (!member || String(member.manager_id) !== String(session.manager_id) || normalized(member.status) !== "active"
      || normalized(member.role) !== "rep" || !member.user_id || String(signed?.user_id || "") !== String(member.user_id)
      || normalized(signed?.email) !== normalized(member.email)) {
      throw new HttpError(409, "canvas_roster_binding_changed", `Team member ${memberId} no longer matches the signed deployment.`);
    }
    userIds.push(String(member.user_id));
  }
  if (new Set(userIds).size !== userIds.length) throw new HttpError(409, "canvas_roster_binding_changed", "Every Canvas rep must map to one distinct authenticated user.");
  const users = await filterRowsByIds(base44.asServiceRole.entities.User, userIds, { team_manager_id: session.manager_id });
  const usersById = new Map(users.map((user: any) => [String(user.id), user]));
  for (const memberId of memberIds) {
    const member: any = byId.get(memberId);
    const user: any = usersById.get(String(member.user_id));
    if (!user || String(user.team_manager_id) !== String(session.manager_id) || normalized(user.email) !== normalized(member.email)) {
      throw new HttpError(409, "canvas_roster_binding_changed", `Team member ${memberId} is not linked to its signed authenticated account.`);
    }
  }
  return byId;
}

function point(value: any) {
  const lat = Number(value?.lat ?? value?.[0]);
  const lng = Number(value?.lng ?? value?.lon ?? value?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(422, "invalid_package_geometry", "The deployed Canvas plan contains invalid coordinates.");
  }
  return { lat: Number(lat.toFixed(8)), lng: Number(lng.toFixed(8)) };
}

function canonicalUnit(unit: any) {
  const segments = asArray(unit?.segments).map((segment) => ({
    edge_id: segment?.edge_id ?? segment?.edgeId ?? null,
    start: point(segment?.start),
    end: point(segment?.end),
    street_names: [...new Set(asArray(segment?.street_names ?? segment?.streetNames).map(String).filter(Boolean))].sort(),
    highway_types: [...new Set(asArray(segment?.highway_types ?? segment?.highwayTypes).map(String).filter(Boolean))].sort(),
    length_meters: Number(segment?.length_meters ?? segment?.lengthMeters ?? 0)
  }));
  if (!segments.length) throw new HttpError(422, "invalid_package_geometry", `Canvas work unit ${unit?.id || "unknown"} has no street segments.`);
  return {
    id: requiredString(unit?.id ?? unit?.unit_id ?? unit?.work_unit_id, "work_unit.id", 512),
    canvas_role: unit?.canvas_role || "knock",
    protected: unit?.protected === true,
    protected_group_id: unit?.protected_group_id || null,
    protected_group_ids: [...new Set(asArray(unit?.protected_group_ids).map(String).filter(Boolean))].sort(),
    street_names: [...new Set(asArray(unit?.street_names ?? unit?.streetNames).map(String).filter(Boolean))].sort(),
    neighbor_ids: [...new Set(asArray(unit?.neighbor_ids ?? unit?.neighborIds).map(String).filter(Boolean))].sort(),
    street_length_meters: Number(unit?.street_length_meters ?? unit?.streetLengthMeters ?? 0),
    opportunity_low: Number(unit?.opportunity_low ?? unit?.opportunity?.low ?? unit?.opportunity?.min ?? 0),
    opportunity_expected: Number(unit?.opportunity_expected ?? unit?.opportunity?.expected ?? 0),
    opportunity_high: Number(unit?.opportunity_high ?? unit?.opportunity?.high ?? unit?.opportunity?.max ?? 0),
    confidence: unit?.confidence || null,
    segments
  };
}

function unitGeometry(unit: any) {
  return {
    type: "MultiLineString",
    coordinates: unit.segments.map((segment: any) => [[segment.start.lng, segment.start.lat], [segment.end.lng, segment.end.lat]])
  };
}

function contextTransitIds(units: any[], zones: any[]) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const transitIds = new Set(units.filter((unit) => unit.canvas_role === "transit_only").map((unit) => unit.id));
  const neighbors = new Map(units.map((unit) => [unit.id, new Set<string>()]));
  for (const unit of units) for (const neighborId of unit.neighbor_ids) {
    if (!byId.has(neighborId) || neighborId === unit.id) continue;
    neighbors.get(unit.id)?.add(neighborId);
    neighbors.get(neighborId)?.add(unit.id);
  }
  const components: Array<{ transit: string[]; borderingKnock: Set<string> }> = [];
  const unseen = new Set(transitIds);
  while (unseen.size) {
    const seed = [...unseen].sort()[0];
    const queue = [seed];
    const transit = [];
    const borderingKnock = new Set<string>();
    unseen.delete(seed);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      transit.push(id);
      for (const neighborId of neighbors.get(id) || []) {
        if (unseen.has(neighborId)) {
          unseen.delete(neighborId);
          queue.push(neighborId);
        } else if (byId.get(neighborId)?.canvas_role === "knock") borderingKnock.add(neighborId);
      }
    }
    components.push({ transit: transit.sort(), borderingKnock });
  }
  const result = new Map<string, string[]>();
  for (const zone of zones) {
    const owned = new Set(asArray(zone.work_unit_ids).map(String));
    result.set(String(zone.zone_id), [...new Set(components
      .filter((component) => [...component.borderingKnock].some((id) => owned.has(id)))
      .flatMap((component) => component.transit))].sort());
  }
  return result;
}

async function normalizedAssignments(session: any, membersById: Map<string, any>) {
  const units = asArray(session.work_units).map(canonicalUnit);
  const zones = asArray(session.zones);
  const segmentCount = units.reduce((sum, unit) => sum + unit.segments.length, 0);
  if (!zones.length || zones.length > MAX_ZONES || !units.length || units.length > MAX_WORK_UNITS || segmentCount > MAX_SEGMENTS) {
    throw new HttpError(413, "canvas_package_plan_too_large", "The Canvas campaign exceeds assignment-package limits.");
  }
  const byUnitId = new Map(units.map((unit) => [unit.id, unit]));
  const transitByZone = contextTransitIds(units, zones);
  const seenZoneIds = new Set<string>();
  const ownedUnitIds = new Set<string>();
  const assignments = [];
  for (const zone of zones) {
    const zoneId = requiredString(zone?.zone_id, "zone_id", 512);
    const teamMemberId = requiredString(zone?.assigned_team_member_id, `zone ${zoneId} assigned_team_member_id`, 256);
    const member = membersById.get(teamMemberId);
    if (seenZoneIds.has(zoneId) || !member) throw new HttpError(409, "canvas_assignment_binding_invalid", `Canvas zone ${zoneId} has an invalid signed assignment.`);
    seenZoneIds.add(zoneId);
    const zoneUnitIds = [...new Set(asArray(zone?.work_unit_ids).map(String).filter(Boolean))].sort();
    const ownedUnits = zoneUnitIds.map((id) => byUnitId.get(id));
    if (!ownedUnits.length || ownedUnits.some((unit) => !unit || (session.territory_model === "residential_street_territory_v2" && unit.canvas_role !== "knock"))) {
      throw new HttpError(409, "canvas_assignment_units_invalid", `Canvas zone ${zoneId} does not contain exact owned knock units.`);
    }
    for (const id of zoneUnitIds) {
      if (ownedUnitIds.has(id)) throw new HttpError(409, "canvas_assignment_units_overlap", `Canvas work unit ${id} belongs to more than one zone.`);
      ownedUnitIds.add(id);
    }
    const display = {
      geometry_role: zone?.geometry_role || "display_only",
      geometry: zone?.geometry ? asArray(zone.geometry).map(point) : null,
      parts: asArray(zone?.parts).map((part) => asArray(part).map(point)),
      center: zone?.center ? point(zone.center) : null,
      drop_point: zone?.drop_point ? point(zone.drop_point) : null
    };
    const assignmentId = `canvas_assignment_${await sha256({ purpose: "firstknock-canvas-assignment-v1", manager_id: session.manager_id, campaign_id: session.id, zone_id: zoneId, team_member_id: teamMemberId })}`;
    const territoryHash = await sha256({ plan_hash: session.plan_hash, zone_id: zoneId, team_member_id: teamMemberId, work_unit_ids: zoneUnitIds, display });
    assignments.push({
      assignmentId,
      zoneId,
      teamMemberId,
      assigneeUserId: String(member.user_id),
      territoryHash,
      zone,
      display,
      ownedUnits,
      sharedTransitUnits: (transitByZone.get(zoneId) || []).map((id) => byUnitId.get(id)).filter(Boolean)
    });
  }
  const expectedOwned = units.filter((unit) => session.territory_model !== "residential_street_territory_v2" || unit.canvas_role === "knock").map((unit) => unit.id).sort();
  if (JSON.stringify([...ownedUnitIds].sort()) !== JSON.stringify(expectedOwned)) {
    throw new HttpError(409, "canvas_assignment_coverage_invalid", "Canvas assignment packages do not cover the exact signed knock-unit partition.");
  }
  return { units, assignments };
}

function artifactObjectKey(packageId: string, artifactId: string) {
  return `canvas-db://${packageId}/${encodeURIComponent(artifactId)}`;
}

async function artifact(kind: string, ordinal: number, content: unknown, required = true) {
  const artifactId = `${kind}:${ordinal}`;
  const contentBytes = bytes(content);
  if (contentBytes.byteLength > MAX_ARTIFACT_BYTES) throw new HttpError(413, "canvas_artifact_too_large", `Canvas artifact ${artifactId} exceeds its bounded size.`);
  return {
    artifactId,
    kind,
    ordinal,
    required,
    contentType: "application/json; charset=utf-8",
    contentBytes,
    sha256: await sha256Bytes(contentBytes)
  };
}

async function shardArtifacts(kind: string, items: any[], wrapper: any, maxItems = 500) {
  if (!items.length) return [];
  const chunks: any[][] = [];
  let current: any[] = [];
  let estimatedBytes = bytes(wrapper).byteLength + 64;
  for (const item of items) {
    const itemBytes = bytes(item).byteLength + 1;
    if (itemBytes > ARTIFACT_TARGET_BYTES) throw new HttpError(413, "canvas_artifact_item_too_large", `One ${kind} item exceeds its bounded artifact size.`);
    if (current.length && (current.length >= maxItems || estimatedBytes + itemBytes > ARTIFACT_TARGET_BYTES)) {
      chunks.push(current);
      current = [];
      estimatedBytes = bytes(wrapper).byteLength + 64;
    }
    current.push(item);
    estimatedBytes += itemBytes;
  }
  if (current.length) chunks.push(current);
  const result = [];
  for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
    result.push(await artifact(kind, ordinal, { ...wrapper, shard_ordinal: ordinal, shard_count: chunks.length, items: chunks[ordinal] }));
  }
  return result;
}

async function signManifest(unsignedManifest: any, privateKey: CryptoKey, keyId: string) {
  const payload = bytes(unsignedManifest);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, payload));
  return {
    ...unsignedManifest,
    signature: { algorithm: "Ed25519", key_id: keyId, value: base64Url(signature) }
  };
}

async function buildPackage(input: any) {
  const contextItems = [
    ...input.assignment.ownedUnits.map((unit: any) => ({ ownership: "owned_knock", ...unit })),
    ...input.assignment.sharedTransitUnits.map((unit: any) => ({ ownership: "shared_transit", ...unit }))
  ];
  const artifacts = [
    await artifact("territory", 0, {
      schema: "firstknock.canvas-territory",
      schema_version: 1,
      campaign_id: input.session.id,
      zone_id: input.assignment.zoneId,
      authoritative_ownership: "street_work_units",
      work_unit_ids: input.assignment.ownedUnits.map((unit: any) => unit.id).sort(),
      display_geometry: input.assignment.display,
      workload: {
        score: Number(input.assignment.zone?.workload_score || 0),
        opportunity_expected: Number(input.assignment.zone?.opportunity_expected || 0),
        street_length_meters: Number(input.assignment.zone?.street_length_meters || 0)
      }
    }),
    ...await shardArtifacts("context_streets", contextItems, {
      schema: "firstknock.canvas-context-streets",
      schema_version: 1,
      campaign_id: input.session.id,
      zone_id: input.assignment.zoneId
    }, 350),
    await artifact("opportunities", 0, {
      schema: "firstknock.canvas-evidence-pin",
      schema_version: 1,
      territory_model: input.session.territory_model,
      evidence_id: input.session.evidence_id || null,
      evidence_release_id: input.session.evidence_release_id || null,
      snapshot_hash: input.session.snapshot_hash || null,
      evidence_schema_version: Number(input.session.evidence_schema_version || 0) || null,
      classification_revision_id: input.session.revision_id || null,
      algorithm_version: input.session.algorithm_version || null,
      data_version: input.session.data_version || null,
      unresolved_unit_count: Number(input.session.unresolved_unit_count || 0)
    }),
    ...await shardArtifacts("pins", input.pins, {
      schema: "firstknock.canvas-pin-baseline",
      schema_version: 1,
      campaign_id: input.session.id,
      zone_id: input.assignment.zoneId,
      replace: true,
      baseline_cursor: String(input.baselineCursor)
    }, 1_000)
  ];
  if (!input.pins.length) {
    artifacts.push(await artifact("pins", 0, {
      schema: "firstknock.canvas-pin-baseline",
      schema_version: 1,
      campaign_id: input.session.id,
      zone_id: input.assignment.zoneId,
      replace: true,
      baseline_cursor: String(input.baselineCursor),
      shard_ordinal: 0,
      shard_count: 1,
      items: []
    }));
  }
  const dncShards = await shardArtifacts("dnc_shard", input.dncEntries, {
    schema: "firstknock.canvas-dnc-shard",
    schema_version: 1,
    manager_id: input.session.manager_id,
    campaign_id: input.session.id,
    zone_id: input.assignment.zoneId,
    high_water_cursor: String(input.baselineCursor)
  }, 1_000);
  artifacts.push(...dncShards);
  const dncRootHash = await sha256({
    high_water_cursor: String(input.baselineCursor),
    shards: dncShards.map((entry) => ({ artifact_id: entry.artifactId, sha256: entry.sha256, byte_size: entry.contentBytes.byteLength }))
  });
  const dncManifestArtifact = await artifact("dnc_manifest", 0, {
    schema: "firstknock.canvas-dnc-manifest",
    schema_version: 1,
    complete: true,
    manager_id: input.session.manager_id,
    campaign_id: input.session.id,
    zone_id: input.assignment.zoneId,
    high_water_cursor: String(input.baselineCursor),
    total_count: input.dncEntries.length,
    root_hash: dncRootHash,
    shard_artifact_ids: dncShards.map((entry) => entry.artifactId)
  });
  artifacts.push(dncManifestArtifact);
  artifacts.sort((left, right) => left.kind.localeCompare(right.kind) || left.ordinal - right.ordinal);
  const artifactBytes = artifacts.reduce((sum, entry) => sum + entry.contentBytes.byteLength, 0);
  const unsignedManifest = {
    schema: PACKAGE_SCHEMA,
    schema_version: PACKAGE_SCHEMA_VERSION,
    package_id: input.packageId,
    package_version: input.packageVersion,
    manager_id: input.session.manager_id,
    assignment_id: input.assignment.assignmentId,
    assignee_user_id: input.assignment.assigneeUserId,
    team_member_id: input.assignment.teamMemberId,
    campaign_id: input.session.id,
    zone_id: input.assignment.zoneId,
    plan_hash: input.session.plan_hash,
    territory_hash: input.assignment.territoryHash,
    issued_at: input.issuedAt,
    valid_until: input.validUntil,
    evidence: {
      evidence_id: input.session.evidence_id || null,
      evidence_release_id: input.session.evidence_release_id || null,
      snapshot_hash: input.session.snapshot_hash || null,
      classification_revision_id: input.session.revision_id || null
    },
    baseline_cursor: String(input.baselineCursor),
    dnc: {
      complete: true,
      artifact_id: dncManifestArtifact.artifactId,
      high_water_cursor: String(input.baselineCursor),
      total_count: input.dncEntries.length,
      root_hash: dncRootHash
    },
    artifacts: artifacts.map((entry) => ({
      artifact_id: entry.artifactId,
      artifact_kind: entry.kind,
      artifact_ordinal: entry.ordinal,
      required: entry.required,
      content_type: entry.contentType,
      byte_size: entry.contentBytes.byteLength,
      sha256: entry.sha256
    }))
  };
  const manifest = await signManifest(unsignedManifest, input.privateKey, input.keyId);
  const manifestBytes = bytes(manifest);
  const manifestHash = await sha256Bytes(manifestBytes);
  const totalBytes = artifactBytes + manifestBytes.byteLength;
  if (totalBytes > MAX_PACKAGE_BYTES) throw new HttpError(413, "canvas_package_too_large", `Canvas zone ${input.assignment.zoneId} exceeds the offline package size limit.`);
  const dncScopeHash = await sha256({
    manager_id: input.session.manager_id,
    campaign_id: input.session.id,
    zone_id: input.assignment.zoneId,
    assignment_id: input.assignment.assignmentId,
    work_unit_ids: input.assignment.ownedUnits.map((unit: any) => unit.id).sort(),
    high_water_cursor: String(input.baselineCursor)
  });
  return { manifest, manifestBytes, manifestHash, artifacts, totalBytes, dncRootHash, dncScopeHash, dncManifestArtifact, dncShards };
}

async function insertOperationalRows(client: any, session: any, assignments: any[]) {
  await client.query(`
    INSERT INTO canvas_deployments (
      campaign_id, manager_id, plan_version, plan_hash, lifecycle_version,
      assignment_index_version, evidence_release_id, classification_revision_id,
      algorithm_version, status, deployed_at
    ) VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, 'packaging', $8)
    ON CONFLICT (campaign_id) DO NOTHING
  `, [session.id, session.manager_id, Number(session.deployment_plan_version), session.plan_hash, session.evidence_release_id || null, session.revision_id || null, session.algorithm_version || null, session.deployed_at]);
  const deployment = rows(await client.query(`
    SELECT * FROM canvas_deployments
    WHERE campaign_id = $1 AND manager_id = $2
    FOR UPDATE
  `, [session.id, session.manager_id]))[0];
  if (!deployment || deployment.plan_hash !== session.plan_hash || Number(deployment.plan_version) !== Number(session.deployment_plan_version)
    || !["packaging", "active"].includes(String(deployment.status))) {
    throw new HttpError(409, "canvas_operational_deployment_conflict", "The Canvas operational deployment does not match this signed campaign.");
  }
  const assignmentRows = assignments.map((assignment) => ({
    assignment_id: assignment.assignmentId,
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: assignment.zoneId,
    assignee_user_id: assignment.assigneeUserId,
    team_member_id: assignment.teamMemberId,
    territory_hash: assignment.territoryHash
  }));
  await client.query(`
    INSERT INTO canvas_assignments (
      assignment_id, manager_id, campaign_id, zone_id, assignee_user_id,
      team_member_id, package_version, package_status, status, territory_hash
    )
    SELECT
      item ->> 'assignment_id', item ->> 'manager_id', item ->> 'campaign_id',
      item ->> 'zone_id', item ->> 'assignee_user_id', item ->> 'team_member_id',
      1, 'pending', 'packaging', item ->> 'territory_hash'
    FROM jsonb_array_elements($1::jsonb) AS item
    ON CONFLICT (assignment_id) DO NOTHING
  `, [JSON.stringify(assignmentRows)]);
  const storedAssignments = rows(await client.query(`
    SELECT * FROM canvas_assignments
    WHERE manager_id = $1 AND campaign_id = $2
      AND assignment_id = ANY($3::text[])
    FOR UPDATE
  `, [session.manager_id, session.id, assignments.map((assignment) => assignment.assignmentId)]));
  if (storedAssignments.length !== assignments.length) {
    throw new HttpError(409, "canvas_operational_assignment_conflict", "The signed deployment assignments were not stored exactly.");
  }
  const storedById = new Map(storedAssignments.map((stored: any) => [String(stored.assignment_id), stored]));
  for (const assignment of assignments) {
    const stored = storedById.get(assignment.assignmentId);
    if (!stored || stored.campaign_id !== session.id || stored.zone_id !== assignment.zoneId
      || stored.assignee_user_id !== assignment.assigneeUserId || stored.team_member_id !== assignment.teamMemberId
      || stored.territory_hash !== assignment.territoryHash || ["revoked", "superseded"].includes(String(stored.status))) {
      throw new HttpError(409, "canvas_operational_assignment_conflict", `Operational assignment ${assignment.zoneId} does not match the signed deployment.`);
    }
  }
  return deployment;
}

async function insertOwnership(client: any, session: any, assignments: any[]) {
  const ownership = assignments.flatMap((assignment) => assignment.ownedUnits.map((unit: any) => ({
    manager_id: session.manager_id,
    campaign_id: session.id,
    assignment_id: assignment.assignmentId,
    zone_id: assignment.zoneId,
    work_unit_id: unit.id,
    protected_group_id: unit.protected_group_id || unit.protected_group_ids[0] || null,
    geometry: unitGeometry(unit)
  })));
  for (let index = 0; index < ownership.length; index += OWNERSHIP_BATCH_SIZE) {
    await client.query(`
      INSERT INTO canvas_work_unit_ownership (
        manager_id, campaign_id, assignment_id, zone_id, work_unit_id,
        protected_group_id, geometry
      )
      SELECT
        item ->> 'manager_id', item ->> 'campaign_id', item ->> 'assignment_id',
        item ->> 'zone_id', item ->> 'work_unit_id', item ->> 'protected_group_id',
        ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(item ->> 'geometry'), 4326))
      FROM jsonb_array_elements($1::jsonb) AS item
      ON CONFLICT (manager_id, campaign_id, work_unit_id) DO NOTHING
    `, [JSON.stringify(ownership.slice(index, index + OWNERSHIP_BATCH_SIZE))]);
  }
  const counts = rows(await client.query(`
    SELECT assignment_id, COUNT(*)::bigint AS unit_count
    FROM canvas_work_unit_ownership
    WHERE manager_id = $1 AND campaign_id = $2
    GROUP BY assignment_id
  `, [session.manager_id, session.id]));
  const byAssignment = new Map(counts.map((row: any) => [String(row.assignment_id), Number(row.unit_count)]));
  for (const assignment of assignments) {
    if (byAssignment.get(assignment.assignmentId) !== assignment.ownedUnits.length) {
      throw new HttpError(409, "canvas_operational_ownership_conflict", `Street ownership for ${assignment.zoneId} is incomplete or conflicting.`);
    }
  }
  if ([...byAssignment.values()].reduce((sum, count) => sum + count, 0) !== ownership.length) {
    throw new HttpError(409, "canvas_operational_ownership_conflict", "Operational street ownership contains unexpected assignments.");
  }
}

async function supersedeOperationalPredecessors(client: any, session: any, predecessors: any[], {
  transitionedAt,
  transitionedByUserId,
  publicationIdempotencyKey
}: any) {
  const transitioned = [];
  for (const predecessor of [...predecessors].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`canvas:publish:${predecessor.manager_id}:${predecessor.id}`]);
    await client.query(`
      INSERT INTO canvas_deployments (
        campaign_id, manager_id, plan_version, plan_hash, lifecycle_version,
        assignment_index_version, evidence_release_id, classification_revision_id,
        algorithm_version, status, deployed_at, closed_at, closed_by_user_id,
        lifecycle_action, lifecycle_idempotency_key, superseded_by_campaign_id
      ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, 'superseded', $9, $10, $11, 'supersede', $12, $13)
      ON CONFLICT (campaign_id) DO NOTHING
    `, [
      predecessor.id,
      predecessor.manager_id,
      Number(predecessor.deployment_plan_version),
      predecessor.plan_hash,
      Number(predecessor.version) + 1,
      predecessor.evidence_release_id || null,
      predecessor.revision_id || null,
      predecessor.algorithm_version || null,
      predecessor.deployed_at,
      transitionedAt,
      transitionedByUserId,
      publicationIdempotencyKey,
      session.id
    ]);
    const deployment = rows(await client.query(`
      SELECT * FROM canvas_deployments
      WHERE campaign_id = $1
      FOR UPDATE
    `, [predecessor.id]))[0];
    if (!deployment
      || String(deployment.manager_id) !== String(predecessor.manager_id)
      || String(deployment.plan_hash) !== String(predecessor.plan_hash)
      || Number(deployment.plan_version) !== Number(predecessor.deployment_plan_version)) {
      throw new HttpError(409, "canvas_operational_lifecycle_conflict", "A replaced operational campaign does not match its signed lifecycle.");
    }
    const currentStatus = String(deployment.status || "");
    if (["completed", "recalled", "quarantined"].includes(currentStatus)) continue;
    if (currentStatus === "superseded") {
      if (String(deployment.superseded_by_campaign_id || "") !== String(session.id)) {
        throw new HttpError(409, "canvas_operational_lifecycle_conflict", "A predecessor campaign is already bound to a different successor.");
      }
      transitioned.push(predecessor.id);
      continue;
    }
    if (!["packaging", "active"].includes(currentStatus)) {
      throw new HttpError(409, "canvas_operational_lifecycle_conflict", `A predecessor campaign is already ${currentStatus || "closed"}.`);
    }
    await client.query(`
      UPDATE canvas_assignment_packages AS p
      SET status = 'revoked', updated_at = NOW()
      FROM canvas_assignments AS a
      WHERE p.manager_id = $1
        AND a.manager_id = p.manager_id
        AND a.assignment_id = p.assignment_id
        AND a.campaign_id = $2
        AND p.status IN ('building', 'ready')
    `, [predecessor.manager_id, predecessor.id]);
    await client.query(`
      UPDATE canvas_assignments
      SET status = 'superseded', package_status = 'revoked',
        revoked_at = COALESCE(revoked_at, $3),
        revocation_reason = COALESCE(revocation_reason, $4),
        updated_at = NOW()
      WHERE manager_id = $1 AND campaign_id = $2
        AND status IN ('packaging', 'active', 'superseded')
    `, [predecessor.manager_id, predecessor.id, transitionedAt, `superseded_by:${session.id}`]);
    const updated = rows(await client.query(`
      UPDATE canvas_deployments
      SET status = 'superseded',
        lifecycle_version = GREATEST(lifecycle_version, $3),
        assignment_index_version = assignment_index_version + 1,
        closed_at = COALESCE(closed_at, $4),
        closed_by_user_id = COALESCE(closed_by_user_id, $5),
        lifecycle_action = COALESCE(lifecycle_action, 'supersede'),
        lifecycle_idempotency_key = COALESCE(lifecycle_idempotency_key, $6),
        superseded_by_campaign_id = COALESCE(superseded_by_campaign_id, $7),
        updated_at = NOW()
      WHERE campaign_id = $1 AND manager_id = $2
      RETURNING status, superseded_by_campaign_id
    `, [predecessor.id, predecessor.manager_id, Number(predecessor.version) + 1, transitionedAt, transitionedByUserId, publicationIdempotencyKey, session.id]))[0];
    if (!updated || String(updated.status) !== "superseded"
      || String(updated.superseded_by_campaign_id) !== String(session.id)) {
      throw new HttpError(503, "canvas_operational_lifecycle_failed", "Canvas could not verify predecessor assignment revocation.");
    }
    transitioned.push(predecessor.id);
  }
  return transitioned;
}

async function activateOperationalDeployment(client: any, session: any, incrementIndex: boolean) {
  const activated = rows(await client.query(`
    UPDATE canvas_deployments
    SET status = 'active',
      assignment_index_version = assignment_index_version + CASE WHEN $3::boolean THEN 1 ELSE 0 END,
      updated_at = NOW()
    WHERE campaign_id = $1 AND manager_id = $2
      AND status IN ('packaging', 'active')
    RETURNING status, assignment_index_version
  `, [session.id, session.manager_id, incrementIndex]))[0];
  if (!activated || String(activated.status) !== "active") {
    throw new HttpError(503, "canvas_operational_activation_failed", "Canvas could not verify the replacement assignment index.");
  }
  return activated;
}

function publicPin(row: any) {
  return {
    pin_id: row.pin_id,
    house_key: row.house_key,
    opportunity_id: row.opportunity_id,
    street_unit_id: row.street_unit_id,
    point: { lat: Number(row.lat), lng: Number(row.lng) },
    address: row.address,
    unit_label: row.unit_label,
    latest_outcome: row.latest_outcome,
    latest_note: row.latest_note,
    latest_event_id: row.latest_event_id,
    latest_change_cursor: String(row.latest_change_cursor),
    latest_client_recorded_at: row.latest_client_recorded_at,
    version: Number(row.version)
  };
}

function publicDnc(row: any) {
  return {
    suppression_id: row.suppression_id,
    house_key: row.house_key,
    point: { lat: Number(row.lat), lng: Number(row.lng) },
    set_at: row.set_at,
    active: true,
    version: Number(row.version),
    change_cursor: String(row.change_cursor)
  };
}

async function baselineRows(client: any, session: any) {
  const highWater = Number(rows(await client.query(`
    SELECT COALESCE(MAX(cursor), 0) AS cursor
    FROM canvas_changes
    WHERE manager_id = $1
  `, [session.manager_id]))[0]?.cursor || 0);
  const pins = rows(await client.query(`
    SELECT p.*, ST_Y(p.point) AS lat, ST_X(p.point) AS lng
    FROM canvas_house_pins p
    WHERE p.manager_id = $1 AND p.campaign_id = $2
    ORDER BY p.zone_id, p.pin_id
    LIMIT $3
  `, [session.manager_id, session.id, MAX_PINS + 1]));
  if (pins.length > MAX_PINS) throw new HttpError(413, "canvas_pin_baseline_too_large", "The campaign pin baseline exceeds the safe publication limit.");
  const dnc = rows(await client.query(`
    SELECT DISTINCT ON (s.suppression_id, w.zone_id)
      s.suppression_id, s.house_key, s.set_at, s.version, s.change_cursor,
      ST_Y(s.point) AS lat, ST_X(s.point) AS lng, w.zone_id
    FROM canvas_dnc_suppressions s
    JOIN canvas_work_unit_ownership w
      ON w.manager_id = s.manager_id AND w.campaign_id = $2
     AND ST_DWithin(w.geometry::geography, s.point::geography, 150)
    WHERE s.manager_id = $1 AND s.active AND s.change_cursor <= $3
    ORDER BY s.suppression_id, w.zone_id, s.change_cursor DESC
    LIMIT $4
  `, [session.manager_id, session.id, highWater, MAX_RELEVANT_DNC_ROWS + 1]));
  if (dnc.length > MAX_RELEVANT_DNC_ROWS) throw new HttpError(413, "canvas_dnc_baseline_too_large", "The complete DNC baseline exceeds the safe publication limit.");
  return { highWater, pins, dnc };
}

async function existingIdempotentPackages(client: any, session: any, assignments: any[], idempotencyKey: string, requestHash: string) {
  const existing = rows(await client.query(`
    SELECT package_id, assignment_id, package_version, publication_request_hash,
      status, valid_until
    FROM canvas_assignment_packages
    WHERE manager_id = $1 AND publication_idempotency_key = $2
      AND assignment_id = ANY($3::text[])
    ORDER BY assignment_id
  `, [session.manager_id, idempotencyKey, assignments.map((assignment) => assignment.assignmentId)]));
  if (!existing.length) return null;
  if (existing.length !== assignments.length || existing.some((entry: any) => entry.publication_request_hash !== requestHash)) {
    throw new HttpError(409, "canvas_publication_idempotency_reused", "This publication key was already used for different package content.");
  }
  if (existing.some((entry: any) => entry.status !== "ready" || Date.parse(entry.valid_until) <= Date.now())) {
    throw new HttpError(409, "canvas_publication_superseded", "That idempotent publication is no longer active. Use a new key to refresh packages.");
  }
  return existing;
}

async function nextPackageVersions(client: any, managerId: string, assignments: any[]) {
  const results = rows(await client.query(`
    SELECT requested.assignment_id,
      MAX(package_version)::bigint AS maximum,
      COUNT(package_id)::bigint AS package_count
    FROM unnest($2::text[]) AS requested(assignment_id)
    LEFT JOIN canvas_assignment_packages packages
      ON packages.manager_id = $1
     AND packages.assignment_id = requested.assignment_id
    GROUP BY requested.assignment_id
  `, [managerId, assignments.map((assignment) => assignment.assignmentId)]));
  if (results.length !== assignments.length) {
    throw new HttpError(409, "canvas_package_version_conflict", "Canvas could not allocate every assignment package version.");
  }
  return new Map(results.map((result: any) => [
    String(result.assignment_id),
    Number(result.package_count || 0) ? Number(result.maximum) + 1 : 1
  ]));
}

async function storePackage(client: any, input: any) {
  const built = await buildPackage(input);
  const dncManifestId = `canvas_dnc_manifest_${await sha256({ package_id: input.packageId, scope_hash: built.dncScopeHash, root_hash: built.dncRootHash })}`;
  const artifactRows = built.artifacts.map((entry: any) => ({
    artifact_id: entry.artifactId,
    artifact_kind: entry.kind,
    artifact_ordinal: entry.ordinal,
    object_key: artifactObjectKey(input.packageId, entry.artifactId),
    sha256: entry.sha256,
    byte_size: entry.contentBytes.byteLength,
    content_type: entry.contentType,
    content_base64: base64Standard(entry.contentBytes),
    required: entry.required
  }));
  const dncScope = {
    campaign_id: input.session.id,
    zone_id: input.assignment.zoneId,
    high_water_cursor: String(input.baselineCursor)
  };
  const dncShardRows = built.dncShards.map((entry: any) => ({
    shard_ordinal: entry.ordinal,
    object_key: artifactObjectKey(input.packageId, entry.artifactId),
    sha256: entry.sha256,
    suppression_count: JSON.parse(new TextDecoder().decode(entry.contentBytes)).items.length,
    scope: dncScope
  }));
  const stored = rows(await client.query(`
    WITH inserted_package AS (
      INSERT INTO canvas_assignment_packages (
        package_id, manager_id, assignment_id, package_version,
        publication_idempotency_key, publication_request_hash, status,
        manifest_object_key, manifest_hash, manifest_signature, manifest_content,
        manifest_byte_size, signing_key_id, evidence_release_id,
        classification_revision_id, event_cursor, dnc_high_water_cursor,
        total_bytes, issued_at, valid_until
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'ready', $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $15, $16, $17, $18
      )
      RETURNING package_id
    ),
    inserted_artifacts AS (
      INSERT INTO canvas_package_artifacts (
        manager_id, package_id, artifact_id, artifact_kind, artifact_ordinal,
        object_key, sha256, byte_size, content_type, content, required
      )
      SELECT
        $2, package.package_id, item ->> 'artifact_id', item ->> 'artifact_kind',
        (item ->> 'artifact_ordinal')::integer, item ->> 'object_key',
        item ->> 'sha256', (item ->> 'byte_size')::bigint,
        item ->> 'content_type', decode(item ->> 'content_base64', 'base64'),
        (item ->> 'required')::boolean
      FROM inserted_package package
      CROSS JOIN jsonb_array_elements($19::jsonb) AS item
      RETURNING artifact_id
    ),
    inserted_dnc_manifest AS (
      INSERT INTO canvas_dnc_manifests (
        dnc_manifest_id, manager_id, package_id, assignment_id, manifest_version,
        high_water_cursor, scope_hash, root_hash, shard_count, total_count, complete
      )
      SELECT $20, $2, package.package_id, $3, $4, $15, $21, $22, $23, $24, TRUE
      FROM inserted_package package
      RETURNING dnc_manifest_id
    ),
    inserted_dnc_shards AS (
      INSERT INTO canvas_dnc_manifest_shards (
        manager_id, dnc_manifest_id, shard_ordinal, object_key, sha256,
        suppression_count, scope
      )
      SELECT
        $2, manifest.dnc_manifest_id, (item ->> 'shard_ordinal')::integer,
        item ->> 'object_key', item ->> 'sha256',
        (item ->> 'suppression_count')::bigint, item -> 'scope'
      FROM inserted_dnc_manifest manifest
      CROSS JOIN jsonb_array_elements($25::jsonb) AS item
      RETURNING shard_ordinal
    ),
    revoked_packages AS (
      UPDATE canvas_assignment_packages
      SET status = 'revoked', updated_at = NOW()
      WHERE manager_id = $2 AND assignment_id = $3 AND package_id <> $1
        AND status IN ('building', 'ready')
      RETURNING package_id
    ),
    updated_assignment AS (
      UPDATE canvas_assignments SET
        package_version = $4, package_status = 'ready', status = 'active',
        valid_from = $17, valid_until = $18, revoked_at = NULL,
        revocation_reason = NULL, updated_at = NOW()
      WHERE assignment_id = $3 AND manager_id = $2
        AND EXISTS (SELECT 1 FROM inserted_package)
      RETURNING assignment_id
    )
    SELECT
      (SELECT COUNT(*)::bigint FROM inserted_package) AS package_count,
      (SELECT COUNT(*)::bigint FROM inserted_artifacts) AS artifact_count,
      (SELECT COUNT(*)::bigint FROM inserted_dnc_manifest) AS dnc_manifest_count,
      (SELECT COUNT(*)::bigint FROM inserted_dnc_shards) AS dnc_shard_count,
      (SELECT COUNT(*)::bigint FROM revoked_packages) AS revoked_count,
      (SELECT COUNT(*)::bigint FROM updated_assignment) AS assignment_count
  `, [
    input.packageId, input.session.manager_id, input.assignment.assignmentId,
    input.packageVersion, input.idempotencyKey, input.requestHash,
    `canvas-db://${input.packageId}/manifest.json`, built.manifestHash,
    built.manifest.signature.value, built.manifestBytes, built.manifestBytes.byteLength,
    input.keyId, input.session.evidence_release_id || null, input.session.revision_id || null,
    input.baselineCursor, built.totalBytes, input.issuedAt, input.validUntil,
    JSON.stringify(artifactRows), dncManifestId, built.dncScopeHash, built.dncRootHash,
    built.dncShards.length, input.dncEntries.length, JSON.stringify(dncShardRows)
  ]))[0];
  if (!stored || Number(stored.package_count) !== 1
    || Number(stored.artifact_count) !== built.artifacts.length
    || Number(stored.dnc_manifest_count) !== 1
    || Number(stored.dnc_shard_count) !== built.dncShards.length
    || Number(stored.assignment_count) !== 1) {
    throw new HttpError(409, "canvas_package_store_incomplete", `Canvas could not atomically store the offline package for ${input.assignment.zoneId}.`);
  }
  return {
    package_id: input.packageId,
    assignment_id: input.assignment.assignmentId,
    zone_id: input.assignment.zoneId,
    assignee_user_id: input.assignment.assigneeUserId,
    package_version: input.packageVersion,
    manifest_hash: built.manifestHash,
    artifact_count: built.artifacts.length,
    total_bytes: built.totalBytes,
    valid_until: input.validUntil
  };
}

Deno.serve(async (req) => {
  let client: any = null;
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to publish Canvas packages." }, 401);
    if (!canManageCanvas(user)) return json({ error: "manager_required", message: "Only a Canvas manager can publish assignment packages." }, 403);
    const body = await req.json().catch(() => ({}));
    const campaignId = requiredString(body.campaign_id, "campaign_id", 256);
    const idempotencyKey = requiredString(body.publication_idempotency_key, "publication_idempotency_key", 128);
    const validHours = body.valid_for_hours === undefined ? DEFAULT_VALID_HOURS : Number(body.valid_for_hours);
    if (!Number.isInteger(validHours) || validHours < 1 || validHours > MAX_VALID_HOURS) {
      throw new HttpError(400, "invalid_package_expiry", `valid_for_hours must be between 1 and ${MAX_VALID_HOURS}.`);
    }
    const session = await base44.entities.CanvasSession.get(campaignId).catch(() => null);
    if (!session || String(session.manager_id || "") !== String(user.id)) throw new HttpError(404, "campaign_not_found", "The Canvas campaign was not found for this manager.");
    if (!await verifyActiveLifecycle(session)) throw new HttpError(409, "canvas_lifecycle_integrity_failed", "Only an active, signed Canvas deployment can be packaged.");
    const operationalPredecessors = await verifiedOperationalPredecessors(base44, session);
    const membersById = await verifiedTeamBindings(base44, session);
    const { assignments } = await normalizedAssignments(session, membersById);
    const signing = await verifiedSigningKeys();
    const requestHash = await sha256({
      purpose: "firstknock-canvas-package-publication-v1",
      campaign_id: session.id,
      manager_id: session.manager_id,
      plan_hash: session.plan_hash,
      lifecycle_signature: session.deployment_signature,
      signing_key_id: signing.configuration.keyId,
      valid_for_hours: validHours
    });

    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas package publication is not configured.");
    client = new Client(databaseUrl);
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`canvas:publish:${session.manager_id}:${session.id}`]);
      const deployment = await insertOperationalRows(client, session, assignments);
      await insertOwnership(client, session, assignments);
      const idempotent = await existingIdempotentPackages(client, session, assignments, idempotencyKey, requestHash);
      if (idempotent) {
        const supersededCampaignIds = await supersedeOperationalPredecessors(client, session, operationalPredecessors, {
          transitionedAt: new Date().toISOString(),
          transitionedByUserId: user.id,
          publicationIdempotencyKey: idempotencyKey
        });
        const activated = await activateOperationalDeployment(client, session, false);
        await client.query("COMMIT");
        return json({
          success: true,
          idempotent: true,
          campaign_id: session.id,
          assignment_index_version: Number(activated.assignment_index_version),
          superseded_campaign_ids: supersededCampaignIds,
          signing_key: signing.publicKey,
          packages: idempotent.map((entry: any) => ({
            package_id: entry.package_id,
            assignment_id: entry.assignment_id,
            package_version: Number(entry.package_version),
            valid_until: entry.valid_until
          }))
        });
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`canvas:dnc:${session.manager_id}`]);
      const baseline = await baselineRows(client, session);
      const pinsByZone = new Map<string, any[]>();
      for (const pin of baseline.pins) {
        const zoneId = String(pin.zone_id);
        if (!pinsByZone.has(zoneId)) pinsByZone.set(zoneId, []);
        pinsByZone.get(zoneId)?.push(publicPin(pin));
      }
      const dncByZone = new Map<string, any[]>();
      for (const entry of baseline.dnc) {
        const zoneId = String(entry.zone_id);
        if (!dncByZone.has(zoneId)) dncByZone.set(zoneId, []);
        dncByZone.get(zoneId)?.push(publicDnc(entry));
      }
      const issuedAt = new Date().toISOString();
      const validUntil = new Date(Date.parse(issuedAt) + validHours * 60 * 60 * 1000).toISOString();
      const packageVersions = await nextPackageVersions(client, session.manager_id, assignments);
      const packages = [];
      let publicationBytes = 0;
      for (const assignment of assignments) {
        const packageVersion = packageVersions.get(assignment.assignmentId);
        if (!packageVersion) throw new HttpError(409, "canvas_package_version_conflict", `Canvas could not allocate a package version for ${assignment.zoneId}.`);
        const packageId = `canvas_package_${await sha256({ assignment_id: assignment.assignmentId, package_version: packageVersion, publication_request_hash: requestHash })}`;
        const stored = await storePackage(client, {
          session,
          assignment,
          packageId,
          packageVersion,
          idempotencyKey,
          requestHash,
          issuedAt,
          validUntil,
          baselineCursor: baseline.highWater,
          pins: pinsByZone.get(assignment.zoneId) || [],
          dncEntries: dncByZone.get(assignment.zoneId) || [],
          privateKey: signing.privateKey,
          keyId: signing.configuration.keyId
        });
        publicationBytes += Number(stored.total_bytes || 0);
        if (publicationBytes > MAX_PUBLICATION_BYTES) throw new HttpError(413, "canvas_publication_too_large", "The assignment-package publication exceeds its all-or-nothing byte limit.");
        packages.push(stored);
      }
      const supersededCampaignIds = await supersedeOperationalPredecessors(client, session, operationalPredecessors, {
        transitionedAt: issuedAt,
        transitionedByUserId: user.id,
        publicationIdempotencyKey: idempotencyKey
      });
      const indexResult = await activateOperationalDeployment(client, session, true);
      await client.query("COMMIT");
      return json({
        success: true,
        idempotent: false,
        campaign_id: session.id,
        package_count: packages.length,
        assignment_index_version: Number(indexResult.assignment_index_version),
        superseded_campaign_ids: supersededCampaignIds,
        signing_key: signing.publicKey,
        publication_bytes: publicationBytes,
        packages
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
    }
    const code = String((error as any)?.code || (error as any)?.cause?.code || "");
    console.error("[canvasPublishAssignmentPackages] publication failed", { code: code || "unknown" });
    return json({ error: "canvas_package_publication_failed", message: "Canvas assignment packages could not be published." }, ["40001", "40P01"].includes(code) ? 409 : 503);
  } finally {
    if (client) await client.end().catch(() => undefined);
  }
});
