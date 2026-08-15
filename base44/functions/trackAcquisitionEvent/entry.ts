import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const PUBLIC_EVENTS = new Set([
  "landing_viewed",
  "signup_cta_clicked",
  "content_assist_reported",
]);
const PUBLIC_LANDING_PATHS = new Set(["/start", "/instagram"]);
const TOKEN_MAX = 120;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PAST_LIMIT_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 12_000;

function normalized(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function token(value: any, fallback = ""): string {
  return normalized(value)
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, TOKEN_MAX) || fallback;
}

function identifier(value: any): string {
  const clean = normalized(value).replace(/[^a-z0-9_-]/g, "").slice(0, 80);
  return /^[a-z0-9_-]{8,80}$/.test(clean) ? clean : "";
}

function timestamp(value: any): string | null {
  const parsed = new Date(value || "");
  const now = Date.now();
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getTime() > now + FUTURE_SKEW_MS
    || parsed.getTime() < now - PAST_LIMIT_MS
  ) {
    return null;
  }
  return parsed.toISOString();
}

function landingPath(value: any): string {
  const raw = String(value || "").trim().slice(0, 300);
  if (!raw.startsWith("/")) return "";
  const path = (raw.length > 1 ? raw.replace(/\/+$/, "") : raw).toLowerCase();
  return PUBLIC_LANDING_PATHS.has(path) ? path : "";
}

function sanitizeTouch(raw: any): any {
  const touch = raw && typeof raw === "object" ? raw : {};
  const source = token(touch.source, "direct");
  const content = token(touch.content, "unassigned");
  const reportedContentId = token(touch.reported_content_id);
  const expectedPrefix = source === "instagram"
    ? "ig-"
    : source === "tiktok"
    ? "tt-"
    : "";
  const rawContentIsGeneric = !content
    || content === "unassigned"
    || content === (source === "instagram" ? "ig-bio" : "tt-bio");
  const reportedContentValid = Boolean(
    expectedPrefix
    && rawContentIsGeneric
    && reportedContentId.startsWith(expectedPrefix)
    && reportedContentId !== `${expectedPrefix}bio`
    && token(touch.reported_content_method) === "visitor_self_report",
  );
  const reportedAt = reportedContentValid
    ? timestamp(touch.reported_content_at)
    : null;
  return {
    source,
    medium: token(touch.medium, "none"),
    campaign: token(touch.campaign, "unassigned"),
    content,
    term: token(touch.term),
    referrer_host: token(touch.referrer_host).slice(0, 160),
    ...(reportedContentValid && reportedAt
      ? {
        reported_content_id: reportedContentId,
        reported_content_method: "visitor_self_report",
        reported_content_at: reportedAt,
      }
      : {}),
  };
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

async function hashedIdentifier(kind: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${kind}_${hex.slice(0, 48)}`;
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
    if (!allowedOrigin(req)) {
      return Response.json({ error: "origin_not_allowed" }, { status: 403 });
    }

    const declaredSize = Number(req.headers.get("content-length") || 0);
    if (declaredSize > MAX_REQUEST_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    const body = (() => {
      try {
        return JSON.parse(rawBody);
      } catch {
        return null;
      }
    })();
    const eventName = token(body?.event_name);
    const eventId = identifier(body?.event_id);
    const anonymousId = identifier(body?.anonymous_id);
    const sessionId = identifier(body?.session_id);
    const occurredAt = timestamp(body?.occurred_at);
    const path = landingPath(body?.landing_path);

    if (
      !body
      || !PUBLIC_EVENTS.has(eventName)
      || !eventId
      || !anonymousId
      || !sessionId
      || !occurredAt
      || !path
    ) {
      return Response.json({ error: "invalid_acquisition_event" }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);
    const entity = base44.asServiceRole.entities.AcquisitionEvent;
    const storedAnonymousId = await hashedIdentifier("anon", anonymousId);
    const storedSessionId = await hashedIdentifier("session", sessionId);
    const duplicateById = asArray(
      await entity.filter({ event_id: eventId }, "-created_date", 1).catch(() => []),
    );
    if (duplicateById.length) {
      return Response.json({ success: true, deduplicated: true });
    }

    const touch = sanitizeTouch(body?.touch);
    if (
      eventName === "content_assist_reported"
      && !touch.reported_content_id
    ) {
      return Response.json({ error: "invalid_content_assist" }, { status: 400 });
    }
    // Each stage is counted once per browser session and tracked content touch.
    // This prevents rerenders/retries from inflating a content row without
    // discarding a legitimate visit to a second post during the same session.
    const duplicateStage = asArray(
      await entity.filter({
        session_id: storedSessionId,
        event_name: eventName,
        source: touch.source,
        medium: touch.medium,
        campaign: touch.campaign,
        content: touch.content,
      }, "-created_date", 1).catch(() => []),
    );
    if (duplicateStage.length) {
      return Response.json({ success: true, deduplicated: true });
    }

    const created = await entity.create({
      event_id: eventId,
      event_name: eventName,
      anonymous_id: storedAnonymousId,
      session_id: storedSessionId,
      occurred_at: occurredAt,
      landing_path: path,
      cta_variant: token(body?.cta_variant).slice(0, 80),
      is_authenticated: false,
      trust_source: "client_diagnostic",
      ...touch,
    });

    return Response.json({
      success: true,
      event_id: created?.event_id || eventId,
    });
  } catch (error: any) {
    console.error("[trackAcquisitionEvent]", error?.message || error);
    return Response.json({ error: "acquisition_event_unavailable" }, { status: 503 });
  }
});
