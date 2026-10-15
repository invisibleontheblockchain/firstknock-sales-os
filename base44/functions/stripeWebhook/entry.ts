// base44/functions/stripeWebhook/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.25";
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
function invoiceSubscriptionId(invoice) {
  if (invoice?.parent?.type === "subscription_details") {
    return stripeResourceId(invoice.parent.subscription_details?.subscription) || stripeResourceId(invoice?.subscription);
  }
  return stripeResourceId(invoice?.subscription);
}
function isBaseSeatItem(item) {
  const price = item?.price || item?.plan;
  return price?.metadata?.billing_component !== PRECISION_CREDIT_COMPONENT && (price?.recurring || price?.type === "recurring" || price?.interval) && (price?.recurring?.usage_type || price?.usage_type) !== "metered" && Number.isSafeInteger(item?.quantity) && item.quantity > 0;
}
function paidKnockSeatCount(subscription) {
  const quantities = (subscription?.items?.data || []).filter(isBaseSeatItem).map((item) => item.quantity);
  return quantities.length ? Math.max(...quantities) : null;
}
function invoiceMatchesSubscription(invoice, subscriptionId, requireOwner = false) {
  const owner = invoiceSubscriptionId(invoice);
  const legacyOwner = stripeResourceId(invoice?.subscription);
  return (!requireOwner || owner === subscriptionId) && (!owner || owner === subscriptionId) && (!legacyOwner || legacyOwner === subscriptionId);
}
function hasPositiveInvoicePayment(invoice) {
  const amountPaid = Number(invoice?.amount_paid || 0);
  return invoice?.status === "paid" && Number.isFinite(amountPaid) && amountPaid > 0;
}
function paidLineCoversCommittedSeats(line, subscription, items2, nowSeconds) {
  const modern = line?.parent?.type === "subscription_item_details" ? line.parent.subscription_item_details : null;
  const modernItemId = stripeResourceId(modern?.subscription_item);
  const legacyItemId = stripeResourceId(line?.subscription_item);
  const itemId = modernItemId || legacyItemId;
  const legacySubscription = stripeResourceId(line?.subscription);
  const modernSubscription = stripeResourceId(modern?.subscription);
  const price = line?.price || line?.pricing?.price_details?.price;
  const amount = Number(line?.amount || 0);
  const start = Number(line?.period?.start);
  const end = Number(line?.period?.end);
  if (!itemId || modernItemId && legacyItemId && modernItemId !== legacyItemId || legacySubscription && legacySubscription !== subscription.id || modernSubscription && modernSubscription !== subscription.id || price?.metadata?.billing_component === PRECISION_CREDIT_COMPONENT || line?.metadata?.billing_component === PRECISION_CREDIT_COMPONENT || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(line?.quantity) || line.quantity < 1 || !Number.isFinite(start) || !Number.isFinite(end) || start > nowSeconds || end <= start) return false;
  return items2.some(({ item, period }) => item.id === itemId && line.quantity >= item.quantity && end >= period.end);
}
async function historicalInvoiceCoversSeats(stripe2, invoice, subscription, items2, nowSeconds) {
  const covers = (line) => paidLineCoversCommittedSeats(line, subscription, items2, nowSeconds);
  const lines = invoice?.lines;
  if ((lines?.data || []).some(covers)) return true;
  if (lines?.has_more !== true) return false;
  if (typeof stripe2?.invoices?.listLineItems !== "function") {
    throw new Error("Stripe invoice line verification is unavailable.");
  }
  let startingAfter = lines.data?.at(-1)?.id;
  const cursors = /* @__PURE__ */ new Set();
  for (let page = 0; page < 10; page += 1) {
    if (!startingAfter || cursors.has(startingAfter)) throw new Error("Stripe invoice lines could not finish pagination.");
    cursors.add(startingAfter);
    const result = await stripe2.invoices.listLineItems(invoice.id, { limit: 100, starting_after: startingAfter });
    if (!Array.isArray(result?.data)) throw new Error("Stripe invoice lines returned an invalid response.");
    if (result.data.some(covers)) return true;
    if (result.has_more !== true) return false;
    startingAfter = result.data.at(-1)?.id;
  }
  throw new Error("Stripe invoice lines exceeded their verification limit.");
}
async function paidCommittedSeatsDuringSeatUpdate(stripe2, subscription, period, nowSeconds) {
  const committedCount = paidKnockSeatCount(subscription);
  const items2 = (subscription.items?.data || []).filter(
    (item) => isBaseSeatItem(item) && item.quantity === committedCount && !!item.id
  ).map((item) => ({ item, period: periodPair(item) || period })).filter((candidate) => candidate.period.start <= nowSeconds && candidate.period.end > nowSeconds);
  if (!items2.length) return false;
  if (typeof stripe2?.invoices?.list !== "function") throw new Error("Stripe paid invoice history is unavailable.");
  let startingAfter;
  const cursors = /* @__PURE__ */ new Set();
  for (let page = 0; page < 10; page += 1) {
    const result = await stripe2.invoices.list({
      subscription: subscription.id,
      status: "paid",
      limit: 100,
      ...startingAfter ? { starting_after: startingAfter } : {}
    });
    if (!Array.isArray(result?.data)) throw new Error("Stripe invoice history returned an invalid response.");
    for (const invoice of result.data) {
      if (hasPositiveInvoicePayment(invoice) && invoiceMatchesSubscription(invoice, subscription.id, true) && await historicalInvoiceCoversSeats(stripe2, invoice, subscription, items2, nowSeconds)) return true;
    }
    if (result.has_more !== true) return false;
    startingAfter = result.data.at(-1)?.id;
    if (!startingAfter || cursors.has(startingAfter)) throw new Error("Stripe invoice history could not finish pagination.");
    cursors.add(startingAfter);
  }
  throw new Error("Stripe invoice history exceeded its verification limit.");
}
async function findCurrentPaidKnockSubscription(stripe2, billingUser, subscriptions, nowSeconds = Date.now() / 1e3) {
  const userId = String(billingUser?.id || "");
  for (const subscription of subscriptions || []) {
    if (!userId || !subscription?.id || String(subscription?.metadata?.base44_user_id || "") !== userId || subscription?.status !== "active") continue;
    const trialEnd = Number(subscription?.trial_end || 0);
    if (!Number.isFinite(trialEnd) || trialEnd > nowSeconds) continue;
    const period = subscriptionPeriod(subscription, nowSeconds);
    if (!period || period.start > nowSeconds || period.end <= nowSeconds) continue;
    const invoice = typeof subscription.latest_invoice === "string" ? await stripe2.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
    if (hasPositiveInvoicePayment(invoice) && invoiceMatchesSubscription(invoice, subscription.id)) {
      return { paid: true, subscription, period };
    }
    const pendingSeatUpdate = subscription.pending_update && typeof subscription.pending_update === "object" && !Array.isArray(subscription.pending_update) && ["open", "draft"].includes(invoice?.status);
    const voidedSeatUpdate = invoice?.status === "void" && invoice?.billing_reason === "subscription_update";
    if ((pendingSeatUpdate || voidedSeatUpdate) && invoiceMatchesSubscription(invoice, subscription.id) && await paidCommittedSeatsDuringSeatUpdate(stripe2, subscription, period, nowSeconds)) {
      return { paid: true, subscription, period };
    }
  }
  return { paid: false, subscription: null, period: null };
}

