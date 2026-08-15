import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const MAX_ARTIFACT_BYTES = 2_000_000;
const MAX_MANIFEST_BYTES = 1_000_000;
const json = (body: unknown, status = 200) => Response.json(body, { status });

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_package_request", `${field} is required or invalid.`);
  return result;
}

function canonicalize(value: any): any {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(503, "canvas_package_integrity_failed", "The stored Canvas package is not canonical.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") throw new HttpError(503, "canvas_package_integrity_failed", "The stored Canvas package is not canonical.");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

function toBytes(value: any) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new HttpError(503, "canvas_package_integrity_failed", "The stored Canvas package bytes are unavailable.");
}

function hex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array) {
  let binary = "";
  for (let index = 0; index < value.byteLength; index += 1) binary += String.fromCharCode(value[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value: string) {
  const normalizedValue = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const binary = atob(normalizedValue.padEnd(Math.ceil(normalizedValue.length / 4) * 4, "="));
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function pemBytes(value: string) {
  return decodeBase64(value.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s/g, ""));
}

async function sha256(value: Uint8Array) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

function publicKeyConfiguration() {
  const value = Deno.env.get("CANVAS_PACKAGE_SIGNING_PUBLIC_KEY") || "";
  const keyId = Deno.env.get("CANVAS_PACKAGE_SIGNING_KEY_ID") || "";
  const configuredFormat = normalized(Deno.env.get("CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT") || "raw");
  if (!value || !/^[A-Za-z0-9._:-]{3,128}$/.test(keyId)) {
    throw new HttpError(503, "canvas_package_verification_unavailable", "Canvas package verification is not configured.");
  }
  if (value.trim().startsWith("{")) {
    return { value, keyId, format: "jwk", descriptor: { algorithm: "Ed25519", key_id: keyId, format: "jwk", keyData: JSON.parse(value) } };
  }
  const format = value.includes("BEGIN PUBLIC KEY") ? "spki" : configuredFormat;
  if (!["raw", "spki"].includes(format)) throw new HttpError(503, "canvas_package_verification_unavailable", "Canvas public-key format is invalid.");
  return { value, keyId, format, descriptor: { algorithm: "Ed25519", key_id: keyId, format, keyData: value } };
}

async function importPublicKey(configuration: any) {
  try {
    if (configuration.format === "jwk") return await crypto.subtle.importKey("jwk", JSON.parse(configuration.value), { name: "Ed25519" }, false, ["verify"]);
    const data = configuration.format === "spki" && configuration.value.includes("BEGIN PUBLIC KEY")
      ? pemBytes(configuration.value)
      : decodeBase64(configuration.value);
    return await crypto.subtle.importKey(configuration.format, data, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new HttpError(503, "canvas_package_verification_unavailable", "Canvas public-key configuration could not be imported.");
  }
}

async function resolveRep(base44: any, user: any) {
  if (canManageCanvas(user)) throw new HttpError(403, "rep_required", "Assignment packages are available only to the assigned rep account.");
  const managerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!managerId) throw new HttpError(403, "canvas_assignment_forbidden", "No active Canvas team membership is linked to this account.");
  const candidates = asArray(await base44.entities.TeamMember.filter(
    { user_id: user.id, status: "active" },
    "-updated_date",
    20
  ).catch(() => [])).filter((member: any) =>
    String(member?.user_id || "") === String(user.id || "")
    && String(member?.manager_id || "") === managerId
    && normalized(member?.status) === "active"
    && normalized(member?.role) === "rep"
  );
  const unique = new Map(candidates.map((member: any) => [String(member.id), member]));
  if (unique.size !== 1) throw new HttpError(unique.size > 1 ? 409 : 403, unique.size > 1 ? "ambiguous_team_membership" : "canvas_assignment_forbidden", "An exact active rep membership is required.");
  return { managerId, teamMemberId: String([...unique.values()][0].id) };
}

function verifyAssignmentState(row: any, user: any, rep: any, requestedVersion: number | null) {
  if (!row || String(row.manager_id) !== rep.managerId || String(row.assignee_user_id) !== String(user.id)
    || String(row.team_member_id) !== rep.teamMemberId) {
    throw new HttpError(403, "canvas_assignment_forbidden", "This Canvas package belongs to another tenant or rep.");
  }
  if (String(row.deployment_status) === "recalled") throw new HttpError(409, "campaign_recalled", "This Canvas campaign was recalled.");
  if (String(row.deployment_status) !== "active") throw new HttpError(409, "campaign_not_active", "This Canvas campaign is not active.");
  if (["revoked", "superseded"].includes(String(row.assignment_status)) || row.revoked_at) {
    throw new HttpError(409, "assignment_revoked", "This Canvas assignment was revoked or replaced.");
  }
  if (String(row.assignment_status) !== "active" || String(row.assignment_package_status) !== "ready") {
    throw new HttpError(409, "assignment_not_ready", "This Canvas assignment is not ready for offline use.");
  }
  if (!row.package_id || String(row.package_status) !== "ready") throw new HttpError(409, "package_revoked", "The current Canvas package was revoked or is unavailable.");
  if (requestedVersion !== null && Number(row.package_version) !== requestedVersion) {
    throw new HttpError(409, "package_version_mismatch", "This Canvas package version is stale.");
  }
  if (Number(row.package_version) !== Number(row.assignment_package_version)) {
    throw new HttpError(409, "package_version_mismatch", "This Canvas package is no longer the current assignment version.");
  }
  const now = Date.now();
  if ((row.valid_from && Date.parse(row.valid_from) > now) || (row.issued_at && Date.parse(row.issued_at) > now + 5 * 60_000)) {
    throw new HttpError(409, "package_not_yet_valid", "This Canvas package is not valid yet.");
  }
  if ((row.valid_until && Date.parse(row.valid_until) <= now) || (row.package_valid_until && Date.parse(row.package_valid_until) <= now)) {
    throw new HttpError(409, "package_expired", "This Canvas package expired and must be refreshed.");
  }
  return row;
}

async function verifyManifest(row: any, user: any, rep: any, configuration: any, publicKey: CryptoKey) {
  const manifestBytes = toBytes(row.manifest_content);
  if (manifestBytes.byteLength < 1 || manifestBytes.byteLength > MAX_MANIFEST_BYTES
    || manifestBytes.byteLength !== Number(row.manifest_byte_size)
    || await sha256(manifestBytes) !== row.manifest_hash) {
    throw new HttpError(503, "canvas_package_integrity_failed", "The Canvas package manifest failed its stored byte or hash contract.");
  }
  let manifest: any;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw new HttpError(503, "canvas_package_integrity_failed", "The Canvas package manifest is not valid UTF-8 JSON.");
  }
  const canonical = canonicalBytes(manifest);
  if (canonical.byteLength !== manifestBytes.byteLength || await sha256(canonical) !== row.manifest_hash) {
    throw new HttpError(503, "canvas_package_integrity_failed", "The Canvas package manifest is not canonical.");
  }
  if (manifest.schema !== "firstknock.canvas-field-package" || Number(manifest.schema_version) !== 1
    || manifest.package_id !== row.package_id || Number(manifest.package_version) !== Number(row.package_version)
    || manifest.manager_id !== rep.managerId || manifest.assignment_id !== row.assignment_id
    || manifest.assignee_user_id !== String(user.id) || manifest.team_member_id !== rep.teamMemberId
    || manifest.campaign_id !== row.campaign_id || manifest.zone_id !== row.zone_id
    || manifest.signature?.algorithm !== "Ed25519" || manifest.signature?.key_id !== configuration.keyId
    || manifest.signature?.value !== row.manifest_signature || manifest.dnc?.complete !== true
    || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
    throw new HttpError(503, "canvas_package_integrity_failed", "The Canvas package manifest identity or DNC completeness contract failed.");
  }
  const { signature, ...unsigned } = manifest;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = decodeBase64(signature.value);
  } catch {
    throw new HttpError(503, "canvas_package_integrity_failed", "The Canvas package signature encoding is invalid.");
  }
  if (signatureBytes.byteLength !== 64 || !await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signatureBytes, canonicalBytes(unsigned))) {
    throw new HttpError(503, "canvas_package_integrity_failed", "The Canvas package signature is invalid.");
  }
  return manifest;
}

