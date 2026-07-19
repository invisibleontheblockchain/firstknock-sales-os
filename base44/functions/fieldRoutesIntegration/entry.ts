import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const ACTIONS = new Set([
  "capability", "get_connection", "save_connection", "test_connection", "list_service_types",
  "disconnect", "list_activity", "retry_request", "reconcile", "schedule_inspection",
  "get_statuses", "process_queue"
]);
const TERMINAL_STATES = new Set(["synced", "review_required", "failed", "superseded"]);
const PROCESSABLE_STATES = new Set(["queued", "processing", "retry_wait", "customer_reconcile", "appointment_reconcile"]);
const VALID_APPOINTMENT_STATUSES = new Set([-2, -1, 0, 1, 2]);
const MAX_BODY_BYTES = 64_000;
const LEASE_MS = 180_000;
const REQUEST_AGE_LIMIT_MS = 24 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 9_000;
const CANVAS_ADDRESS_VALIDATOR_VERSION = "batchdata-address-verify-v1";
const MAX_CANVAS_ADDRESS_VALIDATION_ATTEMPTS = 5;
const CANVAS_ADDRESS_CONFIGURATION_ERRORS = new Set([
  "canvas_address_validator_not_configured",
  "canvas_address_validation_configuration_error"
]);

class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class ProviderError extends Error {
  code: string;
  httpStatus: number | null;
  retryable: boolean;
  ambiguousWrite: boolean;
  tokenUsage: Record<string, number> | null;
  retryAfterSeconds: number | null;
  constructor(code: string, options: { httpStatus?: number | null; retryable?: boolean; ambiguousWrite?: boolean; tokenUsage?: Record<string, number> | null; retryAfterSeconds?: number | null } = {}) {
    super(code);
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = options.retryable === true;
    this.ambiguousWrite = options.ambiguousWrite === true;
    this.tokenUsage = options.tokenUsage || null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

class ReviewRequiredError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const asArray = (value: any): any[] => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
const normalized = (value: unknown) => String(value || "").trim().toLowerCase();

function fieldRoutesModes() {
  const canvasEnabled = normalized(Deno.env.get("FIELDROUTES_CANVAS_ENABLED")) === "true";
  return {
    precision_enabled: true,
    canvas_enabled: canvasEnabled,
    modes: {
      precision: true,
      canvas: canvasEnabled
    }
  };
}

function assertFieldRoutesScheduleSourceEnabled(body: any) {
  const source = body?.source || {};
  const requestedModes = [
    source?.kind,
    source?.mode,
    source?.source_kind,
    source?.source_mode,
    body?.source_kind,
    body?.source_mode,
    body?.mode
  ].map(normalized).filter(Boolean);
  if (requestedModes.includes("canvas") && !fieldRoutesModes().canvas_enabled) {
    throw new HttpError(
      409,
      "canvas_fieldroutes_not_enabled",
      "Canvas FieldRoutes scheduling is not available yet. Precision FieldRoutes scheduling remains available."
    );
  }
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function sha256(value: unknown) {
  const encoded = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

function requiredString(value: unknown, field: string, maxLength = 256) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_request", `${field} is required or invalid.`);
  return result;
}

function optionalString(value: unknown, field: string, maxLength = 256) {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value).trim();
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  return result;
}

function numericIdentifier(value: unknown, field: string, required = false) {
  const result = value === undefined || value === null || value === "" ? "" : String(value).trim();
  if (!result) {
    if (required) throw new HttpError(400, "invalid_request", `${field} is required.`);
    return null;
  }
  if (!/^[1-9]\d{0,18}$/.test(result)) throw new HttpError(400, "invalid_request", `${field} must be a positive FieldRoutes identifier.`);
  return result;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encryptionKeyBytes() {
  const configured = (Deno.env.get("FIELDROUTES_ENCRYPTION_KEY") || "").trim();
  let bytes: Uint8Array;
  try {
    if (/^[a-fA-F0-9]{64}$/.test(configured)) {
      bytes = Uint8Array.from(configured.match(/../g) || [], (pair) => parseInt(pair, 16));
    } else {
      bytes = base64UrlDecode(configured);
    }
  } catch {
    bytes = new Uint8Array();
  }
  if (bytes.length !== 32) throw new HttpError(503, "encryption_unavailable", "FieldRoutes encryption is not configured.");
  return bytes;
}

async function encryptionKey() {
  return await crypto.subtle.importKey("raw", encryptionKeyBytes(), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function envelopeAad(purpose: string, managerId: string, recordId: string) {
  return new TextEncoder().encode(`firstknock-fieldroutes:v1:${purpose}:${managerId}:${recordId}`);
}

async function encryptJson(value: unknown, purpose: string, managerId: string, recordId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: envelopeAad(purpose, managerId, recordId), tagLength: 128 },
    await encryptionKey(),
    plaintext
  );
  return { v: 1, alg: "A256GCM", kid: "fieldroutes-v1", iv: base64UrlEncode(iv), ct: base64UrlEncode(new Uint8Array(ciphertext)) };
}

async function decryptJson(envelope: any, purpose: string, managerId: string, recordId: string) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== "A256GCM" || envelope.kid !== "fieldroutes-v1") {
    throw new HttpError(503, "encrypted_record_invalid", "A FieldRoutes encrypted record is unavailable.");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(String(envelope.iv)), additionalData: envelopeAad(purpose, managerId, recordId), tagLength: 128 },
      await encryptionKey(),
      base64UrlDecode(String(envelope.ct))
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "encrypted_record_invalid", "A FieldRoutes encrypted record could not be opened.");
  }
}

function canManage(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}

async function resolveActor(base44: any, user: any) {
  if (canManage(user)) return { managerId: String(user.id), teamMember: null, isManager: true };
  const managerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!managerId) throw new HttpError(403, "team_membership_required", "An active team assignment is required.");
  const matches = asArray(await base44.entities.TeamMember.filter({ user_id: user.id, status: "active" }, "-updated_date", 20).catch(() => []))
    .filter((member) => String(member?.user_id || "") === String(user.id) && String(member?.manager_id || "") === managerId && member?.status === "active" && normalized(member?.role) === "rep");
  const unique = new Map(matches.map((member) => [String(member.id), member]));
  if (unique.size !== 1) throw new HttpError(unique.size ? 409 : 403, unique.size ? "ambiguous_team_membership" : "team_membership_required", "An exact active rep assignment is required.");
  return { managerId, teamMember: [...unique.values()][0], isManager: false };
}

function requireManager(actor: any) {
  if (!actor.isManager) throw new HttpError(403, "manager_required", "Manager access is required.");
}

function providerLocation(input: any) {
  const environment = normalized(input?.environment || "production");
  if (environment === "legacy_staging" || environment === "staging") {
    return { environment: "legacy_staging", subdomain: null, baseUrl: "https://stagingdemo.pestroutes.com/api/" };
  }
  if (environment !== "production") throw new HttpError(400, "invalid_provider_host", "Select production or the legacy staging environment.");
  const subdomain = requiredString(input?.subdomain, "subdomain", 63).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new HttpError(400, "invalid_provider_host", "Enter only the FieldRoutes account subdomain.");
  }
  return { environment: "production", subdomain, baseUrl: `https://${subdomain}.fieldroutes.com/api/` };
}

function assertStoredProviderLocation(connection: any) {
  const expected = providerLocation({ environment: connection.environment, subdomain: connection.subdomain });
  if (connection.base_url !== expected.baseUrl) throw new HttpError(503, "provider_host_invalid", "The stored FieldRoutes host failed validation.");
  return expected;
}

function requestIntegrationSnapshot(connection: any) {
  const location = assertStoredProviderLocation(connection);
  return {
    environment: location.environment,
    account_host: new URL(location.baseUrl).host,
    service_type_id: String(connection.default_service_type_id || ""),
    appointment_duration_minutes: Number(connection.appointment_duration_minutes || 60),
    source_id: connection.source_id ? String(connection.source_id) : null
  };
}

function assertRequestIntegrationSnapshot(connection: any, payload: any) {
  const snapshot = payload?.integration;
  const current = requestIntegrationSnapshot(connection);
  if (!snapshot || !snapshot.environment || !snapshot.account_host || !snapshot.service_type_id
    || !Number.isInteger(Number(snapshot.appointment_duration_minutes))
    || Number(snapshot.appointment_duration_minutes) < 5 || Number(snapshot.appointment_duration_minutes) > 480) {
    throw new ReviewRequiredError("fieldroutes_request_configuration_missing");
  }
  if (String(snapshot.environment) !== current.environment
    || String(snapshot.account_host).toLowerCase() !== current.account_host
    || String(snapshot.service_type_id) !== current.service_type_id) {
    throw new ReviewRequiredError("fieldroutes_request_configuration_changed");
  }
  return {
    environment: current.environment,
    account_host: current.account_host,
    service_type_id: current.service_type_id,
    appointment_duration_minutes: Number(snapshot.appointment_duration_minutes),
    source_id: snapshot.source_id ? String(snapshot.source_id) : null
  };
}

function redactRecursive(value: any): any {
  if (Array.isArray(value)) return value.map(redactRecursive);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(authentication|credential|secret|password|api.?key|token)/i.test(key)) result[key] = "[REDACTED]";
    else result[key] = redactRecursive(child);
  }
  return result;
}

function safeTokenUsage(payload: any) {
  const source = payload?.tokenUsage || payload?.result?.tokenUsage;
  if (!source || typeof source !== "object") return null;
  const result: Record<string, number> = {};
  for (const key of ["readsToday", "writesToday", "readsLastMinute", "writesLastMinute"]) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value >= 0) result[key] = Math.floor(value);
  }
  return Object.keys(result).length ? result : null;
}

function formValue(value: any) {
  if (Array.isArray(value) || (value && typeof value === "object")) return JSON.stringify(value);
  return String(value);
}

async function providerCall(connection: any, credentials: any, endpoint: string, params: Record<string, any>, write = false) {
  const allowedEndpoints = new Set(["customer/search", "customer/create", "appointment/search", "appointment/get", "appointment/create", "serviceType/search"]);
  if (!allowedEndpoints.has(endpoint)) throw new HttpError(500, "provider_endpoint_invalid", "The FieldRoutes operation is not allowed.");
  const location = assertStoredProviderLocation(connection);
  const authKey = requiredString(credentials?.authenticationKey, "authenticationKey", 1024);
  const authToken = requiredString(credentials?.authenticationToken, "authenticationToken", 2048);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, formValue(value));
  }
  // FieldRoutes can partially execute requests when these are not last.
  form.append("authenticationKey", authKey);
  form.append("authenticationToken", authToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL(endpoint, location.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "accept": "application/json" },
      body: form.toString(),
      signal: controller.signal,
      redirect: "error"
    });
  } catch (error) {
    const timeoutError = error?.name === "AbortError";
    throw new ProviderError(timeoutError ? "provider_timeout" : "provider_network_error", { retryable: true, ambiguousWrite: write });
  } finally {
    clearTimeout(timeout);
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError("provider_invalid_json", { httpStatus: response.status, retryable: !write, ambiguousWrite: write });
  }
  const tokenUsage = safeTokenUsage(payload);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ProviderError("provider_rate_limited", { httpStatus: 429, retryable: true, tokenUsage, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60 });
  }
  if (response.status >= 500) throw new ProviderError("provider_server_error", { httpStatus: response.status, retryable: true, ambiguousWrite: write, tokenUsage });
  if (!response.ok) throw new ProviderError(response.status === 401 || response.status === 403 ? "provider_authentication_failed" : "provider_request_rejected", { httpStatus: response.status, tokenUsage });
  if (!payload || payload.success === false) {
    const rawCode = normalized(payload?.errorCode || payload?.code || payload?.errorMessage);
    const authFailure = /auth|credential|token|key/.test(rawCode);
    throw new ProviderError(authFailure ? "provider_authentication_failed" : "provider_validation_failed", { httpStatus: response.status, tokenUsage });
  }
  return { payload, tokenUsage };
}

function parseCreatedId(payload: any, expectedField: "customerID" | "appointmentID") {
  // Swagger installations return a raw ID while legacy installations wrap it
  // in result (primitive or the single expected named field). No other field is guessed.
  const candidates: unknown[] = [];
  if (typeof payload === "string" || typeof payload === "number") candidates.push(payload);
  if (payload && typeof payload === "object" && payload.success !== false && (typeof payload.result === "string" || typeof payload.result === "number")) candidates.push(payload.result);
  if (payload && typeof payload === "object" && payload.success !== false && payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) candidates.push(payload.result[expectedField]);
  const ids = [...new Set(candidates.map((value) => String(value ?? "").trim()).filter((value) => /^[1-9]\d*$/.test(value)))];
  if (ids.length !== 1) throw new ProviderError("provider_create_id_invalid", { ambiguousWrite: true });
  return ids[0];
}

function providerRows(payload: any, singular: string, plural: string) {
  const candidates = [payload?.[plural], payload?.[singular], payload?.result?.[plural], payload?.result?.[singular], payload?.result];
  const looksLikeRow = (row: any) => row && typeof row === "object" && !Array.isArray(row)
    && ["customerID", "customerId", "appointmentID", "appointmentId", "typeID", "serviceTypeID", "serviceID", "id"].some((key) => row[key] !== undefined);
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((row) => row && typeof row === "object");
    if (looksLikeRow(candidate)) return [candidate];
    if (candidate && typeof candidate === "object") {
      const mapped = Object.values(candidate).filter(looksLikeRow);
      if (mapped.length) return mapped;
    }
  }
  if (Array.isArray(payload)) return payload.filter((row) => row && typeof row === "object");
  return [];
}

function providerReturnedIds(payload: any, pluralField: string) {
  const values = payload?.[pluralField] ?? payload?.result?.[pluralField];
  return asArray(values).map((value) => String(value || "").trim()).filter((value) => /^[1-9]\d*$/.test(value));
}

function normalizeStreet(value: unknown) {
  const substitutions: Record<string, string> = {
    st: "street", rd: "road", ave: "avenue", av: "avenue", blvd: "boulevard", dr: "drive",
    ln: "lane", ct: "court", cir: "circle", hwy: "highway", pkwy: "parkway", pl: "place", ter: "terrace",
    n: "north", s: "south", e: "east", w: "west", ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest"
  };
  return normalized(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => substitutions[part] || part)
    .join(" ");
}

