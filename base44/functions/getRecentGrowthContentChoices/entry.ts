import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const SOCIAL_PLATFORMS = new Set(["instagram", "tiktok"]);
const PUBLIC_LANDING_PATHS = new Set(["/start", "/instagram"]);
const MAX_REQUEST_BYTES = 4_000;
const MAX_QUERY_ROWS = 40;
const MAX_CHOICES = 4;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

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

function landingPath(value: any): string {
  const raw = String(value || "").trim().slice(0, 300);
  if (!raw.startsWith("/")) return "";
  const path = (raw.length > 1 ? raw.replace(/\/+$/, "") : raw).toLowerCase();
  return PUBLIC_LANDING_PATHS.has(path) ? path : "";
}

function timestamp(value: any): string {
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function allowedOrigin(req: Request): boolean {
  const value = req.headers.get("origin");
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "firstknock.online"
      || host === "www.firstknock.online"
      || host === "localhost"
      || host === "127.0.0.1"
      || host.endsWith(".base44.app")
      || host.endsWith(".base44.com");
  } catch {
    return false;
  }
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function genericContent(source: string, content: string): boolean {
  return !content
    || content === "unassigned"
    || content === (source === "instagram" ? "ig-bio" : "tt-bio");
}

function strongPublishedChoice(
  job: any,
  source: string,
  campaign: string,
  nowMs: number,
): any | null {
  const sentAt = timestamp(job?.provider_sent_at);
  const metricsPublishedAt = timestamp(job?.metrics_published_at);
  const sentMs = new Date(sentAt || 0).getTime();
  const content = token(job?.platform_content_id);
  const expectedPrefix = source === "instagram" ? "ig-" : "tt-";
  if (
    job?.provider !== "buffer"
    || token(job?.platform) !== source
    || token(job?.provider_service) !== source
    || token(job?.campaign) !== campaign
    || token(job?.state) !== "sent"
    || token(job?.provider_status) !== "sent"
    || !String(job?.provider_channel_id || "").trim()
    || !String(job?.provider_post_id || "").trim()
    || !/^[a-f0-9]{64}$/.test(normalized(job?.job_key))
    || !/^[a-f0-9]{64}$/.test(normalized(job?.request_hash))
    || !/^[a-f0-9]{64}$/.test(normalized(job?.config_revision))
    || !sentAt
    || metricsPublishedAt !== sentAt
    || !Number.isFinite(sentMs)
    || sentMs > nowMs + FUTURE_SKEW_MS
    || sentMs < nowMs - LOOKBACK_MS
    || !content.startsWith(expectedPrefix)
    || genericContent(source, content)
  ) {
    return null;
  }
  return {
    content,
    hook: String(job?.hook_snapshot || "FirstKnock product demo")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 160),
    published_at: sentAt,
    provider_post_id: String(job.provider_post_id),
  };
}

function responseJson(value: any, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return responseJson({ error: "method_not_allowed" }, 405);
    }
    if (!allowedOrigin(req)) {
      return responseJson({ error: "origin_not_allowed" }, 403);
    }
    const declaredSize = Number(req.headers.get("content-length") || 0);
    if (declaredSize > MAX_REQUEST_BYTES) {
      return responseJson({ error: "payload_too_large" }, 413);
    }
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return responseJson({ error: "payload_too_large" }, 413);
    }
    const body = (() => {
      try {
        return JSON.parse(rawBody);
      } catch {
        return null;
      }
    })();
    const source = token(body?.source);
    const campaign = token(body?.campaign, "unassigned");
    const content = token(body?.content, "unassigned");
    const path = landingPath(body?.landing_path);
    if (
      !body
      || !SOCIAL_PLATFORMS.has(source)
      || campaign !== "1000-users"
      || !genericContent(source, content)
      || !path
    ) {
      return responseJson({ error: "invalid_content_choice_request" }, 400);
    }

    const base44 = createClientFromRequest(req);
    const rows = asArray(await base44.asServiceRole.entities.GrowthPublishJob.filter(
      { platform: source },
      "-provider_sent_at",
      MAX_QUERY_ROWS,
    ));
    const nowMs = Date.now();
    const candidates = rows
      .map((job) => strongPublishedChoice(job, source, campaign, nowMs))
      .filter(Boolean);
    const contentCounts = new Map<string, number>();
    const providerCounts = new Map<string, number>();
    for (const candidate of candidates) {
      contentCounts.set(
        candidate.content,
        (contentCounts.get(candidate.content) || 0) + 1,
      );
      providerCounts.set(
        candidate.provider_post_id,
        (providerCounts.get(candidate.provider_post_id) || 0) + 1,
      );
    }
    const choices = candidates
      .filter((candidate) => (
        contentCounts.get(candidate.content) === 1
        && providerCounts.get(candidate.provider_post_id) === 1
      ))
      .sort((left, right) => right.published_at.localeCompare(left.published_at))
      .slice(0, MAX_CHOICES)
      .map(({ provider_post_id: _providerPostId, ...choice }) => choice);

    return responseJson({
      success: true,
      source,
      campaign,
      attribution: "visitor_self_report",
      choices,
    });
  } catch (error: any) {
    console.error("[getRecentGrowthContentChoices]", error?.message || error);
    return responseJson({ error: "content_choices_unavailable" }, 503);
  }
});