function descriptorFromManifest(manifest: any, artifactId: string) {
  const matches = manifest.artifacts.filter((entry: any) => String(entry?.artifact_id || "") === artifactId);
  if (matches.length !== 1) throw new HttpError(503, "canvas_package_integrity_failed", "The requested artifact is absent or duplicated in the signed manifest.");
  return matches[0];
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to download a Canvas assignment package." }, 401);
    const rep = await resolveRep(base44, user);
    const body = await req.json().catch(() => ({}));
    const assignmentId = body.assignment_id ? requiredString(body.assignment_id, "assignment_id") : null;
    const campaignId = body.campaign_id ? requiredString(body.campaign_id, "campaign_id") : null;
    const zoneId = body.zone_id ? requiredString(body.zone_id, "zone_id", 512) : null;
    if (!assignmentId && !(campaignId && zoneId)) throw new HttpError(400, "invalid_package_request", "Provide assignment_id or the exact campaign_id and zone_id.");
    const requestedVersionValue = body.package_version;
    const requestedVersion = requestedVersionValue === undefined || requestedVersionValue === null
      ? null
      : Number(requestedVersionValue);
    if (requestedVersion !== null && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) {
      throw new HttpError(400, "invalid_package_version", "package_version must be a positive integer.");
    }
    const artifactId = body.artifact_id ? requiredString(body.artifact_id, "artifact_id", 256) : null;

    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas package retrieval is not configured.");
    const sql = neon(databaseUrl);
    const query = assignmentId ? `
      SELECT
        a.assignment_id, a.manager_id, a.campaign_id, a.zone_id,
        a.assignee_user_id, a.team_member_id,
        a.package_version AS assignment_package_version,
        a.package_status AS assignment_package_status,
        a.status AS assignment_status, a.valid_from, a.valid_until, a.revoked_at,
        d.status AS deployment_status,
        p.package_id, p.package_version, p.status AS package_status,
        p.manifest_hash, p.manifest_signature, p.manifest_content,
        p.manifest_byte_size, p.signing_key_id, p.issued_at,
        p.valid_until AS package_valid_until, p.dnc_high_water_cursor,
        p.total_bytes
      FROM canvas_assignments a
      JOIN canvas_deployments d ON d.campaign_id = a.campaign_id AND d.manager_id = a.manager_id
      JOIN canvas_assignment_packages p
        ON p.manager_id = a.manager_id AND p.assignment_id = a.assignment_id
       AND p.package_version = a.package_version
      WHERE a.assignment_id = $1 AND a.manager_id = $2
        AND a.assignee_user_id = $3 AND a.team_member_id = $4
    ` : `
      SELECT
        a.assignment_id, a.manager_id, a.campaign_id, a.zone_id,
        a.assignee_user_id, a.team_member_id,
        a.package_version AS assignment_package_version,
        a.package_status AS assignment_package_status,
        a.status AS assignment_status, a.valid_from, a.valid_until, a.revoked_at,
        d.status AS deployment_status,
        p.package_id, p.package_version, p.status AS package_status,
        p.manifest_hash, p.manifest_signature, p.manifest_content,
        p.manifest_byte_size, p.signing_key_id, p.issued_at,
        p.valid_until AS package_valid_until, p.dnc_high_water_cursor,
        p.total_bytes
      FROM canvas_assignments a
      JOIN canvas_deployments d ON d.campaign_id = a.campaign_id AND d.manager_id = a.manager_id
      JOIN canvas_assignment_packages p
        ON p.manager_id = a.manager_id AND p.assignment_id = a.assignment_id
       AND p.package_version = a.package_version
      WHERE a.campaign_id = $1 AND a.zone_id = $2 AND a.manager_id = $3
        AND a.assignee_user_id = $4 AND a.team_member_id = $5
    `;
    const parameters = assignmentId
      ? [assignmentId, rep.managerId, String(user.id), rep.teamMemberId]
      : [campaignId, zoneId, rep.managerId, String(user.id), rep.teamMemberId];
    const packageRows = asArray(await sql(query, parameters));
    if (packageRows.length !== 1) throw new HttpError(packageRows.length ? 409 : 403, packageRows.length ? "ambiguous_assignment_package" : "canvas_assignment_forbidden", "An exact current assignment package could not be resolved.");
    const row = verifyAssignmentState(packageRows[0], user, rep, requestedVersion);
    const configuration = publicKeyConfiguration();
    if (configuration.keyId !== row.signing_key_id) throw new HttpError(409, "package_signing_key_stale", "This package was signed by a key that is no longer active.");
    const publicKey = await importPublicKey(configuration);
    const manifest = await verifyManifest(row, user, rep, configuration, publicKey);

    if (!artifactId) {
      return json({
        success: true,
        package: {
          manifest,
          signing_key: configuration.descriptor,
          artifact_retrieval: {
            function: "canvasGetAssignmentPackage",
            one_artifact_per_request: true,
            assignment_id: row.assignment_id,
            package_version: Number(row.package_version)
          }
        }
      });
    }

    const descriptor = descriptorFromManifest(manifest, artifactId);
    const artifacts = asArray(await sql(`
      SELECT artifact.artifact_id, artifact.artifact_kind,
        artifact.artifact_ordinal, artifact.sha256, artifact.byte_size,
        artifact.content_type, artifact.content, artifact.required
      FROM canvas_package_artifacts artifact
      JOIN canvas_assignment_packages package
        ON package.package_id = artifact.package_id
       AND package.manager_id = artifact.manager_id
      JOIN canvas_assignments assignment
        ON assignment.assignment_id = package.assignment_id
       AND assignment.manager_id = package.manager_id
       AND assignment.package_version = package.package_version
      JOIN canvas_deployments deployment
        ON deployment.campaign_id = assignment.campaign_id
       AND deployment.manager_id = assignment.manager_id
      WHERE artifact.manager_id = $1 AND artifact.package_id = $2
        AND artifact.artifact_id = $3
        AND assignment.assignee_user_id = $4
        AND assignment.team_member_id = $5
        AND package.status = 'ready'
        AND assignment.status = 'active'
        AND assignment.package_status = 'ready'
        AND assignment.revoked_at IS NULL
        AND deployment.status = 'active'
        AND (assignment.valid_from IS NULL OR assignment.valid_from <= NOW())
        AND (assignment.valid_until IS NULL OR assignment.valid_until > NOW())
        AND package.issued_at <= NOW() + INTERVAL '5 minutes'
        AND package.valid_until > NOW()
    `, [rep.managerId, row.package_id, artifactId, String(user.id), rep.teamMemberId]));
    if (artifacts.length !== 1) {
      throw new HttpError(
        artifacts.length ? 503 : 409,
        artifacts.length ? "canvas_package_integrity_failed" : "package_no_longer_current",
        artifacts.length ? "The Canvas package artifact binding is ambiguous." : "This Canvas package changed while it was being downloaded. Retrieve the current manifest."
      );
    }
    const stored = artifacts[0];
    const artifactBytes = toBytes(stored.content);
    if (artifactBytes.byteLength > MAX_ARTIFACT_BYTES || artifactBytes.byteLength !== Number(stored.byte_size)
      || stored.sha256 !== descriptor.sha256 || Number(stored.byte_size) !== Number(descriptor.byte_size ?? descriptor.byte_length)
      || stored.artifact_kind !== descriptor.artifact_kind || Number(stored.artifact_ordinal) !== Number(descriptor.artifact_ordinal)
      || await sha256(artifactBytes) !== stored.sha256) {
      throw new HttpError(503, "canvas_artifact_integrity_failed", "The Canvas artifact failed its signed byte and hash contract.");
    }
    return json({
      success: true,
      package_id: row.package_id,
      package_version: Number(row.package_version),
      artifact: {
        descriptor,
        encoding: "base64url",
        bytes: base64Url(artifactBytes)
      }
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    console.error("[canvasGetAssignmentPackage] request failed");
    return json({ error: "canvas_package_unavailable", message: "The Canvas assignment package is temporarily unavailable." }, 503);
  }
});
