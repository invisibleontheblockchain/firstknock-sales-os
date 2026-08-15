import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import { neon } from "npm:@neondatabase/serverless@0.9.0";

const OUTCOMES = ["no_answer", "not_interested", "callback", "appointment", "sale", "do_not_knock"];
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

function parseCounts(value: any) {
  const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value || {};
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, Math.max(0, Number(parsed[outcome] || 0))]));
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) return json({ error: "unauthorized", message: "Sign in to view Canvas campaign progress." }, 401);
    if (!canManageCanvas(user)) return json({ error: "manager_required", message: "Only a Canvas manager can view campaign summaries." }, 403);
    const body = await req.json().catch(() => ({}));
    const campaignId = String(body.campaign_id || "").trim();
    if (!campaignId || campaignId.length > 256) throw new HttpError(400, "invalid_campaign_id", "campaign_id is required or invalid.");

    const databaseUrl = Deno.env.get("CANVAS_DATABASE_URL") || "";
    if (!databaseUrl) throw new HttpError(503, "canvas_database_unavailable", "Canvas campaign summaries are not configured.");
    const sql = neon(databaseUrl);
    const deployments = asArray(await sql(`
      SELECT campaign_id, manager_id, plan_version, plan_hash, lifecycle_version,
        assignment_index_version, status, deployed_at, closed_at, updated_at
      FROM canvas_deployments
      WHERE campaign_id = $1 AND manager_id = $2
    `, [campaignId, String(user.id)]));
    const deployment = deployments[0];
    if (!deployment) throw new HttpError(404, "campaign_not_found", "The Canvas campaign was not found for this manager.");

    const [progressRows, assignmentRows, cursorRows, dncRows] = await Promise.all([
      sql(`
        SELECT manager_id, campaign_id, zone_id, distinct_pin_count, event_count,
          active_dnc_count, outcome_counts, last_change_cursor, version, updated_at
        FROM canvas_zone_progress
        WHERE manager_id = $1 AND campaign_id = $2
        ORDER BY zone_id
      `, [String(user.id), campaignId]),
      sql(`
        SELECT DISTINCT ON (zone_id)
          assignment_id, zone_id, assignee_user_id, team_member_id,
          package_version, package_status, status, valid_from, valid_until,
          revoked_at, updated_at
        FROM canvas_assignments
        WHERE manager_id = $1 AND campaign_id = $2
        ORDER BY zone_id, package_version DESC, updated_at DESC
      `, [String(user.id), campaignId]),
      sql(`
        SELECT COALESCE(MAX(cursor), 0) AS high_water_cursor
        FROM canvas_changes
        WHERE manager_id = $1 AND campaign_id = $2
      `, [String(user.id), campaignId]),
      sql(`
        SELECT COUNT(*)::bigint AS active_count
        FROM canvas_dnc_suppressions
        WHERE manager_id = $1 AND active
      `, [String(user.id)])
    ]);

    const assignmentsByZone = new Map(asArray(assignmentRows).map((assignment: any) => [String(assignment.zone_id), assignment]));
    const progressByZone = new Map(asArray(progressRows).map((progress: any) => [String(progress.zone_id), progress]));
    const zoneIds = [...new Set([...assignmentsByZone.keys(), ...progressByZone.keys()])].sort();
    const totals: any = {
      distinct_pin_count: 0,
      event_count: 0,
      dnc_set_count: 0,
      outcome_counts: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]))
    };
    const zones = zoneIds.map((zoneId) => {
      const assignment: any = assignmentsByZone.get(zoneId) || null;
      const progress: any = progressByZone.get(zoneId) || null;
      const outcomeCounts = parseCounts(progress?.outcome_counts);
      const zone = {
        zone_id: zoneId,
        assignment: assignment ? {
          assignment_id: assignment.assignment_id,
          assignee_user_id: assignment.assignee_user_id,
          team_member_id: assignment.team_member_id,
          package_version: Number(assignment.package_version),
          package_status: assignment.package_status,
          status: assignment.status,
          valid_from: assignment.valid_from,
          valid_until: assignment.valid_until,
          revoked_at: assignment.revoked_at
        } : null,
        progress: {
          distinct_pin_count: Number(progress?.distinct_pin_count || 0),
          event_count: Number(progress?.event_count || 0),
          dnc_set_count: Number(progress?.active_dnc_count || 0),
          outcome_counts: outcomeCounts,
          last_change_cursor: Number(progress?.last_change_cursor || 0),
          version: Number(progress?.version || 0),
          updated_at: progress?.updated_at || null
        }
      };
      totals.distinct_pin_count += zone.progress.distinct_pin_count;
      totals.event_count += zone.progress.event_count;
      totals.dnc_set_count += zone.progress.dnc_set_count;
      for (const outcome of OUTCOMES) totals.outcome_counts[outcome] += outcomeCounts[outcome];
      return zone;
    });

    const assignments = asArray(assignmentRows);
    return json({
      success: true,
      campaign: {
        campaign_id: deployment.campaign_id,
        status: deployment.status,
        plan_version: Number(deployment.plan_version),
        plan_hash: deployment.plan_hash,
        lifecycle_version: Number(deployment.lifecycle_version),
        assignment_index_version: Number(deployment.assignment_index_version),
        deployed_at: deployment.deployed_at,
        closed_at: deployment.closed_at,
        updated_at: deployment.updated_at
      },
      assignment_counts: {
        total: assignments.length,
        active: assignments.filter((assignment: any) => assignment.status === "active").length,
        revoked_or_superseded: assignments.filter((assignment: any) => ["revoked", "superseded"].includes(assignment.status)).length,
        package_ready: assignments.filter((assignment: any) => assignment.package_status === "ready").length
      },
      totals: {
        ...totals,
        tenant_wide_active_dnc_count: Number(asArray(dncRows)[0]?.active_count || 0),
        high_water_cursor: Number(asArray(cursorRows)[0]?.high_water_cursor || 0)
      },
      zones
    });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    console.error("[canvasGetCampaignSummary] request failed");
    return json({ error: "canvas_summary_unavailable", message: "Canvas campaign progress is temporarily unavailable." }, 503);
  }
});
