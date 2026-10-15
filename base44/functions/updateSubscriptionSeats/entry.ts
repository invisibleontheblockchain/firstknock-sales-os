// base44/functions/updateSubscriptionSeats/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.6";
import Stripe from "npm:stripe@14.14.0";

// base44/shared/knockBillingAccess.js
var PRECISION_CREDIT_COMPONENT = "precision_extra_credits";
function stripeResourceId(resource) {
  if (!resource) return null;
  return typeof resource === "string" ? resource : resource.id || null;
}
function periodPair(source) {
  const start = Number(source?.current_period_start);
  const end = Number(source?.current_period_end);
  return Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > start ? { start, end } : null;
}
function subscriptionPeriod(subscription, nowSeconds = Date.now() / 1e3) {
  const legacy = periodPair(subscription);
  if (legacy) return legacy;
  const periods = (subscription?.items?.data || []).filter((item) => item?.price?.metadata?.billing_component !== PRECISION_CREDIT_COMPONENT).map(periodPair).filter(Boolean);
  return periods.find((period) => period.start <= nowSeconds && nowSeconds < period.end) || periods[0] || null;
}
async function loadOwnedKnockSubscriptions(stripe, billingUser) {
  const userId = String(billingUser?.id || "");
  if (!userId) throw new Error("A billing account is required to verify subscriptions.");
  const candidates = /* @__PURE__ */ new Map();
  const rememberOwned = (subscription) => {
    if (subscription?.id && !candidates.has(subscription.id) && String(subscription?.metadata?.base44_user_id || "") === userId) {
      candidates.set(subscription.id, subscription);
    }
  };
  let lookupError = null;
  if (billingUser?.subscription_id) {
    try {
      rememberOwned(await stripe.subscriptions.retrieve(String(billingUser.subscription_id), {
        expand: ["latest_invoice"]
      }));
    } catch (error) {
      lookupError = error;
    }
  }
  let searchComplete = false;
  if (typeof stripe?.subscriptions?.search === "function") {
    const escapedUserId = userId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const seenPages = /* @__PURE__ */ new Set();
    let page;
    try {
      for (let pageCount = 0; pageCount < 10; pageCount += 1) {
        const result = await stripe.subscriptions.search({
          query: `metadata['base44_user_id']:'${escapedUserId}'`,
          limit: 100,
          expand: ["data.latest_invoice"],
          ...page ? { page } : {}
        });
        if (!Array.isArray(result?.data)) throw new Error("Stripe subscription search returned an invalid response.");
        for (const subscription of result.data) rememberOwned(subscription);
        if (result.has_more !== true) {
          searchComplete = true;
          break;
        }
        const nextPage = result.next_page;
        if (typeof nextPage !== "string" || !nextPage || seenPages.has(nextPage)) {
          throw new Error("Stripe subscription search could not finish pagination.");
        }
        seenPages.add(nextPage);
        page = nextPage;
      }
      if (!searchComplete) lookupError = new Error("Stripe subscription search exceeded its verification limit.");
    } catch (error) {
      lookupError = error;
    }
  }
  if (candidates.size || searchComplete) return [...candidates.values()];
  throw lookupError || new Error("Stripe subscription discovery is unavailable.");
}

