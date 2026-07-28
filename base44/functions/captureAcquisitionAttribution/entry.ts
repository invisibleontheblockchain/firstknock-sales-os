import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const TOKEN_MAX = 120;
const PATH_MAX = 300;
const HOST_MAX = 160;
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
    .slice(0, TOKEN_MAX) || fallback;
}

function landingPath(value: any): string {
  const path = String(value || "/").trim().slice(0, PATH_MAX);
  return path.startsWith("/") ? path : "/";
}

function timestamp(value: any): string {
  const parsed = new Date(value || "");
  const now = Date.now();
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > now + FUTURE_SKEW_MS) {
    return new Date(now).toISOString();
  }
  return parsed.toISOString();
}

function sanitizeTouch(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  const source = token(raw.source);
  const campaign = token(raw.campaign);
  const content = token(raw.content);
  if (!source && !campaign && !content) return null;
  return {
    source: source || "unknown",
    medium: token(raw.medium, "unknown"),
    campaign: campaign || "unassigned",
    content: content || "unassigned",
    term: token(raw.term),
    landing_path: landingPath(raw.landing_path),
    referrer_host: token(raw.referrer_host).slice(0, HOST_MAX),
    captured_at: timestamp(raw.captured_at),
  };
}

function identifier(value: any, fallback: string): string {
  const clean = normalized(value).replace(/[^a-z0-9_-]/g, "").slice(0, 80);
  const cleanFallback = normalized(fallback).replace(/[^a-z0-9_-]/g, "").slice(0, 80);
  return /^[a-z0-9_-]{8,80}$/.test(clean) ? clean : cleanFallback;
}

async function hashedIdentifier(kind: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${kind}_${hex.slice(0, 48)}`;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }

    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.me();
    if (!authenticated?.id) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const firstTouch = sanitizeTouch(body?.first_touch);
    const lastTouch = sanitizeTouch(body?.last_touch) || firstTouch;
    if (!firstTouch && !lastTouch) {
      return Response.json({ error: "invalid_attribution_touch" }, { status: 400 });
    }

    const user = await base44.asServiceRole.entities.User.get(authenticated.id);
    if (!user || normalized(user.email) !== normalized(authenticated.email)) {
      return Response.json({ error: "account_verification_failed" }, { status: 401 });
    }

    const updates: Record<string, any> = {
      acquisition_last_touch: lastTouch,
      acquisition_attribution_updated_at: new Date().toISOString(),
    };
    const firstTouchCreated = !user.acquisition_first_touch;
    if (firstTouchCreated) {
      updates.acquisition_first_touch = firstTouch || lastTouch;
    }

    await base44.asServiceRole.entities.User.update(user.id, updates);

    // Record auth completion once for this user. Attribution remains the
    // authoritative source; this event supplies a timestamped funnel stage.
    try {
      const events = base44.asServiceRole.entities.AcquisitionEvent;
      const existing = await events.filter({
        event_name: "auth_completed",
        user_id: user.id,
      }, "-created_date", 1);
      const rows = Array.isArray(existing)
        ? existing
        : Array.isArray(existing?.items) ? existing.items : [];
      if (!rows.length) {
        const touch = updates.acquisition_first_touch
          || user.acquisition_first_touch
          || firstTouch
          || lastTouch;
        const anonymousId = identifier(body?.anonymous_id, `authenticated_${user.id}`);
        const sessionId = identifier(body?.session_id, `authenticated_${user.id}`);
        await events.create({
          event_id: identifier(`auth_${user.id}`, `auth_${Date.now()}`),
          event_name: "auth_completed",
          anonymous_id: await hashedIdentifier("anon", anonymousId),
          session_id: await hashedIdentifier("session", sessionId),
          user_id: user.id,
          source: touch?.source || "unknown",
          medium: touch?.medium || "unknown",
          campaign: touch?.campaign || "unassigned",
          content: touch?.content || "unassigned",
          term: touch?.term || "",
          landing_path: touch?.landing_path || "/",
          referrer_host: touch?.referrer_host || "",
          cta_variant: "",
          occurred_at: new Date().toISOString(),
          is_authenticated: true,
          trust_source: "authenticated_bridge",
        });
      }
    } catch (eventError: any) {
      console.warn(
        "[captureAcquisitionAttribution] auth event deferred",
        eventError?.message || eventError,
      );
    }

    return Response.json({
      success: true,
      first_touch_created: firstTouchCreated,
      first_touch: updates.acquisition_first_touch || user.acquisition_first_touch,
      last_touch: lastTouch,
    });
  } catch (error: any) {
    console.error("[captureAcquisitionAttribution]", error?.message || error);
    return Response.json({ error: "attribution_capture_failed" }, { status: 500 });
  }
});
