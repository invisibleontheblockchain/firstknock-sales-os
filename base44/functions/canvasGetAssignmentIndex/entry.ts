import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_BODY_BYTES = 8_192;
const CLOCK_SKEW_MS = 5 * 60_000;
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
  if (Array.isArray(value)) return value;
  if (Array.isArray((value as any)?.rows)) return (value as any).rows;
  if (Array.isArray((value as any)?.items)) return (value as any).items;
  return [];
}

function normalized(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function canManageCanvas(user: any) {
  const appRole = normalized(user?.app_role || user?.data?.app_role);
  const accountRole = normalized(user?.role || user?.data?.role);
  return user?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(accountRole);
}

async function boundedBody(req: Request) {
  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "assignment_index_request_too_large", "The Canvas assignment-index request is too large.");
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "assignment_index_request_too_large", "The Canvas assignment-index request is too large.");
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_assignment_index_request", "The Canvas assignment-index request must be a JSON object.");
  }
}

async function resolveRep(base44: any, user: any) {
  if (canManageCanvas(user)) {
    throw new HttpError(403, "rep_required", "The Canvas assignment index is available only to rep accounts.");
  }
  const managerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!managerId || managerId.length > 256) {
    throw new HttpError(403, "canvas_assignment_forbidden", "No active Canvas team membership is linked to this account.");
  }
  const candidates = asArray(await base44.entities.TeamMember.filter(
    { user_id: user.id, status: "active" },
    "-updated_date",
    20
  ).catch(() => [])).filter((member: any) =>
    String(member?.user_id || "") === String(user.id)
    && String(member?.manager_id || "") === managerId
    && normalized(member?.status) === "active"
    && normalized(member?.role) === "rep"
  );
  const unique = new Map(candidates.map((member: any) => [String(member.id || ""), member]));
  unique.delete("");
  if (unique.size !== 1) {
    throw new HttpError(
      unique.size > 1 ? 409 : 403,
      unique.size > 1 ? "ambiguous_team_membership" : "canvas_assignment_forbidden",
      "An exact active rep membership is required."
    );
  }
  return { managerId, teamMemberId: String([...unique.values()][0].id) };
}

function positiveSafeInteger(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new HttpError(503, "canvas_assignment_index_integrity_failed", `The stored ${field} is invalid.`);
  }
  return number;
}

