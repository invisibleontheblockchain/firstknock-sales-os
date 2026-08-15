import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const MAX_CHANGE_PAGE = 500;
const DEFAULT_CHANGE_PAGE = 200;
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
  if (!result || result.length > maxLength) throw new HttpError(400, "invalid_request", `${field} is required or invalid.`);
  return result;
}

async function resolveActor(base44: any, user: any) {
  if (canManageCanvas(user)) return { managerId: String(user.id || "").trim(), teamMemberId: null, isManager: true };
  const managerId = String(user?.team_manager_id || user?.data?.team_manager_id || "").trim();
  if (!managerId) throw new HttpError(403, "canvas_assignment_forbidden", "No active Canvas team membership is linked to this account.");
  const candidates = asArray(await base44.entities.TeamMember.filter(
    { user_id: user.id, status: "active" },
    "-updated_date",
    20
  ).catch(() => [])).filter((member: any) =>
    String(member?.user_id || "") === String(user.id || "") &&
    String(member?.manager_id || "") === managerId &&
    normalized(member?.status) === "active" &&
    normalized(member?.role) === "rep"
  );
  const unique = new Map(candidates.map((member: any) => [String(member.id), member]));
  if (unique.size !== 1) {
    throw new HttpError(unique.size > 1 ? 409 : 403, unique.size > 1 ? "ambiguous_team_membership" : "canvas_assignment_forbidden", "An exact active rep membership is required.");
  }
  return { managerId, teamMemberId: String([...unique.values()][0].id), isManager: false };
}

function validateAssignment(row: any, actor: any, user: any, packageVersion: number) {
  if (!row || String(row.manager_id) !== actor.managerId) {
    throw new HttpError(403, "canvas_assignment_forbidden", "This assignment is not available to this account.");
  }
  if (!actor.isManager && (String(row.assignee_user_id) !== String(user.id) || String(row.team_member_id) !== actor.teamMemberId)) {
    throw new HttpError(403, "canvas_assignment_forbidden", "This assignment belongs to another rep.");
  }
  if (String(row.deployment_status) === "recalled") throw new HttpError(409, "campaign_recalled", "This Canvas campaign was recalled.");
  if (String(row.deployment_status) !== "active") throw new HttpError(409, "campaign_not_active", "This Canvas campaign is not active.");
  if (["revoked", "superseded"].includes(String(row.assignment_status)) || row.revoked_at) {
    throw new HttpError(409, "assignment_revoked", "This Canvas assignment was revoked or replaced.");
  }
  if (String(row.assignment_status) !== "active" || String(row.package_status) !== "ready") {
    throw new HttpError(409, "assignment_not_ready", "This Canvas assignment package is not ready.");
  }
  if (Number(row.package_version) !== packageVersion) {
    throw new HttpError(409, "package_version_mismatch", "The offline package is stale. Download the current assignment package.");
  }
  if (!row.package_id || String(row.package_record_status) !== "ready") {
    throw new HttpError(409, "package_not_ready", "The signed offline assignment package is not ready.");
  }
  const now = Date.now();
  if ((row.valid_from && Date.parse(row.valid_from) > now) || (row.package_issued_at && Date.parse(row.package_issued_at) > now)) {
    throw new HttpError(409, "assignment_not_yet_valid", "This Canvas assignment is not active yet.");
  }
  if ((row.valid_until && Date.parse(row.valid_until) <= now) || (row.package_valid_until && Date.parse(row.package_valid_until) <= now)) {
    throw new HttpError(409, "assignment_expired", "This Canvas assignment package has expired.");
  }
  return row;
}

