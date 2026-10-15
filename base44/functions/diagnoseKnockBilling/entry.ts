// base44/functions/diagnoseKnockBilling/entry.ts
import { createClientFromRequest } from "npm:@base44/sdk@0.8.31";
import Stripe from "npm:stripe@14.14.0";

// base44/shared/privilegedAccounts.js
var UNLIMITED_PROPERTY_CAP = 1e6;
function normalizeAccountEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}
var PRECISION_GRANTS = /* @__PURE__ */ new Map([
  ["invisibleontheblockchain@gmail.com", UNLIMITED_PROPERTY_CAP],
  ["christian@nativapest.com", 1e3],
  ["devinfgalligan@gmail.com", 1e3]
]);
var PRECISION_GRANTS_BY_USER_ID = /* @__PURE__ */ new Map([
  // christian@nativapest.com
  ["6978c7229935cf40cde25086", 1e3],
  // devinfgalligan@gmail.com
  ["69fb8c76e8bf4b0b31e8d4f9", 1e3]
]);
var KNOCK_GATE_EXEMPT_EMAILS = /* @__PURE__ */ new Set([
  ...PRECISION_GRANTS.keys(),
  "christian@nativapest.com",
  "christian@nativepest.com",
  "christian@nativepestmanagement.com",
  "kevin@reefenvironmental.com",
  "kevin@reifenvironmental.com",
  "keven@reefenvironmental.com",
  "justinhoskins44@gmail.com"
]);
var PRECISION_GRANTS_BY_EMAIL_DOMAIN = /* @__PURE__ */ new Map([
  // Every spelling of Christian's company seen on an account so far. The
  // knock-gate list already carries all three, so all three are in use.
  ["nativapest.com", 1e3],
  ["nativepest.com", 1e3],
  ["nativepestmanagement.com", 1e3]
]);
function emailDomain(email) {
  const normalized3 = normalizeAccountEmail(email);
  const at = normalized3.lastIndexOf("@");
  return at > 0 && at < normalized3.length - 1 ? normalized3.slice(at + 1) : "";
}
function usableLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function precisionGrantLimit(user) {
  const byId = usableLimit(PRECISION_GRANTS_BY_USER_ID.get(String(user?.id ?? "").trim()));
  if (byId !== null) return byId;
  const byEmail = usableLimit(PRECISION_GRANTS.get(normalizeAccountEmail(user?.email)));
  if (byEmail !== null) return byEmail;
  return usableLimit(PRECISION_GRANTS_BY_EMAIL_DOMAIN.get(emailDomain(user?.email)));
}
function hasPrecisionGrant(user) {
  return precisionGrantLimit(user) !== null;
}
function precisionGrantLabel(limit) {
  return limit >= UNLIMITED_PROPERTY_CAP ? "owner_unlimited_grant" : "account_precision_grant";
}
function isKnockGateExempt(user) {
  return hasPrecisionGrant(user) || KNOCK_GATE_EXEMPT_EMAILS.has(normalizeAccountEmail(user?.email));
}