function normalizeZip(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function normalizeUnit(value: unknown) {
  return normalized(value).replace(/^(unit|apt|apartment|suite|#)\s*/i, "").replace(/[^a-z0-9]/g, "");
}

function splitFieldRoutesAddressLine(value: unknown) {
  const line = String(value || "").trim();
  const match = line.match(/^(.*\S)\s+(?:#|apt(?:artment)?|unit|suite|ste)\s*([a-z0-9-]+)$/i);
  return match
    ? { street: match[1].trim(), unit: normalizeUnit(match[2]) }
    : { street: line, unit: "" };
}

function fieldRoutesAddressLine(address: any) {
  const street = String(address?.street_address || "").trim();
  const unit = normalizeUnit(address?.unit);
  return unit ? `${street} # ${unit.toUpperCase()}` : street;
}

function exactCustomerMatch(row: any, address: any) {
  const candidate = splitFieldRoutesAddressLine(row?.address || row?.streetAddress);
  const expected = splitFieldRoutesAddressLine(fieldRoutesAddressLine(address));
  const candidateUnit = normalizeUnit(row?.unit || row?.address2 || row?.unitNumber) || candidate.unit;
  const expectedUnit = normalizeUnit(address?.unit) || expected.unit;
  return normalizeStreet(candidate.street) === normalizeStreet(expected.street)
    && normalizeZip(row?.zip || row?.zipCode) === normalizeZip(address.zip)
    && candidateUnit === expectedUnit;
}

function customerIdFromRow(row: any) {
  const value = String(row?.customerID ?? row?.customerId ?? "").trim();
  return /^[1-9]\d*$/.test(value) ? value : null;
}

function appointmentIdFromRow(row: any) {
  const value = String(row?.appointmentID ?? row?.appointmentId ?? "").trim();
  return /^[1-9]\d*$/.test(value) ? value : null;
}

function appointmentHasMarker(row: any, marker: string) {
  if (String(row?.notes || row?.appointmentNotes || "").includes(marker)) return true;
  const dataLink = row?.dataLink;
  if (dataLink && typeof dataLink === "object" && String(dataLink.firstKnockEvent || "") === marker) return true;
  if (typeof dataLink === "string") {
    try {
      return String(JSON.parse(dataLink)?.firstKnockEvent || "") === marker;
    } catch {
      return false;
    }
  }
  return false;
}

function providerDateTime(value: Date) {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeContact(input: any, _fallbackName?: string | null) {
  const firstName = requiredString(input?.first_name ?? input?.firstName, "contact.first_name", 100);
  const lastName = requiredString(input?.last_name ?? input?.lastName, "contact.last_name", 100);
  const phoneInput = optionalString(input?.phone, "contact.phone", 40);
  const phoneDigits = phoneInput ? phoneInput.replace(/\D/g, "") : "";
  const phone = phoneDigits.length === 11 && phoneDigits.startsWith("1") ? phoneDigits.slice(1) : phoneDigits || null;
  const email = optionalString(input?.email, "contact.email", 254);
  if (!phone && !email) throw new HttpError(400, "contact_required", "A reviewed phone number or email address is required.");
  if (phone && !/^\d{10}$/.test(phone)) throw new HttpError(400, "invalid_request", "contact.phone must be a 10-digit US phone number.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_request", "contact.email is invalid.");
  return { first_name: firstName, last_name: lastName, phone, email: email ? email.toLowerCase() : null };
}

function normalizeAddress(input: any) {
  const streetAddress = requiredString(input?.street_address ?? input?.address, "address.street_address", 300);
  const city = requiredString(input?.city, "address.city", 100);
  const state = requiredString(input?.state, "address.state", 30).toUpperCase();
  const zip = requiredString(input?.zip ?? input?.zip_code, "address.zip", 20);
  if (!/^[A-Z]{2}$/.test(state)) throw new HttpError(400, "invalid_request", "address.state must be a two-letter code.");
  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new HttpError(400, "invalid_request", "address.zip must be a US ZIP code.");
  const unit = optionalString(input?.unit ?? input?.unit_label, "address.unit", 100);
  const lat = input?.lat === undefined || input?.lat === null ? null : Number(input.lat);
  const lng = input?.lng === undefined || input?.lng === null ? null : Number(input.lng);
  if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
    throw new HttpError(400, "invalid_request", "address coordinates are invalid.");
  }
  return { street_address: streetAddress, city, state, zip, unit, lat, lng };
}

function canonicalCanvasHouseIdentity(campaignId: string, zoneId: string, streetUnitId: string, address: any) {
  return [
    "canvas-house-v1",
    campaignId,
    zoneId,
    streetUnitId,
    normalizeStreet(address?.street_address),
    normalizeZip(address?.zip),
    normalizeUnit(address?.unit)
  ].join(":");
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

function canvasLifecycleSignaturePayload(session: any, repIds = canvasRepTeamMemberIds(session)) {
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
    rep_team_member_ids: [...new Set(asArray(repIds).map(String).filter(Boolean))].sort(),
    lifecycle_state: session?.lifecycle_state || null,
    lifecycle_evidence: session?.lifecycle_evidence || null,
    closed_at: session?.closed_at || null,
    closed_by_user_id: session?.closed_by_user_id || null,
    close_action: session?.close_action || null,
    close_idempotency_key: session?.close_idempotency_key || null,
    deployment_qa: session?.deployment_qa || null
  };
}

async function hmacHex(secret: string, payload: any) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(canonicalize(payload))));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canvasSigningSecret() {
  const secret = Deno.env.get("CANVAS_DEPLOYMENT_SIGNING_SECRET") || "";
  if (secret.length < 32) throw new HttpError(503, "canvas_signing_unavailable", "Canvas assignment verification is not configured.");
  return secret;
}

async function verifyActiveCanvasSession(session: any) {
  const secret = canvasSigningSecret();
  const evidence = session?.lifecycle_evidence || {};
  const qa = session?.deployment_qa || {};
  const exactActiveShape = session?.status === "deployed"
    && session?.lifecycle_state === "active"
    && evidence?.state === "active"
    && evidence?.transition === "deploy"
    && qa?.lifecycle_state === "active"
    && qa?.lifecycle_transition === "deploy"
    && Number(evidence?.schema_version) === 1
    && Number(evidence?.to_version) === Number(session?.version)
    && Number(evidence?.from_version) === Number(session?.version)
    && String(evidence?.transitioned_at || "") === String(session?.deployed_at || "")
    && String(evidence?.transitioned_by_user_id || "") === String(session?.deployed_by_user_id || "")
    && String(evidence?.idempotency_key || "") === String(session?.deployment_idempotency_key || "")
    && !session?.closed_at && !session?.closed_by_user_id && !session?.close_action;
  if (!exactActiveShape || !/^[a-f0-9]{64}$/.test(String(session?.plan_hash || "")) || !/^[a-f0-9]{64}$/.test(String(session?.deployment_signature || ""))) return false;
  if (await sha256(canvasStoredPlanForHash(session)) !== session.plan_hash) return false;
  return await hmacHex(secret, canvasLifecycleSignaturePayload(session)) === session.deployment_signature;
}

function campaignDecisionAnchorPayload(session: any) {
  return {
    purpose: "firstknock-canvas-decision-campaign-anchor-v1",
    manager_id: String(session?.manager_id || ""),
    campaign_id: String(session?.id || session?.campaign_id || ""),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: String(session?.plan_hash || "")
  };
}

function campaignDecisionStatePayload(state: any) {
  return {
    purpose: "firstknock-canvas-decision-campaign-state-v1",
    anchor_signature: String(state?.anchor_signature || ""),
    manager_id: String(state?.manager_id || ""),
    campaign_id: String(state?.campaign_id || ""),
    deployment_plan_version: Number(state?.deployment_plan_version),
    plan_hash: String(state?.plan_hash || ""),
    state: String(state?.state || ""),
    state_version: Number(state?.state_version),
    transition_action: String(state?.transition_action || ""),
    transition_idempotency_key: String(state?.transition_idempotency_key || ""),
    transition_started_at: String(state?.transition_started_at || ""),
    transition_completed_at: state?.transition_completed_at || null,
    superseded_by_campaign_id: state?.superseded_by_campaign_id || null
  };
}

function zoneDecisionAnchorPayload(session: any, zoneId: string) {
  return {
    purpose: "firstknock-canvas-decision-zone-anchor-v1",
    manager_id: String(session?.manager_id || ""),
    campaign_id: String(session?.id || session?.campaign_id || ""),
    zone_id: String(zoneId),
    deployment_plan_version: Number(session?.deployment_plan_version),
    plan_hash: String(session?.plan_hash || "")
  };
}

async function verifyCanvasDecisionGates(base44: any, session: any, zoneId: string) {
  const secret = canvasSigningSecret();
  const campaignRows = asArray(await base44.asServiceRole.entities.CanvasDecisionCampaignState.filter({
    manager_id: session.manager_id,
    campaign_id: session.id
  }, "-updated_date", 2)).filter((row) => String(row.manager_id || "") === String(session.manager_id) && String(row.campaign_id || "") === String(session.id));
  if (campaignRows.length !== 1) throw new HttpError(409, "canvas_decision_state_integrity_failed", "The Canvas campaign decision gate could not be verified.");
  const campaignState = campaignRows[0];
  const expectedCampaignAnchor = await hmacHex(secret, campaignDecisionAnchorPayload(session));
  const expectedStateSignature = await hmacHex(secret, campaignDecisionStatePayload(campaignState));
  if (String(campaignState.anchor_signature || "") !== expectedCampaignAnchor
    || String(campaignState.state_signature || "") !== expectedStateSignature
    || Number(campaignState.deployment_plan_version) !== Number(session.deployment_plan_version)
    || String(campaignState.plan_hash || "") !== String(session.plan_hash || "")) {
    throw new HttpError(409, "canvas_decision_state_integrity_failed", "The Canvas campaign decision gate failed integrity verification.");
  }
  if (campaignState.state === "superseded") throw new HttpError(409, "canvas_campaign_superseded", "This Canvas campaign was replaced. Refresh the assignment.");
  if (campaignState.state !== "active") throw new HttpError(409, "canvas_campaign_not_active", "This Canvas campaign is closing or closed.");

  const zoneRows = asArray(await base44.asServiceRole.entities.CanvasDecisionZoneState.filter({
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId
  }, "-updated_date", 2)).filter((row) => String(row.manager_id || "") === String(session.manager_id) && String(row.campaign_id || "") === String(session.id) && String(row.zone_id || "") === zoneId);
  const zoneState = zoneRows[0];
  if (zoneRows.length !== 1
    || String(zoneState?.anchor_signature || "") !== await hmacHex(secret, zoneDecisionAnchorPayload(session, zoneId))
    || Number(zoneState?.deployment_plan_version) !== Number(session.deployment_plan_version)
    || String(zoneState?.plan_hash || "") !== String(session.plan_hash || "")
    || !Number.isInteger(Number(zoneState?.lease_generation))
    || Number(zoneState?.lease_generation) < 0) {
    throw new HttpError(409, "canvas_zone_state_integrity_failed", "The assigned Canvas area gate failed integrity verification.");
  }
  const leaseFields = [zoneState.lease_token, zoneState.lease_actor_user_id, zoneState.lease_acquired_at, zoneState.lease_expires_at];
  const presentLeaseFields = leaseFields.filter((value) => value !== undefined && value !== null && value !== "").length;
  if (presentLeaseFields !== 0 && presentLeaseFields !== leaseFields.length) throw new HttpError(409, "canvas_zone_state_integrity_failed", "The assigned Canvas area lease is malformed.");
  if (presentLeaseFields && (!Number.isFinite(new Date(zoneState.lease_acquired_at).getTime()) || !Number.isFinite(new Date(zoneState.lease_expires_at).getTime()))) throw new HttpError(409, "canvas_zone_state_integrity_failed", "The assigned Canvas area lease is malformed.");
  return { campaignState, zoneState };
}

async function acquireCanvasZoneLease(base44: any, session: any, zoneId: string, actorUserId: string) {
  const { zoneState } = await verifyCanvasDecisionGates(base44, session, zoneId);
  const now = new Date();
  const leaseToken = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
  const expiresAt = new Date(now.getTime() + 30_000).toISOString();
  const generation = Number(zoneState.lease_generation || 0) + 1;
  const mutation = await base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany({
    id: zoneState.id,
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId,
    anchor_signature: zoneState.anchor_signature,
    lease_generation: Number(zoneState.lease_generation || 0),
    $or: [
      { lease_token: null },
      { lease_token: { $exists: false } },
      { lease_expires_at: { $lte: now.toISOString() } }
    ]
  }, { $set: {
    lease_token: leaseToken,
    lease_actor_user_id: actorUserId,
    lease_acquired_at: now.toISOString(),
    lease_expires_at: expiresAt,
    lease_generation: generation
  } });
  if (mutation?.success !== true || Number(mutation?.updated) !== 1 || mutation?.has_more === true) throw new HttpError(409, "canvas_zone_write_in_progress", "Another Canvas house update is finishing. Retry with the same idempotency key.");
  const locked = await base44.asServiceRole.entities.CanvasDecisionZoneState.get(zoneState.id).catch(() => null);
  if (!locked || locked.lease_token !== leaseToken || Number(locked.lease_generation) !== generation || locked.lease_expires_at !== expiresAt) throw new HttpError(503, "canvas_zone_lease_unverified", "Canvas could not verify the area write lease. Retry with the same idempotency key.");
  return { stateId: zoneState.id, token: leaseToken, generation };
}

async function releaseCanvasZoneLease(base44: any, session: any, zoneId: string, lease: any) {
  if (!lease) return;
  await base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany({
    id: lease.stateId,
    manager_id: session.manager_id,
    campaign_id: session.id,
    zone_id: zoneId,
    lease_token: lease.token,
    lease_generation: lease.generation
  }, { $unset: {
    lease_token: "",
    lease_actor_user_id: "",
    lease_acquired_at: "",
    lease_expires_at: ""
  } }).catch(() => null);
}

function canvasBindingMatches(session: any, teamMember: any, user: any) {
  const binding = asArray(session?.deployment_qa?.verified_team_member_bindings)
    .find((candidate) => String(candidate?.team_member_id || "") === String(teamMember?.id || ""));
  return binding
    && String(binding.user_id || "") === String(user.id || "")
    && normalized(binding.email) === normalized(user.email)
    && String(teamMember.user_id || "") === String(user.id || "");
}

function normalizePoint(value: any) {
  const lat = Number(value?.lat ?? value?.latitude ?? value?.[0]);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude ?? value?.[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new HttpError(400, "invalid_canvas_location", "A valid house latitude and longitude are required.");
  }
  return { lat, lng };
}

function distanceToSegmentMeters(point: any, start: any, end: any) {
  const latRadians = point.lat * Math.PI / 180;
  const toXY = (value: any) => ({
    x: (Number(value.lng) - point.lng) * Math.cos(latRadians) * 111_320,
    y: (Number(value.lat) - point.lat) * 110_540
  });
  const a = toXY(start);
  const b = toXY(end);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared)) : 0;
  return Math.sqrt((a.x + t * dx) ** 2 + (a.y + t * dy) ** 2);
}

function pointInPolygon(point: any, polygon: any[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (distanceToSegmentMeters(point, a, b) <= 1) return true;
    const intersects = a.lat > point.lat !== b.lat > point.lat
      && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat || Number.EPSILON) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

function resolveCanvasStreetOwnership(session: any, point: any, requestedZoneId: string) {
  if (!pointInPolygon(point, asArray(session.polygon))) throw new HttpError(422, "house_outside_campaign", "Choose a house inside the active Canvas campaign.");
  const unitToZone = new Map<string, string>();
  for (const zone of asArray(session.zones)) {
    for (const unitId of asArray(zone.work_unit_ids)) unitToZone.set(String(unitId), String(zone.zone_id));
  }
  const candidates = asArray(session.work_units).map((unit) => {
    const distances = asArray(unit?.segments).map((segment) => distanceToSegmentMeters(point, segment?.start, segment?.end)).filter(Number.isFinite);
    return {
      workUnitId: String(unit?.id || ""),
      zoneId: unitToZone.get(String(unit?.id || "")) || null,
      canvasRole: unit?.canvas_role || null,
      distanceMeters: distances.length ? Math.min(...distances) : Number.POSITIVE_INFINITY
    };
  }).filter((candidate) => candidate.workUnitId && candidate.zoneId
    && (session.territory_model !== "residential_street_territory_v2" || candidate.canvasRole === "knock")
    && Number.isFinite(candidate.distanceMeters))
    .sort((left, right) => left.distanceMeters - right.distanceMeters || left.workUnitId.localeCompare(right.workUnitId));
  const nearest = candidates[0];
  if (!nearest || nearest.distanceMeters > 150) throw new HttpError(422, "house_too_far_from_owned_street", "Choose a house within 150 meters of an eligible campaign street.");
  const competing = candidates.find((candidate) => candidate.workUnitId !== nearest.workUnitId && candidate.zoneId !== nearest.zoneId);
  if (competing && competing.distanceMeters <= 150) {
    const gap = competing.distanceMeters - nearest.distanceMeters;
    const ratio = nearest.distanceMeters <= 0.01 ? (competing.distanceMeters <= 0.01 ? 1 : Number.POSITIVE_INFINITY) : competing.distanceMeters / nearest.distanceMeters;
    if (gap <= 12 && ratio <= 1.5) throw new HttpError(409, "ambiguous_canvas_territory", "Move the house point closer to the assigned street before scheduling.");
  }
  if (nearest.zoneId !== requestedZoneId) throw new HttpError(403, "house_outside_assigned_zone", "This house belongs to a different Canvas area.");
  return nearest;
}

async function managerRecord(base44: any, actor: any, user: any) {
  if (actor.isManager) return user;
  const manager = await base44.asServiceRole.entities.User.get(actor.managerId).catch(() => null);
  if (!manager || String(manager.id || "") !== actor.managerId) throw new HttpError(409, "manager_account_unavailable", "The team manager account is unavailable.");
  return manager;
}

async function authorizePrecisionSource(base44: any, sql: any, user: any, actor: any, input: any) {
  const routeId = requiredString(input?.route_id, "source.route_id", 128);
  const addressHash = requiredString(input?.address_hash, "source.address_hash", 256);
  const route = await base44.asServiceRole.entities.SavedRoute.get(routeId).catch(() => null);
  const manager = await managerRecord(base44, actor, user);
  if (!route) throw new HttpError(404, "route_not_found", "The Precision route was not found.");
  const managerOwnsRoute = String(route.manager_id || "") === actor.managerId
    || (!route.manager_id && normalized(route.created_by) === normalized(manager.email));
  if (!managerOwnsRoute || (route.route_mode && route.route_mode !== "precision")) throw new HttpError(403, "route_not_authorized", "This Precision route is not available to this team.");
  if (!actor.isManager && ![String(actor.teamMember.id), String(user.id)].includes(String(route.assigned_to || ""))) {
    throw new HttpError(403, "route_not_assigned", "This Precision route is not assigned to the active rep account.");
  }

  const rows = await sql`
    SELECT p.address_hash, p.legacy_hash, p.full_address, p.house_number, p.street_name, p.city, p.state,
           p.zip_code, p.lat, p.lng, p.owner_full_name
      FROM properties p
      JOIN workspace_properties wp ON wp.property_id = p.id
     WHERE wp.user_email = ${String(manager.email || "").toLowerCase()}
       AND (p.address_hash = ${addressHash} OR p.legacy_hash = ${addressHash})
     LIMIT 2
  `;
  let property = rows.length === 1 ? rows[0] : null;
  if (!property && rows.length === 0) {
    const direct = [
      ...asArray(await base44.asServiceRole.entities.MasterProperty.filter({ address_hash: addressHash }, null, 10).catch(() => [])),
      ...asArray(await base44.asServiceRole.entities.MasterProperty.filter({ legacy_hash: addressHash }, null, 10).catch(() => []))
    ].filter((candidate) => normalized(candidate?.created_by) === normalized(manager.email));
    const unique = new Map(direct.map((candidate) => [String(candidate.id), candidate]));
    if (unique.size === 1) property = [...unique.values()][0];
    else if (unique.size > 1) throw new HttpError(409, "ambiguous_precision_property", "The route address could not be uniquely resolved in this workspace.");
  }
  if (!property) throw new HttpError(rows.length ? 409 : 404, rows.length ? "ambiguous_precision_property" : "precision_property_unavailable", "The route address could not be uniquely resolved in this workspace.");
  const routeHashes = new Set(asArray(route.property_hashes).map(String));
  if (![addressHash, String(property.address_hash || ""), String(property.legacy_hash || "")].some((candidate) => candidate && routeHashes.has(candidate))) {
    throw new HttpError(403, "property_not_on_route", "This address is not part of the assigned route.");
  }
  const streetAddress = String(property.full_address || property.address || `${property.house_number || ""} ${property.street_name || ""}`).split(",")[0].trim();
  const address = normalizeAddress({ street_address: streetAddress, city: property.city, state: property.state, zip: property.zip_code || property.zip, lat: property.lat, lng: property.lng });
  return {
    kind: "precision",
    sourceReference: `precision:${routeId}:${addressHash}`,
    routeId,
    campaignId: null,
    zoneId: null,
    pinId: null,
    address,
    fallbackName: property.owner_full_name || null,
    eventId: addressHash,
    businessIdentity: `precision:${routeId}:${String(property.address_hash || addressHash)}`
  };
}

async function authorizeCanvasSource(base44: any, user: any, actor: any, input: any, propertyInput: any) {
  const campaignId = requiredString(input?.campaign_id, "source.campaign_id", 128);
  const zoneId = requiredString(input?.zone_id, "source.zone_id", 128);
  const pinId = requiredString(input?.pin_id, "source.pin_id", 128);
  const session = await base44.asServiceRole.entities.CanvasSession.get(campaignId).catch(() => null);
  if (!session || String(session.manager_id || "") !== actor.managerId || !await verifyActiveCanvasSession(session)) {
    throw new HttpError(409, "canvas_campaign_untrusted", "The active Canvas campaign could not be verified.");
  }
  await verifyCanvasDecisionGates(base44, session, zoneId);
  const zones = asArray(session.zones);
  const zone = zones.find((candidate) => String(candidate?.zone_id || "") === zoneId);
  if (!zone) throw new HttpError(404, "canvas_zone_not_found", "The assigned Canvas area was not found.");
  if (!actor.isManager) {
    if (String(zone.assigned_team_member_id || "") !== String(actor.teamMember.id) || !canvasBindingMatches(session, actor.teamMember, user)) {
      throw new HttpError(403, "canvas_zone_not_assigned", "This Canvas area is not assigned to the active rep account.");
    }
  }
  let pin: any = null;
  const point = normalizePoint(input?.point || propertyInput);
  pin = await base44.asServiceRole.entities.CanvasHousePin.get(pinId).catch(() => null);
  if (!pin || String(pin.manager_id || "") !== actor.managerId || String(pin.campaign_id || "") !== campaignId || String(pin.zone_id || "") !== zoneId) {
    throw new HttpError(409, "canvas_pin_untrusted", "Save this Canvas house pin before scheduling a FieldRoutes inspection.");
  }
  if (["do_not_knock", "dnc"].includes(normalized(pin.latest_outcome || pin.outcome).replace(/[\s-]+/g, "_"))) {
    throw new HttpError(409, "canvas_pin_do_not_knock", "A do-not-knock Canvas house cannot be sent to FieldRoutes.");
  }
  if (session.evidence_id && String(pin.evidence_id || "") !== String(session.evidence_id || "")) throw new HttpError(409, "canvas_pin_evidence_mismatch", "The Canvas pin is from different campaign evidence.");
  if (String(pin.revision_id || "") !== String(session.revision_id || "")) throw new HttpError(409, "canvas_pin_revision_mismatch", "The Canvas pin is from a different reviewed revision.");
  const pinPoint = normalizePoint(pin);
  const pinGap = Math.hypot((pinPoint.lat - point.lat) * 110_540, (pinPoint.lng - point.lng) * Math.cos(point.lat * Math.PI / 180) * 111_320);
  if (pinGap > 12) throw new HttpError(409, "canvas_pin_location_mismatch", "The selected house point does not match the Canvas pin.");
  const ownership = resolveCanvasStreetOwnership(session, point, zoneId);
  if (pin?.street_unit_id && String(pin.street_unit_id) !== ownership.workUnitId) throw new HttpError(409, "canvas_pin_street_mismatch", "The Canvas pin no longer resolves to its verified street unit.");
  if (input?.street_unit_id && String(input.street_unit_id) !== ownership.workUnitId) throw new HttpError(409, "canvas_street_mismatch", "The requested Canvas street unit does not own this house point.");
  // The saved pin authorizes campaign/zone/evidence/location ownership only. Its
  // optional free-text label is not postal evidence; BatchData verifies the
  // rep-reviewed structured address and unit under the durable request lease.
  const address = normalizeAddress({ ...propertyInput, lat: point.lat, lng: point.lng });
  const sourceReference = `canvas:${campaignId}:${zoneId}:${point.lat.toFixed(6)}:${point.lng.toFixed(6)}`;
  return {
    kind: "canvas",
    sourceReference,
    routeId: null,
    campaignId,
    zoneId,
    pinId,
    address,
    fallbackName: null,
    eventId: sourceReference,
    streetUnitId: ownership.workUnitId,
    businessIdentity: canonicalCanvasHouseIdentity(campaignId, zoneId, ownership.workUnitId, address),
    canvasSession: session
  };
}

async function authorizeSource(base44: any, sql: any, user: any, actor: any, source: any, propertyInput: any) {
  const kind = normalized(source?.kind || source?.mode);
  const authorized = kind === "precision"
    ? await authorizePrecisionSource(base44, sql, user, actor, source)
    : kind === "canvas"
      ? await authorizeCanvasSource(base44, user, actor, source, propertyInput || source?.address)
      : null;
  if (!authorized) throw new HttpError(400, "invalid_source", "source.kind must be precision or canvas.");
  if (source?.source_key && String(source.source_key) !== authorized.sourceReference) throw new HttpError(409, "source_identity_mismatch", "The source identity does not match the server-authorized house.");
  return authorized;
}

function safeRateBudget(connection: any) {
  const usage = safeTokenUsage({ tokenUsage: connection?.last_token_usage }) || {};
  const readsToday = Number(usage.readsToday || 0);
  const writesToday = Number(usage.writesToday || 0);
  return {
    reads_today: readsToday,
    writes_today: writesToday,
    reads_last_minute: Number(usage.readsLastMinute || 0),
    writes_last_minute: Number(usage.writesLastMinute || 0),
    daily_write_limit: 3000,
    warning_threshold: 2500,
    remaining_writes: Math.max(0, 3000 - writesToday),
    over_warning_threshold: readsToday > 2500 || writesToday > 2500,
    observed_at: connection?.token_usage_observed_at || null
  };
}

function safeConnection(connection: any, includeRateBudget = false) {
  const modeCapabilities = fieldRoutesModes();
  if (!connection) return {
    enabled: true,
    ...modeCapabilities,
    configured: false,
    config_ready: false,
    connected: false,
    environment: null,
    subdomain: null,
    service_type_id: null,
    service_type_name: null,
    default_length: 60,
    office_id: null,
    source_id: null,
    connection_status: "not_configured",
    status: "not_configured",
    account_host: null,
    verified_at: null,
    ...(includeRateBudget ? { rate_budget: safeRateBudget(null) } : {})
  };
  return {
    enabled: true,
    ...modeCapabilities,
    configured: true,
    config_ready: Boolean(connection.connection_status === "connected" && connection.default_service_type_id && connection.credential_envelope && !connection.disabled_at && !connection.office_id),
    connected: connection.connection_status === "connected" && !connection.disabled_at && !connection.office_id,
    environment: connection.environment,
    subdomain: connection.subdomain || null,
    service_type_id: connection.default_service_type_id || null,
    service_type_name: connection.default_service_type_name || null,
    default_length: Number(connection.appointment_duration_minutes || 60),
    office_id: null,
    source_id: connection.source_id || null,
    connection_status: connection.connection_status,
    status: connection.connection_status,
    account_host: connection.environment === "legacy_staging" ? "stagingdemo.pestroutes.com" : (connection.subdomain ? `${connection.subdomain}.fieldroutes.com` : null),
    verified_at: connection.verified_at || null,
    updated_at: connection.updated_at || null,
    config_revision: Number(connection.config_revision || 1),
    ...(includeRateBudget ? { rate_budget: safeRateBudget(connection) } : {})
  };
}

function safeRequest(row: any) {
  const precisionParts = row.source_kind === "precision" ? String(row.source_reference || "").split(":") : [];
  return {
    request_id: String(row.id),
    source_kind: row.source_kind,
    source_reference: row.source_reference,
    source_key: row.source_reference,
    source_mode: row.source_kind,
    route_id: row.route_id || null,
    campaign_id: row.campaign_id || null,
    zone_id: row.zone_id || null,
    pin_id: row.pin_id || null,
    property_key: precisionParts.length >= 3 ? precisionParts.slice(2).join(":") : null,
    address_hash: precisionParts.length >= 3 ? precisionParts.slice(2).join(":") : null,
    state: row.state,
    checkpoint: row.checkpoint,
    customer_id: row.fieldroutes_customer_id || null,
    appointment_id: row.fieldroutes_appointment_id || null,
    appointment_marker: row.appointment_marker,
    used_existing_customer: row.used_existing_customer === null || row.used_existing_customer === undefined ? null : Boolean(row.used_existing_customer),
    attempt_count: Number(row.attempt_count || 0),
    next_retry_at: row.next_retry_at || null,
    error_code: row.last_error_code || null,
    token_usage: row.token_usage && typeof row.token_usage === "object" ? redactRecursive(row.token_usage) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null
  };
}

async function getConnection(sql: any, managerId: string) {
  const rows = await sql`SELECT * FROM fieldroutes_connections WHERE manager_id = ${managerId} LIMIT 1`;
  return rows[0] || null;
}

async function requireUsableConnection(sql: any, managerId: string) {
  const connection = await getConnection(sql, managerId);
  if (!connection || connection.connection_status === "disconnected" || connection.disabled_at) throw new HttpError(409, "fieldroutes_not_connected", "A manager must connect FieldRoutes before inspections can be scheduled.");
  if (connection.connection_status !== "connected") throw new HttpError(409, "fieldroutes_connection_unverified", "A manager must test the FieldRoutes connection before scheduling inspections.");
  if (connection.office_id) throw new HttpError(409, "fieldroutes_office_scope_required", "Reconnect with office-scoped FieldRoutes credentials. Phase 1 does not support saved office IDs or multi-office accounts.");
  if (!connection.default_service_type_id) throw new HttpError(409, "fieldroutes_service_type_required", "Choose the default inspection service type in FieldRoutes settings.");
  assertStoredProviderLocation(connection);
  return connection;
}

function providerErrorMessage(code: string) {
  const messages: Record<string, string> = {
    provider_authentication_failed: "FieldRoutes rejected the configured credentials.",
    provider_validation_failed: "FieldRoutes rejected the inspection data.",
    provider_request_rejected: "FieldRoutes rejected the request.",
    provider_rate_limited: "FieldRoutes rate-limited the request.",
    provider_timeout: "FieldRoutes did not confirm the request in time.",
    provider_network_error: "FieldRoutes could not be reached.",
    provider_server_error: "FieldRoutes did not confirm the request.",
    provider_invalid_json: "FieldRoutes returned an invalid response.",
    provider_create_id_invalid: "FieldRoutes did not return a usable record identifier.",
    provider_service_type_invalid: "The configured FieldRoutes service type is not an eligible initial service for this office.",
    provider_multi_office_not_supported: "Phase 1 requires FieldRoutes credentials scoped to exactly one office.",
    canvas_address_validation_unavailable: "The Canvas house address could not be verified yet. FirstKnock will retry safely.",
    canvas_address_validation_malformed: "BatchData returned an unusable address verification response. FirstKnock will retry safely.",
    retry_window_expired: "The automatic retry window expired. A manager retry opens a new 24-hour window."
  };
  return messages[code] || "The FieldRoutes operation could not be completed.";
}

async function persistConnectionTokenUsage(sql: any, managerId: string, tokenUsage: any) {
  const safe = safeTokenUsage({ tokenUsage });
  if (!safe) return;
  await sql`
    UPDATE fieldroutes_connections
       SET last_token_usage = ${JSON.stringify(safe)}::jsonb, token_usage_observed_at = NOW(), updated_at = NOW()
     WHERE manager_id = ${managerId}
  `;
}

async function providerCallLogged(sql: any, row: any, connection: any, credentials: any, operation: string, endpoint: string, params: Record<string, any>, write = false) {
  const attemptRows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE id = ${row.id} AND manager_id = ${row.manager_id}
     RETURNING attempt_count
  `;
  const attemptNumber = Number(attemptRows[0]?.attempt_count || Number(row.attempt_count || 0) + 1);
  const attemptId = crypto.randomUUID();
  try {
    const result = await providerCall(connection, credentials, endpoint, params, write);
    await sql`
      INSERT INTO fieldroutes_sync_attempts
        (id, manager_id, request_id, operation, attempt_number, outcome, provider_http_status, token_usage, response_metadata, started_at, finished_at)
      VALUES
        (${attemptId}, ${row.manager_id}, ${row.id}, ${operation}, ${attemptNumber}, 'success', 200, ${result.tokenUsage ? JSON.stringify(result.tokenUsage) : null}::jsonb,
         ${JSON.stringify({ endpoint, write })}::jsonb, NOW(), NOW())
    `;
    if (result.tokenUsage) await sql`UPDATE fieldroutes_inspection_requests SET token_usage = ${JSON.stringify(result.tokenUsage)}::jsonb WHERE id = ${row.id} AND manager_id = ${row.manager_id}`;
    await persistConnectionTokenUsage(sql, row.manager_id, result.tokenUsage);
    return result;
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError("provider_unknown_error");
    await sql`
      INSERT INTO fieldroutes_sync_attempts
        (id, manager_id, request_id, operation, attempt_number, outcome, provider_http_status, error_code, error_message, token_usage, response_metadata, started_at, finished_at)
      VALUES
        (${attemptId}, ${row.manager_id}, ${row.id}, ${operation}, ${attemptNumber}, 'error', ${providerError.httpStatus}, ${providerError.code},
         ${providerErrorMessage(providerError.code)}, ${providerError.tokenUsage ? JSON.stringify(providerError.tokenUsage) : null}::jsonb,
         ${JSON.stringify({ endpoint, write, ambiguous_write: providerError.ambiguousWrite })}::jsonb, NOW(), NOW())
    `;
    await persistConnectionTokenUsage(sql, row.manager_id, providerError.tokenUsage);
    throw providerError;
  }
}

async function searchExactCustomer(sql: any, row: any, connection: any, credentials: any, payload: any) {
  const byLink = await providerCallLogged(sql, row, connection, credentials, "customer_search_link", "customer/search", {
    customerLink: payload.customer_link,
    includeData: 1
  });
  const linkRows = providerRows(byLink.payload, "customer", "customers");
  const linkIdsWithoutData = providerReturnedIds(byLink.payload, "customerIDs");
  if (!linkRows.length && linkIdsWithoutData.length) throw new ReviewRequiredError("customer_match_missing_address_data");
  if (linkRows.length) {
    const exact = linkRows.filter((candidate) => exactCustomerMatch(candidate, payload.address) && customerIdFromRow(candidate));
    if (exact.length === 1 && linkRows.length === 1) return { customerId: customerIdFromRow(exact[0]), existing: true };
    throw new ReviewRequiredError(exact.length > 1 ? "ambiguous_customer_match" : "customer_link_address_conflict");
  }

  const byAddress = await providerCallLogged(sql, row, connection, credentials, "customer_search_address", "customer/search", {
    address: fieldRoutesAddressLine(payload.address),
    zip: payload.address.zip,
    includeData: 1
  });
  const addressRows = providerRows(byAddress.payload, "customer", "customers");
  const idsWithoutData = providerReturnedIds(byAddress.payload, "customerIDs");
  if (!addressRows.length && idsWithoutData.length) throw new ReviewRequiredError("customer_match_missing_address_data");
  const exact = addressRows.filter((candidate) => exactCustomerMatch(candidate, payload.address) && customerIdFromRow(candidate));
  if (exact.length > 1) throw new ReviewRequiredError("ambiguous_customer_match");
  if (exact.length === 1) return { customerId: customerIdFromRow(exact[0]), existing: true };
  return { customerId: null, existing: false };
}

async function createCustomer(sql: any, row: any, connection: any, credentials: any, payload: any) {
  const params: Record<string, any> = {
    fname: payload.contact.first_name,
    lname: payload.contact.last_name,
    address: fieldRoutesAddressLine(payload.address),
    city: payload.address.city,
    state: payload.address.state,
    zip: payload.address.zip,
    lat: payload.address.lat,
    lng: payload.address.lng,
    phone1: payload.contact.phone,
    email: payload.contact.email,
    notes: `Lead from FirstKnock. Rep: ${payload.actor.display_name}. Knock date: ${String(payload.created_at).slice(0, 10)}.`,
    customerLink: payload.customer_link,
    sourceID: payload.integration.source_id,
    status: 1,
    commercialAccount: 0,
    ...(Deno.env.get("FIELDROUTES_ENABLE_CUSTOMER_DATALINK") === "true" ? { dataLink: {
      firstKnockRequestId: row.id,
      firstKnockSource: payload.source.source_reference,
      firstKnockRepId: payload.actor.team_member_id || payload.actor.user_id,
      knockTimestamp: payload.created_at
    } } : {})
  };
  const result = await providerCallLogged(sql, row, connection, credentials, "customer_create", "customer/create", params, true);
  return parseCreatedId(result.payload, "customerID");
}

function normalizedHouseNumber(value: unknown) {
  return normalized(value).replace(/[^a-z0-9]/g, "");
}

function houseNumberFromStreet(value: unknown) {
  const match = String(value || "").trim().match(/^(\d+[a-z]?(?:[-/]\d+[a-z]?)?)/i);
  return match ? normalizedHouseNumber(match[1]) : "";
}

function canvasAddressVerificationInput(payload: any) {
  const address = payload?.address || {};
  if (address.lat === undefined || address.lat === null || address.lng === undefined || address.lng === null) {
    throw new ReviewRequiredError("canvas_address_validation_missing_coordinates");
  }
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new ReviewRequiredError("canvas_address_validation_missing_coordinates");
  return {
    provider: "batchdata",
    validator_version: CANVAS_ADDRESS_VALIDATOR_VERSION,
    street: normalizeStreet(address.street_address),
    city: normalized(address.city),
    state: String(address.state || "").trim().toUpperCase(),
    zip: normalizeZip(address.zip),
    unit: normalizeUnit(address.unit),
    lat: lat.toFixed(7),
    lng: lng.toFixed(7)
  };
}

async function canvasAddressVerificationInputHash(payload: any) {
  return await sha256(canvasAddressVerificationInput(payload));
}

function metersBetween(leftLat: number, leftLng: number, rightLat: number, rightLng: number) {
  const toRadians = (value: number) => value * Math.PI / 180;
  const latDistance = toRadians(rightLat - leftLat);
  const lngDistance = toRadians(rightLng - leftLng);
  const startLat = toRadians(leftLat);
  const endLat = toRadians(rightLat);
  const haversine = Math.sin(latDistance / 2) ** 2
    + Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDistance / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, haversine))));
}

function canvasVerificationDistanceOutcome(distanceMeters: number) {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return "location_mismatch";
  if (distanceMeters <= 30) return "pass";
  if (distanceMeters <= 75) return "location_uncertain";
  return "location_mismatch";
}

function throwBatchDataStatus(status: number) {
  if ([408, 425, 429].includes(status) || status >= 500) {
    throw new ProviderError("canvas_address_validation_unavailable", { httpStatus: status, retryable: true });
  }
  if ([401, 402, 403].includes(status)) throw new ReviewRequiredError("canvas_address_validation_configuration_error");
  throw new ReviewRequiredError("canvas_address_validation_rejected");
}

async function validateCanvasAddressWithBatchData(payload: any, expectedInputHash?: string) {
  const apiKey = String(Deno.env.get("BATCH_DATA_API_KEY") || "").trim();
  if (!apiKey) throw new ReviewRequiredError("canvas_address_validator_not_configured");
  const inputHash = expectedInputHash || await canvasAddressVerificationInputHash(payload);
  const requestedUnit = normalizeUnit(payload?.address?.unit);
  const requestStreet = `${String(payload.address.street_address).trim()}${requestedUnit ? ` # ${requestedUnit.toUpperCase()}` : ""}`;
  const requestId = inputHash;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await fetch("https://api.batchdata.com/api/v1/address/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}`, "accept": "application/json" },
      body: JSON.stringify({ requests: [{
        street: requestStreet,
        city: payload.address.city,
        state: payload.address.state,
        zip: payload.address.zip,
        requestId
      }] }),
      signal: controller.signal,
      redirect: "error"
    });
  } catch {
    throw new ProviderError("canvas_address_validation_unavailable", { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) {
    if (response.status >= 200 && response.status < 300) throw new ProviderError("canvas_address_validation_malformed", { httpStatus: response.status, retryable: true });
    throwBatchDataStatus(response.status);
  }
  let responsePayload: any;
  try {
    responsePayload = await response.json();
  } catch {
    throw new ProviderError("canvas_address_validation_malformed", { httpStatus: response.status, retryable: true });
  }
  const rawPayloadStatus = responsePayload?.status?.code;
  const payloadStatus = rawPayloadStatus === undefined || rawPayloadStatus === null || rawPayloadStatus === "" ? Number.NaN : Number(rawPayloadStatus);
  if (!Number.isFinite(payloadStatus)) throw new ProviderError("canvas_address_validation_malformed", { httpStatus: response.status, retryable: true });
  if (payloadStatus !== 200) {
    if (payloadStatus >= 200 && payloadStatus < 300) throw new ProviderError("canvas_address_validation_malformed", { httpStatus: response.status, retryable: true });
    throwBatchDataStatus(payloadStatus);
  }
  const addresses = responsePayload?.results?.addresses;
  if (!Array.isArray(addresses)) throw new ProviderError("canvas_address_validation_malformed", { httpStatus: response.status, retryable: true });
  if (addresses.length !== 1) throw new ReviewRequiredError(addresses.length ? "canvas_address_validation_ambiguous" : "canvas_address_validation_no_match");
  const verified = addresses[0];
  if (!verified || typeof verified !== "object" || Array.isArray(verified)) throw new ProviderError("canvas_address_validation_malformed", { httpStatus: response.status, retryable: true });
  const correlatedRequestId = verified.requestId ?? verified.request?.requestId;
  if (String(correlatedRequestId ?? "") !== requestId) throw new ReviewRequiredError("canvas_address_validation_correlation_mismatch");
  if (verified.error || verified.meta?.error !== false || verified.meta?.normalized !== true || verified.meta?.hashed !== true) {
    throw new ReviewRequiredError("canvas_address_validation_not_verified");
  }
  const providerHash = String(verified.hash || "").trim();
  if (!providerHash || providerHash.length > 512) throw new ReviewRequiredError("canvas_address_validation_not_verified");
  const dpvMatchCode = String(verified.dpvMatchCode || "").trim().toUpperCase();
  if (dpvMatchCode !== "Y") throw new ReviewRequiredError(dpvMatchCode === "D" ? "canvas_address_validation_secondary_missing" : "canvas_address_validation_not_deliverable");

  const providerStreet = String(verified.streetNoUnit || "").trim();
  const providerCity = String(verified.city || "").trim();
  const providerState = String(verified.state || "").trim().toUpperCase();
  const providerZip = normalizeZip(verified.zip);
  const requestedHouseNumber = houseNumberFromStreet(payload.address.street_address);
  const providerHouseNumber = normalizedHouseNumber(verified.houseNumber);
  if (!requestedHouseNumber || !providerHouseNumber || requestedHouseNumber !== providerHouseNumber
    || !providerStreet || normalizeStreet(providerStreet) !== normalizeStreet(payload.address.street_address)) {
    throw new ReviewRequiredError("canvas_address_validation_primary_mismatch");
  }
  if (providerState !== String(payload.address.state || "").trim().toUpperCase() || providerZip !== normalizeZip(payload.address.zip)) {
    throw new ReviewRequiredError("canvas_address_validation_region_mismatch");
  }
  if (!providerCity || providerCity.length > 100 || providerStreet.length > 300) throw new ReviewRequiredError("canvas_address_validation_not_verified");

  const providerUnitRaw = String(verified.unitNumber ?? "").trim();
  const providerUnit = normalizeUnit(providerUnitRaw);
  if (requestedUnit) {
    if (!providerUnit || providerUnit !== requestedUnit) throw new ReviewRequiredError("canvas_address_validation_unit_mismatch");
  } else if (providerUnit || String(verified.unitType || "").trim()) {
    throw new ReviewRequiredError("canvas_address_validation_unexpected_unit");
  }

  const lat = verified.latitude === undefined || verified.latitude === null || verified.latitude === "" ? Number.NaN : Number(verified.latitude);
  const lng = verified.longitude === undefined || verified.longitude === null || verified.longitude === "" ? Number.NaN : Number(verified.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new ReviewRequiredError("canvas_address_validation_missing_coordinates");
  const distanceMeters = metersBetween(Number(payload.address.lat), Number(payload.address.lng), lat, lng);
  const distanceOutcome = canvasVerificationDistanceOutcome(distanceMeters);
  if (distanceOutcome !== "pass") throw new ReviewRequiredError(`canvas_address_validation_${distanceOutcome}`);

  const canonicalAddress = {
    street_address: providerStreet,
    city: providerCity,
    state: providerState,
    zip: providerZip,
    unit: requestedUnit ? providerUnitRaw : null,
    lat,
    lng
  };
  return {
    address: canonicalAddress,
    receipt: {
      provider: "batchdata",
      validator_version: CANVAS_ADDRESS_VALIDATOR_VERSION,
      input_hash: inputHash,
      provider_address_hash: providerHash,
      canonical_address: canonicalAddress,
      dpv_match_code: dpvMatchCode,
      dpv_footnotes: String(verified.dpvFootnotes || "").slice(0, 128),
      verified_at: new Date().toISOString()
    }
  };
}

async function reusableCanvasAddressValidation(row: any, payload: any, inputHash: string) {
  if (!row.address_validation_envelope
    || row.address_validation_version !== CANVAS_ADDRESS_VALIDATOR_VERSION
    || row.address_validation_input_hash !== inputHash
    || !row.address_validation_receipt_hash) return null;
  let receipt: any;
  try {
    receipt = await decryptJson(row.address_validation_envelope, "address-validation", row.manager_id, row.id);
  } catch {
    return null;
  }
  if (!receipt || receipt.provider !== "batchdata"
    || receipt.validator_version !== CANVAS_ADDRESS_VALIDATOR_VERSION
    || receipt.input_hash !== inputHash
    || !receipt.provider_address_hash
    || receipt.dpv_match_code !== "Y"
    || await sha256(receipt) !== row.address_validation_receipt_hash) return null;
  let address: any;
  try {
    address = normalizeAddress(receipt.canonical_address);
  } catch {
    return null;
  }
  if (address.lat === null || address.lng === null) return null;
  if (normalizeUnit(address.unit) !== normalizeUnit(payload?.address?.unit)) return null;
  return { receipt, address };
}

async function verifiedCanvasPayloadForRequest(sql: any, row: any, payload: any) {
  const inputHash = await canvasAddressVerificationInputHash(payload);
  const reusable = await reusableCanvasAddressValidation(row, payload, inputHash);
  if (reusable) return { row, payload: { ...payload, address: reusable.address } };
  if (row.fieldroutes_customer_id) throw new ReviewRequiredError("canvas_address_validation_receipt_required");

  const sameAttemptScope = row.address_validation_version === CANVAS_ADDRESS_VALIDATOR_VERSION
    && row.address_validation_input_hash === inputHash;
  const priorAttempts = sameAttemptScope ? Number(row.address_validation_attempt_count || 0) : 0;
  if (priorAttempts >= MAX_CANVAS_ADDRESS_VALIDATION_ATTEMPTS) throw new ReviewRequiredError("canvas_address_validation_retry_exhausted");
  const attemptRows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET address_validation_attempt_count = ${priorAttempts + 1},
           address_validation_version = ${CANVAS_ADDRESS_VALIDATOR_VERSION},
           address_validation_input_hash = ${inputHash},
           address_validation_envelope = NULL,
           address_validation_receipt_hash = NULL,
           address_validated_at = NULL,
           checkpoint = 'address_validation_pending',
           updated_at = NOW()
     WHERE id = ${row.id} AND manager_id = ${row.manager_id}
       AND state = 'processing' AND lease_token = ${row.lease_token} AND lease_expires_at > NOW()
     RETURNING *
  `;
  if (!attemptRows[0]) throw new HttpError(409, "request_lease_lost", "The durable request lease changed during Canvas address verification.");
  row = attemptRows[0];

  let validation: any;
  try {
    validation = await validateCanvasAddressWithBatchData(payload, inputHash);
  } catch (error) {
    if (error instanceof ReviewRequiredError && CANVAS_ADDRESS_CONFIGURATION_ERRORS.has(error.code)) {
      await sql`
        UPDATE fieldroutes_inspection_requests
           SET address_validation_attempt_count = ${priorAttempts}, updated_at = NOW()
         WHERE id = ${row.id} AND manager_id = ${row.manager_id}
           AND state = 'processing' AND lease_token = ${row.lease_token}
      `;
    }
    if (error instanceof ProviderError && error.retryable && priorAttempts + 1 >= MAX_CANVAS_ADDRESS_VALIDATION_ATTEMPTS) {
      throw new ReviewRequiredError("canvas_address_validation_retry_exhausted");
    }
    throw error;
  }
  const receiptHash = await sha256(validation.receipt);
  const receiptEnvelope = await encryptJson(validation.receipt, "address-validation", row.manager_id, row.id);
  const persistedRows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET address_validation_envelope = ${JSON.stringify(receiptEnvelope)}::jsonb,
           address_validation_receipt_hash = ${receiptHash},
           address_validation_version = ${CANVAS_ADDRESS_VALIDATOR_VERSION},
           address_validation_input_hash = ${inputHash},
           address_validated_at = ${validation.receipt.verified_at},
           checkpoint = 'address_verified',
           updated_at = NOW()
     WHERE id = ${row.id} AND manager_id = ${row.manager_id}
       AND state = 'processing' AND lease_token = ${row.lease_token} AND lease_expires_at > NOW()
     RETURNING *
  `;
  if (!persistedRows[0]) throw new HttpError(409, "request_lease_lost", "The durable request lease changed before Canvas address verification was recorded.");
  return { row: persistedRows[0], payload: { ...payload, address: validation.address } };
}

async function searchAppointmentByMarker(sql: any, row: any, connection: any, credentials: any, customerId: string, payload: any) {
  const requestTime = new Date(row.created_at);
  const lowerBound = providerDateTime(new Date(requestTime.getTime() - 24 * 60 * 60 * 1000));
  const upperBound = providerDateTime(new Date(requestTime.getTime() + 24 * 60 * 60 * 1000));
  const result = await providerCallLogged(sql, row, connection, credentials, "appointment_reconcile", "appointment/search", {
    customerIDs: [customerId],
    serviceIDs: [payload.integration.service_type_id],
    dateAddedStart: lowerBound,
    dateAddedEnd: upperBound,
    status: [-2, -1, 0, 1, 2],
    includeData: 1
  });
  let candidateRows = providerRows(result.payload, "appointment", "appointments");
  const resultIds = [...new Set([
    ...providerReturnedIds(result.payload, "appointmentIDs"),
    ...candidateRows.map(appointmentIdFromRow).filter(Boolean)
  ])];
  if (resultIds.length > 5) throw new ReviewRequiredError("appointment_reconcile_too_broad");
  const rowsMissingNotes = candidateRows.filter((candidate) => !String(candidate?.notes || candidate?.appointmentNotes || "").trim());
  const idsNeedingGet = [...new Set([
    ...resultIds.filter((id) => !candidateRows.some((candidate) => appointmentIdFromRow(candidate) === id)),
    ...rowsMissingNotes.map(appointmentIdFromRow).filter(Boolean)
  ])];
  if (idsNeedingGet.length) {
    const detail = await providerCallLogged(sql, row, connection, credentials, "appointment_get", "appointment/get", { appointmentIDs: idsNeedingGet });
    const detailRows = providerRows(detail.payload, "appointment", "appointments");
    const detailById = new Map(detailRows.map((candidate) => [appointmentIdFromRow(candidate), candidate]).filter(([id]) => id));
    if (detailById.size !== idsNeedingGet.length || idsNeedingGet.some((id) => !detailById.has(id))) throw new ReviewRequiredError("appointment_detail_unavailable");
    const requested = new Set(idsNeedingGet);
    candidateRows = candidateRows.filter((candidate) => !requested.has(appointmentIdFromRow(candidate))).concat([...detailById.values()]);
  }
  const rows = candidateRows.filter((candidate) => appointmentHasMarker(candidate, row.appointment_marker));
  const valid = rows.filter((candidate) => {
    const id = appointmentIdFromRow(candidate);
    const status = Number(candidate?.status ?? 0);
    return id && VALID_APPOINTMENT_STATUSES.has(status);
  });
  if (valid.length > 1 || rows.length !== valid.length) throw new ReviewRequiredError("ambiguous_appointment_match");
  if (!valid.length) return null;
  return { appointmentId: appointmentIdFromRow(valid[0]), status: Number(valid[0]?.status ?? 0) };
}

function fieldRoutesAppointmentNotes(row: any, payload: any) {
  const audit = `Unassigned inspection lead from FirstKnock. ${row.appointment_marker}. Address: ${fieldRoutesAddressLine(payload.address)}, ${payload.address.city} ${payload.address.state} ${payload.address.zip}. Rep: ${payload.actor.display_name}.`;
  const officeNote = String(payload.note || "").replace(/\s+/g, " ").trim().slice(0, 1_000);
  return `${audit}${officeNote ? ` Office note: ${officeNote}` : ""}`.slice(0, 2_000);
}

async function createAppointment(sql: any, row: any, connection: any, credentials: any, payload: any, customerId: string) {
  const result = await providerCallLogged(sql, row, connection, credentials, "appointment_create", "appointment/create", {
    customerID: customerId,
    type: payload.integration.service_type_id,
    notes: fieldRoutesAppointmentNotes(row, payload),
    duration: payload.integration.appointment_duration_minutes
  }, true);
  return parseCreatedId(result.payload, "appointmentID");
}

function retryDelaySeconds(attemptCount: number, providerError?: ProviderError | null) {
  if (providerError?.retryAfterSeconds) return Math.max(60, Math.min(21_600, providerError.retryAfterSeconds));
  const delays = [30, 120, 600, 3600, 14_400];
  return delays[Math.min(delays.length - 1, Math.max(0, attemptCount - 1))];
}

async function releaseWithState(sql: any, row: any, state: string, checkpoint: string, options: any = {}) {
  const retrySeconds = options.retrySeconds || 0;
  const completed = state === "synced" || state === "review_required" || state === "failed";
  const rows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET state = ${state}, checkpoint = ${checkpoint},
           fieldroutes_customer_id = COALESCE(${options.customerId || null}, fieldroutes_customer_id),
           fieldroutes_appointment_id = COALESCE(${options.appointmentId || null}, fieldroutes_appointment_id),
           used_existing_customer = COALESCE(${options.usedExistingCustomer ?? null}, used_existing_customer),
           reconciliation_count = reconciliation_count + ${options.incrementReconciliation ? 1 : 0},
           next_retry_at = ${retrySeconds ? new Date(Date.now() + retrySeconds * 1000).toISOString() : new Date().toISOString()},
           last_http_status = ${options.httpStatus ?? null},
           last_error_code = ${options.errorCode || null},
           last_error_message = ${options.errorMessage || null},
           lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
           completed_at = ${completed ? new Date().toISOString() : null},
           updated_at = NOW()
     WHERE id = ${row.id} AND manager_id = ${row.manager_id} AND lease_token = ${row.lease_token}
     RETURNING *
  `;
  return rows[0] || null;
}

async function renewProcessingLease(sql: any, row: any) {
  const rows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET lease_expires_at = ${new Date(Date.now() + LEASE_MS).toISOString()}, updated_at = NOW()
     WHERE id = ${row.id} AND manager_id = ${row.manager_id}
       AND state = 'processing' AND lease_token = ${row.lease_token} AND lease_expires_at > NOW()
     RETURNING *
  `;
  if (!rows[0]) throw new HttpError(409, "request_lease_lost", "The durable request lease changed before the provider write. It will be reconciled safely.");
  return rows[0];
}

async function markConnectionError(sql: any, managerId: string, code: string) {
  if (code !== "provider_authentication_failed") return;
  await sql`
    UPDATE fieldroutes_connections
       SET connection_status = 'error', last_error_code = ${code}, last_error_at = NOW(), updated_at = NOW()
     WHERE manager_id = ${managerId}
  `;
}

async function processClaimedRequest(sql: any, claimed: any) {
  let row = claimed;
  try {
    const connection = await requireUsableConnection(sql, row.manager_id);
    const [credentials, decryptedPayload] = await Promise.all([
      decryptJson(connection.credential_envelope, "credentials", row.manager_id, row.manager_id),
      decryptJson(row.payload_envelope, "request", row.manager_id, row.id)
    ]);
    let payload = { ...decryptedPayload, integration: assertRequestIntegrationSnapshot(connection, decryptedPayload) };
    const retryDeadline = new Date(row.retry_deadline_at || new Date(new Date(row.created_at).getTime() + REQUEST_AGE_LIMIT_MS).toISOString()).getTime();
    if (!Number.isFinite(retryDeadline) || Date.now() > retryDeadline) return await releaseWithState(sql, row, "failed", row.checkpoint, { errorCode: "retry_window_expired", errorMessage: "The automatic retry window expired. A manager can explicitly retry to open a new 24-hour window." });
    if (payload?.source?.kind === "canvas") {
      const verified = await verifiedCanvasPayloadForRequest(sql, row, payload);
      row = verified.row;
      payload = verified.payload;
    }

    let customerId = row.fieldroutes_customer_id ? String(row.fieldroutes_customer_id) : null;
    let usedExistingCustomer = row.used_existing_customer;
    if (!customerId) {
      const match = await searchExactCustomer(sql, row, connection, credentials, payload);
      if (match.customerId) {
        customerId = String(match.customerId);
        usedExistingCustomer = true;
      } else if (row.checkpoint === "customer_create_ambiguous") {
        if (Number(row.reconciliation_count || 0) >= 5) return await releaseWithState(sql, row, "review_required", "customer_create_ambiguous", { errorCode: "customer_create_unconfirmed", errorMessage: "Customer creation could not be confirmed without risking a duplicate." });
        return await releaseWithState(sql, row, "customer_reconcile", "customer_create_ambiguous", { retrySeconds: retryDelaySeconds(Number(row.reconciliation_count || 0) + 1), incrementReconciliation: true, errorCode: "customer_create_unconfirmed", errorMessage: "Reconciling an unconfirmed customer write." });
      } else {
        row = await renewProcessingLease(sql, row);
        customerId = await createCustomer(sql, row, connection, credentials, payload);
        usedExistingCustomer = false;
      }
      const customerRows = await sql`
        UPDATE fieldroutes_inspection_requests
           SET fieldroutes_customer_id = ${customerId}, used_existing_customer = ${usedExistingCustomer},
               checkpoint = 'customer_resolved', updated_at = NOW()
         WHERE id = ${row.id} AND manager_id = ${row.manager_id} AND lease_token = ${row.lease_token}
         RETURNING *
      `;
      row = customerRows[0] || row;
    }

    const existingAppointment = await searchAppointmentByMarker(sql, row, connection, credentials, customerId, payload);
    if (existingAppointment) {
      return await releaseWithState(sql, row, "synced", "appointment_confirmed", { customerId, appointmentId: existingAppointment.appointmentId, usedExistingCustomer });
    }
    if (row.checkpoint === "appointment_create_ambiguous") {
      if (Number(row.reconciliation_count || 0) >= 5) return await releaseWithState(sql, row, "review_required", "appointment_create_ambiguous", { errorCode: "appointment_create_unconfirmed", errorMessage: "Appointment creation could not be confirmed without risking a duplicate." });
      return await releaseWithState(sql, row, "appointment_reconcile", "appointment_create_ambiguous", { customerId, retrySeconds: retryDelaySeconds(Number(row.reconciliation_count || 0) + 1), incrementReconciliation: true, errorCode: "appointment_create_unconfirmed", errorMessage: "Reconciling an unconfirmed appointment write." });
    }
    row = await renewProcessingLease(sql, row);
    const appointmentId = await createAppointment(sql, row, connection, credentials, payload, customerId);
    return await releaseWithState(sql, row, "synced", "appointment_confirmed", { customerId, appointmentId, usedExistingCustomer });
  } catch (error) {
    if (error instanceof ReviewRequiredError) {
      const isCanvasValidation = error.code.startsWith("canvas_address_validation") || error.code === "canvas_address_validator_not_configured";
      const isIntegrationConfiguration = error.code.startsWith("fieldroutes_request_configuration_");
      const checkpoint = CANVAS_ADDRESS_CONFIGURATION_ERRORS.has(error.code)
        ? "address_validation_configuration"
        : isCanvasValidation ? "address_validation_review"
          : isIntegrationConfiguration ? "integration_configuration_review" : row.checkpoint;
      const errorMessage = CANVAS_ADDRESS_CONFIGURATION_ERRORS.has(error.code)
        ? "Canvas address verification is not configured. Fix the BatchData integration, then retry this durable request."
        : error.code === "canvas_address_validation_retry_exhausted"
          ? "BatchData verification remained unavailable. A manager can retry this durable request after the provider recovers."
        : isCanvasValidation
          ? "The Canvas address could not be verified safely. Correct and save a new house pin before scheduling again."
          : isIntegrationConfiguration
            ? "FieldRoutes account or service settings changed after this request was saved. Schedule a new request under the current configuration."
          : "Manager review is required to avoid a duplicate FieldRoutes record.";
      return await releaseWithState(sql, row, "review_required", checkpoint, { errorCode: error.code, errorMessage });
    }
    if (error instanceof ProviderError) {
      await markConnectionError(sql, row.manager_id, error.code);
      const operation = row.checkpoint;
      if (error.ambiguousWrite) {
        const customerAmbiguous = !row.fieldroutes_customer_id;
        return await releaseWithState(sql, row, customerAmbiguous ? "customer_reconcile" : "appointment_reconcile", customerAmbiguous ? "customer_create_ambiguous" : "appointment_create_ambiguous", {
          retrySeconds: retryDelaySeconds(Number(row.attempt_count || 0) + 1, error),
          incrementReconciliation: true,
          httpStatus: error.httpStatus,
          errorCode: error.code,
          errorMessage: providerErrorMessage(error.code)
        });
      }
      if (error.retryable) {
        return await releaseWithState(sql, row, "retry_wait", operation, {
          retrySeconds: retryDelaySeconds(Number(row.attempt_count || 0) + 1, error),
          httpStatus: error.httpStatus,
          errorCode: error.code,
          errorMessage: providerErrorMessage(error.code)
        });
      }
      return await releaseWithState(sql, row, "failed", operation, { httpStatus: error.httpStatus, errorCode: error.code, errorMessage: providerErrorMessage(error.code) });
    }
    if (error instanceof HttpError) {
      return await releaseWithState(sql, row, "failed", row.checkpoint, { errorCode: error.code, errorMessage: error.message });
    }
    return await releaseWithState(sql, row, "retry_wait", row.checkpoint, { retrySeconds: 120, errorCode: "integration_processing_error", errorMessage: "The durable request will be retried." });
  }
}

async function claimAndProcess(sql: any, managerId: string, requestId: string) {
  const currentRows = await sql`
    SELECT * FROM fieldroutes_inspection_requests
     WHERE id = ${requestId} AND manager_id = ${managerId}
     LIMIT 1
  `;
  const current = currentRows[0];
  if (!current || TERMINAL_STATES.has(current.state) || !PROCESSABLE_STATES.has(current.state)) return current || null;
  const previousState = current.state;
  const leaseToken = crypto.randomUUID();
  const rows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET state = 'processing', lease_token = ${leaseToken}, lease_acquired_at = NOW(),
           lease_expires_at = ${new Date(Date.now() + LEASE_MS).toISOString()}, updated_at = NOW()
     WHERE id = ${requestId} AND manager_id = ${managerId}
       AND state = ${previousState}
       AND next_retry_at <= NOW()
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
     RETURNING *
  `;
  if (!rows[0]) return current;
  return await processClaimedRequest(sql, rows[0]);
}

function serviceTypesFromPayload(payload: any) {
  const rows = providerRows(payload, "serviceType", "serviceTypes");
  const result = rows.map((row) => {
    const id = String(row?.typeID ?? row?.serviceTypeID ?? row?.serviceID ?? row?.id ?? "").trim();
    const name = String(row?.name ?? row?.description ?? row?.serviceName ?? "").trim();
    if (!/^[1-9]\d*$/.test(id) || !name || name.length > 200) return null;
    const visible = ![0, "0", false, "false"].includes(row?.visible);
    const initial = [1, "1", true, "true"].includes(row?.initial);
    if (!visible || !initial) return null;
    const defaultLength = Number(row?.defaultLength);
    const officeId = String(row?.officeID ?? "").trim();
    return {
      id,
      type_id: id,
      name,
      description: name,
      visible: true,
      initial: true,
      default_length: Number.isInteger(defaultLength) && defaultLength > 0 ? defaultLength : null,
      office_id: /^[1-9]\d*$/.test(officeId) ? officeId : null
    };
  }).filter(Boolean);
  return [...new Map(result.map((item: any) => [item.id, item])).values()].sort((left: any, right: any) => left.name.localeCompare(right.name));
}

function validateConfiguredServiceType(connection: any, serviceTypes: any[]) {
  const officeIds = [...new Set(serviceTypes.map((serviceType) => serviceType.office_id).filter(Boolean).map(String))];
  if (officeIds.length > 1) throw new ProviderError("provider_multi_office_not_supported");
  if (!connection.default_service_type_id) return null;
  const selected = serviceTypes.find((serviceType) => String(serviceType.id) === String(connection.default_service_type_id));
  if (!selected || selected.visible !== true || selected.initial !== true) throw new ProviderError("provider_service_type_invalid");
  return selected;
}

async function readCredentials(connection: any) {
  return await decryptJson(connection.credential_envelope, "credentials", String(connection.manager_id), String(connection.manager_id));
}

async function saveConnectionAction(sql: any, actor: any, user: any, body: any) {
  requireManager(actor);
  const existing = await getConnection(sql, actor.managerId);
  const location = providerLocation(body);
  let authenticationKey = optionalString(body?.authentication_key ?? body?.api_key, "authentication_key", 1024);
  let authenticationToken = optionalString(body?.authentication_token ?? body?.auth_token, "authentication_token", 2048);
  if ((!authenticationKey || !authenticationToken) && existing && !existing.disabled_at && existing.connection_status !== "disconnected") {
    const prior = await readCredentials(existing);
    authenticationKey ||= String(prior.authenticationKey || "");
    authenticationToken ||= String(prior.authenticationToken || "");
  }
  if (!authenticationKey || !authenticationToken) throw new HttpError(400, "credentials_required", "Both FieldRoutes credential values are required.");
  const serviceTypeId = numericIdentifier(body?.service_type_id ?? body?.default_service_type_id, "service_type_id");
  const serviceTypeName = optionalString(body?.service_type_name ?? body?.default_service_type_name, "service_type_name", 200);
  if (body?.office_id !== undefined && body?.office_id !== null && String(body.office_id).trim() !== "") {
    throw new HttpError(409, "fieldroutes_office_scope_required", "Phase 1 requires office-scoped FieldRoutes credentials and does not accept an office ID.");
  }
  const sourceId = numericIdentifier(body?.source_id, "source_id");
  const duration = Number(body?.default_length ?? body?.appointment_duration_minutes ?? 60);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new HttpError(400, "invalid_request", "default_length must be between 5 and 480 minutes.");
  const envelope = await encryptJson({ authenticationKey, authenticationToken }, "credentials", actor.managerId, actor.managerId);
  const rows = await sql`
    INSERT INTO fieldroutes_connections
      (manager_id, environment, subdomain, base_url, credential_envelope, default_service_type_id,
       default_service_type_name, office_id, source_id, appointment_duration_minutes, connection_status,
       config_revision, disabled_at, last_error_code, last_error_at, created_by_user_id, updated_by_user_id, created_at, updated_at)
    VALUES
      (${actor.managerId}, ${location.environment}, ${location.subdomain}, ${location.baseUrl}, ${JSON.stringify(envelope)}::jsonb,
       ${serviceTypeId}, ${serviceTypeName}, NULL, ${sourceId}, ${duration}, 'unverified', 1, NULL, NULL, NULL,
       ${String(user.id)}, ${String(user.id)}, NOW(), NOW())
    ON CONFLICT (manager_id) DO UPDATE SET
       environment = EXCLUDED.environment,
       subdomain = EXCLUDED.subdomain,
       base_url = EXCLUDED.base_url,
       credential_envelope = EXCLUDED.credential_envelope,
       default_service_type_id = EXCLUDED.default_service_type_id,
       default_service_type_name = EXCLUDED.default_service_type_name,
       office_id = EXCLUDED.office_id,
       source_id = EXCLUDED.source_id,
       appointment_duration_minutes = EXCLUDED.appointment_duration_minutes,
       connection_status = 'unverified',
       config_revision = fieldroutes_connections.config_revision + 1,
       disabled_at = NULL,
       last_error_code = NULL,
       last_error_at = NULL,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = NOW()
    RETURNING *
  `;
  const capability = safeConnection(rows[0], true);
  return json({ saved: true, ...capability, capability });
}

async function testConnectionAction(sql: any, actor: any) {
  requireManager(actor);
  const connection = await getConnection(sql, actor.managerId);
  if (!connection || connection.disabled_at) throw new HttpError(409, "fieldroutes_not_configured", "Save FieldRoutes settings first.");
  if (connection.office_id) throw new HttpError(409, "fieldroutes_office_scope_required", "Reconnect with office-scoped FieldRoutes credentials. Phase 1 does not support saved office IDs or multi-office accounts.");
  try {
    const result = await providerCall(connection, await readCredentials(connection), "serviceType/search", { includeData: 1 }, false);
    const serviceTypes = serviceTypesFromPayload(result.payload);
    validateConfiguredServiceType(connection, serviceTypes);
    const rows = await sql`
      UPDATE fieldroutes_connections
         SET connection_status = 'connected', verified_at = NOW(), last_error_code = NULL,
             last_error_at = NULL, updated_at = NOW()
       WHERE manager_id = ${actor.managerId}
       RETURNING *
    `;
    await persistConnectionTokenUsage(sql, actor.managerId, result.tokenUsage);
    const capability = safeConnection(await getConnection(sql, actor.managerId), true);
    return json({ connected: true, ...capability, capability, service_types: serviceTypes, token_usage: result.tokenUsage });
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : new ProviderError("provider_unknown_error");
    await persistConnectionTokenUsage(sql, actor.managerId, providerError.tokenUsage);
    await sql`
      UPDATE fieldroutes_connections
         SET connection_status = 'error', last_error_code = ${providerError.code}, last_error_at = NOW(), updated_at = NOW()
       WHERE manager_id = ${actor.managerId}
    `;
    throw new HttpError(422, providerError.code, providerErrorMessage(providerError.code));
  }
}

async function listServiceTypesAction(sql: any, actor: any) {
  requireManager(actor);
  const connection = await getConnection(sql, actor.managerId);
  if (!connection || connection.disabled_at) throw new HttpError(409, "fieldroutes_not_configured", "Save FieldRoutes settings first.");
  if (connection.office_id) throw new HttpError(409, "fieldroutes_office_scope_required", "Reconnect with office-scoped FieldRoutes credentials. Phase 1 does not support saved office IDs or multi-office accounts.");
  try {
    const result = await providerCall(connection, await readCredentials(connection), "serviceType/search", { includeData: 1 }, false);
    const serviceTypes = serviceTypesFromPayload(result.payload);
    validateConfiguredServiceType({ ...connection, default_service_type_id: null }, serviceTypes);
    await persistConnectionTokenUsage(sql, actor.managerId, result.tokenUsage);
    return json({ service_types: serviceTypes, token_usage: result.tokenUsage, rate_budget: safeRateBudget(await getConnection(sql, actor.managerId)) });
  } catch (error) {
    if (error instanceof ProviderError) await persistConnectionTokenUsage(sql, actor.managerId, error.tokenUsage);
    throw error;
  }
}

async function disconnectAction(sql: any, actor: any, user: any) {
  requireManager(actor);
  const rows = await sql`
    UPDATE fieldroutes_connections
       SET connection_status = 'disconnected', disabled_at = NOW(), credential_envelope = NULL,
           verified_at = NULL, last_error_code = NULL, last_error_at = NULL,
           worker_lease_token = NULL, worker_lease_acquired_at = NULL, worker_lease_expires_at = NULL, worker_next_claim_at = NULL,
           updated_by_user_id = ${String(user.id)}, updated_at = NOW()
     WHERE manager_id = ${actor.managerId}
     RETURNING *
  `;
  const capability = safeConnection(rows[0] || null, true);
  return json({ disconnected: true, ...capability, capability });
}

function retryAllowed(row: any) {
  if (["retry_wait", "customer_reconcile", "appointment_reconcile"].includes(row.state)) return true;
  if (row.state === "failed") return true;
  if (row.state === "review_required" && ["customer_create_ambiguous", "appointment_create_ambiguous"].includes(row.checkpoint)) return true;
  if (row.state === "review_required" && CANVAS_ADDRESS_CONFIGURATION_ERRORS.has(row.last_error_code)) return true;
  if (row.state === "review_required" && row.last_error_code === "canvas_address_validation_retry_exhausted") return true;
  return false;
}

function displayError(row: any) {
  if (!row.last_error_code) return null;
  if (CANVAS_ADDRESS_CONFIGURATION_ERRORS.has(row.last_error_code)) return "BatchData address verification needs configuration. Fix the integration secret or billing, then retry.";
  if (row.last_error_code === "canvas_address_validation_retry_exhausted") return "BatchData verification remained unavailable. Retry this durable request after the provider recovers.";
  if (String(row.last_error_code).startsWith("canvas_address_validation")) return "This Canvas address was not safe to send. Correct and save a new house pin, then schedule a new request.";
  if (String(row.last_error_code).startsWith("fieldroutes_request_configuration_")) return "FieldRoutes settings changed after this request was saved. Schedule a new request under the current account and service.";
  if (/ambiguous|conflict|unconfirmed|missing_address/.test(row.last_error_code)) return "Review this request before retrying to avoid a duplicate FieldRoutes record.";
  return providerErrorMessage(row.last_error_code);
}

async function listActivityAction(sql: any, actor: any, body: any) {
  requireManager(actor);
  const limit = Math.max(1, Math.min(100, Number(body?.limit || 10)));
  const rows = await sql`
    SELECT * FROM fieldroutes_inspection_requests
     WHERE manager_id = ${actor.managerId}
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  const items = [];
  for (const row of rows) {
    let addressSafeLabel = row.source_kind === "canvas" ? "Canvas house" : "Precision address";
    try {
      const payload = await decryptJson(row.payload_envelope, "request", row.manager_id, row.id);
      addressSafeLabel = [payload?.address?.street_address, payload?.address?.city].filter(Boolean).join(", ") || addressSafeLabel;
    } catch {
      // Activity remains usable if a single historical envelope cannot be opened.
    }
    items.push({
      ...safeRequest(row),
      source_mode: row.source_kind,
      address_safe_label: addressSafeLabel,
      display_error: displayError(row),
      error_label: displayError(row),
      retry_allowed: retryAllowed(row)
    });
  }
  return json({ items });
}

async function retryRequestAction(sql: any, actor: any, body: any) {
  requireManager(actor);
  const requestId = requiredString(body?.request_id, "request_id", 128);
  const currentRows = await sql`SELECT * FROM fieldroutes_inspection_requests WHERE id = ${requestId} AND manager_id = ${actor.managerId} LIMIT 1`;
  const current = currentRows[0];
  if (!current) throw new HttpError(404, "request_not_found", "The FieldRoutes request was not found.");
  if (!retryAllowed(current)) throw new HttpError(409, "retry_not_allowed", "This FieldRoutes request cannot be retried.");
  const nextState = current.checkpoint === "customer_create_ambiguous" ? "customer_reconcile"
    : current.checkpoint === "appointment_create_ambiguous" ? "appointment_reconcile" : "queued";
  const resetAddressValidationAttempts = current.last_error_code === "canvas_address_validation_retry_exhausted";
  const rows = await sql`
    UPDATE fieldroutes_inspection_requests
       SET state = ${nextState}, next_retry_at = NOW(), completed_at = NULL,
           retry_deadline_at = ${new Date(Date.now() + REQUEST_AGE_LIMIT_MS).toISOString()},
           lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL,
           address_validation_attempt_count = ${resetAddressValidationAttempts ? 0 : Number(current.address_validation_attempt_count || 0)},
           last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
     WHERE id = ${requestId} AND manager_id = ${actor.managerId}
     RETURNING *
  `;
  return json({ retried: true, accepted: true, request_id: requestId, request: safeRequest(rows[0]) }, 202);
}

function scheduleResponse(row: any, idempotent = false) {
  const request = safeRequest(row);
  if (row.state === "synced") return json({ accepted: true, idempotent, request_id: row.id, request }, 200);
  if (PROCESSABLE_STATES.has(row.state) || row.state === "processing") return json({ accepted: true, idempotent, request_id: row.id, request }, 202);
  return json({
    accepted: true,
    durable: true,
    needs_attention: true,
    idempotent,
    request_id: row.id,
    request,
    safe_message: displayError(row) || "The durable request requires manager attention."
  }, 202);
}

function canSupersedeCanvasAddressReview(row: any, nextRequestHash: string) {
  const errorCode = String(row?.last_error_code || "");
  return row?.source_kind === "canvas"
    && row?.state === "review_required"
    && row?.checkpoint === "address_validation_review"
    && errorCode.startsWith("canvas_address_validation_")
    && errorCode !== "canvas_address_validation_retry_exhausted"
    && row?.request_hash !== nextRequestHash
    && Number(row?.attempt_count || 0) === 0
    && !row?.fieldroutes_customer_id
    && !row?.fieldroutes_appointment_id
    && (row?.used_existing_customer === null || row?.used_existing_customer === undefined);
}

async function scheduleInspectionAction(base44: any, sql: any, user: any, actor: any, body: any, req: Request) {
  assertFieldRoutesScheduleSourceEnabled(body);
  const connection = await requireUsableConnection(sql, actor.managerId);
  const idempotencyKey = String(req.headers.get("idempotency-key") || body?.idempotency_key || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new HttpError(400, "idempotency_key_required", "Provide an 8-128 character idempotency key.");
  const sourceInput = body?.source || {};
  const source = await authorizeSource(base44, sql, user, actor, sourceInput, body?.property || sourceInput?.address);
  const contact = normalizeContact(body?.contact, source.fallbackName);
  const note = optionalString(body?.notes, "notes", 1000);
  const manager = await managerRecord(base44, actor, user);
  const now = new Date().toISOString();
  const retryDeadline = new Date(new Date(now).getTime() + REQUEST_AGE_LIMIT_MS).toISOString();
  const integrationSnapshot = requestIntegrationSnapshot(connection);
  const customerLinkHash = await sha256({ manager_id: actor.managerId, house: source.businessIdentity });
  const businessKey = await sha256({
    manager_id: actor.managerId,
    house: source.businessIdentity,
    account_host: integrationSnapshot.account_host,
    service_type_id: integrationSnapshot.service_type_id
  });
  const appointmentMarker = `FK:${businessKey.slice(0, 48)}`;
  const canonicalPayload = {
    source: {
      kind: source.kind,
      source_reference: source.sourceReference,
      route_id: source.routeId,
      campaign_id: source.campaignId,
      zone_id: source.zoneId,
      pin_id: source.pinId,
      street_unit_id: source.streetUnitId || null
    },
    address: source.address,
    contact,
    note,
    integration: integrationSnapshot,
    actor: {
      user_id: String(user.id),
      team_member_id: actor.teamMember ? String(actor.teamMember.id) : null,
      display_name: String(user.full_name || user.name || user.email || "FirstKnock rep").slice(0, 200)
    },
    manager: { id: actor.managerId, display_name: String(manager.full_name || manager.name || manager.email || "Manager").slice(0, 200) },
    service_type_id: String(connection.default_service_type_id),
    customer_link: `FKC:${customerLinkHash.slice(0, 48)}`,
    appointment_marker: appointmentMarker,
    created_at: now
  };
  const requestHash = await sha256({
    source: canonicalPayload.source,
    address: canonicalPayload.address,
    contact: canonicalPayload.contact,
    note: canonicalPayload.note,
    actor_user_id: canonicalPayload.actor.user_id,
    actor_team_member_id: canonicalPayload.actor.team_member_id,
    integration: canonicalPayload.integration
  });
  const existingRows = await sql`
    SELECT * FROM fieldroutes_inspection_requests
     WHERE manager_id = ${actor.managerId} AND idempotency_key = ${idempotencyKey}
     LIMIT 1
  `;
  if (existingRows[0]) {
    if (existingRows[0].request_hash !== requestHash) throw new HttpError(409, "idempotency_conflict", "This idempotency key was already used with different inspection data.");
    return scheduleResponse(existingRows[0], true);
  }
  const duplicateRows = await sql`
    SELECT * FROM fieldroutes_inspection_requests
     WHERE manager_id = ${actor.managerId} AND business_key = ${businessKey} AND state <> 'superseded'
     LIMIT 1
  `;
  if (duplicateRows[0] && !canSupersedeCanvasAddressReview(duplicateRows[0], requestHash)) return scheduleResponse(duplicateRows[0], true);

  const requestId = crypto.randomUUID();
  const envelope = await encryptJson(canonicalPayload, "request", actor.managerId, requestId);
  let inserted: any;
  let canvasLease: any = null;
  try {
    if (source.kind === "canvas") canvasLease = await acquireCanvasZoneLease(base44, source.canvasSession, source.zoneId, String(user.id));
    const activeRows = await sql`
      SELECT * FROM fieldroutes_inspection_requests
       WHERE manager_id = ${actor.managerId} AND business_key = ${businessKey} AND state <> 'superseded'
       LIMIT 1
    `;
    try {
      if (activeRows[0]) {
        if (!canSupersedeCanvasAddressReview(activeRows[0], requestHash)) return scheduleResponse(activeRows[0], true);
        const rows = await sql`
          WITH superseded AS (
            UPDATE fieldroutes_inspection_requests AS request_row
               SET state = 'superseded', checkpoint = 'superseded_before_provider',
                   superseded_by_request_id = ${requestId}, superseded_at = NOW(), completed_at = COALESCE(completed_at, NOW()),
                   lease_token = NULL, lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = NOW()
             WHERE request_row.id = ${activeRows[0].id} AND request_row.manager_id = ${actor.managerId}
               AND request_row.state = 'review_required' AND request_row.checkpoint = 'address_validation_review'
               AND request_row.request_hash <> ${requestHash} AND request_row.attempt_count = 0
               AND request_row.fieldroutes_customer_id IS NULL AND request_row.fieldroutes_appointment_id IS NULL
               AND request_row.used_existing_customer IS NULL
               AND request_row.last_error_code LIKE 'canvas_address_validation_%'
               AND request_row.last_error_code <> 'canvas_address_validation_retry_exhausted'
               AND NOT EXISTS (
                 SELECT 1 FROM fieldroutes_sync_attempts attempt_row
                  WHERE attempt_row.manager_id = request_row.manager_id AND attempt_row.request_id = request_row.id
               )
             RETURNING request_row.id
          )
          INSERT INTO fieldroutes_inspection_requests
            (id, manager_id, actor_user_id, actor_team_member_id, source_kind, source_reference,
             route_id, campaign_id, zone_id, pin_id, idempotency_key, request_hash, business_key,
             payload_envelope, supersedes_request_id, state, checkpoint, appointment_marker, next_retry_at, retry_deadline_at, created_at, updated_at)
          SELECT
            ${requestId}, ${actor.managerId}, ${String(user.id)}, ${actor.teamMember ? String(actor.teamMember.id) : null},
            ${source.kind}, ${source.sourceReference}, ${source.routeId}, ${source.campaignId}, ${source.zoneId}, ${source.pinId},
            ${idempotencyKey}, ${requestHash}, ${businessKey}, ${JSON.stringify(envelope)}::jsonb,
            superseded.id, 'queued', 'outbox_persisted', ${appointmentMarker}, NOW(), ${retryDeadline}, NOW(), NOW()
            FROM superseded
          RETURNING *
        `;
        inserted = rows[0];
      } else {
        const rows = await sql`
          INSERT INTO fieldroutes_inspection_requests
            (id, manager_id, actor_user_id, actor_team_member_id, source_kind, source_reference,
             route_id, campaign_id, zone_id, pin_id, idempotency_key, request_hash, business_key,
             payload_envelope, supersedes_request_id, state, checkpoint, appointment_marker, next_retry_at, retry_deadline_at, created_at, updated_at)
          VALUES
            (${requestId}, ${actor.managerId}, ${String(user.id)}, ${actor.teamMember ? String(actor.teamMember.id) : null},
             ${source.kind}, ${source.sourceReference}, ${source.routeId}, ${source.campaignId}, ${source.zoneId}, ${source.pinId},
             ${idempotencyKey}, ${requestHash}, ${businessKey}, ${JSON.stringify(envelope)}::jsonb,
             NULL, 'queued', 'outbox_persisted', ${appointmentMarker}, NOW(), ${retryDeadline}, NOW(), NOW())
          RETURNING *
        `;
        inserted = rows[0];
      }
    } catch {
      const races = await sql`
        SELECT * FROM fieldroutes_inspection_requests
         WHERE manager_id = ${actor.managerId}
           AND (idempotency_key = ${idempotencyKey} OR (business_key = ${businessKey} AND state <> 'superseded'))
         ORDER BY created_at ASC LIMIT 2
      `;
      const exact = races.find((row) => row.idempotency_key === idempotencyKey);
      if (exact && exact.request_hash === requestHash) return scheduleResponse(exact, true);
      if (exact) throw new HttpError(409, "idempotency_conflict", "This idempotency key was already used with different inspection data.");
      if (races[0]) return scheduleResponse(races[0], true);
      throw new HttpError(503, "outbox_unavailable", "The inspection request could not be saved safely. Retry with the same idempotency key.");
    }
    if (!inserted) {
      const currentRows = await sql`
        SELECT * FROM fieldroutes_inspection_requests
         WHERE manager_id = ${actor.managerId} AND business_key = ${businessKey} AND state <> 'superseded'
         LIMIT 1
      `;
      if (currentRows[0]) return scheduleResponse(currentRows[0], true);
      throw new HttpError(409, "supersession_conflict", "The prior Canvas request changed while the corrected request was being saved. Retry with the same idempotency key.");
    }
  } finally {
    if (canvasLease) await releaseCanvasZoneLease(base44, source.canvasSession, source.zoneId, canvasLease);
  }
  return scheduleResponse(inserted, false);
}

function sourceReferencesFromBody(body: any) {
  const references = asArray(body?.source_references).map(String).filter((value) => value.length <= 500);
  for (const source of asArray(body?.sources)) {
    if (source?.source_reference || source?.source_key) references.push(String(source.source_reference || source.source_key));
    else if (normalized(source?.kind || source?.mode) === "precision" && source.route_id && source.address_hash) references.push(`precision:${source.route_id}:${source.address_hash}`);
    else if (normalized(source?.kind || source?.mode) === "canvas" && source.campaign_id && source.zone_id && source.point) {
      const point = normalizePoint(source.point);
      references.push(`canvas:${source.campaign_id}:${source.zone_id}:${point.lat.toFixed(6)}:${point.lng.toFixed(6)}`);
    }
  }
  return [...new Set(references)].slice(0, 100);
}

async function authorizePrecisionStatusScope(base44: any, actor: any, user: any, body: any) {
  const routeId = requiredString(body?.route_id, "route_id", 128);
  const route = await base44.asServiceRole.entities.SavedRoute.get(routeId).catch(() => null);
  const manager = await managerRecord(base44, actor, user);
  if (!route) throw new HttpError(404, "route_not_found", "The Precision route was not found.");
  const managerOwnsRoute = String(route.manager_id || "") === actor.managerId
    || (!route.manager_id && normalized(route.created_by) === normalized(manager.email));
  if (!managerOwnsRoute || (route.route_mode && route.route_mode !== "precision")) throw new HttpError(403, "route_not_authorized", "This Precision route is not available to this team.");
  if (!actor.isManager && ![String(actor.teamMember.id), String(user.id)].includes(String(route.assigned_to || ""))) throw new HttpError(403, "route_not_assigned", "This Precision route is not assigned to the active rep account.");
  const propertyKeys = asArray(body?.property_keys);
  if (propertyKeys.length > 1_000 || propertyKeys.some((value) => !String(value || "").trim() || String(value).length > 256)) throw new HttpError(400, "invalid_request", "property_keys is invalid.");
  return routeId;
}

async function authorizeCanvasStatusScope(base44: any, actor: any, user: any, body: any) {
  const campaignId = requiredString(body?.campaign_id, "campaign_id", 128);
  const zoneId = requiredString(body?.zone_id, "zone_id", 128);
  const session = await base44.asServiceRole.entities.CanvasSession.get(campaignId).catch(() => null);
  if (!session || String(session.manager_id || "") !== actor.managerId || !await verifyActiveCanvasSession(session)) throw new HttpError(409, "canvas_campaign_untrusted", "The active Canvas campaign could not be verified.");
  await verifyCanvasDecisionGates(base44, session, zoneId);
  const zone = asArray(session.zones).find((candidate) => String(candidate?.zone_id || "") === zoneId);
  if (!zone) throw new HttpError(404, "canvas_zone_not_found", "The assigned Canvas area was not found.");
  if (!actor.isManager && (String(zone.assigned_team_member_id || "") !== String(actor.teamMember.id) || !canvasBindingMatches(session, actor.teamMember, user))) throw new HttpError(403, "canvas_zone_not_assigned", "This Canvas area is not assigned to the active rep account.");
  return { campaignId, zoneId };
}

async function getStatusesAction(base44: any, sql: any, actor: any, user: any, body: any) {
  const requestIds = [...new Set(asArray(body?.request_ids).map(String).filter((value) => value && value.length <= 128))].slice(0, 100);
  const sourceReferences = sourceReferencesFromBody(body);
  const params: any[] = [actor.managerId];
  let actorFilter = "";
  if (!actor.isManager) {
    params.push(String(user.id));
    actorFilter = ` AND actor_user_id = $${params.length}`;
  }
  const selectors: string[] = [];
  if (requestIds.length || sourceReferences.length) {
    params.push(requestIds);
    const requestIndex = params.length;
    params.push(sourceReferences);
    const sourceIndex = params.length;
    selectors.push(`(id = ANY($${requestIndex}::text[]) OR source_reference = ANY($${sourceIndex}::text[]))`);
  }
  const mode = normalized(body?.source_mode || body?.mode);
  if (mode === "precision") {
    const routeId = await authorizePrecisionStatusScope(base44, actor, user, body);
    params.push(routeId);
    selectors.push(`(source_kind = 'precision' AND route_id = $${params.length})`);
  } else if (mode === "canvas") {
    const scope = await authorizeCanvasStatusScope(base44, actor, user, body);
    params.push(scope.campaignId);
    const campaignIndex = params.length;
    params.push(scope.zoneId);
    selectors.push(`(source_kind = 'canvas' AND campaign_id = $${campaignIndex} AND zone_id = $${params.length})`);
  } else if (mode) {
    throw new HttpError(400, "invalid_source", "source_mode must be precision or canvas.");
  }
  if (!selectors.length) throw new HttpError(400, "status_reference_required", "Provide request IDs, source references, or an authorized Precision/Canvas scope.");
  const rows = await sql(
    `SELECT * FROM fieldroutes_inspection_requests
      WHERE manager_id = $1${actorFilter}
        AND state <> 'superseded'
        AND (${selectors.join(" OR ")})
      ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return json({ statuses: rows.map(safeRequest) });
}

async function acquireConnectionWorkerLease(sql: any, managerId: string) {
  const token = crypto.randomUUID();
  const rows = await sql`
    UPDATE fieldroutes_connections
       SET worker_lease_token = ${token}, worker_lease_acquired_at = NOW(),
           worker_lease_expires_at = ${new Date(Date.now() + LEASE_MS).toISOString()},
           worker_next_claim_at = ${new Date(Date.now() + 20_000).toISOString()}
     WHERE manager_id = ${managerId}
       AND connection_status = 'connected' AND disabled_at IS NULL
       AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < NOW())
       AND (worker_next_claim_at IS NULL OR worker_next_claim_at <= NOW())
     RETURNING manager_id
  `;
  return rows[0] ? token : null;
}

async function releaseConnectionWorkerLease(sql: any, managerId: string, token: string | null) {
  if (!token) return;
  await sql`
    UPDATE fieldroutes_connections
       SET worker_lease_token = NULL, worker_lease_acquired_at = NULL, worker_lease_expires_at = NULL
     WHERE manager_id = ${managerId} AND worker_lease_token = ${token}
  `;
}

async function processQueueAction(sql: any, body: any, req: Request) {
  const configured = Deno.env.get("FIELDROUTES_WORKER_SECRET") || "";
  const supplied = req.headers.get("x-fieldroutes-worker-secret") || "";
  if (configured.length < 32 || !constantTimeEqual(configured, supplied)) throw new HttpError(403, "worker_forbidden", "Worker authorization failed.");
  const limit = Math.max(1, Math.min(5, Number(body?.limit || 5)));
  const candidates = await sql`
    WITH ranked AS (
      SELECT r.id, r.manager_id,
             ROW_NUMBER() OVER (PARTITION BY r.manager_id ORDER BY r.next_retry_at ASC, r.created_at ASC) AS manager_rank
        FROM fieldroutes_inspection_requests r
        JOIN fieldroutes_connections c ON c.manager_id = r.manager_id
       WHERE r.state IN ('queued', 'processing', 'retry_wait', 'customer_reconcile', 'appointment_reconcile')
         AND r.next_retry_at <= NOW()
         AND (r.lease_expires_at IS NULL OR r.lease_expires_at < NOW())
         AND c.connection_status = 'connected' AND c.disabled_at IS NULL
         AND (c.worker_next_claim_at IS NULL OR c.worker_next_claim_at <= NOW())
    )
    SELECT id, manager_id FROM ranked
     WHERE manager_rank = 1
     ORDER BY manager_id
     LIMIT ${limit}
  `;
  const counts: Record<string, number> = { processed: 0, synced: 0, pending: 0, review_required: 0, failed: 0 };
  const results = await Promise.all(candidates.map(async (candidate) => {
    const managerId = String(candidate.manager_id);
    const accountLease = await acquireConnectionWorkerLease(sql, managerId);
    if (!accountLease) return null;
    try {
      return await claimAndProcess(sql, managerId, String(candidate.id));
    } finally {
      await releaseConnectionWorkerLease(sql, managerId, accountLease);
    }
  }));
  for (const result of results) {
    if (!result) continue;
    counts.processed += 1;
    if (result.state === "synced") counts.synced += 1;
    else if (result.state === "review_required") counts.review_required += 1;
    else if (result.state === "failed") counts.failed += 1;
    else counts.pending += 1;
  }
  return json({ ok: true, ...counts });
}

async function parseBody(req: Request) {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large", "The request body is too large.");
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large", "The request body is too large.");
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "A JSON request body is required.");
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const body = await parseBody(req);
    let action = normalized(body?.action);
    if (action === "reconcile") action = "retry_request";
    if (!ACTIONS.has(normalized(body?.action)) || !ACTIONS.has(action)) throw new HttpError(400, "invalid_action", "Unknown FieldRoutes action.");
    const databaseUrl = Deno.env.get("DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "database_unavailable", "FieldRoutes storage is not configured.");
    const sql = neon(databaseUrl);
    if (action === "process_queue") return await processQueueAction(sql, body, req);

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) throw new HttpError(401, "authentication_required", "Sign in to use FieldRoutes.");
    const actor = await resolveActor(base44, user);

    if (action === "capability" || action === "get_connection") {
      if (action === "get_connection") requireManager(actor);
      const capability = safeConnection(await getConnection(sql, actor.managerId), actor.isManager);
      return json({ ...capability, capability });
    }
    if (action === "save_connection") return await saveConnectionAction(sql, actor, user, body);
    if (action === "test_connection") return await testConnectionAction(sql, actor);
    if (action === "list_service_types") return await listServiceTypesAction(sql, actor);
    if (action === "disconnect") return await disconnectAction(sql, actor, user);
    if (action === "list_activity") return await listActivityAction(sql, actor, body);
    if (action === "retry_request") return await retryRequestAction(sql, actor, body);
    if (action === "schedule_inspection") return await scheduleInspectionAction(base44, sql, user, actor, body, req);
    if (action === "get_statuses") return await getStatusesAction(base44, sql, actor, user, body);
    throw new HttpError(400, "invalid_action", "Unknown FieldRoutes action.");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
    if (error instanceof ProviderError) return json({ error: error.code, message: providerErrorMessage(error.code) }, error.retryable ? 503 : 422);
    console.error("[fieldRoutesIntegration] unhandled failure");
    return json({ error: "fieldroutes_unavailable", message: "FieldRoutes is temporarily unavailable." }, 503);
  }
});