function publicChange(row: any) {
  return {
    cursor: Number(row.cursor),
    campaign_id: row.campaign_id,
    zone_id: row.zone_id,
    assignment_id: row.assignment_id,
    change_type: row.change_type,
    entity_id: row.entity_id,
    entity_version: Number(row.entity_version),
    payload: row.payload,
    occurred_at: row.occurred_at
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to retrieve Canvas changes." }, 401);
    const actor = await resolveActor(base44, user);
    const body = await req.json().catch(() => ({}));
    const assignmentId = requiredString(body.assignment_id, "assignment_id");
    const packageVersion = Number(body.package_version);
    const sinceCursor = Number(body.since_cursor ?? 0);
    const requestedLimit = Number(body.limit ?? DEFAULT_CHANGE_PAGE);
    if (!Number.isInteger(packageVersion) || packageVersion < 1) throw new HttpError(400, "invalid_package_version", "package_version must be a positive integer.");
    if (!Number.isSafeInteger(sinceCursor) || sinceCursor < 0) throw new HttpError(400, "invalid_cursor", "since_cursor must be a non-negative safe integer.");
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new HttpError(400, "invalid_limit", "limit must be a positive integer.");
    const limit = Math.min(requestedLimit, MAX_CHANGE_PAGE);

    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas change sync is not configured.");
    const sql = neon(databaseUrl);
    const assignmentRows = await sql(`
      SELECT
        a.assignment_id, a.manager_id, a.campaign_id, a.zone_id,
        a.assignee_user_id, a.team_member_id, a.package_version,
        a.package_status, a.status AS assignment_status, a.valid_from,
        a.valid_until, a.revoked_at, d.status AS deployment_status,
        p.package_id, p.status AS package_record_status,
        p.issued_at AS package_issued_at, p.valid_until AS package_valid_until
      FROM canvas_assignments a
      JOIN canvas_deployments d
        ON d.campaign_id = a.campaign_id AND d.manager_id = a.manager_id
      LEFT JOIN canvas_assignment_packages p
        ON p.manager_id = a.manager_id AND p.assignment_id = a.assignment_id
       AND p.package_version = a.package_version
      WHERE a.assignment_id = $1 AND a.manager_id = $2
    `, [assignmentId, actor.managerId]);
    const assignment = validateAssignment(asArray(assignmentRows)[0], actor, user, packageVersion);

    // Pin the upper edge before selecting rows. Advancing to this cursor is
    // safe when fewer than a full relevant page exists, and prevents a rep
    // from rescanning an arbitrarily large stream of unrelated tenant changes.
    // Changes committed after this read remain strictly above the pinned edge
    // and are returned on the next request.
    const highWaterRows = asArray(await sql(`
      SELECT COALESCE(MAX(cursor), 0) AS high_water_cursor
      FROM canvas_changes
      WHERE manager_id = $1
    `, [assignment.manager_id]));
    const highWaterCursor = Number(highWaterRows[0]?.high_water_cursor || 0);

    const changeRows = asArray(await sql(`
      SELECT c.*
      FROM canvas_changes c
      WHERE c.manager_id = $1 AND c.cursor > $2 AND c.cursor <= $6
        AND (
          c.assignment_id = $3
          OR (
            c.change_type IN ('dnc_upsert', 'dnc_revoke')
            AND jsonb_typeof(c.payload -> 'point') = 'object'
            AND (c.payload -> 'point' ->> 'lat') ~ '^-?[0-9]+([.][0-9]+)?$'
            AND (c.payload -> 'point' ->> 'lng') ~ '^-?[0-9]+([.][0-9]+)?$'
            AND EXISTS (
              SELECT 1
              FROM canvas_work_unit_ownership w
              WHERE w.manager_id = $1 AND w.campaign_id = $4 AND w.assignment_id = $3
                AND ST_DWithin(
                  w.geometry::geography,
                  ST_SetSRID(ST_MakePoint(
                    (c.payload -> 'point' ->> 'lng')::double precision,
                    (c.payload -> 'point' ->> 'lat')::double precision
                  ), 4326)::geography,
                  150
                )
            )
          )
        )
      ORDER BY c.cursor ASC
      LIMIT $5
    `, [assignment.manager_id, sinceCursor, assignment.assignment_id, assignment.campaign_id, limit + 1, highWaterCursor]));
    const hasMore = changeRows.length > limit;
    const page = changeRows.slice(0, limit).map(publicChange);
    const nextCursor = hasMore ? page[page.length - 1].cursor : highWaterCursor;

    return json({
      success: true,
      assignment_id: assignment.assignment_id,
      campaign_id: assignment.campaign_id,
      zone_id: assignment.zone_id,
      package_version: Number(assignment.package_version),
      since_cursor: sinceCursor,
      next_cursor: nextCursor,
      high_water_cursor: highWaterCursor,
      has_more: hasMore,
      limit,
      changes: page
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    console.error("[canvasGetChanges] request failed");
    return json({ error: "canvas_changes_unavailable", message: "Canvas changes are temporarily unavailable." }, 503);
  }
});