// base44/shared/referralLedger.js
function items(result) {
  return Array.isArray(result) ? result : result?.items || [];
}
async function recordReferralInvoice(base44, user, subscription, invoice) {
  const invoiceId = String(invoice?.id || "");
  const revenueCents = Number(invoice?.amount_paid || 0);
  if (!user?.id || !invoiceId || !Number.isInteger(revenueCents) || revenueCents <= 0) return null;
  const existing = items(await base44.asServiceRole.entities.ReferralCommission.filter(
    { stripe_invoice_id: invoiceId },
    "-created_date",
    1
  ));
  if (existing[0]) return existing[0];
  let referrals = items(await base44.asServiceRole.entities.Referral.filter(
    { referred_user_id: user.id },
    "-created_date",
    1
  ));
  if (!referrals[0] && user.email) {
    referrals = items(await base44.asServiceRole.entities.Referral.filter(
      { referred_email: String(user.email).trim().toLowerCase() },
      "-created_date",
      1
    ));
  }
  const referral = referrals[0];
  if (!referral?.referrer_user_id) return null;
  const paidSeconds = Number(invoice?.status_transitions?.paid_at || invoice?.created || 0);
  const paidAt = paidSeconds > 0 ? new Date(paidSeconds * 1e3) : /* @__PURE__ */ new Date();
  return await base44.asServiceRole.entities.ReferralCommission.create({
    referrer_user_id: referral.referrer_user_id,
    referrer_email: String(referral.referrer_email || "").trim().toLowerCase(),
    referred_user_id: user.id,
    referred_email: String(user.email || referral.referred_email || "").trim().toLowerCase(),
    referral_id: referral.id,
    referral_code: referral.referral_code,
    stripe_invoice_id: invoiceId,
    stripe_subscription_id: subscription?.id || null,
    revenue_cents: revenueCents,
    currency: String(invoice?.currency || "usd").toLowerCase(),
    paid_at: paidAt.toISOString(),
    commission_month: paidAt.toISOString().slice(0, 7),
    payout_status: "unpaid"
  });
}

