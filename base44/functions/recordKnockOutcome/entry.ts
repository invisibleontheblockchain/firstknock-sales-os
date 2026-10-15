// base44/functions/recordKnockOutcome/entry.ts
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
  const normalized4 = normalizeAccountEmail(email);
  const at = normalized4.lastIndexOf("@");
  return at > 0 && at < normalized4.length - 1 ? normalized4.slice(at + 1) : "";
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

// base44/functions/recordKnockOutcome/entry.ts
var stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "");
var CARD_REQUIRED_AFTER = 25;
var FREE_OUTCOME_LIMIT = 50;
var OUTCOME_LEASE_MS = 3e4;
var OUTCOME_LEASE_WAIT_MS = 5e3;
var DUPLICATE_TAP_WINDOW_MS = 1e4;
var OUTCOMES = /* @__PURE__ */ new Set([
  "SOLD",
  "QUALIFIED",
  "HARD_NO",
  "NOT_QUALIFIED",
  "CALLBACK",
  "NO_ANSWER",
  "ELIGIBLE",
  "NOT_MOVED_IN",
  "DM_NOT_HOME"
]);
var WORKFLOW_TRANSITIONS = {
  BULK_MOVE_TO_TODO: {
    parsedStatus: "ELIGIBLE",
    workflowBucket: "TODO",
    rawInputText: "Workflow update - moved to Todo"
  },
  BULK_MOVE_TO_CALLBACK: {
    parsedStatus: "CALLBACK",
    workflowBucket: "CALLBACK",
    rawInputText: "Workflow update - moved to Callback"
  },
  BULK_MOVE_TO_RE_KNOCK: {
    parsedStatus: "ELIGIBLE",
    workflowBucket: "RE_KNOCK",
    rawInputText: "Workflow update - moved to Re-Knock"
  }
};
var HttpError = class extends Error {
  status;
  code;
  details;
  constructor(status, code, message, details = void 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
};
function asArray3(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}
function normalized3(value) {
  return String(value || "").trim().toLowerCase();
}
function requiredString(value, field, maxLength = 256) {
  const result = String(value || "").trim();
  if (!result || result.length > maxLength) {
    throw new HttpError(400, "invalid_outcome", `${field} is required or invalid.`);
  }
  return result;
}
function optionalString(value, field, maxLength) {
  if (value === void 0 || value === null || value === "") return null;
  const result = String(value).trim();
  if (result.length > maxLength) {
    throw new HttpError(400, "invalid_outcome", `${field} is too long.`);
  }
  return result || null;
}
function optionalNumber(value, field, minimum, maximum) {
  if (value === void 0 || value === null || value === "") return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new HttpError(400, "invalid_outcome", `${field} is invalid.`);
  }
  return result;
}
function optionalDateTime(value, field) {
  const result = optionalString(value, field, 64);
  if (!result) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(result);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === void 0 ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === void 0 ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  const timestamp = new Date(result);
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(timestamp.getTime())) {
    throw new HttpError(400, "invalid_outcome", `${field} is invalid.`);
  }
  return timestamp.toISOString();
}
function boundedServerString(value, maxLength) {
  const result = String(value || "").trim();
  return result ? result.slice(0, maxLength) : null;
}
function isAdminActor(user) {
  return normalized3(user?.role || user?.data?.role) === "admin";
}
function idempotencyKey(value, maxLength = 128) {
  const result = requiredString(value, "idempotency_key", maxLength);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) {
    throw new HttpError(400, "invalid_idempotency_key", "idempotency_key contains unsupported characters.");
  }
  return result;
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  return `knock_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
}
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function acquireOutcomeLease(base44, actorId) {
  const deadline = Date.now() + OUTCOME_LEASE_WAIT_MS;
  do {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const token = randomToken();
    const expiresAt = new Date(now + OUTCOME_LEASE_MS).toISOString();
    const currentUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
    if (currentUser) {
      const existingToken = String(currentUser.knock_outcome_lock_token || "");
      const existingExpiresAt = String(currentUser.knock_outcome_lock_expires_at || "");
      const isExpired = !existingExpiresAt || new Date(existingExpiresAt).getTime() <= now;
      if (!existingToken || isExpired) {
        await base44.asServiceRole.entities.User.update(actorId, {
          knock_outcome_lock_token: token,
          knock_outcome_lock_acquired_at: nowIso,
          knock_outcome_lock_expires_at: expiresAt
        }).catch(() => null);
        const lockedUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
        if (lockedUser && String(lockedUser.knock_outcome_lock_token || "") === token && String(lockedUser.knock_outcome_lock_expires_at || "") === expiresAt) {
          return { token };
        }
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(50);
  } while (Date.now() <= deadline);
  throw new HttpError(
    409,
    "outcome_write_in_progress",
    "Another outcome is being saved for this account. Retry in a moment."
  );
}
async function releaseOutcomeLease(base44, actorId, lease) {
  if (!lease) return;
  const currentUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
  if (currentUser && String(currentUser.knock_outcome_lock_token || "") === lease.token) {
    await base44.asServiceRole.entities.User.update(actorId, {
      knock_outcome_lock_token: null,
      knock_outcome_lock_acquired_at: null,
      knock_outcome_lock_expires_at: null
    }).catch(() => null);
  }
}
async function resolveActorAndBillingUser(base44, authenticatedUser) {
  return await resolveOutcomeBillingContext(base44, authenticatedUser);
}
function isPrivilegedBillingAccount(user) {
  const role = normalized3(user?.role || user?.data?.role);
  return user?.is_owner === true || role === "admin" || isKnockGateExempt(user);
}
function customerBelongsToUser(customer, user) {
  return !!customer && customer.deleted !== true && String(customer?.metadata?.base44_user_id || "") === String(user?.id || "");
}
async function resolveCanonicalCustomer(user, subscriptions, paidSubscription) {
  const subscriptionCustomerIds = [...new Set(
    [paidSubscription, ...subscriptions].map((subscription) => stripeResourceId(subscription?.customer)).filter(Boolean)
  )];
  if (subscriptionCustomerIds.length > 1) {
    throw new HttpError(
      409,
      "billing_identity_ambiguous",
      "More than one Stripe customer is attached to this account. Contact support before logging more outcomes."
    );
  }
  const preferredId = subscriptionCustomerIds[0] || (user?.stripe_customer_id ? String(user.stripe_customer_id) : null);
  if (preferredId) {
    try {
      const customer = await stripe.customers.retrieve(preferredId);
      if (customerBelongsToUser(customer, user)) return customer;
      if (subscriptionCustomerIds[0]) {
        throw new HttpError(409, "billing_identity_mismatch", "The subscription customer does not belong to this account.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.raw?.code !== "resource_missing") throw error;
    }
  }
  if (typeof stripe.customers.search !== "function") return null;
  const escapedUserId = String(user.id).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const result = await stripe.customers.search({
    query: `metadata['base44_user_id']:'${escapedUserId}'`,
    limit: 10
  });
  const owned = (result.data || []).filter((customer) => customerBelongsToUser(customer, user));
  if (owned.length > 1) {
    throw new HttpError(
      409,
      "billing_identity_ambiguous",
      "More than one Stripe customer matches this account. Contact support before logging more outcomes."
    );
  }
  return owned[0] || null;
}
async function liveBillingEvidence(base44, billingUser, verifyPersonalCard = true) {
  if (!Deno.env.get("STRIPE_SECRET_KEY")) {
    throw new HttpError(
      503,
      "billing_verification_unavailable",
      "Billing verification is temporarily unavailable. No outcome was logged."
    );
  }
  try {
    const subscriptions = await loadOwnedKnockSubscriptions(stripe, billingUser);
    const paidEvidence = await findCurrentPaidKnockSubscription(stripe, billingUser, subscriptions);
    if (paidEvidence.paid) {
      return {
        paid: true,
        hasCard: false,
        customerId: stripeResourceId(paidEvidence.subscription.customer),
        subscription: paidEvidence.subscription
      };
    }
    if (!verifyPersonalCard) return { paid: false, hasCard: false, subscription: null };
    const customer = await resolveCanonicalCustomer(
      billingUser,
      subscriptions,
      paidEvidence.subscription
    );
    let hasCard = false;
    if (customer) {
      const methods = await stripe.paymentMethods.list({
        customer: customer.id,
        type: "card",
        limit: 1
      });
      hasCard = (methods.data || []).length > 0;
    }
    await base44.asServiceRole.entities.User.update(billingUser.id, {
      ...customer ? { stripe_customer_id: customer.id } : {},
      stripe_card_on_file_confirmed: hasCard,
      ...hasCard ? { stripe_card_confirmed_at: (/* @__PURE__ */ new Date()).toISOString() } : { stripe_card_confirmed_at: null }
    });
    return {
      paid: paidEvidence.paid,
      hasCard,
      customerId: customer?.id || null
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("Live Knock billing verification failed:", error?.message || error);
    throw new HttpError(
      503,
      "billing_verification_unavailable",
      "Billing verification is temporarily unavailable. No outcome was logged."
    );
  }
}
function sanitizeInteraction(value, forcedStatus = null) {
  const source = value || {};
  const parsedStatus = forcedStatus || requiredString(source.parsed_status, "parsed_status", 32).toUpperCase();
  if (!OUTCOMES.has(parsedStatus)) {
    throw new HttpError(400, "invalid_outcome", "parsed_status is not supported.");
  }
  if (!forcedStatus && parsedStatus === "ELIGIBLE") {
    throw new HttpError(400, "invalid_outcome", "Use clear_decision to move a property back to Todo.");
  }
  const nextEligibleDate = optionalString(source.next_eligible_date, "next_eligible_date", 64);
  if (nextEligibleDate && !Number.isFinite(new Date(nextEligibleDate).getTime())) {
    throw new HttpError(400, "invalid_outcome", "next_eligible_date is invalid.");
  }
  const sold = parsedStatus === "SOLD";
  return {
    address_hash: requiredString(source.address_hash, "address_hash", 256),
    raw_input_text: requiredString(source.raw_input_text, "raw_input_text", 1e3),
    parsed_status: parsedStatus,
    sale_amount: optionalNumber(source.sale_amount, "sale_amount", 0, 1e8),
    sale_date: sold ? optionalDateTime(source.sale_date, "sale_date") : null,
    property_address: sold ? optionalString(source.property_address, "property_address", 500) : null,
    homeowner_name: sold ? optionalString(source.homeowner_name, "homeowner_name", 250) : null,
    route_id: optionalString(source.route_id, "route_id", 128),
    gps_proof_lat: optionalNumber(source.gps_proof_lat, "gps_proof_lat", -90, 90),
    gps_proof_lng: optionalNumber(source.gps_proof_lng, "gps_proof_lng", -180, 180),
    gps_accuracy: optionalNumber(source.gps_accuracy, "gps_accuracy", 0, 1e5),
    image_url: optionalString(source.image_url, "image_url", 2048),
    next_eligible_date: nextEligibleDate,
    description: optionalString(source.description, "description", 1e3)
  };
}
function compactInteraction(interaction) {
  return Object.fromEntries(Object.entries(interaction).filter(([, value]) => value !== null));
}
async function loadVisibleRoute(base44, actor, managerId, routeId) {
  const route = await base44.entities.SavedRoute.get(routeId).catch(() => null);
  if (!route) {
    throw new HttpError(403, "route_access_denied", "This route is not available to the authenticated account.");
  }
  const routeManagerId = String(route.manager_id || "").trim();
  const belongsToActor = normalized3(route.created_by) === normalized3(actor.email);
  if (routeManagerId && routeManagerId !== String(managerId) && !belongsToActor && !isAdminActor(actor)) {
    throw new HttpError(403, "route_tenant_mismatch", "This route belongs to a different workspace.");
  }
  return route;
}
function routeAliases(route) {
  return new Set(
    (Array.isArray(route?.property_hashes) ? route.property_hashes : []).map((hash) => String(hash || "").trim()).filter(Boolean)
  );
}
function propertyAliases(property) {
  return [
    property?.address_hash,
    property?.legacy_hash,
    property?.id
  ].map((hash) => String(hash || "").trim()).filter(Boolean);
}
async function verifyHashesOnRoute(base44, route, requestedHashes) {
  const allowedRouteHashes = routeAliases(route);
  const missing = requestedHashes.filter((hash) => !allowedRouteHashes.has(hash));
  if (missing.length === 0) return;
  const propertiesByRequestedHash = /* @__PURE__ */ new Map();
  const remember = (properties) => {
    for (const property of properties) {
      for (const alias of propertyAliases(property)) {
        if (missing.includes(alias)) propertiesByRequestedHash.set(alias, property);
      }
    }
  };
  remember(asArray3(await base44.asServiceRole.entities.MasterProperty.filter({
    address_hash: missing
  }, "-updated_date", Math.min(500, missing.length))));
  remember(asArray3(await base44.asServiceRole.entities.MasterProperty.filter({
    legacy_hash: missing
  }, "-updated_date", Math.min(500, missing.length))));
  remember(asArray3(await base44.asServiceRole.entities.MasterProperty.filter({
    id: missing
  }, "-updated_date", Math.min(500, missing.length))));
  const unauthorized = missing.filter((hash) => {
    const property = propertiesByRequestedHash.get(hash);
    return !property || !propertyAliases(property).some((alias) => allowedRouteHashes.has(alias));
  });
  if (unauthorized.length > 0) {
    throw new HttpError(
      403,
      "property_not_on_route",
      "Every selected property must be part of the selected route.",
      { rejected_address_hashes: unauthorized.slice(0, 10) }
    );
  }
}
async function verifyRouteAccess(base44, actor, managerId, interaction) {
  if (!interaction.route_id) return null;
  const route = await loadVisibleRoute(base44, actor, managerId, interaction.route_id);
  await verifyHashesOnRoute(base44, route, [interaction.address_hash]);
  return route;
}
function saleIdentitySnapshot(actor, teamMember, route) {
  return {
    rep_id: String(teamMember?.id || actor.id),
    rep_name: boundedServerString(
      teamMember?.name || actor?.full_name || actor?.name || actor?.email,
      250
    ),
    route_name: boundedServerString(route?.name, 250)
  };
}
async function currentProtectedCount(base44, actor) {
  let count = Math.max(0, Math.floor(Number(actor.outcomes_logged || 0)));
  const latest = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
    logged_by_user_id: actor.id,
    counts_toward_free_limit: true
  }, "-outcome_sequence", 1));
  if (latest[0]) count = Math.max(count, Math.floor(Number(latest[0].outcome_sequence || 0)));
  let reconciledAt = actor.outcomes_reconciled_at || null;
  if (!reconciledAt) {
    let legacyCount = 0;
    const pageSize = 500;
    for (let skip = 0; skip < 1e4 && legacyCount < FREE_OUTCOME_LIMIT; skip += pageSize) {
      const page = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
        created_by: actor.email
      }, "-created_date", pageSize, skip));
      legacyCount += page.filter(
        (log) => log.counts_as_knock !== false && log.parsed_status !== "ELIGIBLE" && log.source !== "csv_history_import" && log.source !== "workflow_transition"
      ).length;
      if (page.length < pageSize) break;
    }
    count = Math.max(count, legacyCount);
    reconciledAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  return { count, reconciledAt };
}
async function syncProtectedCount(base44, actorId, lease, count, reconciledAt) {
  const currentUser = await base44.asServiceRole.entities.User.get(actorId).catch(() => null);
  if (!currentUser || String(currentUser.knock_outcome_lock_token || "") !== lease.token) {
    throw new HttpError(
      503,
      "outcome_counter_write_failed",
      "The outcome counter could not be committed. Retry with the same action."
    );
  }
  await base44.asServiceRole.entities.User.update(actorId, {
    outcomes_logged: count,
    outcomes_reconciled_at: reconciledAt
  });
}
async function existingIdempotentLog(base44, actorId, key) {
  const rows = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
    logged_by_user_id: actorId,
    idempotency_key: key
  }, "-created_date", 2));
  if (rows.length > 1) {
    throw new HttpError(409, "idempotency_integrity_failed", "Duplicate outcome retry keys require support review.");
  }
  return rows[0] || null;
}
async function enforceGate(base44, billingUser, count, teamMember = null) {
  if (isPrivilegedBillingAccount(billingUser)) {
    return { privileged: true, paid: true, hasCard: true };
  }
  if (count < CARD_REQUIRED_AFTER) {
    return { privileged: false, paid: false, hasCard: false };
  }
  const companySeats = await companySeatAccess(base44, billingUser, teamMember, Deno.env.get("BETA_ACCESS_GRANTS"));
  if (companySeats) {
    return { privileged: false, paid: true, hasCard: false, companySeats };
  }
  const evidence = await liveBillingEvidence(base44, billingUser, !teamMember);
  if (teamMember) {
    const seatLimit = evidence.paid ? paidKnockSeatCount(evidence.subscription) : null;
    if (evidence.paid && seatLimit === null) {
      throw new HttpError(
        503,
        "billing_verification_unavailable",
        "Your company seat allocation could not be verified. Ask your manager to review team access."
      );
    }
    const paidSeats = seatLimit === null ? null : await verifyCompanySeatAllocation(
      base44,
      billingUser,
      teamMember,
      seatLimit,
      "company_subscription"
    );
    if (!paidSeats) {
      throw new HttpError(
        403,
        "team_seat_access_required",
        "Your team needs active seat access. Ask your manager to review the company subscription."
      );
    }
    return { privileged: false, ...evidence, companySeats: paidSeats };
  }
  if (count >= FREE_OUTCOME_LIMIT && !evidence.paid) {
    throw new HttpError(
      402,
      "free_outcome_limit_reached",
      "The 50-outcome free limit has been reached. Upgrade to keep logging outcomes.",
      { gate: "limit", outcomes_logged: count }
    );
  }
  if (!evidence.paid && !evidence.hasCard) {
    throw new HttpError(
      402,
      "card_required",
      "A live attached card is required after 25 logged outcomes.",
      { gate: "card", outcomes_logged: count }
    );
  }
  return { privileged: false, ...evidence };
}
async function recordOne(base44, authenticatedUser, body, clearDecision = false) {
  const key = idempotencyKey(body.idempotency_key);
  const interaction = sanitizeInteraction(
    body.interaction || body,
    clearDecision ? "ELIGIBLE" : null
  );
  const source = clearDecision ? "decision_clear" : "knock_mode";
  const countsTowardLimit = !clearDecision;
  const requestHash = await sha256({ interaction: compactInteraction(interaction), source });
  const { actor: initialActor, billingUser, managerId, teamMember } = await resolveActorAndBillingUser(
    base44,
    authenticatedUser
  );
  const verifiedRoute = await verifyRouteAccess(base44, initialActor, managerId, interaction);
  const interactionForWrite = interaction.parsed_status === "SOLD" ? { ...interaction, ...saleIdentitySnapshot(initialActor, teamMember, verifiedRoute) } : interaction;
  let lease = null;
  try {
    lease = await acquireOutcomeLease(base44, initialActor.id);
    const actor = await base44.asServiceRole.entities.User.get(initialActor.id);
    const protectedState = await currentProtectedCount(base44, actor);
    const existing = await existingIdempotentLog(base44, actor.id, key);
    if (existing) {
      if (String(existing.request_hash || "") !== requestHash) {
        throw new HttpError(
          409,
          "idempotency_key_reused",
          "This retry key was already used for a different outcome."
        );
      }
      const recoveredCount = countsTowardLimit ? Math.max(protectedState.count, Math.floor(Number(existing.outcome_sequence || 0))) : protectedState.count;
      await syncProtectedCount(
        base44,
        actor.id,
        lease,
        recoveredCount,
        protectedState.reconciledAt
      );
      return {
        success: true,
        reused: true,
        interaction: existing,
        outcomes_logged: recoveredCount
      };
    }
    if (countsTowardLimit) {
      const recent = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
        logged_by_user_id: actor.id,
        address_hash: interaction.address_hash,
        source: "knock_mode"
      }, "-created_date", 1))[0];
      const recentTime = recent?.created_date ? new Date(recent.created_date).getTime() : NaN;
      if (recent && recent.request_hash === requestHash && Number.isFinite(recentTime) && Date.now() - recentTime <= DUPLICATE_TAP_WINDOW_MS) {
        const recoveredCount = Math.max(
          protectedState.count,
          Math.floor(Number(recent.outcome_sequence || 0))
        );
        await syncProtectedCount(
          base44,
          actor.id,
          lease,
          recoveredCount,
          protectedState.reconciledAt
        );
        return {
          success: true,
          reused: true,
          duplicate_tap_suppressed: true,
          interaction: recent,
          outcomes_logged: recoveredCount
        };
      }
    }
    if (countsTowardLimit) {
      await enforceGate(base44, billingUser, protectedState.count, teamMember);
    }
    const nextCount = countsTowardLimit ? protectedState.count + 1 : protectedState.count;
    const created = await base44.asServiceRole.entities.InteractionLog.create({
      ...compactInteraction(interactionForWrite),
      created_by: actor.email,
      manager_id: managerId,
      logged_by_user_id: actor.id,
      idempotency_key: key,
      request_hash: requestHash,
      ...countsTowardLimit ? { outcome_sequence: nextCount } : {},
      counts_toward_free_limit: countsTowardLimit,
      counts_as_knock: countsTowardLimit,
      ...clearDecision ? {
        workflow_action: "CLEAR_TO_TODO",
        workflow_bucket: "TODO"
      } : {},
      source
    });
    await syncProtectedCount(
      base44,
      actor.id,
      lease,
      nextCount,
      protectedState.reconciledAt
    );
    const verifiedUser = await base44.asServiceRole.entities.User.get(actor.id);
    if (Math.floor(Number(verifiedUser?.outcomes_logged || 0)) < nextCount) {
      throw new HttpError(
        503,
        "outcome_counter_verification_failed",
        "The outcome was saved but its counter is still reconciling. Retry with the same action."
      );
    }
    return {
      success: true,
      reused: false,
      interaction: created,
      outcomes_logged: nextCount,
      card_required_after: CARD_REQUIRED_AFTER,
      free_outcome_limit: FREE_OUTCOME_LIMIT
    };
  } finally {
    await releaseOutcomeLease(base44, initialActor.id, lease);
  }
}
async function importHistory(base44, authenticatedUser, body) {
  const requestKey = idempotencyKey(body.idempotency_key, 100);
  const interactions = Array.isArray(body.interactions) ? body.interactions : [];
  if (interactions.length < 1 || interactions.length > 500) {
    throw new HttpError(400, "invalid_import", "History imports require 1 to 500 interactions per request.");
  }
  const { actor, billingUser, managerId, teamMember } = await resolveActorAndBillingUser(base44, authenticatedUser);
  try {
    await enforceGate(base44, billingUser, FREE_OUTCOME_LIMIT, teamMember);
  } catch (error) {
    if (error?.code === "free_outcome_limit_reached") {
      throw new HttpError(
        402,
        "paid_plan_required",
        "CSV history import requires a current paid subscription.",
        { gate: "limit" }
      );
    }
    throw error;
  }
  const prepared = [];
  const routeCache = /* @__PURE__ */ new Map();
  for (let index = 0; index < interactions.length; index += 1) {
    const interaction = sanitizeInteraction(interactions[index]);
    let verifiedRoute = null;
    if (interaction.route_id) {
      if (!routeCache.has(interaction.route_id)) {
        routeCache.set(
          interaction.route_id,
          await loadVisibleRoute(base44, actor, managerId, interaction.route_id)
        );
      }
      verifiedRoute = routeCache.get(interaction.route_id);
      await verifyHashesOnRoute(base44, verifiedRoute, [interaction.address_hash]);
    }
    const interactionForWrite = interaction.parsed_status === "SOLD" ? { ...interaction, ...saleIdentitySnapshot(actor, teamMember, verifiedRoute) } : interaction;
    const key = `${requestKey}:${index}`;
    const requestHash = await sha256({
      interaction: compactInteraction(interaction),
      source: "csv_history_import"
    });
    prepared.push({
      ...compactInteraction(interactionForWrite),
      created_by: actor.email,
      manager_id: managerId,
      logged_by_user_id: actor.id,
      idempotency_key: key,
      request_hash: requestHash,
      counts_toward_free_limit: false,
      counts_as_knock: true,
      source: "csv_history_import"
    });
  }
  const keys = prepared.map((item) => item.idempotency_key);
  const existing = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
    logged_by_user_id: actor.id,
    idempotency_key: keys
  }, "-created_date", prepared.length));
  const existingByKey = new Map(existing.map((item) => [item.idempotency_key, item]));
  for (const item of prepared) {
    const prior = existingByKey.get(item.idempotency_key);
    if (prior && prior.request_hash !== item.request_hash) {
      throw new HttpError(
        409,
        "idempotency_key_reused",
        "This import retry key was already used with different history."
      );
    }
  }
  const missing = prepared.filter((item) => !existingByKey.has(item.idempotency_key));
  if (missing.length > 0) {
    await base44.asServiceRole.entities.InteractionLog.bulkCreate(missing);
  }
  return {
    success: true,
    imported: missing.length,
    reused: prepared.length - missing.length
  };
}
function workflowRequest(body) {
  const routeId = requiredString(body.route_id, "route_id", 128);
  const workflowAction = requiredString(body.workflow_action, "workflow_action", 64).toUpperCase();
  const transition = WORKFLOW_TRANSITIONS[workflowAction];
  if (!transition) {
    throw new HttpError(400, "invalid_workflow_transition", "workflow_action is not supported.");
  }
  if (!Array.isArray(body.address_hashes) || body.address_hashes.length < 1 || body.address_hashes.length > 500) {
    throw new HttpError(
      400,
      "invalid_workflow_transition",
      "Workflow transitions require 1 to 500 address_hashes."
    );
  }
  const addressHashes = body.address_hashes.map((hash) => requiredString(hash, "address_hashes", 256)).sort();
  if (new Set(addressHashes).size !== addressHashes.length) {
    throw new HttpError(
      400,
      "invalid_workflow_transition",
      "address_hashes must not contain duplicates."
    );
  }
  return {
    routeId,
    addressHashes,
    workflowAction,
    transition,
    key: idempotencyKey(body.idempotency_key)
  };
}
function verifyWorkflowRouteOwner(actor, managerId, teamMember, route) {
  const assignedTo = String(route?.assigned_to || "").trim();
  const actorOwnsRoute = normalized3(route?.created_by) === normalized3(actor.email) || String(route?.manager_id || "") === String(actor.id);
  const assignedToActor = [actor.id, teamMember?.id].filter(Boolean).map(String).includes(assignedTo);
  if (!actorOwnsRoute && !assignedToActor && !isAdminActor(actor)) {
    throw new HttpError(
      403,
      "route_not_assigned",
      "This route is not owned by or assigned to the authenticated account."
    );
  }
  if (String(route?.manager_id || "").trim() && String(route.manager_id) !== String(managerId) && !isAdminActor(actor)) {
    throw new HttpError(403, "route_tenant_mismatch", "This route belongs to a different workspace.");
  }
  if (normalized3(route?.status) === "archived") {
    throw new HttpError(409, "route_archived", "Archived routes are read-only.");
  }
}
async function workflowTransition(base44, authenticatedUser, body) {
  const request = workflowRequest(body);
  const { actor, managerId, teamMember } = await resolveActorAndBillingUser(base44, authenticatedUser);
  const route = await loadVisibleRoute(base44, actor, managerId, request.routeId);
  verifyWorkflowRouteOwner(actor, managerId, teamMember, route);
  await verifyHashesOnRoute(base44, route, request.addressHashes);
  const requestHash = await sha256({
    source: "workflow_transition",
    route_id: request.routeId,
    address_hashes: request.addressHashes,
    workflow_action: request.workflowAction
  });
  let lease = null;
  try {
    lease = await acquireOutcomeLease(base44, actor.id);
    const existing = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
      logged_by_user_id: actor.id,
      idempotency_key: request.key
    }, "-created_date", 501));
    if (existing.some(
      (row) => row.source !== "workflow_transition" || String(row.request_hash || "") !== requestHash || String(row.route_id || "") !== request.routeId || String(row.workflow_action || "") !== request.workflowAction
    )) {
      throw new HttpError(
        409,
        "idempotency_key_reused",
        "This retry key was already used for a different workflow transition."
      );
    }
    const existingByHash = /* @__PURE__ */ new Map();
    for (const row of existing) {
      const hash = String(row.address_hash || "");
      if (!request.addressHashes.includes(hash) || existingByHash.has(hash)) {
        throw new HttpError(
          409,
          "idempotency_integrity_failed",
          "Workflow retry records require support review."
        );
      }
      existingByHash.set(hash, row);
    }
    const missingHashes = request.addressHashes.filter((hash) => !existingByHash.has(hash));
    const missingRows = missingHashes.map((addressHash) => ({
      address_hash: addressHash,
      raw_input_text: request.transition.rawInputText,
      parsed_status: request.transition.parsedStatus,
      route_id: request.routeId,
      created_by: actor.email,
      manager_id: managerId,
      logged_by_user_id: actor.id,
      idempotency_key: request.key,
      request_hash: requestHash,
      counts_toward_free_limit: false,
      counts_as_knock: false,
      workflow_action: request.workflowAction,
      workflow_bucket: request.transition.workflowBucket,
      source: "workflow_transition"
    }));
    const bulkResult = missingRows.length > 0 ? await base44.asServiceRole.entities.InteractionLog.bulkCreate(missingRows) : [];
    const created = asArray3(bulkResult);
    return {
      success: true,
      reused: missingRows.length === 0,
      workflow_action: request.workflowAction,
      workflow_bucket: request.transition.workflowBucket,
      updated_count: request.addressHashes.length,
      interactions: [
        ...existing,
        ...created.length === missingRows.length ? created : missingRows
      ]
    };
  } finally {
    await releaseOutcomeLease(base44, actor.id, lease);
  }
}
async function saveHouseNote(base44, authenticatedUser, body) {
  const addressHash = requiredString(body.address_hash, "address_hash", 256);
  const note = optionalString(body.note, "note", 1e3) || "";
  const routeId = optionalString(body.route_id, "route_id", 128);
  const { actor, managerId } = await resolveActorAndBillingUser(base44, authenticatedUser);
  if (routeId) {
    await verifyRouteAccess(base44, actor, managerId, {
      route_id: routeId,
      address_hash: addressHash
    });
  }
  const existing = asArray3(await base44.asServiceRole.entities.InteractionLog.filter({
    address_hash: addressHash,
    manager_id: managerId,
    source: "house_note"
  }, "-created_date", 1))[0] || null;
  const fields = {
    description: note,
    // address_hash, parsed_status and raw_input_text are required by the
    // InteractionLog schema, so they are written on updates too, not only on
    // create. ELIGIBLE is the "no decision was made" value — every status
    // derivation filters house notes out before reading it, so it is never
    // what the house displays.
    address_hash: addressHash,
    parsed_status: "ELIGIBLE",
    raw_input_text: note ? "House note updated" : "House note cleared",
    route_id: routeId || existing?.route_id || null,
    logged_by_user_id: actor.id,
    counts_toward_free_limit: false,
    counts_as_knock: false,
    // No workflow action is set — that enum describes administrative
    // transitions between route buckets, and a note is not one. No decision
    // field is set either, so this row can never read as an outcome.
    source: "house_note"
  };
  const saved = existing ? await base44.asServiceRole.entities.InteractionLog.update(existing.id, fields) : await base44.asServiceRole.entities.InteractionLog.create({
    ...fields,
    created_by: actor.email,
    manager_id: managerId
  });
  return { success: true, note: saved, address_hash: addressHash };
}
async function editSale(base44, authenticatedUser, body) {
  const allowedFields = /* @__PURE__ */ new Set([
    "action",
    "interaction_id",
    "parsed_status",
    "raw_input_text",
    "sale_amount"
  ]);
  const unexpectedFields = Object.keys(body || {}).filter((field) => !allowedFields.has(field));
  if (unexpectedFields.length > 0) {
    throw new HttpError(
      400,
      "invalid_sale_edit",
      "Sale edits may only change parsed_status, raw_input_text, and sale_amount."
    );
  }
  const interactionId = requiredString(body.interaction_id, "interaction_id", 128);
  const { actor, managerId } = await resolveActorAndBillingUser(base44, authenticatedUser);
  const existing = await base44.asServiceRole.entities.InteractionLog.get(interactionId).catch(() => null);
  if (!existing) {
    throw new HttpError(404, "interaction_not_found", "The sale interaction was not found.");
  }
  const isCreator = String(existing.logged_by_user_id || "") === String(actor.id) || normalized3(existing.created_by) === normalized3(actor.email);
  const isExactTenantManager = String(managerId) === String(actor.id) && String(existing.manager_id || "") === String(actor.id);
  if (!isCreator && !isExactTenantManager && !isAdminActor(actor)) {
    throw new HttpError(403, "sale_edit_denied", "This sale is outside the authenticated account scope.");
  }
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, "parsed_status")) {
    const parsedStatus = requiredString(body.parsed_status, "parsed_status", 32).toUpperCase();
    if (!OUTCOMES.has(parsedStatus)) {
      throw new HttpError(400, "invalid_sale_edit", "parsed_status is not supported.");
    }
    updates.parsed_status = parsedStatus;
    if (parsedStatus !== "SOLD" && !Object.prototype.hasOwnProperty.call(body, "sale_amount")) {
      updates.sale_amount = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "raw_input_text")) {
    updates.raw_input_text = requiredString(body.raw_input_text, "raw_input_text", 1e3);
  }
  if (Object.prototype.hasOwnProperty.call(body, "sale_amount")) {
    updates.sale_amount = optionalNumber(body.sale_amount, "sale_amount", 0, 1e8);
  }
  if (Object.keys(updates).length === 0) {
    throw new HttpError(
      400,
      "invalid_sale_edit",
      "Provide at least one supported sale field to update."
    );
  }
  const resultingStatus = String(updates.parsed_status || existing.parsed_status || "").toUpperCase();
  if (resultingStatus !== "SOLD" && updates.sale_amount !== null && updates.sale_amount !== void 0) {
    throw new HttpError(400, "invalid_sale_edit", "sale_amount is only valid for SOLD interactions.");
  }
  const updated = await base44.asServiceRole.entities.InteractionLog.update(interactionId, updates);
  return {
    success: true,
    interaction: updated || { ...existing, ...updates }
  };
}
Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) throw new HttpError(401, "unauthorized", "Unauthorized");
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "record").trim().toLowerCase();
    let result;
    if (action === "record") {
      result = await recordOne(base44, user, body, false);
    } else if (action === "clear_decision") {
      result = await recordOne(base44, user, body, true);
    } else if (action === "import_history") {
      result = await importHistory(base44, user, body);
    } else if (action === "workflow_transition") {
      result = await workflowTransition(base44, user, body);
    } else if (action === "save_house_note") {
      result = await saveHouseNote(base44, user, body);
    } else if (action === "edit_sale") {
      result = await editSale(base44, user, body);
    } else {
      throw new HttpError(400, "unsupported_action", "Unsupported outcome action.");
    }
    return Response.json(result);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error("recordKnockOutcome failed:", error?.message || error);
    }
    return Response.json({
      error: error?.message || "Unable to log outcome.",
      code: error?.code || "outcome_write_failed",
      ...error?.details ? error.details : {}
    }, { status: Number(error?.status || 500) });
  }
});