// base44/functions/updateSubscriptionSeats/entry.ts
var FIRSTKNOCK_ORIGIN = "https://firstknock.online";
var normalized = (value) => String(value || "").trim().toLowerCase();
var asArray = (value) => Array.isArray(value) ? value : value?.items || [];
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function firstKnockReturnUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (["https://firstknock.online", "https://www.firstknock.online"].includes(url.origin)) {
      return `${FIRSTKNOCK_ORIGIN}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
  }
  return `${FIRSTKNOCK_ORIGIN}/AdminTeam`;
}
async function resolveVerifiedActiveSubscription(stripe, user) {
  let subscriptions;
  try {
    subscriptions = await loadOwnedKnockSubscriptions(stripe, user);
  } catch {
    throw httpError(503, "billing_verification_unavailable", "The company subscription could not be verified. Retry in a moment.");
  }
  const candidates = subscriptions.filter((subscription2) => subscription2.status === "active");
  if (candidates.length > 1) {
    throw httpError(409, "billing_identity_ambiguous", "Multiple active subscriptions are linked to this account. Contact support before changing seats.");
  }
  if (!candidates[0]) return null;
  let subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(candidates[0].id, { expand: ["latest_invoice"] });
  } catch {
    throw httpError(503, "billing_verification_unavailable", "The company subscription could not be verified. Retry in a moment.");
  }
  return subscription?.status === "active" && String(subscription?.metadata?.base44_user_id || "") === String(user.id) ? subscription : null;
}
function selectBaseSeatItem(subscription, user) {
  const candidates = (subscription.items?.data || []).filter((item) => {
    const price = item?.price || item?.plan;
    return item?.id && stripeResourceId(price) && price?.metadata?.billing_component !== "precision_extra_credits" && (price?.recurring || price?.type === "recurring" || price?.interval) && (price?.recurring?.usage_type || price?.usage_type) !== "metered" && Number.isSafeInteger(item.quantity) && item.quantity > 0;
  });
  if (candidates.length === 1) return candidates[0];
  const tier = normalized(subscription.metadata?.subscription_tier);
  const matchingTier = candidates.filter((item) => tier && normalized(item.price?.metadata?.subscription_tier) === tier);
  if (matchingTier.length === 1) return matchingTier[0];
  const matchingPlan = candidates.filter((item) => stripeResourceId(item.price || item.plan) === user.subscription_plan_id);
  if (matchingPlan.length === 1) return matchingPlan[0];
  throw httpError(409, "seat_plan_ambiguous", "The company seat plan could not be selected safely. Contact support before changing seats.");
}
async function syncOwnerInviteCodes(base44, userId, totalSeats) {
  const entity = base44.asServiceRole.entities.InviteCode;
  const codes = [];
  for (let skip = 0; ; skip += 100) {
    const page = asArray(await entity.filter({ linked_user_id: userId }, "created_date", 100, skip));
    codes.push(...page.filter((code) => normalized(code.role || "rep") === "rep" && code.is_active !== false));
    if (page.length < 100) break;
  }
  if (codes.length) {
    for (const code of codes) await entity.update(code.id, { max_uses: totalSeats, is_active: true });
  } else {
    await entity.create({
      code: Math.floor(1e5 + Math.random() * 9e5).toString(),
      role: "rep",
      label: "Team Invite Code",
      max_uses: totalSeats,
      linked_user_id: userId,
      is_active: true
    });
  }
}
async function seatUpdateIdempotencyKey(subscription, item, quantity) {
  const period = subscriptionPeriod(subscription);
  const state = JSON.stringify({
    subscription: subscription.id,
    item: item.id,
    price: stripeResourceId(item.price || item.plan),
    current: item.quantity,
    requested: quantity,
    period,
    invoice: stripeResourceId(subscription.latest_invoice),
    invoice_status: subscription.latest_invoice?.status || null
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `firstknock-seats-v2:${hash}`;
}
async function billingResponse(stripe, subscription, item, requestedQuantity, returnUrl, options = {}) {
  let invoice = subscription.latest_invoice;
  if (typeof invoice === "string") invoice = await stripe.invoices.retrieve(invoice);
  if (invoice?.id && invoice.status === "draft") {
    invoice = await stripe.invoices.finalizeInvoice(invoice.id, {}, {
      idempotencyKey: `firstknock-seat-invoice-finalize:${subscription.id}:${invoice.id}`
    });
  }
  let url = invoice?.hosted_invoice_url || null;
  if (!url) {
    const customer = stripeResourceId(subscription.customer);
    const portal = await stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
    url = portal.url;
  }
  const pending = subscription.pending_update && typeof subscription.pending_update === "object";
  const committedItem = subscription.items?.data?.find((candidate) => candidate.id === item.id) || item;
  const pendingItem = pending && subscription.pending_update.subscription_items?.find((candidate) => candidate.id === item.id);
  return Response.json({
    success: true,
    status: subscription.status,
    new_quantity: pending && Number.isSafeInteger(pendingItem?.quantity) ? pendingItem.quantity : options.reused ? committedItem.quantity : requestedQuantity,
    requested_quantity: requestedQuantity,
    current_quantity: committedItem.quantity,
    pending_update: !!pending,
    reused: options.reused === true,
    requires_payment: !!invoice && invoice.status !== "paid",
    invoice_status: invoice?.status || null,
    invoice_id: invoice?.id || null,
    invoice_url: url,
    url
  });
}
Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      } });
    }
    if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.me();
    if (!authenticated?.id) throw httpError(401, "authentication_required", "Authentication required.");
    const user = await base44.asServiceRole.entities.User.get(authenticated.id);
    if (!user || String(user.id) !== String(authenticated.id) || normalized(user.email) !== normalized(authenticated.email)) {
      throw httpError(401, "invalid_authenticated_user", "The authenticated account could not be verified.");
    }
    const { quantity, returnUrl } = await req.json();
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
      throw httpError(400, "invalid_seat_quantity", "Quantity must be a whole number from 1 to 100.");
    }
    if (user.is_owner === true || user.data?.is_owner === true) {
      await base44.asServiceRole.entities.User.update(user.id, { total_seats: quantity });
      await syncOwnerInviteCodes(base44, user.id, quantity);
      return Response.json({ success: true, status: "owner_exempt", new_quantity: quantity });
    }
    const secret = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secret) throw httpError(503, "billing_verification_unavailable", "Billing is temporarily unavailable. Retry in a moment.");
    const stripe = new Stripe(secret, { apiVersion: "2023-10-16" });
    const subscription = await resolveVerifiedActiveSubscription(stripe, user);
    if (!subscription || !stripeResourceId(subscription.customer)) {
      throw httpError(404, "subscription_not_found", "No verified active company subscription was found.");
    }
    const item = selectBaseSeatItem(subscription, user);
    const safeReturnUrl = firstKnockReturnUrl(returnUrl);
    if (subscription.pending_update || item.quantity === quantity) {
      return await billingResponse(stripe, subscription, item, quantity, safeReturnUrl, { reused: true });
    }
    const key = await seatUpdateIdempotencyKey(subscription, item, quantity);
    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id, quantity }],
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice"]
    }, { idempotencyKey: key });
    return await billingResponse(stripe, updated, item, quantity, safeReturnUrl);
  } catch (error) {
    console.error("Update seats error:", error?.message || error);
    return Response.json({ error: error.message, ...error.code ? { code: error.code } : {} }, { status: error.status || 500 });
  }
});