// base44/shared/precisionCredits.js
var CREDIT_BLOCK_PROPERTIES = 1e3;
var CREDIT_BLOCK_PRICE_CENTS = 4900;
var MAX_EXTRA_CREDIT_BLOCKS = 49;
var PRECISION_CREDIT_COMPONENT2 = "precision_extra_credits";
var PRECISION_CREDIT_PACK_INTENT = "precision_credit_pack";
var MIN_CREDIT_PACK_BLOCKS = 1;
function normalizeCreditPackBlocks(value) {
  const blocks = Number(value ?? 0);
  if (!Number.isInteger(blocks) || blocks < MIN_CREDIT_PACK_BLOCKS || blocks > MAX_EXTRA_CREDIT_BLOCKS) return null;
  return blocks;
}
function isPrecisionCreditPrice(price) {
  return String(price?.metadata?.billing_component || "") === PRECISION_CREDIT_COMPONENT2;
}
function isPaidPrecisionCreditInvoice(invoice) {
  return invoice?.status === "paid" && Number(invoice?.amount_paid || 0) > 0 && (invoice?.lines?.data || []).some(
    (line) => Number(line?.amount || 0) > 0 && isPrecisionCreditPrice(line?.price)
  );
}

// base44/functions/stripeWebhook/entry.ts
var stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "");
var endpointSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
var PRECISION_PRICE_CENTS = 9900;
var CANVAS_PRICE_CENTS = 1900;
var BLOCKING_SUBSCRIPTION_STATUSES = /* @__PURE__ */ new Set(["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]);
function normalizeSubscriptionTier(value) {
  return String(value || "").trim().toLowerCase();
}
function subscriptionBaseItem(subscription) {
  const quantity = paidKnockSeatCount(subscription);
  const candidates = (subscription?.items?.data || []).filter(
    (item) => paidKnockSeatCount({ items: { data: [item] } }) !== null
  );
  const tier = normalizeSubscriptionTier(subscription?.metadata?.subscription_tier);
  return candidates.find((item) => tier && normalizeSubscriptionTier(item.price?.metadata?.subscription_tier) === tier) || candidates.find((item) => item.quantity === quantity) || null;
}
function inferTierFromSubscription(subscription, fallback = "custom") {
  const price = subscriptionBaseItem(subscription)?.price;
  const priceMetadataTier = normalizeSubscriptionTier(price?.metadata?.subscription_tier);
  if (priceMetadataTier === "precision" || priceMetadataTier === "canvas") return priceMetadataTier;
  const metadataTier = normalizeSubscriptionTier(subscription?.metadata?.subscription_tier);
  if (metadataTier && metadataTier !== "custom") return metadataTier;
  const amountCents = Number(price?.unit_amount || price?.unit_amount_decimal || 0);
  if (amountCents >= PRECISION_PRICE_CENTS) return "precision";
  if (amountCents >= CANVAS_PRICE_CENTS) return "canvas";
  return normalizeSubscriptionTier(fallback) || metadataTier || "custom";
}
function invoiceHasPositivePayment(invoice) {
  return invoice?.status === "paid" && Number(invoice?.amount_paid || 0) > 0;
}
function invoiceCoversCurrentPeriod(subscription, invoice) {
  const currentStart = subscriptionPeriod(subscription)?.start;
  if (!Number.isFinite(currentStart) || currentStart <= 0) return false;
  if ((invoice?.lines?.data || []).some((line) => {
    const legacyOwner = stripeResourceId2(line?.subscription);
    const modernOwner = line?.parent?.type === "subscription_item_details" ? stripeResourceId2(line.parent.subscription_item_details?.subscription) : null;
    const start2 = Number(line?.period?.start);
    const end2 = Number(line?.period?.end);
    return (!legacyOwner || legacyOwner === subscription.id) && (!modernOwner || modernOwner === subscription.id) && Number.isFinite(start2) && Number.isFinite(end2) && start2 <= currentStart && currentStart < end2;
  })) return true;
  const start = Number(invoice?.period_start);
  const end = Number(invoice?.period_end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= currentStart && currentStart < end;
}
function subscriptionHasPaidInvoice(subscription, invoice) {
  const trialEnded = !subscription?.trial_end || subscription.trial_end * 1e3 <= Date.now();
  const owner = invoiceSubscriptionId(invoice);
  const legacyOwner = stripeResourceId2(invoice?.subscription);
  return subscription?.status === "active" && trialEnded && invoiceHasPositivePayment(invoice) && (!owner || owner === subscription.id) && (!legacyOwner || legacyOwner === subscription.id) && (invoiceCoversCurrentPeriod(subscription, invoice) || isPaidPrecisionCreditInvoice(invoice));
}
async function paidSubscriptionConfirmed(subscription, invoice) {
  if (subscriptionHasPaidInvoice(subscription, invoice)) return true;
  if (!subscription?.pending_update && !(invoice?.status === "void" && invoice?.billing_reason === "subscription_update")) return false;
  const evidence = await findCurrentPaidKnockSubscription(
    stripe,
    { id: subscription.metadata?.base44_user_id },
    [{ ...subscription, latest_invoice: invoice }]
  );
  return evidence.paid;
}
function isBlockingSubscription(subscription) {
  return BLOCKING_SUBSCRIPTION_STATUSES.has(String(subscription?.status || "").toLowerCase());
}
async function getCurrentUser(base44, userId) {
  return await base44.asServiceRole.entities.User.get(userId);
}
async function isCurrentSubscription(base44, userId, subscriptionId) {
  const currentUser = await getCurrentUser(base44, userId);
  return !currentUser?.subscription_id || currentUser.subscription_id === subscriptionId;
}
async function canReplaceCurrentSubscription(base44, userId, incomingSubscriptionId) {
  const currentUser = await getCurrentUser(base44, userId);
  if (!currentUser?.subscription_id || currentUser.subscription_id === incomingSubscriptionId) return true;
  try {
    const currentSubscription = await stripe.subscriptions.retrieve(currentUser.subscription_id);
    return !isBlockingSubscription(currentSubscription);
  } catch (error) {
    if (error?.raw?.code === "resource_missing") return true;
    throw error;
  }
}
function stripeTimestampIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1e3).toISOString();
}
function isPrecisionBillingTier(tier) {
  return ["precision", "pro", "growth", "enterprise"].includes(normalizeSubscriptionTier(tier));
}
async function buildSubscriptionPeriodUpdates(_base44, _userId, subscription, tier, paidConfirmed) {
  const period = subscriptionPeriod(subscription);
  const periodStart = stripeTimestampIso(period?.start);
  const periodEnd = stripeTimestampIso(period?.end);
  if (!paidConfirmed || !periodStart || !periodEnd) return {};
  return {
    subscription_period_start: periodStart,
    subscription_period_end: periodEnd,
    ...isPrecisionBillingTier(tier) ? {
      precision_usage_period_start: periodStart,
      precision_usage_period_end: periodEnd
    } : {}
  };
}
function stripeResourceId2(resource) {
  if (!resource) return null;
  return typeof resource === "string" ? resource : resource.id || null;
}
async function attachedCardUpdates(userId, customerResource) {
  const customerId = stripeResourceId2(customerResource);
  if (!customerId || typeof stripe.customers?.retrieve !== "function" || typeof stripe.paymentMethods?.list !== "function") {
    return {
      stripe_card_on_file_confirmed: false,
      stripe_card_confirmed_at: null
    };
  }
  const customer = await stripe.customers.retrieve(customerId);
  if (customer?.deleted || String(customer?.metadata?.base44_user_id || "") !== String(userId)) {
    throw Object.assign(new Error(`Stripe customer ${customerId} ownership metadata does not match user ${userId}`), {
      code: "billing_identity_mismatch"
    });
  }
  const methods = await stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 1
  });
  const hasCard = (methods.data || []).length > 0;
  return {
    stripe_customer_id: customerId,
    stripe_card_on_file_confirmed: hasCard,
    ...hasCard ? { stripe_card_confirmed_at: (/* @__PURE__ */ new Date()).toISOString() } : { stripe_card_confirmed_at: null }
  };
}
async function optionalAttachedCardUpdates(userId, customerResource) {
  try {
    return await attachedCardUpdates(userId, customerResource);
  } catch (error) {
    if (error?.code === "billing_identity_mismatch") throw error;
    console.warn(`Attached-card cache refresh failed for ${userId}; applying the verified subscription without changing its card cache.`);
    return {};
  }
}
async function refreshAttachedCard(base44, userId, customerResource) {
  const updates = await attachedCardUpdates(userId, customerResource);
  await base44.asServiceRole.entities.User.update(userId, updates);
  return updates;
}
async function recordPrecisionCreditInvoice(base44, userId, subscription, invoice) {
  if (!invoiceHasPositivePayment(invoice) || subscription?.status !== "active") return 0;
  let recorded = 0;
  for (const line of invoice?.lines?.data || []) {
    if (String(line?.price?.metadata?.billing_component || "") !== PRECISION_CREDIT_COMPONENT2) continue;
    const amountCents = Math.max(0, Math.floor(Number(line?.amount || 0)));
    const credits = Math.floor(amountCents * CREDIT_BLOCK_PROPERTIES / CREDIT_BLOCK_PRICE_CENTS);
    if (!line?.id || credits <= 0) continue;
    const existing = await base44.asServiceRole.entities.PrecisionCreditLedger.filter({
      invoice_id: invoice.id,
      stripe_line_id: line.id
    }, "created_date", 1);
    const matches = Array.isArray(existing) ? existing : existing?.items || [];
    if (matches.length > 0) continue;
    await base44.asServiceRole.entities.PrecisionCreditLedger.create({
      owner_user_id: userId,
      subscription_id: subscription.id,
      invoice_id: invoice.id,
      stripe_line_id: line.id,
      credits_delta: credits,
      amount_paid_cents: amountCents,
      purchase_kind: "subscription_addon",
      ...stripeTimestampIso(line?.period?.start) ? { billing_period_start: stripeTimestampIso(line.period.start) } : {},
      ...stripeTimestampIso(line?.period?.end) ? { billing_period_end: stripeTimestampIso(line.period.end) } : {}
    });
    recorded += credits;
  }
  return recorded;
}
async function recordPrecisionCreditPack(base44, userId, session) {
  if (session?.payment_status !== "paid") {
    console.warn(`Credit pack session ${session?.id} is not paid; granting nothing`);
    return 0;
  }
  const blocks = normalizeCreditPackBlocks(Number(session?.metadata?.precision_credit_blocks || 0));
  if (blocks === null) {
    throw new Error(`Credit pack session ${session.id} carries an unusable block count`);
  }
  const amountCents = Math.max(0, Math.floor(Number(session?.amount_total || 0)));
  if (amountCents <= 0) {
    throw new Error(`Credit pack session ${session.id} settled with no payable amount`);
  }
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || `${session.id}:payment`;
  const existing = await base44.asServiceRole.entities.PrecisionCreditLedger.filter({
    invoice_id: session.id,
    stripe_line_id: paymentIntentId
  }, "created_date", 1);
  const matches = Array.isArray(existing) ? existing : existing?.items || [];
  if (matches.length > 0) return 0;
  const credits = blocks * CREDIT_BLOCK_PROPERTIES;
  await base44.asServiceRole.entities.PrecisionCreditLedger.create({
    owner_user_id: userId,
    // The subscription that entitles the account, not the thing that paid --
    // a pack is funded on its own. Recorded so a grant stays traceable to
    // the plan it was bought against.
    subscription_id: String(session?.metadata?.precision_subscription_id || ""),
    invoice_id: session.id,
    stripe_line_id: paymentIntentId,
    credits_delta: credits,
    amount_paid_cents: amountCents,
    purchase_kind: "credit_pack"
  });
  return credits;
}
async function syncInviteCode(base44, userId, totalSeats) {
  try {
    const existingCodes = await base44.asServiceRole.entities.InviteCode.filter({ linked_user_id: userId });
    const items2 = Array.isArray(existingCodes) ? existingCodes : existingCodes?.items || [];
    if (items2.length > 0) {
      await Promise.all(items2.map((code) => base44.asServiceRole.entities.InviteCode.update(code.id, {
        max_uses: totalSeats,
        is_active: true
      })));
      console.log(`Updated ${items2.length} invite code(s) max_uses to ${totalSeats}`);
    } else {
      const randomCode = Math.floor(1e5 + Math.random() * 9e5).toString();
      await base44.asServiceRole.entities.InviteCode.create({
        code: randomCode,
        role: "rep",
        label: "Team Invite Code",
        max_uses: totalSeats,
        linked_user_id: userId,
        is_active: true
      });
      console.log(`Created new invite code ${randomCode} for user ${userId} with ${totalSeats} seats`);
    }
  } catch (e) {
    console.error("Error syncing invite code:", e);
    throw e;
  }
}
Deno.serve(async (req) => {
  try {
    const signature = req.headers.get("stripe-signature");
    if (!signature || !endpointSecret) {
      console.error("Missing signature or secret. endpointSecret present?", !!endpointSecret);
      return Response.json({ error: "Missing signature or secret" }, { status: 400 });
    }
    const body = await req.text();
    let event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature, endpointSecret);
    } catch (err) {
      const secretHint = endpointSecret ? `...${endpointSecret.slice(-4)}` : "MISSING";
      console.error(`Webhook signature verification failed (Using secret ${secretHint}): ${err.message}`);
      return Response.json({
        error: `Webhook Error: ${err.message || "Verification failed"}`,
        hint: `Your app is using a secret ending in ${secretHint}. Check this against your Stripe Webhook Signing Secret.`
      }, { status: 400 });
    }
    console.log(`Received Webhook Event: ${event.type} [${event.id}]`);
    const base44 = createClientFromRequest(req);
    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const userId = session.metadata?.base44_user_id;
          if (userId) {
            if (session.mode === "setup") {
              if (session.metadata?.checkout_intent !== "knock_card_gate") {
                throw new Error(`Checkout Setup Session ${session.id} has an unsupported intent`);
              }
              const cardUpdates2 = await refreshAttachedCard(base44, userId, session.customer);
              if (cardUpdates2.stripe_card_on_file_confirmed !== true) {
                throw new Error(`Checkout Setup Session ${session.id} completed without an attached card`);
              }
              console.log(`Confirmed card-only Checkout for user ${userId}`);
              break;
            }
            if (session.metadata?.checkout_intent === PRECISION_CREDIT_PACK_INTENT) {
              const customerId2 = typeof session.customer === "string" ? session.customer : session.customer?.id;
              const packCustomer = await stripe.customers.retrieve(customerId2);
              if (packCustomer?.deleted || String(packCustomer?.metadata?.base44_user_id || "") !== String(userId)) {
                throw new Error(`Credit pack session ${session.id} customer ownership does not match user ${userId}`);
              }
              const granted = await recordPrecisionCreditPack(base44, userId, session);
              console.log(`Credit pack session ${session.id} granted ${granted} Precision credits to user ${userId}`);
              break;
            }
            const subscriptionId = session.subscription ? typeof session.subscription === "string" ? session.subscription : session.subscription.id : null;
            if (!subscriptionId) {
              throw new Error(`Checkout Session ${session.id} completed without a subscription`);
            }
            const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
            if (String(sub.metadata?.base44_user_id || "") !== String(userId)) {
              throw new Error(`Checkout Session ${session.id} subscription ownership metadata does not match the session user`);
            }
            if (!await canReplaceCurrentSubscription(base44, userId, sub.id)) {
              console.warn(`Ignoring stale Checkout Session ${session.id} for subscription ${sub.id}`);
              break;
            }
            const subscriptionStatus = sub.status;
            const subscriptionTier = inferTierFromSubscription(sub, session.metadata?.subscription_tier || "custom");
            const quantity = paidKnockSeatCount(sub);
            const latestInvoice = typeof sub.latest_invoice === "string" ? await stripe.invoices.retrieve(sub.latest_invoice) : sub.latest_invoice;
            const paidConfirmed = await paidSubscriptionConfirmed(sub, latestInvoice);
            const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
            const cardUpdates = await optionalAttachedCardUpdates(userId, customerId);
            const periodUpdates = await buildSubscriptionPeriodUpdates(
              base44,
              userId,
              sub,
              subscriptionTier,
              paidConfirmed
            );
            await base44.asServiceRole.entities.User.update(userId, {
              ...cardUpdates,
              subscription_id: subscriptionId,
              subscription_status: subscriptionStatus,
              subscription_tier: subscriptionTier,
              subscription_paid_confirmed: paidConfirmed,
              ...paidConfirmed ? { subscription_paid_confirmed_at: (/* @__PURE__ */ new Date()).toISOString() } : {},
              ...periodUpdates,
              ...paidConfirmed && quantity !== null ? { total_seats: quantity } : {}
            });
            if (paidConfirmed && quantity !== null) {
              await syncInviteCode(base44, userId, quantity);
            }
            console.log(`Successfully processed checkout.session.completed for user ${userId}`);
          } else {
            console.warn(`No userId in session metadata for ${session.id}`);
          }
          break;
        }
        case "customer.subscription.updated": {
          const eventSubscription = event.data.object;
          const subscription = await stripe.subscriptions.retrieve(eventSubscription.id, {
            expand: ["latest_invoice"]
          });
          const userId = subscription.metadata?.base44_user_id;
          const status = subscription.status;
          const baseItem = subscriptionBaseItem(subscription);
          const quantity = paidKnockSeatCount(subscription);
          const planId = baseItem?.price?.id;
          const latestInvoice = typeof subscription.latest_invoice === "string" ? await stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
          const paidConfirmed = await paidSubscriptionConfirmed(subscription, latestInvoice);
          if (userId) {
            if (!await isCurrentSubscription(base44, userId, subscription.id)) {
              console.warn(`Ignoring update for stale subscription ${subscription.id}`);
              break;
            }
            const cardUpdates = await optionalAttachedCardUpdates(userId, subscription.customer);
            const subscriptionTier = inferTierFromSubscription(subscription, "custom");
            const periodUpdates = await buildSubscriptionPeriodUpdates(
              base44,
              userId,
              subscription,
              subscriptionTier,
              paidConfirmed
            );
            await base44.asServiceRole.entities.User.update(userId, {
              subscription_id: subscription.id,
              subscription_status: status,
              ...cardUpdates,
              ...paidConfirmed ? { subscription_paid_confirmed: true, subscription_paid_confirmed_at: (/* @__PURE__ */ new Date()).toISOString() } : { subscription_paid_confirmed: false },
              ...planId ? { subscription_plan_id: planId } : {},
              subscription_tier: subscriptionTier,
              ...periodUpdates,
              ...paidConfirmed && quantity !== null ? { total_seats: quantity } : {}
            });
            if (paidConfirmed && quantity !== null) {
              await syncInviteCode(base44, userId, quantity);
            }
            console.log(`Successfully updated subscription for user ${userId}. Status: ${status}`);
          } else {
            console.log(`No userId in subscription metadata for ${subscription.id}`);
          }
          break;
        }
        case "invoice.paid": {
          const eventInvoice = event.data.object;
          const subscriptionId = invoiceSubscriptionId(eventInvoice);
          if (!subscriptionId) break;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["latest_invoice"]
          });
          const userId = subscription.metadata?.base44_user_id;
          const quantity = paidKnockSeatCount(subscription);
          if (userId) {
            if (!await isCurrentSubscription(base44, userId, subscription.id)) {
              console.warn(`Ignoring paid invoice for stale subscription ${subscription.id}`);
              break;
            }
            const currentInvoice = typeof subscription.latest_invoice === "string" ? await stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
            if (!currentInvoice || currentInvoice.id !== eventInvoice.id) {
              console.warn(`Ignoring stale paid invoice ${eventInvoice.id}; it is not the current invoice for ${subscription.id}`);
              break;
            }
            const paidConfirmed = await paidSubscriptionConfirmed(subscription, currentInvoice);
            const cardUpdates = await optionalAttachedCardUpdates(userId, subscription.customer);
            const subscriptionTier = inferTierFromSubscription(subscription, "custom");
            const periodUpdates = await buildSubscriptionPeriodUpdates(
              base44,
              userId,
              subscription,
              subscriptionTier,
              paidConfirmed
            );
            await base44.asServiceRole.entities.User.update(userId, {
              subscription_id: subscription.id,
              subscription_status: subscription.status,
              subscription_tier: subscriptionTier,
              ...paidConfirmed ? { subscription_paid_confirmed: true, subscription_paid_confirmed_at: (/* @__PURE__ */ new Date()).toISOString() } : { subscription_paid_confirmed: false },
              ...cardUpdates,
              ...periodUpdates,
              ...paidConfirmed && quantity !== null ? { total_seats: quantity } : {}
            });
            if (paidConfirmed) {
              if (quantity !== null) await syncInviteCode(base44, userId, quantity);
              const creditedProperties = await recordPrecisionCreditInvoice(base44, userId, subscription, currentInvoice);
              const paidUser = await getCurrentUser(base44, userId);
              await recordReferralInvoice(base44, paidUser, subscription, currentInvoice);
              console.log(`Confirmed paid subscription invoice for user ${userId} with ${quantity} seats and ${creditedProperties} rollover credits`);
            } else {
              console.log(`Ignored zero-dollar or trial invoice for user ${userId}`);
            }
          }
          break;
        }
        case "invoice.payment_failed": {
          const eventInvoice = event.data.object;
          const subscriptionId = invoiceSubscriptionId(eventInvoice);
          if (!subscriptionId) break;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["latest_invoice"]
          });
          const userId = subscription.metadata?.base44_user_id;
          if (userId) {
            if (!await isCurrentSubscription(base44, userId, subscription.id)) {
              console.warn(`Ignoring payment failure for stale subscription ${subscription.id}`);
              break;
            }
            const currentInvoice = typeof subscription.latest_invoice === "string" ? await stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
            const currentInvoiceIsUnpaid = currentInvoice && ["open", "uncollectible"].includes(String(currentInvoice.status || "").toLowerCase());
            if (!currentInvoice || currentInvoice.id !== eventInvoice.id || !currentInvoiceIsUnpaid) {
              console.warn(`Ignoring stale payment failure ${eventInvoice.id}; it is not the current unpaid invoice for ${subscription.id}`);
              break;
            }
            const paidConfirmed = await paidSubscriptionConfirmed(subscription, currentInvoice);
            const quantity = paidKnockSeatCount(subscription);
            await base44.asServiceRole.entities.User.update(userId, {
              subscription_id: subscription.id,
              subscription_status: subscription.status,
              subscription_paid_confirmed: paidConfirmed,
              ...paidConfirmed && quantity !== null ? { total_seats: quantity } : {}
            });
            console.log(`Marked the current subscription payment failed for user ${userId}`);
          }
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const userId = subscription.metadata?.base44_user_id;
          if (userId) {
            if (!await isCurrentSubscription(base44, userId, subscription.id)) {
              console.warn(`Ignoring deletion for stale subscription ${subscription.id}`);
              break;
            }
            await base44.asServiceRole.entities.User.update(userId, {
              subscription_status: "canceled",
              subscription_paid_confirmed: false,
              ...await optionalAttachedCardUpdates(userId, subscription.customer)
            });
            try {
              const existingCodes = await base44.asServiceRole.entities.InviteCode.filter({ linked_user_id: userId });
              const items2 = Array.isArray(existingCodes) ? existingCodes : existingCodes?.items || [];
              if (items2.length > 0) {
                await base44.asServiceRole.entities.InviteCode.update(items2[0].id, { is_active: false });
              }
            } catch (codeErr) {
              console.error(`Error deactivating invite code for ${userId}:`, codeErr.message);
            }
            console.log(`Successfully canceled subscription for user ${userId}`);
          }
          break;
        }
        case "payment_method.attached":
        case "payment_method.detached": {
          const paymentMethod = event.data.object;
          const customerId = stripeResourceId2(paymentMethod.customer) || stripeResourceId2(event.data.previous_attributes?.customer);
          if (!customerId) break;
          const customer = await stripe.customers.retrieve(customerId);
          const userId = !customer?.deleted ? customer?.metadata?.base44_user_id : null;
          if (userId) {
            await refreshAttachedCard(base44, userId, customerId);
            console.log(`Reconciled attached cards for user ${userId} after ${event.type}`);
          }
          break;
        }
        case "customer.updated": {
          const eventCustomer = event.data.object;
          const customer = await stripe.customers.retrieve(eventCustomer.id);
          const userId = !customer?.deleted ? customer?.metadata?.base44_user_id : null;
          if (userId) {
            await refreshAttachedCard(base44, userId, customer.id);
          }
          break;
        }
        case "setup_intent.succeeded": {
          const setupIntent = event.data.object;
          const customerId = stripeResourceId2(setupIntent.customer);
          if (!customerId) break;
          const customer = await stripe.customers.retrieve(customerId);
          const userId = !customer?.deleted ? customer?.metadata?.base44_user_id : null;
          if (userId) {
            await refreshAttachedCard(base44, userId, customer.id);
          }
          break;
        }
        default: {
          console.log(`Unhandled event type: ${event.type}`);
          break;
        }
      }
    } catch (processError) {
      console.error(`Error processing event ${event.type}: ${processError.message}`);
      return Response.json({ error: "Webhook processing failed" }, { status: 500 });
    }
    return Response.json({ received: true });
  } catch (error) {
    console.error(`Global Webhook Handler Error: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
