import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";

const TOKEN_MAX = 120;
const PATH_MAX = 300;
const HOST_MAX = 160;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const ATTRIBUTION_WRITE_ATTEMPTS = 4;

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
  const reportedContentId = token(raw.reported_content_id);
  const expectedPrefix = source === "instagram"
    ? "ig-"
    : source === "tiktok"
    ? "tt-"
    : "";
  const rawContent = content || "unassigned";
  const rawContentIsGeneric = !rawContent
    || rawContent === "unassigned"
    || rawContent === (source === "instagram" ? "ig-bio" : "tt-bio");
  const reportedContentValid = Boolean(
    expectedPrefix
    && rawContentIsGeneric
    && reportedContentId.startsWith(expectedPrefix)
    && reportedContentId !== `${expectedPrefix}bio`
    && token(raw.reported_content_method) === "visitor_self_report",
  );
  return {
    source: source || "unknown",
    medium: token(raw.medium, "unknown"),
    campaign: campaign || "unassigned",
    content: rawContent,
    term: token(raw.term),
    ...(reportedContentValid
      ? {
        reported_content_id: reportedContentId,
        reported_content_method: "visitor_self_report",
        reported_content_at: timestamp(raw.reported_content_at),
      }
      : {}),
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

function touchTime(value: any): number {
  const parsed = new Date(value?.captured_at || "");
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

function latestTouch(current: any, incoming: any): any {
  if (!current) return incoming;
  if (!incoming) return current;
  return touchTime(incoming) > touchTime(current) ? incoming : current;
}

async function persistAttribution(
  userEntity: any,
  authenticated: any,
  firstTouch: any,
  lastTouch: any,
): Promise<any | null> {
  for (let attempt = 0; attempt < ATTRIBUTION_WRITE_ATTEMPTS; attempt += 1) {
    const current = await userEntity.get(authenticated.id);
    if (
      !current
      || normalized(current.email) !== normalized(authenticated.email)
      || !current.updated_date
    ) {
      return null;
    }
    const persistedFirstTouch = current.acquisition_first_touch
      || firstTouch
      || lastTouch;
    const persistedLastTouch = latestTouch(
      current.acquisition_last_touch,
      lastTouch || firstTouch,
    );
    const firstTouchCreated = !current.acquisition_first_touch;
    const updates: Record<string, any> = {
      acquisition_last_touch: persistedLastTouch,
      acquisition_attribution_updated_at: new Date().toISOString(),
      ...(firstTouchCreated
        ? { acquisition_first_touch: persistedFirstTouch }
        : {}),
    };
    const result = await userEntity.updateMany(
      {
        id: current.id,
        updated_date: current.updated_date,
      },
      { $set: updates },
    );
    if (Number(result?.updated || 0) === 1) {
      return {
        user: { ...current, ...updates },
        firstTouchCreated,
        firstTouch: persistedFirstTouch,
        lastTouch: persistedLastTouch,
      };
    }
  }
  throw Object.assign(
    new Error("attribution_capture_conflict"),
    { code: "attribution_capture_conflict" },
  );
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

    const userEntity = base44.asServiceRole.entities.User;
    const persisted = await persistAttribution(
      userEntity,
      authenticated,
      firstTouch,
      lastTouch,
    );
    if (!persisted) {
      return Response.json({ error: "account_verification_failed" }, { status: 401 });
    }
    const user = persisted.user;

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
        const touch = persisted.firstTouch;
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
          ...(touch?.reported_content_id
            ? {
              reported_content_id: touch.reported_content_id,
              reported_content_method: "visitor_self_report",
              reported_content_at: touch.reported_content_at,
            }
            : {}),
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
      first_touch_created: persisted.firstTouchCreated,
      first_touch: persisted.firstTouch,
      last_touch: persisted.lastTouch,
    });
  } catch (error: any) {
    if (error?.code === "attribution_capture_conflict") {
      return Response.json({ error: error.code }, { status: 409 });
    }
    console.error("[captureAcquisitionAttribution]", error?.message || error);
    return Response.json({ error: "attribution_capture_failed" }, { status: 500 });
  }
});