function publicIndexRow(row: any, user: any, rep: any, now: number) {
  const packageVersion = positiveSafeInteger(row?.package_version, "package version");
  const assignmentPackageVersion = positiveSafeInteger(row?.assignment_package_version, "assignment package version");
  const assignmentIndexVersion = positiveSafeInteger(row?.assignment_index_version, "assignment index version");
  const identityMatches = String(row?.manager_id || "") === rep.managerId
    && String(row?.assignee_user_id || "") === String(user.id)
    && String(row?.team_member_id || "") === rep.teamMemberId;
  const stateMatches = row?.assignment_status === "active"
    && row?.assignment_package_status === "ready"
    && row?.deployment_status === "active"
    && row?.package_status === "ready"
    && !row?.revoked_at
    && !row?.superseded_by_campaign_id
    && packageVersion === assignmentPackageVersion;
  const assignmentId = String(row?.assignment_id || "").trim();
  const packageId = String(row?.package_id || "").trim();
  const campaignId = String(row?.campaign_id || "").trim();
  const zoneId = String(row?.zone_id || "").trim();
  const manifestHash = String(row?.manifest_hash || "").trim();
  const assignmentValidFrom = row?.valid_from ? Date.parse(row.valid_from) : null;
  const assignmentValidUntil = row?.valid_until ? Date.parse(row.valid_until) : null;
  const packageIssuedAt = Date.parse(row?.issued_at || "");
  const packageValidUntil = Date.parse(row?.package_valid_until || "");
  const effectiveValidUntil = Date.parse(row?.effective_valid_until || "");
  const datesMatch = (assignmentValidFrom === null || (Number.isFinite(assignmentValidFrom) && assignmentValidFrom <= now))
    && (assignmentValidUntil === null || (Number.isFinite(assignmentValidUntil) && assignmentValidUntil > now))
    && Number.isFinite(packageIssuedAt) && packageIssuedAt <= now + CLOCK_SKEW_MS
    && Number.isFinite(packageValidUntil) && packageValidUntil > now
    && Number.isFinite(effectiveValidUntil) && effectiveValidUntil > now;
  if (!identityMatches || !stateMatches || !datesMatch || !assignmentId || !packageId || !campaignId || !zoneId
    || !/^[a-f0-9]{64}$/.test(manifestHash)) {
    throw new HttpError(503, "canvas_assignment_index_integrity_failed", "A Canvas assignment-index row failed its identity, state, or expiry contract.");
  }
  return {
    assignment_id: assignmentId,
    package_id: packageId,
    package_version: packageVersion,
    manifest_hash: manifestHash,
    valid_until: new Date(effectiveValidUntil).toISOString(),
    campaign_id: campaignId,
    zone_id: zoneId,
    assignment_index_version: assignmentIndexVersion
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to view Canvas assignments." }, 401);
    const rep = await resolveRep(base44, user);
    const body: any = await boundedBody(req);
    const requestedLimit = body.limit === undefined ? DEFAULT_PAGE_SIZE : Number(body.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_PAGE_SIZE) {
      throw new HttpError(400, "invalid_assignment_index_limit", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
    }
    const cursor = body.cursor === undefined || body.cursor === null ? null : String(body.cursor).trim();
    if (cursor !== null && (!cursor || cursor.length > 256)) {
      throw new HttpError(400, "invalid_assignment_index_cursor", "cursor is invalid.");
    }

    // This is the only storage boundary used by this endpoint. In particular,
    // assignment discovery never reads Precision property or route storage and
    // never scans denormalized CanvasSession records.
    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas assignment discovery is not configured.");
    const sql = neon(databaseUrl);
    const result = await sql(`
      SELECT
        a.assignment_id, a.manager_id, a.campaign_id, a.zone_id,
        a.assignee_user_id, a.team_member_id,
        a.package_version AS assignment_package_version,
        a.package_status AS assignment_package_status,
        a.status AS assignment_status, a.valid_from, a.valid_until, a.revoked_at,
        d.status AS deployment_status, d.assignment_index_version,
        d.superseded_by_campaign_id,
        p.package_id, p.package_version, p.status AS package_status,
        p.manifest_hash, p.issued_at, p.valid_until AS package_valid_until,
        CASE
          WHEN a.valid_until IS NULL THEN p.valid_until
          ELSE LEAST(a.valid_until, p.valid_until)
        END AS effective_valid_until
      FROM canvas_assignments a
      JOIN canvas_deployments d
        ON d.campaign_id = a.campaign_id AND d.manager_id = a.manager_id
      JOIN canvas_assignment_packages p
        ON p.manager_id = a.manager_id AND p.assignment_id = a.assignment_id
       AND p.package_version = a.package_version
      WHERE a.manager_id = $1
        AND a.assignee_user_id = $2
        AND a.team_member_id = $3
        AND a.status = 'active'
        AND a.package_status = 'ready'
        AND a.revoked_at IS NULL
        AND (a.valid_from IS NULL OR a.valid_from <= NOW())
        AND (a.valid_until IS NULL OR a.valid_until > NOW())
        AND d.status = 'active'
        AND d.closed_at IS NULL
        AND d.superseded_by_campaign_id IS NULL
        AND d.evidence_release_id IS NOT NULL
        AND p.status = 'ready'
        AND p.issued_at <= NOW() + INTERVAL '5 minutes'
        AND p.valid_until > NOW()
        AND ($4::text IS NULL OR a.assignment_id > $4)
      ORDER BY a.assignment_id ASC
      LIMIT $5
    `, [rep.managerId, String(user.id), rep.teamMemberId, cursor, requestedLimit + 1]);
    const rows = asArray(result);
    const hasMore = rows.length > requestedLimit;
    const visible = rows.slice(0, requestedLimit);
    const now = Date.now();
    const assignments = visible.map((row) => publicIndexRow(row, user, rep, now));
    if (new Set(assignments.map((assignment) => assignment.assignment_id)).size !== assignments.length) {
      throw new HttpError(503, "canvas_assignment_index_integrity_failed", "The Canvas assignment index contains duplicate assignments.");
    }
    return json({
      success: true,
      schema: "firstknock.canvas-assignment-index",
      schema_version: 1,
      assignments,
      has_more: hasMore,
      next_cursor: hasMore && assignments.length ? assignments[assignments.length - 1].assignment_id : null,
      server_time: new Date(now).toISOString()
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    console.error("[canvasGetAssignmentIndex] request failed");
    return json({ error: "canvas_assignment_index_unavailable", message: "Canvas assignment discovery is temporarily unavailable." }, 503);
  }
});
