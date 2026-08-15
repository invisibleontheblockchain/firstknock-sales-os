import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const MAX_PAGE = 500;
const DEFAULT_PAGE = 250;
const MAX_VIEWPORT_DEGREES_SQUARED = 16;
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

function coordinate(value: unknown, field: string, minimum: number, maximum: number) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new HttpError(400, "invalid_viewport", `${field} is outside the supported coordinate range.`);
  }
  return Number(result.toFixed(7));
}

function publicPin(payload: any) {
  return {
    pin_id: payload.pin_id,
    house_key: payload.house_key,
    opportunity_id: payload.opportunity_id,
    street_unit_id: payload.street_unit_id,
    point: payload.point,
    address: payload.address,
    unit_label: payload.unit_label,
    latest_outcome: payload.latest_outcome,
    latest_note: payload.latest_note,
    latest_event_id: payload.latest_event_id,
    latest_client_recorded_at: payload.latest_client_recorded_at,
    version: Number(payload.version),
    dnc_active: payload.dnc_active === true,
  };
}

function publicDnc(payload: any) {
  return {
    suppression_id: payload.suppression_id,
    house_key: payload.house_key,
    point: payload.point,
    active: true,
    version: Number(payload.version),
    set_at: payload.set_at,
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to view Canvas map decisions." }, 401);
    if (!canManageCanvas(user)) return json({ error: "manager_required", message: "Only a Canvas manager can view campaign decisions." }, 403);
    const body = await req.json().catch(() => ({}));
    const campaignId = String(body.campaign_id || "").trim();
    if (!campaignId || campaignId.length > 256) throw new HttpError(400, "invalid_campaign_id", "campaign_id is required or invalid.");
    const west = coordinate(body?.bounds?.west, "bounds.west", -180, 180);
    const east = coordinate(body?.bounds?.east, "bounds.east", -180, 180);
    const south = coordinate(body?.bounds?.south, "bounds.south", -90, 90);
    const north = coordinate(body?.bounds?.north, "bounds.north", -90, 90);
    if (west >= east || south >= north || (east - west) * (north - south) > MAX_VIEWPORT_DEGREES_SQUARED) {
      throw new HttpError(400, "invalid_viewport", "Zoom farther into the campaign before loading house decisions.");
    }
    const afterCursor = Number(body.after_cursor || 0);
    const afterId = String(body.after_id || "");
    const requestedLimit = Number(body.limit || DEFAULT_PAGE);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0 || afterId.length > 256) throw new HttpError(400, "invalid_page_cursor", "The Canvas viewport cursor is invalid.");
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new HttpError(400, "invalid_limit", "limit must be a positive integer.");
    const limit = Math.min(requestedLimit, MAX_PAGE);

    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas map decisions are not configured.");
    const sql = neon(databaseUrl);
    const deployments = asArray(await sql(`
      SELECT campaign_id, manager_id, status, assignment_index_version
      FROM canvas_deployments
      WHERE campaign_id = $1 AND manager_id = $2
    `, [campaignId, String(user.id)]));
    const deployment = deployments[0];
    if (!deployment) throw new HttpError(404, "campaign_not_found", "The Canvas campaign was not found for this manager.");

    const rows = asArray(await sql(`
      WITH viewport AS (
        SELECT ST_MakeEnvelope($3, $4, $5, $6, 4326) AS geometry
      ), visible AS (
        SELECT
          'pin'::text AS record_kind,
          p.latest_change_cursor::bigint AS change_cursor,
          p.pin_id::text AS record_id,
          jsonb_build_object(
            'pin_id', p.pin_id, 'house_key', p.house_key,
            'opportunity_id', p.opportunity_id, 'street_unit_id', p.street_unit_id,
            'point', jsonb_build_object('lat', ST_Y(p.point), 'lng', ST_X(p.point)),
            'address', p.address, 'unit_label', p.unit_label,
            'latest_outcome', p.latest_outcome, 'latest_note', p.latest_note,
            'latest_event_id', p.latest_event_id,
            'latest_client_recorded_at', p.latest_client_recorded_at,
            'version', p.version, 'dnc_active', EXISTS (
              SELECT 1 FROM canvas_dnc_suppressions ds
              WHERE ds.manager_id = p.manager_id AND ds.house_key = p.house_key AND ds.active
            )
          ) AS payload
        FROM canvas_house_pins p, viewport v
        WHERE p.manager_id = $2 AND p.campaign_id = $1
          AND p.point && v.geometry AND ST_Intersects(p.point, v.geometry)
        UNION ALL
        SELECT
          'dnc'::text AS record_kind,
          d.change_cursor::bigint AS change_cursor,
          d.suppression_id::text AS record_id,
          jsonb_build_object(
            'suppression_id', d.suppression_id, 'house_key', d.house_key,
            'point', jsonb_build_object('lat', ST_Y(d.point), 'lng', ST_X(d.point)),
            'active', TRUE, 'version', d.version, 'set_at', d.set_at
          ) AS payload
        FROM canvas_dnc_suppressions d, viewport v
        WHERE d.manager_id = $2 AND d.active
          AND d.point && v.geometry AND ST_Intersects(d.point, v.geometry)
      )
      SELECT record_kind, change_cursor, record_id, payload
      FROM visible
      WHERE $7 = 0 OR change_cursor < $7 OR (change_cursor = $7 AND record_id < $8)
      ORDER BY change_cursor DESC, record_id DESC
      LIMIT $9
    `, [campaignId, String(user.id), west, south, east, north, afterCursor, afterId, limit + 1]));
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return json({
      success: true,
      campaign_id: campaignId,
      deployment_status: deployment.status,
      assignment_index_version: Number(deployment.assignment_index_version || 0),
      bounds: { west, south, east, north },
      pins: page.filter((row: any) => row.record_kind === "pin").map((row: any) => publicPin(row.payload)),
      dnc: page.filter((row: any) => row.record_kind === "dnc").map((row: any) => publicDnc(row.payload)),
      has_more: hasMore,
      next_cursor: last ? Number(last.change_cursor) : afterCursor,
      next_id: last ? String(last.record_id) : afterId,
      limit,
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    console.error("[canvasGetViewportPins] request failed");
    return json({ error: "canvas_viewport_unavailable", message: "Canvas map decisions are temporarily unavailable." }, 503);
  }
});
