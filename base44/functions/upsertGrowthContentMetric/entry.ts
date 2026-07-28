import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const FORMATS = new Set(["reel", "carousel", "story", "collab", "live", "other"]);
const SNAPSHOT_DAYS = new Set([1, 3, 7, 30]);
const MAX_METRIC = 1_000_000_000;

function normalized(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function token(value: any, fallback = ""): string {
  return normalized(value)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || fallback;
}

function text(value: any, max = 300): string {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function wholeNumber(value: any): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_METRIC, Math.max(0, Math.floor(parsed)));
}

function optionalTimestamp(value: any): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function canManageGrowth(user: any): boolean {
  return user?.is_owner === true
    || normalized(user?.role) === "admin"
    || normalized(user?.app_role) === "admin";
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!canManageGrowth(user)) {
      return Response.json({ error: "growth_admin_required" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const campaign = token(body?.campaign, "1000-users");
    const content = token(body?.content);
    const format = token(body?.format, "reel");
    const snapshotDays = Number(body?.snapshot_days || 7);
    if (!content || !FORMATS.has(format) || !SNAPSHOT_DAYS.has(snapshotDays)) {
      return Response.json({ error: "invalid_content_metric" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const metric = {
      campaign,
      content,
      format,
      hook: text(body?.hook),
      cta_variant: text(body?.cta_variant, 120),
      ...(optionalTimestamp(body?.published_at)
        ? { published_at: optionalTimestamp(body?.published_at) }
        : {}),
      snapshot_days: snapshotDays,
      snapshot_captured_at: optionalTimestamp(body?.snapshot_captured_at) || now,
      reach: wholeNumber(body?.reach),
      views: wholeNumber(body?.views),
      shares: wholeNumber(body?.shares),
      saves: wholeNumber(body?.saves),
      comments: wholeNumber(body?.comments),
      follows: wholeNumber(body?.follows),
      profile_visits: wholeNumber(body?.profile_visits),
      link_clicks: wholeNumber(body?.link_clicks),
      dm_intents: wholeNumber(body?.dm_intents),
    };

    const entity = base44.asServiceRole.entities.GrowthContentMetric;
    const existing = asArray(
      await entity.filter({ campaign, content }, "-updated_date", 10).catch(() => []),
    )[0];
    const saved = existing?.id
      ? await entity.update(existing.id, metric)
      : await entity.create(metric);

    return Response.json({
      success: true,
      created: !existing?.id,
      metric: saved || { ...metric, id: existing?.id },
    });
  } catch (error: any) {
    console.error("[upsertGrowthContentMetric]", error?.message || error);
    return Response.json({ error: "content_metric_unavailable" }, { status: 503 });
  }
});