// base44/shared/companySeatAllocation.js
var normalized = (value) => String(value || "").trim().toLowerCase();
var identifier = (value) => String(value || "").trim();
var asArray = (value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
function isoInstant(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
function resolveConfiguredCompanySeatGrant(billingUser, encodedGrants, now = Date.now()) {
  const userId = identifier(billingUser?.id);
  const absent = { present: false, grant: null };
  if (!userId || !encodedGrants) return absent;
  let document;
  try {
    document = JSON.parse(encodedGrants);
  } catch {
    return absent;
  }
  if (!document || Array.isArray(document) || typeof document !== "object" || !document.grants || Array.isArray(document.grants) || typeof document.grants !== "object" || !Object.prototype.hasOwnProperty.call(document.grants, userId)) return absent;
  const invalid = { present: true, grant: null };
  if (document.version !== 1) return invalid;
  const candidate = document.grants[userId];
  if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") return invalid;
  const startsAt = isoInstant(candidate.starts_at);
  const endsAt = isoInstant(candidate.ends_at);
  if (candidate.status !== "active" || typeof candidate.grant_id !== "string" || !candidate.grant_id.trim() || candidate.grant_id.length > 256 || !Number.isSafeInteger(candidate.canvas_seats) || candidate.canvas_seats < 1 || candidate.canvas_seats > 100 || !Number.isSafeInteger(candidate.precision_limit) || candidate.precision_limit < 1 || candidate.precision_limit > 1e3 || startsAt === null || endsAt === null || startsAt >= endsAt || !Number.isFinite(now) || now < startsAt || now >= endsAt) return invalid;
  return {
    present: true,
    grant: {
      source: "configured_company_seats",
      seat_limit: candidate.canvas_seats,
      grant_id: candidate.grant_id.trim(),
      starts_at: candidate.starts_at,
      ends_at: candidate.ends_at
    }
  };
}
function isActiveRep(member, managerId) {
  return identifier(member?.manager_id) === managerId && normalized(member?.role) === "rep" && normalized(member?.status) === "active";
}
function rosterOrder(left, right) {
  const leftTime = Date.parse(left?.created_date);
  const rightTime = Date.parse(right?.created_date);
  const dateDifference = (Number.isFinite(leftTime) ? leftTime : Infinity) - (Number.isFinite(rightTime) ? rightTime : Infinity);
  if (dateDifference && Number.isFinite(dateDifference)) return dateDifference;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
  const leftId = identifier(left?.id);
  const rightId = identifier(right?.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
function seatIdentity(member) {
  const userId = identifier(member?.user_id);
  if (userId) return `user:${userId}`;
  const email = normalized(member?.email);
  return email ? `email:${email}` : `member:${identifier(member?.id)}`;
}
async function verifyCompanySeatAllocation(base44, billingUser, teamMember, seatLimit, source = "company_seat_grant") {
  const managerId = identifier(billingUser?.id);
  if (!managerId || !Number.isSafeInteger(seatLimit) || seatLimit < 1) return null;
  const roster = [];
  const pageSize = 100;
  for (let skip = 0; ; skip += pageSize) {
    const page = asArray(await base44.asServiceRole.entities.TeamMember.filter(
      { manager_id: managerId },
      "created_date",
      pageSize,
      skip
    ));
    roster.push(...page.filter((member) => identifier(member?.id) && isActiveRep(member, managerId)));
    if (page.length < pageSize) break;
  }
  roster.sort(rosterOrder);
  const identities = [...new Set(roster.map(seatIdentity))];
  const seated = new Set(identities.slice(0, seatLimit));
  if (teamMember) {
    const memberId = identifier(teamMember.id);
    const userId = identifier(teamMember.user_id);
    const email = normalized(teamMember.email);
    if (!memberId || !userId || !email) return null;
    const exactMember = roster.find((member) => identifier(member.id) === memberId && identifier(member.user_id) === userId && normalized(member.email) === email);
    if (!exactMember || !seated.has(seatIdentity(exactMember))) return null;
  }
  return {
    source,
    manager_id: managerId,
    seat_limit: seatLimit,
    active_rep_count: identities.length,
    over_capacity: identities.length > seatLimit,
    unseated_rep_count: Math.max(0, identities.length - seatLimit)
  };
}

// base44/shared/companySeatAccess.js
var COMPANY_SEAT_GRANTS_BY_MANAGER_ID = /* @__PURE__ */ new Map([
  // Kevin Kussmaul / Flotilla: 13 company-paid rep seats, billed outside Stripe.
  ["6abaa09e961945efded82229", 13]
]);
var normalized2 = (value) => String(value || "").trim().toLowerCase();
var asArray2 = (value) => Array.isArray(value) ? value : value?.items || [];
var isActiveRep2 = (member) => normalized2(member?.role || "rep") === "rep" && normalized2(member?.status || "active") === "active";
function membershipRequired() {
  return Object.assign(new Error("Your company membership needs to be verified. Ask your manager to check your team access."), {
    status: 403,
    code: "team_membership_required"
  });
}
async function resolveOutcomeBillingContext(base44, authenticatedUser) {
  const actor = await base44.asServiceRole.entities.User.get(authenticatedUser.id).catch(() => null);
  if (!actor || normalized2(actor.email) !== normalized2(authenticatedUser.email)) {
    throw Object.assign(new Error("The authenticated account could not be verified."), {
      status: 401,
      code: "invalid_authenticated_user"
    });
  }
  const personalContext = { actor, billingUser: actor, managerId: actor.id, teamMember: null };
  let managerId = String(actor.team_manager_id || actor.data?.team_manager_id || "").trim();
  const memberId = String(actor.team_member_id || actor.data?.team_member_id || "").trim();
  const appRole = normalized2(actor.app_role || actor.data?.app_role);
  const teamAccount = appRole === "rep" || !!memberId && !["manager", "admin"].includes(appRole);
  if (managerId === String(actor.id)) {
    if (teamAccount) throw membershipRequired();
    return personalContext;
  }
  if (!managerId && !teamAccount) return personalContext;
  const memberships = [];
  for (let skip = 0; ; skip += 100) {
    const page = asArray2(await base44.asServiceRole.entities.TeamMember.filter({
      user_id: actor.id,
      ...managerId ? { manager_id: managerId } : {}
    }, "-updated_date", 100, skip));
    memberships.push(...page);
    if (page.length < 100) break;
  }
  const verified = memberships.filter(
    (member) => String(member?.user_id || "") === String(actor.id) && !!member?.manager_id && (!managerId || String(member.manager_id) === managerId) && normalized2(member?.email) === normalized2(actor.email) && isActiveRep2(member)
  );
  if (!managerId) {
    const managerIds = [...new Set(verified.map((member) => String(member.manager_id)))];
    if (managerIds.length !== 1) throw membershipRequired();
    managerId = managerIds[0];
  }
  const teamMember = verified.find((member) => String(member.id) === memberId) || verified[0];
  if (!teamMember) throw membershipRequired();
  const billingUser = await base44.asServiceRole.entities.User.get(managerId).catch(() => null);
  if (!billingUser) throw membershipRequired();
  return { actor, billingUser, managerId, teamMember };
}
async function companySeatAccess(base44, billingUser, teamMember, encodedGrants) {
  const appRole = normalized2(billingUser?.app_role || billingUser?.data?.app_role);
  const role = normalized2(billingUser?.role || billingUser?.data?.role);
  if (!(billingUser?.is_owner === true || ["manager", "admin"].includes(appRole) || ["manager", "admin"].includes(role))) return null;
  const configured = resolveConfiguredCompanySeatGrant(billingUser, encodedGrants);
  if (configured.present) {
    return configured.grant ? verifyCompanySeatAllocation(
      base44,
      billingUser,
      teamMember,
      configured.grant.seat_limit,
      configured.grant.source
    ) : null;
  }
  const grantedSeats = COMPANY_SEAT_GRANTS_BY_MANAGER_ID.get(String(billingUser?.id || ""));
  const allocatedSeats = billingUser?.total_seats;
  if (!Number.isSafeInteger(grantedSeats) || grantedSeats < 1 || !Number.isSafeInteger(allocatedSeats) || allocatedSeats < 1 || normalized2(billingUser?.subscription_status) !== "active") return null;
  return verifyCompanySeatAllocation(base44, billingUser, teamMember, Math.min(grantedSeats, allocatedSeats));
}

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
async function loadOwnedKnockSubscriptions(stripe2, billingUser) {
  const userId = String(billingUser?.id || "");
  if (!userId) throw new Error("A billing account is required to verify subscriptions.");
  const candidates = /* @__PURE__ */ new Map();
  const rememberOwned = (subscription) => {
    if (subscription?.id && String(subscription?.metadata?.base44_user_id || "") === userId) {
      candidates.set(subscription.id, subscription);
    }
  };
  let lookupError = null;
  if (billingUser?.subscription_id) {
    try {
      rememberOwned(await stripe2.subscriptions.retrieve(String(billingUser.subscription_id), {
        expand: ["latest_invoice"]
      }));
    } catch (error) {
      lookupError = error;
    }
  }
  let searchComplete = false;
  if (typeof stripe2?.subscriptions?.search === "function") {
    const escapedUserId = userId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const seenPages = /* @__PURE__ */ new Set();
    let page;
    try {
      for (let pageCount = 0; pageCount < 10; pageCount += 1) {
        const result = await stripe2.subscriptions.search({
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
function invoiceMatchesSubscription(invoice, subscriptionId, requireOwner = false) {
  const owner = invoiceSubscriptionId(invoice);
  const legacyOwner = stripeResourceId(invoice?.subscription);
  return (!requireOwner || owner === subscriptionId) && (!owner || owner === subscriptionId) && (!legacyOwner || legacyOwner === subscriptionId);
}
function hasPositiveInvoicePayment(invoice) {
  const amountPaid = Number(invoice?.amount_paid || 0);
  return invoice?.status === "paid" && Number.isFinite(amountPaid) && amountPaid > 0;
}
function paidLineCoversCommittedSeats(line, subscription, items, nowSeconds) {
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
  return items.some(({ item, period }) => item.id === itemId && line.quantity >= item.quantity && end >= period.end);
}
async function historicalInvoiceCoversSeats(stripe2, invoice, subscription, items, nowSeconds) {
  const covers = (line) => paidLineCoversCommittedSeats(line, subscription, items, nowSeconds);
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
  const items = (subscription.items?.data || []).filter(
    (item) => isBaseSeatItem(item) && item.quantity === committedCount && !!item.id
  ).map((item) => ({ item, period: periodPair(item) || period })).filter((candidate) => candidate.period.start <= nowSeconds && candidate.period.end > nowSeconds);
  if (!items.length) return false;
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
      if (hasPositiveInvoicePayment(invoice) && invoiceMatchesSubscription(invoice, subscription.id, true) && await historicalInvoiceCoversSeats(stripe2, invoice, subscription, items, nowSeconds)) return true;
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

// base44/functions/diagnoseKnockBilling/entry.ts
var stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "");
Deno.serve(async (req) => {
  let teamAccount = false;
  try {
    const base44 = createClientFromRequest(req);
    const caller = await base44.auth.me();
    if (!caller) return Response.json({ error: "Authentication required" }, { status: 401 });
    if (String(caller.role || "").toLowerCase() !== "admin") {
      return Response.json({ error: "Admin access required" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const userId = String(body.user_id || "").trim();
    if (!email && !userId) return Response.json({ error: "email or user_id is required" }, { status: 400 });
    let user;
    if (userId) {
      user = await base44.asServiceRole.entities.User.get(userId);
      if (user && String(user.id) !== userId) {
        return Response.json({ error: "The requested account identity could not be verified.", code: "account_identity_mismatch" }, { status: 409 });
      }
    } else {
      const users = await base44.asServiceRole.entities.User.filter({ email }, "-updated_date", 2);
      user = (Array.isArray(users) ? users : users?.items || [])[0];
    }
    if (!user) return Response.json({ error: "No such account" }, { status: 404 });
    if (email && String(user.email || "").trim().toLowerCase() !== email) {
      return Response.json({ error: "The email does not match the requested account.", code: "account_identity_mismatch" }, { status: 409 });
    }
    teamAccount = !!(user.team_manager_id || user.data?.team_manager_id || user.team_member_id || user.data?.team_member_id || String(user.app_role || user.data?.app_role || "").toLowerCase() === "rep");
    const context = await resolveOutcomeBillingContext(base44, user);
    const billingUser = context.billingUser;
    teamAccount = !!context.teamMember;
    const role = String(billingUser.role || billingUser.data?.role || "").trim().toLowerCase();
    const privileged = billingUser.is_owner === true || role === "admin" || isKnockGateExempt(billingUser);
    let companySeats = privileged ? null : await companySeatAccess(
      base44,
      billingUser,
      context.teamMember,
      Deno.env.get("BETA_ACCESS_GRANTS")
    );
    const nowSeconds = Date.now() / 1e3;
    let subscriptions = [];
    let paidEvidence = { paid: false, subscription: null, period: null };
    if (!privileged && !companySeats) {
      try {
        if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new Error("Stripe is not configured.");
        subscriptions = await loadOwnedKnockSubscriptions(stripe, billingUser);
        paidEvidence = await findCurrentPaidKnockSubscription(stripe, billingUser, subscriptions, nowSeconds);
      } catch (error) {
        throw Object.assign(new Error("Billing verification is temporarily unavailable."), {
          status: 503,
          code: "billing_verification_unavailable",
          cause: error
        });
      }
    }
    let covered = privileged || !!companySeats;
    let source = privileged ? "privileged" : companySeats?.source || (teamAccount ? "team_seat_unavailable" : "individual_free");
    let accessCode = null;
    if (paidEvidence.paid) {
      const seatCount = paidKnockSeatCount(paidEvidence.subscription);
      if (seatCount !== null) {
        companySeats = await verifyCompanySeatAllocation(base44, billingUser, context.teamMember, seatCount, "company_subscription");
      }
      covered = !teamAccount || !!companySeats;
      source = teamAccount ? "stripe_paid_company" : "stripe_paid_individual";
      if (teamAccount && !covered) {
        accessCode = seatCount === null ? "billing_verification_unavailable" : "team_seat_access_required";
      }
    }
    if (teamAccount && !covered && !accessCode) accessCode = "team_seat_access_required";
    const requiresManagerAttention = teamAccount && !covered;
    const report = [];
    for (const subscription of subscriptions) {
      const invoice = typeof subscription.latest_invoice === "string" ? await stripe.invoices.retrieve(subscription.latest_invoice).catch(() => null) : subscription.latest_invoice;
      report.push({
        lookup: "verified_owned_subscription",
        subscription_id: subscription.id,
        status: subscription.status,
        metadata_user_id: subscription.metadata?.base44_user_id || null,
        metadata_matches_account: String(subscription.metadata?.base44_user_id || "") === String(billingUser.id),
        current_period_end_present: subscription.current_period_end !== void 0,
        current_period_end_in_future: Number(subscription.current_period_end || 0) > nowSeconds,
        item_period_end_in_future: (subscription.items?.data || []).some((item) => Number(item?.current_period_end || 0) > nowSeconds),
        trial_active: Number(subscription.trial_end || 0) > nowSeconds,
        period: subscriptionPeriod(subscription, nowSeconds),
        paid_seat_count: paidKnockSeatCount(subscription),
        customer_id: stripeResourceId(subscription.customer),
        invoice: invoice ? {
          id: invoice.id,
          status: invoice.status,
          amount_paid: invoice.amount_paid,
          subscription_field: stripeResourceId(invoice.subscription),
          parent_subscription: invoice?.parent?.type === "subscription_details" ? stripeResourceId(invoice.parent.subscription_details?.subscription) : null,
          verified_subscription_id: invoiceSubscriptionId(invoice)
        } : null
      });
    }
    const precisionLimit = precisionGrantLimit(user);
    return Response.json({
      success: true,
      account: {
        email: user.email,
        user_id: user.id,
        precision_grant_limit: precisionLimit,
        precision_grant_label: precisionLimit === null ? null : precisionGrantLabel(precisionLimit),
        outcomes_logged: user.outcomes_logged || 0,
        subscription_status: user.subscription_status || null,
        subscription_paid_confirmed: user.subscription_paid_confirmed === true,
        stripe_card_on_file_confirmed: user.stripe_card_on_file_confirmed === true,
        is_owner: user.is_owner === true,
        role: user.role || null
      },
      billing_account: {
        user_id: billingUser.id,
        email: billingUser.email,
        verified_team_member_id: context.teamMember?.id || null
      },
      company_seat_access: companySeats,
      billing_access: {
        source,
        covered,
        paid: !!companySeats || paidEvidence.paid,
        privileged,
        requires_manager_attention: requiresManagerAttention,
        ...accessCode ? { code: accessCode } : {}
      },
      requires_manager_attention: requiresManagerAttention,
      ...covered || teamAccount ? { outcome_gate: {
        card_required: false,
        free_outcome_limit_applies: false,
        requires_manager_attention: requiresManagerAttention
      } } : {},
      subscriptions: report
    });
  } catch (error) {
    console.error("[diagnoseKnockBilling]", error?.message || error);
    return Response.json({
      error: error?.message || "Diagnostic failed",
      ...error?.code ? { code: error.code } : {},
      ...teamAccount ? { requires_manager_attention: true } : {}
    }, { status: error?.status || 500 });
  }
});
