const PAGE_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REACTIVATION_INACTIVITY_DAYS = 30;
const STRIPE_PAGE_SIZE = 100;
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const BLOCKING_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);
const PAYMENT_RECOVERY_STATUSES = new Set([
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);

type AnyRecord = Record<string, any>;

function asArray(value: any): AnyRecord[] {
  return Array.isArray(value)
    ? value
    : Array.isArray(value?.items)
    ? value.items
    : [];
}

function normalized(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function cleanString(value: any): string {
  return String(value || "").trim();
}

function timestamp(value: any): number {
  if (!value) return 0;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

function stripeTimestamp(value: any): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function isoFromMs(value: number): string {
  return Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : "";
}

function isoFromStripe(value: any): string {
  return isoFromMs(stripeTimestamp(value));
}

function firstNonEmpty(records: AnyRecord[], field: string): string {
  for (const record of records) {
    const value = cleanString(record?.[field]);
    if (value) return value;
  }
  return "";
}

function maxNumber(records: AnyRecord[], field: string): number {
  return records.reduce(
    (max, record) => Math.max(max, Number(record?.[field] || 0)),
    0,
  );
}

function anyTrue(records: AnyRecord[], field: string): boolean {
  return records.some((record) => record?.[field] === true);
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isReservedOrTestEmail(email: string): boolean {
  const [local = "", domain = ""] = normalized(email).split("@");
  const reservedDomain =
    ["example.com", "example.org", "example.net"].includes(domain) ||
    domain.endsWith(".test") ||
    domain.endsWith(".example") ||
    domain.endsWith(".invalid") ||
    domain === "localhost";
  const obviousTestLocal = /^(test|testing|demo|fake|sample|qa)([+._-]|\d|$)/
    .test(local);
  return reservedDomain || obviousTestLocal;
}

function isLiveTeamMember(member: AnyRecord): boolean {
  return !["inactive", "disabled", "deleted", "archived", "revoked"].includes(
    normalized(member?.status),
  );
}

function newestAccountTimestamp(record: AnyRecord): number {
  return Math.max(
    timestamp(record?.updated_date),
    timestamp(record?.created_date),
  );
}

function routePropertyCount(route: AnyRecord): number {
  return Array.isArray(route?.property_hashes)
    ? route.property_hashes.filter(Boolean).length
    : 0;
}

function isCanvasJob(job: AnyRecord): boolean {
  return normalized(job?.mode_tag) === "canvas_door" ||
    normalized(job?.provider) === "canvas" ||
    normalized(job?.phase) === "canvas_session";
}

function isPrecisionJob(job: AnyRecord): boolean {
  if (isCanvasJob(job)) return false;
  const mode = normalized(job?.mode_tag);
  const provider = normalized(job?.provider);
  return mode === "precision_target" || provider === "batchdata" ||
    Boolean(job?.precision_usage_user_id);
}

function isLegacyPrecisionJob(job: AnyRecord): boolean {
  if (isCanvasJob(job) || isPrecisionJob(job)) return false;
  const mode = normalized(job?.mode_tag);
  const provider = normalized(job?.provider);
  return mode === "legacy_rentcast" || provider === "rentcast";
}

function jobActivityTimestamp(job: AnyRecord): number {
  // Avoid updated_date: watchdog/system work can update a job without user activity.
  return Math.max(
    timestamp(job?.completed_at),
    timestamp(job?.started_at),
    timestamp(job?.created_date),
  );
}

function routeActivityTimestamp(route: AnyRecord): number {
  return Math.max(timestamp(route?.updated_date), timestamp(route?.created_date));
}

function interactionActivityTimestamp(interaction: AnyRecord): number {
  return Math.max(
    timestamp(interaction?.sale_date),
    timestamp(interaction?.created_date),
  );
}

function canvasActivityTimestamp(session: AnyRecord): number {
  return Math.max(
    timestamp(session?.closed_at),
    timestamp(session?.deployed_at),
    timestamp(session?.draft_saved_at),
    timestamp(session?.updated_date),
    timestamp(session?.created_date),
  );
}

function stripeObjectId(value: any): string {
  return typeof value === "string" ? value : cleanString(value?.id);
}

function invoiceHasPositivePayment(invoice: AnyRecord | null): boolean {
  return Boolean(invoice) && normalized(invoice?.status) === "paid" &&
    Number(invoice?.amount_paid || 0) > 0;
}

function invoiceCoversCurrentPeriod(
  subscription: AnyRecord,
  invoice: AnyRecord | null,
): boolean {
  if (!invoice) return false;
  const currentStart = Number(subscription?.current_period_start);
  if (!Number.isFinite(currentStart) || currentStart <= 0) return false;

  const lines = Array.isArray(invoice?.lines?.data)
    ? invoice.lines.data
    : [];
  if (lines.some((line: AnyRecord) => {
    const lineSubscription = stripeObjectId(line?.subscription);
    const start = Number(line?.period?.start);
    const end = Number(line?.period?.end);
    return (!lineSubscription || lineSubscription === subscription.id) &&
      Number.isFinite(start) && Number.isFinite(end) &&
      start <= currentStart && currentStart < end;
  })) return true;

  const start = Number(invoice?.period_start);
  const end = Number(invoice?.period_end);
  return Number.isFinite(start) && Number.isFinite(end) &&
    start <= currentStart && currentStart < end;
}

function subscriptionTier(subscription: AnyRecord): string {
  const price = subscription?.items?.data?.[0]?.price;
  const priceTier = normalized(price?.metadata?.subscription_tier);
  if (priceTier === "precision" || priceTier === "canvas") return priceTier;
  const subscriptionMetadataTier = normalized(
    subscription?.metadata?.subscription_tier,
  );
  if (subscriptionMetadataTier && subscriptionMetadataTier !== "custom") {
    return subscriptionMetadataTier === "growth"
      ? "precision"
      : subscriptionMetadataTier;
  }
  const amount = Number(price?.unit_amount || price?.unit_amount_decimal || 0);
  if (amount >= 9900) return "precision";
  if (amount >= 1900) return "canvas";
  return subscriptionMetadataTier || "custom";
}

function subscriptionMrrCents(subscription: AnyRecord): number {
  return (subscription?.items?.data || []).reduce(
    (sum: number, item: AnyRecord) => {
      const amount = Number(
        item?.price?.unit_amount || item?.price?.unit_amount_decimal || 0,
      );
      const quantity = Math.max(1, Number(item?.quantity || 1));
      const interval = normalized(item?.price?.recurring?.interval);
      const intervalCount = Math.max(
        1,
        Number(item?.price?.recurring?.interval_count || 1),
      );
      if (interval === "year") return sum + (amount * quantity) / (12 * intervalCount);
      if (interval === "week") return sum + (amount * quantity * 52) / (12 * intervalCount);
      if (interval === "day") return sum + (amount * quantity * 365) / (12 * intervalCount);
      return sum + (amount * quantity) / intervalCount;
    },
    0,
  );
}

function isStrictActivePaid(
  subscription: AnyRecord,
  expectedUserIds: Set<string>,
  nowMs: number,
): boolean {
  const metadataUserId = cleanString(subscription?.metadata?.base44_user_id);
  const invoice = typeof subscription?.latest_invoice === "object"
    ? subscription.latest_invoice
    : null;
  const invoiceSubscriptionId = stripeObjectId(invoice?.subscription);
  const trialEnded = !subscription?.trial_end ||
    stripeTimestamp(subscription.trial_end) <= nowMs;
  const currentStart = stripeTimestamp(subscription?.current_period_start);
  const currentEnd = stripeTimestamp(subscription?.current_period_end);
  return subscription?.livemode === true &&
    expectedUserIds.has(metadataUserId) &&
    normalized(subscription?.status) === "active" &&
    trialEnded &&
    currentStart > 0 && currentStart <= nowMs &&
    currentEnd > nowMs &&
    invoiceHasPositivePayment(invoice) &&
    (!invoiceSubscriptionId || invoiceSubscriptionId === subscription.id) &&
    invoiceCoversCurrentPeriod(subscription, invoice);
}

function activePaidFailureReasons(
  subscription: AnyRecord,
  knownIds: Set<string>,
  nowMs: number,
): string[] {
  const reasons: string[] = [];
  const metadataUserId = cleanString(subscription?.metadata?.base44_user_id);
  const invoice = typeof subscription?.latest_invoice === "object"
    ? subscription.latest_invoice
    : null;
  const invoiceSubscriptionId = stripeObjectId(invoice?.subscription);
  const currentStart = stripeTimestamp(subscription?.current_period_start);
  const currentEnd = stripeTimestamp(subscription?.current_period_end);
  if (subscription?.livemode !== true) reasons.push("not_live_mode");
  if (!metadataUserId) reasons.push("missing_base44_user_metadata");
  else if (!knownIds.has(metadataUserId)) reasons.push("metadata_user_not_found");
  if (normalized(subscription?.status) !== "active") reasons.push("status_not_active");
  if (subscription?.trial_end && stripeTimestamp(subscription.trial_end) > nowMs) {
    reasons.push("trial_not_ended");
  }
  if (!currentStart || currentStart > nowMs) reasons.push("current_period_not_started");
  if (!currentEnd || currentEnd <= nowMs) reasons.push("current_period_expired");
  if (!invoice) reasons.push("latest_invoice_not_expanded");
  else {
    if (normalized(invoice?.status) !== "paid") reasons.push("latest_invoice_not_paid");
    if (Number(invoice?.amount_paid || 0) <= 0) reasons.push("latest_invoice_not_positive");
    if (invoiceSubscriptionId && invoiceSubscriptionId !== subscription?.id) {
      reasons.push("latest_invoice_subscription_mismatch");
    }
    if (!invoiceCoversCurrentPeriod(subscription, invoice)) {
      reasons.push("invoice_does_not_cover_current_period");
    }
  }
  return reasons;
}

function subscriptionMatchSource(
  subscription: AnyRecord,
  ids: Set<string>,
  cachedSubscriptionIds: Set<string>,
  cachedCustomerIds: Set<string>,
): string {
  const metadataUserId = cleanString(subscription?.metadata?.base44_user_id);
  if (metadataUserId && ids.has(metadataUserId)) return "stripe_metadata_user_id";
  if (metadataUserId) return "metadata_points_elsewhere";
  if (cachedSubscriptionIds.has(cleanString(subscription?.id))) {
    return "base44_cached_subscription_id";
  }
  if (cachedCustomerIds.has(stripeObjectId(subscription?.customer))) {
    return "base44_cached_customer_id";
  }
  return "unmatched";
}

function linkedSubscription(
  subscription: AnyRecord,
  ids: Set<string>,
  cachedSubscriptionIds: Set<string>,
  cachedCustomerIds: Set<string>,
): boolean {
  const source = subscriptionMatchSource(
    subscription,
    ids,
    cachedSubscriptionIds,
    cachedCustomerIds,
  );
  return source === "stripe_metadata_user_id" ||
    source === "base44_cached_subscription_id" ||
    source === "base44_cached_customer_id";
}

function comma(values: any[]): string {
  return [...new Set(values.map(cleanString).filter(Boolean))].join(", ");
}

function maxTimestamp(values: number[]): number {
  return Math.max(0, ...values.filter((value) => Number.isFinite(value)));
}

function minTimestamp(values: number[]): number {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  return usable.length ? Math.min(...usable) : 0;
}

function daysSince(value: number, nowMs: number): number | null {
  return value > 0 ? Math.max(0, Math.floor((nowMs - value) / DAY_MS)) : null;
}

function failureCategory(job: AnyRecord | null): string {
  if (!job) return "";
  const status = normalized(job?.status);
  if (status === "cancelled") return "cancelled";
  const message = normalized(job?.error_message);
  if (!message) return status === "failed" ? "other_failure" : "";
  if (/timeout|watchdog|stale|timed out/.test(message)) return "timeout_or_stall";
  if (/payment|billing|allowance|quota|limit|subscription|invoice|card/.test(message)) {
    return "billing_or_allowance";
  }
  if (/polygon|area|zip|fips|geocod|location/.test(message)) return "area_selection";
  if (/no match|no propert|empty|zero result/.test(message)) return "no_matches";
  if (/auth|permission|unauthor|forbidden/.test(message)) return "access";
  if (/batchdata|provider|upstream|api/.test(message)) return "provider";
  return "other_failure";
}

async function listAll(
  entity: any,
  fields: string[],
  maxRecords: number,
  label: string,
): Promise<AnyRecord[]> {
  const records: AnyRecord[] = [];
  for (let skip = 0; skip < maxRecords; skip += PAGE_SIZE) {
    const page = asArray(await entity.list("-created_date", PAGE_SIZE, skip, fields));
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  throw new Error(`${label} exceeded the safe export limit of ${maxRecords}.`);
}

async function listStripeSubscriptions(secret: string): Promise<AnyRecord[]> {
  const subscriptions: AnyRecord[] = [];
  let startingAfter = "";
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const params = new URLSearchParams({ status: "all", limit: String(STRIPE_PAGE_SIZE) });
    params.append("expand[]", "data.latest_invoice");
    params.append("expand[]", "data.customer");
    if (startingAfter) params.set("starting_after", startingAfter);
    const response = await fetch(`${STRIPE_API_BASE}/subscriptions?${params.toString()}`, {
      // Match the Stripe SDK version pinned by FirstKnock's deployed billing code.
      headers: {
        Authorization: `Bearer ${secret}`,
        "Stripe-Version": "2023-10-16",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Stripe subscription export failed (${response.status}): ${body.slice(0, 240)}`);
    }
    const payload = await response.json();
    const page = Array.isArray(payload?.data) ? payload.data : [];
    subscriptions.push(...page);
    if (!payload?.has_more) return subscriptions;
    if (!page.length) throw new Error("Stripe pagination reported more data but returned an empty page.");
    startingAfter = cleanString(page[page.length - 1]?.id);
    if (!startingAfter) throw new Error("Stripe pagination could not determine starting_after.");
  }
  throw new Error("Stripe subscription export exceeded 1000 pages.");
}

const exportPath = Deno.env.get("FIRSTKNOCK_EXPORT_PATH");
const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY") || "";
if (!exportPath) throw new Error("FIRSTKNOCK_EXPORT_PATH is required.");
if (!stripeSecret.startsWith("sk_live_")) {
  throw new Error("A live-mode STRIPE_SECRET_KEY is required for the active-paying export.");
}

const [users, jobs, routes, teamMembers, interactions, canvasSessions, subscriptions] =
  await Promise.all([
    listAll(
      base44.entities.User,
      [
        "id", "email", "full_name", "role", "app_role", "is_owner",
        "team_manager_id", "disabled", "is_verified", "is_service",
        "created_date", "updated_date", "has_seen_onboarding",
        "has_defined_market", "has_pulled_data", "last_data_pull",
        "area_pulls_count", "territory_property_count", "homes_marked_count",
        "outcomes_logged", "subscription_status", "subscription_tier",
        "subscription_id", "subscription_paid_confirmed",
        "subscription_paid_confirmed_at", "subscription_period_start",
        "subscription_period_end", "subscription_plan_id", "stripe_customer_id",
        "stripe_card_on_file_confirmed", "total_seats", "first_paid_at",
        "first_paid_subscription_id", "first_paid_invoice_id",
      ],
      20000,
      "User export",
    ),
    listAll(
      base44.entities.FetchJob,
      [
        "id", "created_date", "updated_date", "created_by", "user_email",
        "precision_usage_user_id", "mode_tag", "provider", "status", "phase",
        "total_expected", "total_fetched", "total_inserted", "total_updated",
        "precision_usage_count", "precision_usage_kind",
        "precision_usage_recorded_at", "started_at", "completed_at",
        "error_message",
      ],
      100000,
      "FetchJob export",
    ),
    listAll(
      base44.entities.SavedRoute,
      [
        "id", "created_date", "updated_date", "created_by", "manager_id",
        "route_mode", "status", "property_hashes",
      ],
      100000,
      "SavedRoute export",
    ),
    listAll(
      base44.entities.TeamMember,
      [
        "id", "email", "user_id", "manager_id", "role", "status",
        "created_date", "updated_date",
      ],
      100000,
      "TeamMember export",
    ),
    listAll(
      base44.entities.InteractionLog,
      [
        "id", "created_by", "logged_by_user_id", "manager_id", "route_id",
        "source", "counts_as_knock", "sale_date", "created_date",
      ],
      100000,
      "InteractionLog export",
    ),
    listAll(
      base44.entities.CanvasSession,
      [
        "id", "created_by", "manager_id", "status", "lifecycle_state",
        "created_date", "updated_date", "draft_saved_at", "deployed_at", "closed_at",
      ],
      100000,
      "CanvasSession export",
    ),
    listStripeSubscriptions(stripeSecret),
  ]);

const nowMs = Date.now();
const generatedAt = new Date(nowMs).toISOString();
const inactivityCutoffMs = nowMs - REACTIVATION_INACTIVITY_DAYS * DAY_MS;

const userGroups = new Map<string, AnyRecord[]>();
for (const user of users) {
  const email = normalized(user?.email);
  if (!email) continue;
  const group = userGroups.get(email) || [];
  group.push(user);
  userGroups.set(email, group);
}

const knownUserIds = new Set(
  users.map((user) => cleanString(user?.id)).filter(Boolean),
);
const stripeSubscriptionById = new Map(
  subscriptions.map((subscription) => [cleanString(subscription?.id), subscription]),
);
const routeById = new Map(
  routes.map((route) => [cleanString(route?.id), route]),
);

const allAccounts: AnyRecord[] = [];
const activePaying: AnyRecord[] = [];
const reactivation: AnyRecord[] = [];
const billingReview: AnyRecord[] = [];
const holdsExclusions: AnyRecord[] = [];

for (const [email, rawAccounts] of userGroups.entries()) {
  const accounts = [...rawAccounts].sort((left, right) =>
    newestAccountTimestamp(right) - newestAccountTimestamp(left)
  );
  const ids = new Set(accounts.map((user) => cleanString(user?.id)).filter(Boolean));
  const cachedSubscriptionIds = new Set(
    accounts.map((user) => cleanString(user?.subscription_id)).filter(Boolean),
  );
  const cachedCustomerIds = new Set(
    accounts.map((user) => cleanString(user?.stripe_customer_id)).filter(Boolean),
  );
  const roles = new Set(accounts.map((user) => normalized(user?.app_role)).filter(Boolean));
  const platformRoles = new Set(accounts.map((user) => normalized(user?.role)).filter(Boolean));
  const matchingMembers = teamMembers.filter((member) =>
    ids.has(cleanString(member?.user_id)) || normalized(member?.email) === email
  );
  const liveMember = matchingMembers.some(isLiveTeamMember);

  const isInternal = accounts.some((user) => user?.is_owner === true) ||
    accounts.some((user) => user?.is_service === true) ||
    roles.has("admin") || platformRoles.has("admin");
  const isDisabled = accounts.some((user) => user?.disabled === true);
  const isRep = roles.has("rep") ||
    accounts.some((user) => Boolean(user?.team_manager_id)) || liveMember;
  const isUnverified = accounts.some((user) => user?.is_verified === false);
  const invalidEmail = !validEmail(email);
  const testEmail = isReservedOrTestEmail(email);
  const identityOkay = !isInternal && !isDisabled && !isRep && !isUnverified &&
    !invalidEmail && !testEmail;

  const linkedSubscriptions = subscriptions.filter((subscription) =>
    linkedSubscription(
      subscription,
      ids,
      cachedSubscriptionIds,
      cachedCustomerIds,
    )
  );
  const strictPaidSubscriptions = linkedSubscriptions.filter((subscription) =>
    isStrictActivePaid(subscription, ids, nowMs)
  );
  const linkedStatuses = new Set(
    linkedSubscriptions.map((subscription) => normalized(subscription?.status)).filter(Boolean),
  );
  const currentBlockingSubscriptions = linkedSubscriptions.filter((subscription) =>
    BLOCKING_SUBSCRIPTION_STATUSES.has(normalized(subscription?.status))
  );
  const activeWithoutProof = linkedSubscriptions.filter((subscription) =>
    normalized(subscription?.status) === "active" &&
    !isStrictActivePaid(subscription, ids, nowMs)
  );
  const trialSubscriptions = linkedSubscriptions.filter((subscription) =>
    normalized(subscription?.status) === "trialing"
  );
  const recoverySubscriptions = linkedSubscriptions.filter((subscription) =>
    PAYMENT_RECOVERY_STATUSES.has(normalized(subscription?.status))
  );
  const everPaid = accounts.some((user) => Boolean(user?.first_paid_at)) ||
    linkedSubscriptions.some((subscription) => {
      const invoice = typeof subscription?.latest_invoice === "object"
        ? subscription.latest_invoice
        : null;
      return invoiceHasPositivePayment(invoice);
    });

  const exactRoutes = routes.filter((route) => normalized(route?.created_by) === email);
  const corroborativeRoutes = routes.filter((route) =>
    normalized(route?.created_by) !== email && ids.has(cleanString(route?.manager_id))
  );
  const precisionRoutes = exactRoutes.filter((route) =>
    normalized(route?.route_mode) === "precision" && routePropertyCount(route) > 0
  );
  const weakPrecisionRoutes = corroborativeRoutes.filter((route) =>
    normalized(route?.route_mode) === "precision" && routePropertyCount(route) > 0
  );
  const canvasRoutes = exactRoutes.filter((route) =>
    normalized(route?.route_mode) === "canvas"
  );

  const strongPrecisionJobs = jobs.filter((job) => isPrecisionJob(job) && (
    ids.has(cleanString(job?.precision_usage_user_id)) ||
    normalized(job?.created_by) === email ||
    normalized(job?.user_email) === email
  ));
  const legacyPrecisionJobs = jobs.filter((job) => isLegacyPrecisionJob(job) && (
    normalized(job?.created_by) === email || normalized(job?.user_email) === email
  ));
  const canvasJobs = jobs.filter((job) => isCanvasJob(job) && (
    ids.has(cleanString(job?.precision_usage_user_id)) ||
    normalized(job?.created_by) === email || normalized(job?.user_email) === email
  ));
  const latestPrecisionJob = [...strongPrecisionJobs].sort(
    (left, right) => jobActivityTimestamp(right) - jobActivityTimestamp(left),
  )[0] || null;

  const ownedPrecisionRouteIds = new Set(
    precisionRoutes.map((route) => cleanString(route?.id)).filter(Boolean),
  );
  const precisionKnocks = interactions.filter((interaction) =>
    interaction?.counts_as_knock !== false &&
    normalized(interaction?.source) === "knock_mode" &&
    ownedPrecisionRouteIds.has(cleanString(interaction?.route_id)) &&
    (
      normalized(interaction?.created_by) === email ||
      ids.has(cleanString(interaction?.logged_by_user_id)) ||
      ids.has(cleanString(interaction?.manager_id))
    )
  );
  const directKnocks = interactions.filter((interaction) =>
    interaction?.counts_as_knock !== false &&
    normalized(interaction?.source) === "knock_mode" &&
    (
      normalized(interaction?.created_by) === email ||
      ids.has(cleanString(interaction?.logged_by_user_id))
    )
  );
  const matchingCanvasSessions = canvasSessions.filter((session) =>
    normalized(session?.created_by) === email || ids.has(cleanString(session?.manager_id))
  );

  const precisionRouteTimestamps = precisionRoutes.map(routeActivityTimestamp);
  const precisionJobTimestamps = strongPrecisionJobs.map(jobActivityTimestamp);
  const precisionKnockTimestamps = precisionKnocks.map(interactionActivityTimestamp);
  const legacyUserPullTimestamps = accounts.map((user) => timestamp(user?.last_data_pull));
  const firstPrecisionActivityMs = minTimestamp([
    ...precisionRouteTimestamps,
    ...precisionJobTimestamps,
    ...precisionKnockTimestamps,
  ]);
  const lastPrecisionActivityMs = maxTimestamp([
    ...precisionRouteTimestamps,
    ...precisionJobTimestamps,
    ...precisionKnockTimestamps,
  ]);
  const lastAnyProductActivityMs = maxTimestamp([
    lastPrecisionActivityMs,
    ...exactRoutes.map(routeActivityTimestamp),
    ...canvasRoutes.map(routeActivityTimestamp),
    ...canvasJobs.map(jobActivityTimestamp),
    ...directKnocks.map(interactionActivityTimestamp),
    ...matchingCanvasSessions.map(canvasActivityTimestamp),
  ]);
  const legacyActivityMs = maxTimestamp([
    ...legacyPrecisionJobs.map(jobActivityTimestamp),
    ...legacyUserPullTimestamps,
  ]);

  const deliveredPrecisionProperties = strongPrecisionJobs.reduce(
    (sum, job) => sum + Math.max(
      Number(job?.precision_usage_count || 0),
      Number(job?.total_inserted || 0),
      Number(job?.total_fetched || 0),
    ),
    0,
  );
  const hasStrongPrecisionEvidence = precisionRoutes.length > 0 ||
    precisionKnocks.length > 0 || strongPrecisionJobs.length > 0;
  const hasLegacyOnlyEvidence = !hasStrongPrecisionEvidence && (
    legacyPrecisionJobs.length > 0 || anyTrue(accounts, "has_pulled_data") ||
    maxNumber(accounts, "area_pulls_count") > 0 || weakPrecisionRoutes.length > 0
  );
  const recentAnyActivity = lastAnyProductActivityMs > inactivityCutoffMs;

  const createdAtMs = minTimestamp(accounts.map((user) => timestamp(user?.created_date)));
  const common = {
    primary_user_id: cleanString(accounts[0]?.id),
    all_user_ids: comma(accounts.map((user) => user?.id)),
    full_name: firstNonEmpty(accounts, "full_name"),
    email,
    account_created_at: isoFromMs(createdAtMs),
    days_since_signup: daysSince(createdAtMs, nowMs),
    duplicate_account_count: accounts.length,
    app_role: roles.size ? comma([...roles]) : "not selected",
    platform_role: comma([...platformRoles]),
    email_verified: isUnverified ? "no" : "not explicitly false",
    disabled: isDisabled,
    internal_account: isInternal,
    rep_or_team_member: isRep,
    team_member_match: matchingMembers.length > 0,
    has_seen_onboarding: anyTrue(accounts, "has_seen_onboarding"),
    has_defined_market: anyTrue(accounts, "has_defined_market"),
    has_pulled_data: anyTrue(accounts, "has_pulled_data"),
    area_pulls_count: maxNumber(accounts, "area_pulls_count"),
    territory_property_count: maxNumber(accounts, "territory_property_count"),
    homes_marked_count: maxNumber(accounts, "homes_marked_count"),
    outcomes_logged: maxNumber(accounts, "outcomes_logged"),
    base44_subscription_status: firstNonEmpty(accounts, "subscription_status"),
    base44_subscription_tier: firstNonEmpty(accounts, "subscription_tier"),
    base44_subscription_id: firstNonEmpty(accounts, "subscription_id"),
    base44_paid_confirmed_cache: anyTrue(accounts, "subscription_paid_confirmed"),
    base44_subscription_period_end: firstNonEmpty(accounts, "subscription_period_end"),
    stripe_customer_id: firstNonEmpty(accounts, "stripe_customer_id"),
    card_on_file_cache: anyTrue(accounts, "stripe_card_on_file_confirmed"),
    first_paid_at: firstNonEmpty(accounts, "first_paid_at"),
    ever_paid: everPaid,
    live_stripe_statuses: comma([...linkedStatuses]),
    live_stripe_subscription_count: linkedSubscriptions.length,
    actively_paying_live_verified: strictPaidSubscriptions.length > 0,
    active_paid_subscription_count: strictPaidSubscriptions.length,
    first_precision_activity_at: isoFromMs(firstPrecisionActivityMs),
    last_precision_activity_at: isoFromMs(lastPrecisionActivityMs),
    days_since_last_precision_activity: daysSince(lastPrecisionActivityMs, nowMs),
    last_any_product_activity_at: isoFromMs(lastAnyProductActivityMs),
    days_since_last_any_product_activity: daysSince(lastAnyProductActivityMs, nowMs),
    precision_job_count: strongPrecisionJobs.length,
    latest_precision_job_status: normalized(latestPrecisionJob?.status),
    latest_job_failure_category: failureCategory(latestPrecisionJob),
    precision_properties_delivered: deliveredPrecisionProperties,
    precision_route_count: precisionRoutes.length,
    precision_knock_count: precisionKnocks.length,
    legacy_precision_job_count: legacyPrecisionJobs.length,
    weak_manager_id_route_count: weakPrecisionRoutes.length,
    legacy_usage_signal: hasLegacyOnlyEvidence,
    recent_canvas_activity: maxTimestamp([
      ...canvasRoutes.map(routeActivityTimestamp),
      ...canvasJobs.map(jobActivityTimestamp),
      ...matchingCanvasSessions.map(canvasActivityTimestamp),
    ]) > inactivityCutoffMs,
    verified_at: generatedAt,
  };

  let lifecycleBucket = "customer_account_no_meaningful_use";
  let exclusionReason = "";
  if (isInternal) {
    lifecycleBucket = "excluded_internal";
    exclusionReason = "Owner, admin, or service account";
  } else if (isDisabled) {
    lifecycleBucket = "excluded_disabled";
    exclusionReason = "Disabled account";
  } else if (isRep) {
    lifecycleBucket = "excluded_rep";
    exclusionReason = "Rep or TeamMember account; manager owns the customer relationship";
  } else if (invalidEmail || testEmail) {
    lifecycleBucket = "excluded_test_or_invalid";
    exclusionReason = invalidEmail ? "Invalid email syntax" : "Reserved or obvious test email";
  } else if (isUnverified) {
    lifecycleBucket = "excluded_unverified";
    exclusionReason = "Authentication email is explicitly unverified";
  } else if (strictPaidSubscriptions.length > 0) {
    lifecycleBucket = "active_paying";
  } else if (trialSubscriptions.length > 0) {
    lifecycleBucket = "current_trial";
    exclusionReason = "Current trial; route to onboarding/customer success";
  } else if (recoverySubscriptions.length > 0 || activeWithoutProof.length > 0) {
    lifecycleBucket = "billing_review";
    exclusionReason = recoverySubscriptions.length
      ? `Current ${comma(recoverySubscriptions.map((subscription) => subscription?.status))} subscription`
      : "Stripe subscription is active but current positive-payment proof is incomplete";
  } else if (hasStrongPrecisionEvidence && recentAnyActivity) {
    lifecycleBucket = "recent_nonpaying_user";
    exclusionReason = `Product activity within the last ${REACTIVATION_INACTIVITY_DAYS} days`;
  } else if (hasStrongPrecisionEvidence) {
    lifecycleBucket = "reactivation_candidate";
  } else if (hasLegacyOnlyEvidence) {
    lifecycleBucket = "legacy_usage_manual_review";
    exclusionReason = "Only legacy or client-writable usage evidence is available";
  } else if (anyTrue(accounts, "has_seen_onboarding") || anyTrue(accounts, "has_defined_market")) {
    lifecycleBucket = "incomplete_onboarding";
  }

  allAccounts.push({
    ...common,
    lifecycle_bucket: lifecycleBucket,
    exclusion_reason: exclusionReason,
    suppression_join_status: "not joined",
    email_ready: false,
  });

  if (strictPaidSubscriptions.length > 0) {
    const invoiceRows = strictPaidSubscriptions.map((subscription) =>
      typeof subscription?.latest_invoice === "object" ? subscription.latest_invoice : null
    );
    const renewalEndMs = minTimestamp(
      strictPaidSubscriptions.map((subscription) => stripeTimestamp(subscription?.current_period_end)),
    );
    const billingUserIds = strictPaidSubscriptions.map((subscription) =>
      cleanString(subscription?.metadata?.base44_user_id)
    );
    const tierValues = strictPaidSubscriptions.map(subscriptionTier);
    const currencies = strictPaidSubscriptions.flatMap((subscription) =>
      (subscription?.items?.data || []).map((item: AnyRecord) => normalized(item?.price?.currency))
    );
    const cacheMismatch = strictPaidSubscriptions.some((subscription) =>
      cachedSubscriptionIds.size > 0 && !cachedSubscriptionIds.has(cleanString(subscription?.id))
    ) || accounts.some((user) => normalized(user?.subscription_status) !== "active");
    activePaying.push({
      customer_user_id: comma(billingUserIds),
      full_name: common.full_name,
      email,
      account_created_at: common.account_created_at,
      app_role: common.app_role,
      actively_paying: true,
      renewal_state: strictPaidSubscriptions.some((subscription) => subscription?.cancel_at_period_end === true)
        ? "canceling_at_period_end"
        : "renewing",
      tier: comma(tierValues),
      subscription_ids: comma(strictPaidSubscriptions.map((subscription) => subscription?.id)),
      stripe_customer_ids: comma(strictPaidSubscriptions.map((subscription) => stripeObjectId(subscription?.customer))),
      active_subscription_count: strictPaidSubscriptions.length,
      quantity: strictPaidSubscriptions.reduce((sum, subscription) =>
        sum + (subscription?.items?.data || []).reduce(
          (itemSum: number, item: AnyRecord) => itemSum + Math.max(1, Number(item?.quantity || 1)),
          0,
        ), 0),
      list_price_mrr: Math.round(strictPaidSubscriptions.reduce(
        (sum, subscription) => sum + subscriptionMrrCents(subscription),
        0,
      )) / 100,
      currency: comma(currencies).toUpperCase(),
      current_invoice_amount_paid: Math.round(invoiceRows.reduce(
        (sum, invoice) => sum + Number(invoice?.amount_paid || 0),
        0,
      )) / 100,
      current_period_start: isoFromMs(minTimestamp(
        strictPaidSubscriptions.map((subscription) => stripeTimestamp(subscription?.current_period_start)),
      )),
      current_period_end: isoFromMs(renewalEndMs),
      days_until_period_end: renewalEndMs > 0
        ? Math.max(0, Math.ceil((renewalEndMs - nowMs) / DAY_MS))
        : null,
      cancel_at_period_end: strictPaidSubscriptions.some((subscription) => subscription?.cancel_at_period_end === true),
      latest_invoice_ids: comma(invoiceRows.map((invoice) => invoice?.id)),
      latest_invoice_statuses: comma(invoiceRows.map((invoice) => invoice?.status)),
      ownership_verified: true,
      live_mode: true,
      invoice_covers_current_period: true,
      base44_cache_mismatch: cacheMismatch,
      duplicate_active_subscription_review: strictPaidSubscriptions.length > 1,
      first_paid_at: common.first_paid_at,
      payment_verified_at: generatedAt,
      source: "Live Stripe subscription + current positive paid invoice",
    });
  }

  const reviewReasons: string[] = [];
  if (trialSubscriptions.length) reviewReasons.push("current_trial");
  if (recoverySubscriptions.length) {
    reviewReasons.push(`payment_recovery_${comma(recoverySubscriptions.map((subscription) => subscription?.status))}`);
  }
  if (activeWithoutProof.length) reviewReasons.push("active_without_current_positive_invoice_proof");
  if (strictPaidSubscriptions.length > 1) reviewReasons.push("multiple_active_paid_subscriptions");
  if (!linkedSubscriptions.length && normalized(common.base44_subscription_status) &&
    BLOCKING_SUBSCRIPTION_STATUSES.has(normalized(common.base44_subscription_status))) {
    reviewReasons.push("base44_blocking_status_without_linked_live_subscription");
  }
  if (reviewReasons.length) {
    billingReview.push({
      user_id: common.primary_user_id,
      full_name: common.full_name,
      email,
      account_created_at: common.account_created_at,
      review_reason: reviewReasons.join("; "),
      base44_subscription_status: common.base44_subscription_status,
      live_stripe_statuses: common.live_stripe_statuses,
      subscription_ids: comma(linkedSubscriptions.map((subscription) => subscription?.id)),
      tier: comma(linkedSubscriptions.map(subscriptionTier)),
      current_period_end: isoFromMs(maxTimestamp(
        linkedSubscriptions.map((subscription) => stripeTimestamp(subscription?.current_period_end)),
      )),
      cancel_at_period_end: linkedSubscriptions.some((subscription) => subscription?.cancel_at_period_end === true),
      actively_paying_live_verified: strictPaidSubscriptions.length > 0,
      recommended_action: strictPaidSubscriptions.length > 1
        ? "Review duplicate billing; retain customer-success ownership."
        : trialSubscriptions.length
        ? "Route to onboarding/customer success, not a reactivation campaign."
        : recoverySubscriptions.length
        ? "Route to billing recovery/customer success, not a product reactivation campaign."
        : "Reconcile Stripe ownership and current invoice evidence before classifying.",
      verified_at: generatedAt,
    });
  }

  if (lifecycleBucket === "reactivation_candidate" && identityOkay) {
    const ageDays = daysSince(lastPrecisionActivityMs, nowMs) ?? 99999;
    const provenUse = precisionRoutes.length > 0 || precisionKnocks.length > 0;
    const deliveredUse = deliveredPrecisionProperties > 0;
    let priority = "P4";
    let cohort = "reactivate_attempted";
    let reasonCode = "precision_attempt_dormant";
    let evidenceStrength = "medium";
    if (everPaid && ageDays <= 365) {
      priority = "P1";
      cohort = "reactivate_churned_paid";
      reasonCode = "former_payer_with_precision_use";
      evidenceStrength = provenUse || deliveredUse ? "high" : "medium";
    } else if (provenUse && ageDays <= 180) {
      priority = "P2";
      cohort = "reactivate_proven_user";
      reasonCode = precisionKnocks.length > 0
        ? "previous_precision_knocking"
        : "previous_precision_route";
      evidenceStrength = "high";
    } else if ((deliveredUse && ageDays <= 180) || (provenUse && ageDays <= 365)) {
      priority = "P3";
      cohort = "reactivate_imported";
      reasonCode = deliveredUse
        ? "precision_data_delivered_no_recent_use"
        : "older_proven_precision_use";
      evidenceStrength = deliveredUse ? "high" : "medium";
    } else if (ageDays > 365) {
      reasonCode = "precision_use_over_one_year_ago";
    } else if (normalized(latestPrecisionJob?.status) === "failed") {
      reasonCode = `precision_job_failed_${failureCategory(latestPrecisionJob) || "unknown"}`;
    }

    const recommendedAngle = priority === "P1"
      ? "Acknowledge they used or paid for an earlier FirstKnock version; explain that the final production release is ready and invite them back for a guided retry."
      : priority === "P2"
      ? "Reference their prior route or field use; explain that the final production release is ready and offer a quick walkthrough of the finished workflow."
      : priority === "P3"
      ? "Reference the earlier Precision data pull; explain that route generation is now production-ready and invite them to try the completed experience."
      : "Use a low-pressure, support-oriented note about the final production release; manually review the earlier attempt before sending.";

    reactivation.push({
      user_id: common.primary_user_id,
      full_name: common.full_name,
      email,
      account_created_at: common.account_created_at,
      app_role: common.app_role,
      priority,
      reactivation_cohort: cohort,
      reason_code: reasonCode,
      evidence_strength: evidenceStrength,
      ever_paid: everPaid,
      first_paid_at: common.first_paid_at,
      previous_live_stripe_statuses: common.live_stripe_statuses,
      first_precision_activity_at: common.first_precision_activity_at,
      last_precision_activity_at: common.last_precision_activity_at,
      days_since_last_precision_activity: common.days_since_last_precision_activity,
      last_any_product_activity_at: common.last_any_product_activity_at,
      days_since_last_any_product_activity: common.days_since_last_any_product_activity,
      precision_job_count: common.precision_job_count,
      latest_precision_job_status: common.latest_precision_job_status,
      latest_job_failure_category: common.latest_job_failure_category,
      precision_properties_delivered: common.precision_properties_delivered,
      precision_route_count: common.precision_route_count,
      precision_knock_count: common.precision_knock_count,
      recommended_email_angle: recommendedAngle,
      suppression_join_status: "not joined",
      email_ready: false,
      required_before_send: "Join deletion requests and ESP unsubscribe, complaint, and hard-bounce suppressions; then manually approve the campaign.",
      verified_at: generatedAt,
    });
  } else if (lifecycleBucket.startsWith("excluded_") ||
    lifecycleBucket === "recent_nonpaying_user" ||
    lifecycleBucket === "legacy_usage_manual_review") {
    holdsExclusions.push({
      user_id: common.primary_user_id,
      full_name: common.full_name,
      email,
      account_created_at: common.account_created_at,
      hold_or_exclusion: lifecycleBucket,
      reason: exclusionReason,
      last_any_product_activity_at: common.last_any_product_activity_at,
      days_since_last_any_product_activity: common.days_since_last_any_product_activity,
      precision_job_count: common.precision_job_count,
      precision_route_count: common.precision_route_count,
      precision_knock_count: common.precision_knock_count,
      legacy_usage_signal: common.legacy_usage_signal,
      email_ready: false,
      verified_at: generatedAt,
    });
  }
}

for (const subscription of subscriptions) {
  const metadataUserId = cleanString(subscription?.metadata?.base44_user_id);
  const customer = typeof subscription?.customer === "object" ? subscription.customer : null;
  const status = normalized(subscription?.status);
  const needsReview = BLOCKING_SUBSCRIPTION_STATUSES.has(status) &&
    (!metadataUserId || !knownUserIds.has(metadataUserId));
  if (!needsReview) continue;
  const invoice = typeof subscription?.latest_invoice === "object"
    ? subscription.latest_invoice
    : null;
  billingReview.push({
    user_id: metadataUserId,
    full_name: cleanString(customer?.name),
    email: normalized(customer?.email),
    account_created_at: "",
    review_reason: metadataUserId
      ? "stripe_subscription_metadata_user_not_found_in_base44"
      : "stripe_subscription_missing_base44_user_metadata",
    base44_subscription_status: "",
    live_stripe_statuses: status,
    subscription_ids: cleanString(subscription?.id),
    tier: subscriptionTier(subscription),
    current_period_end: isoFromStripe(subscription?.current_period_end),
    cancel_at_period_end: subscription?.cancel_at_period_end === true,
    actively_paying_live_verified: false,
    recommended_action: invoiceHasPositivePayment(invoice)
      ? "Reconcile Stripe ownership metadata before counting this subscription as a paying customer."
      : "Reconcile Stripe ownership and invoice state before outreach.",
    verified_at: generatedAt,
  });
}

allAccounts.sort((left, right) =>
  left.lifecycle_bucket.localeCompare(right.lifecycle_bucket) ||
  left.email.localeCompare(right.email)
);
activePaying.sort((left, right) => left.email.localeCompare(right.email));
reactivation.sort((left, right) =>
  left.priority.localeCompare(right.priority) ||
  Number(left.days_since_last_precision_activity || 0) -
    Number(right.days_since_last_precision_activity || 0) ||
  left.email.localeCompare(right.email)
);
billingReview.sort((left, right) =>
  left.review_reason.localeCompare(right.review_reason) ||
  left.email.localeCompare(right.email)
);
holdsExclusions.sort((left, right) =>
  left.hold_or_exclusion.localeCompare(right.hold_or_exclusion) ||
  left.email.localeCompare(right.email)
);

const customerAccounts = allAccounts.filter((row) =>
  !String(row.lifecycle_bucket).startsWith("excluded_")
);
const bucketCounts: Record<string, number> = {};
for (const row of allAccounts) {
  bucketCounts[row.lifecycle_bucket] = (bucketCounts[row.lifecycle_bucket] || 0) + 1;
}
const priorityCounts: Record<string, number> = {};
for (const row of reactivation) {
  priorityCounts[row.priority] = (priorityCounts[row.priority] || 0) + 1;
}
const stripeStatusCounts: Record<string, number> = {};
const activeStripeProofFailureCounts: Record<string, number> = {};
let globallyVerifiedActivePaidSubscriptions = 0;
for (const subscription of subscriptions) {
  const status = normalized(subscription?.status) || "unknown";
  stripeStatusCounts[status] = (stripeStatusCounts[status] || 0) + 1;
  if (status !== "active") continue;
  const metadataUserId = cleanString(subscription?.metadata?.base44_user_id);
  const expected = new Set(metadataUserId ? [metadataUserId] : []);
  if (isStrictActivePaid(subscription, expected, nowMs) && knownUserIds.has(metadataUserId)) {
    globallyVerifiedActivePaidSubscriptions += 1;
    continue;
  }
  for (const reason of activePaidFailureReasons(subscription, knownUserIds, nowMs)) {
    activeStripeProofFailureCounts[reason] =
      (activeStripeProofFailureCounts[reason] || 0) + 1;
  }
}

const payload = {
  generated_at: generatedAt,
  data_environment: "production",
  stripe_mode: "live",
  precision_only_reactivation: true,
  reactivation_inactivity_days: REACTIVATION_INACTIVITY_DAYS,
  email_ready: false,
  safety_note: "No outreach row is send-ready until deletion requests and ESP unsubscribe, complaint, and hard-bounce suppressions are joined.",
  source_counts: {
    base44_users: users.length,
    unique_user_emails: userGroups.size,
    users_without_email: users.filter((user) => !normalized(user?.email)).length,
    fetch_jobs: jobs.length,
    saved_routes: routes.length,
    team_members: teamMembers.length,
    interaction_logs: interactions.length,
    canvas_sessions: canvasSessions.length,
    stripe_subscriptions_all_statuses: subscriptions.length,
  },
  bucket_counts: bucketCounts,
  reactivation_priority_counts: priorityCounts,
  stripe_status_counts: stripeStatusCounts,
  globally_verified_active_paid_subscription_count: globallyVerifiedActivePaidSubscriptions,
  active_stripe_proof_failure_counts: activeStripeProofFailureCounts,
  active_paying_count: activePaying.length,
  customer_account_count: customerAccounts.length,
  reactivation_candidate_count: reactivation.length,
  billing_review_count: billingReview.length,
  holds_exclusions_count: holdsExclusions.length,
  active_paying: activePaying,
  reactivation_candidates: reactivation,
  billing_review: billingReview,
  customer_accounts: customerAccounts,
  holds_exclusions: holdsExclusions,
  source_data: allAccounts,
};

await Deno.writeTextFile(exportPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({
  ok: true,
  generated_at: generatedAt,
  source_counts: payload.source_counts,
  active_paying_count: activePaying.length,
  customer_account_count: customerAccounts.length,
  reactivation_candidate_count: reactivation.length,
  billing_review_count: billingReview.length,
  holds_exclusions_count: holdsExclusions.length,
  bucket_counts: bucketCounts,
  priority_counts: priorityCounts,
  stripe_status_counts: stripeStatusCounts,
  globally_verified_active_paid_subscription_count: globallyVerifiedActivePaidSubscriptions,
  active_stripe_proof_failure_counts: activeStripeProofFailureCounts,
}));
