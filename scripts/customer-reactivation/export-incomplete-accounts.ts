const PAGE_SIZE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SIGNUP_GRACE_MS = 24 * HOUR_MS;
const ACTIVE_JOB_GRACE_MS = HOUR_MS;

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

function timestamp(value: any): number {
  const parsed = new Date(String(value || ""));
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

function newestTimestamp(record: AnyRecord): number {
  return Math.max(
    timestamp(record?.updated_date),
    timestamp(record?.completed_at),
    timestamp(record?.started_at),
    timestamp(record?.created_date),
  );
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

function firstNonEmpty(records: AnyRecord[], field: string): string {
  for (const record of records) {
    const value = String(record?.[field] || "").trim();
    if (value) return value;
  }
  return "";
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isReservedOrTestEmail(email: string): boolean {
  const [local = "", domain = ""] = email.split("@");
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

function isPrecisionJob(job: AnyRecord): boolean {
  const mode = normalized(job?.mode_tag);
  const provider = normalized(job?.provider);
  if (mode === "canvas_door" || provider === "canvas") return false;
  return mode === "precision_target" ||
    provider === "batchdata" ||
    Boolean(job?.precision_usage_user_id);
}

function isPaid(user: AnyRecord): boolean {
  return Boolean(user?.first_paid_at) ||
    (
      user?.subscription_paid_confirmed === true &&
      normalized(user?.subscription_status) === "active"
    );
}

function isLiveTeamMember(member: AnyRecord): boolean {
  return !["inactive", "disabled", "deleted", "archived", "revoked"].includes(
    normalized(member?.status),
  );
}

function categorizeFailure(message: any, status: string): string {
  if (status === "cancelled") return "cancelled_by_user_or_system";
  const text = normalized(message);
  if (!text) return status === "failed" ? "other_failure" : "";
  if (/timeout|watchdog|stale|timed out/.test(text)) return "timeout_or_stall";
  if (
    /payment|billing|allowance|quota|limit|subscription|invoice|card/.test(text)
  ) {
    return "billing_or_allowance";
  }
  if (/polygon|area|zip|fips|geocod|location/.test(text)) {
    return "area_selection";
  }
  if (/no match|no propert|empty|zero result/.test(text)) return "no_matches";
  if (/auth|permission|unauthor|forbidden/.test(text)) return "access";
  if (/batchdata|provider|upstream|api/.test(text)) return "provider";
  return "other_failure";
}

function reasonDetails(reason: string): { angle: string; action: string } {
  const details: Record<string, { angle: string; action: string }> = {
    signup_no_role: {
      angle: "Offer help choosing the manager setup and reaching the map.",
      action:
        "Check deletion and email-provider suppressions, then send a short reactivation email.",
    },
    signup_no_role_with_import: {
      angle:
        "Their account state is inconsistent; ask whether they want help completing setup.",
      action: "Review manually before any outreach.",
    },
    manager_no_market: {
      angle: "Offer a two-minute walkthrough for drawing the first market.",
      action:
        "Check deletion and email-provider suppressions, then send a setup-help email.",
    },
    drawing_started_no_import: {
      angle: "Help finish area selection and start the first Precision pull.",
      action:
        "Check deletion and email-provider suppressions, then send a setup-help email.",
    },
    import_stale_pending: {
      angle:
        "Acknowledge that setup appears stuck and offer to troubleshoot the pull.",
      action:
        "Review the latest job before outreach; do not restart it automatically.",
    },
    import_failed: {
      angle: "Acknowledge the setup snag and offer hands-on troubleshooting.",
      action:
        "Review the failure category, check suppressions, then send a support-oriented email.",
    },
    import_cancelled: {
      angle:
        "Ask whether they want help restarting with a smaller or different area.",
      action: "Check suppressions, then send a low-pressure setup-help email.",
    },
    import_completed_no_matches: {
      angle:
        "Help refine the selected area or filters so the first pull returns matches.",
      action: "Check suppressions, then send a results-help email.",
    },
    import_completed_no_route: {
      angle:
        "Properties arrived; offer help finishing and saving the first route.",
      action:
        "Prioritize for product-support outreach after suppression checks.",
    },
    legacy_pull_no_route: {
      angle:
        "Help turn the previously imported data into the first saved route.",
      action: "Review the legacy account state before support outreach.",
    },
    import_active_fresh: {
      angle:
        "The import is still recent and may complete without intervention.",
      action: "Hold; recheck after the active-job grace period.",
    },
    import_unknown_no_route: {
      angle:
        "The import state needs a manual check before contacting the account.",
      action: "Review manually before any outreach.",
    },
  };
  return details[reason] || {
    angle: "Offer help completing the first Precision route.",
    action: "Review manually before any outreach.",
  };
}

async function listAll(
  entity: any,
  fields: string[],
  maxRecords: number,
  label: string,
): Promise<AnyRecord[]> {
  const records: AnyRecord[] = [];
  for (let skip = 0; skip < maxRecords; skip += PAGE_SIZE) {
    const page = asArray(
      await entity.list("-created_date", PAGE_SIZE, skip, fields),
    );
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
  throw new Error(`${label} exceeded the safe export limit of ${maxRecords}.`);
}

const exportPath = Deno.env.get("FIRSTKNOCK_EXPORT_PATH");
if (!exportPath) throw new Error("FIRSTKNOCK_EXPORT_PATH is required.");

const [users, jobs, rawRoutes, teamMembers, interactions] = await Promise.all([
  listAll(
    base44.entities.User,
    [
      "id",
      "email",
      "full_name",
      "role",
      "app_role",
      "is_owner",
      "team_manager_id",
      "disabled",
      "is_verified",
      "is_service",
      "created_date",
      "updated_date",
      "has_seen_onboarding",
      "has_defined_market",
      "has_pulled_data",
      "last_data_pull",
      "area_pulls_count",
      "territory_property_count",
      "subscription_status",
      "subscription_paid_confirmed",
      "first_paid_at",
      "stripe_customer_id",
      "stripe_subscription_id",
    ],
    20000,
    "User export",
  ),
  listAll(
    base44.entities.FetchJob,
    [
      "id",
      "created_date",
      "updated_date",
      "created_by",
      "user_email",
      "precision_usage_user_id",
      "mode_tag",
      "provider",
      "status",
      "phase",
      "progress_pct",
      "total_expected",
      "total_fetched",
      "total_inserted",
      "total_updated",
      "precision_usage_count",
      "started_at",
      "completed_at",
      "error_message",
    ],
    100000,
    "FetchJob export",
  ),
  listAll(
    base44.entities.SavedRoute,
    [
      "id",
      "created_date",
      "updated_date",
      "created_by",
      "manager_id",
      "route_mode",
      "status",
      "property_hashes",
    ],
    100000,
    "SavedRoute export",
  ),
  listAll(
    base44.entities.TeamMember,
    [
      "id",
      "email",
      "user_id",
      "manager_id",
      "role",
      "status",
      "created_date",
      "updated_date",
    ],
    100000,
    "TeamMember export",
  ),
  listAll(
    base44.entities.InteractionLog,
    [
      "id",
      "created_by",
      "logged_by_user_id",
      "counts_as_knock",
      "created_date",
    ],
    100000,
    "InteractionLog export",
  ),
]);

const routes = rawRoutes.map((route) => ({
  ...route,
  property_count: Array.isArray(route?.property_hashes)
    ? route.property_hashes.filter(Boolean).length
    : 0,
  property_hashes: undefined,
}));

const groups = new Map<string, AnyRecord[]>();
for (const user of users) {
  const email = normalized(user?.email);
  if (!email) continue;
  const current = groups.get(email) || [];
  current.push(user);
  groups.set(email, current);
}

const now = Date.now();
const rows: AnyRecord[] = [];
const globalCounts: Record<string, number> = {
  users: users.length,
  unique_emails: groups.size,
  users_without_email: users.filter((user) => !normalized(user?.email)).length,
  jobs: jobs.length,
  routes: routes.length,
  team_members: teamMembers.length,
  interactions: interactions.length,
};

for (const [email, accountRecords] of groups.entries()) {
  const accounts = [...accountRecords].sort((left, right) => (
    newestTimestamp(right) - newestTimestamp(left)
  ));
  const ids = new Set(
    accounts.map((user) => String(user?.id || "")).filter(Boolean),
  );
  const roles = new Set(
    accounts.map((user) => normalized(user?.app_role)).filter(Boolean),
  );
  const platformRoles = new Set(
    accounts.map((user) => normalized(user?.role)).filter(Boolean),
  );
  const createdValues = accounts.map((user) => timestamp(user?.created_date))
    .filter(Boolean);
  const createdAtMs = createdValues.length ? Math.min(...createdValues) : 0;
  const createdAt = createdAtMs ? new Date(createdAtMs).toISOString() : "";
  const accountAgeMs = createdAtMs
    ? now - createdAtMs
    : Number.POSITIVE_INFINITY;

  const matchingMembers = teamMembers.filter((member) => (
    ids.has(String(member?.user_id || "")) ||
    normalized(member?.email) === email
  ));
  const liveMember = matchingMembers.some(isLiveTeamMember);

  const matchingRoutes = routes.filter((route) => (
    normalized(route?.created_by) === email ||
    ids.has(String(route?.manager_id || ""))
  ));
  const usableRoutes = matchingRoutes.filter((route) =>
    Number(route?.property_count || 0) > 0
  );
  const precisionRoutes = usableRoutes.filter((route) =>
    normalized(route?.route_mode) !== "canvas"
  );

  const matchingJobs = jobs.filter((job) =>
    isPrecisionJob(job) && (
      ids.has(String(job?.precision_usage_user_id || "")) ||
      normalized(job?.user_email) === email ||
      normalized(job?.created_by) === email
    )
  ).sort((left, right) => newestTimestamp(right) - newestTimestamp(left));
  const latestJob = matchingJobs[0] || null;
  const latestJobStatus = normalized(latestJob?.status);
  const latestJobAgeMs = latestJob ? now - newestTimestamp(latestJob) : 0;

  const directInteractions = interactions.filter((interaction) => (
    interaction?.counts_as_knock !== false &&
    (
      normalized(interaction?.created_by) === email ||
      ids.has(String(interaction?.logged_by_user_id || ""))
    )
  ));

  const isAdmin = accounts.some((user) => user?.is_owner === true) ||
    roles.has("admin") ||
    platformRoles.has("admin");
  const isService = accounts.some((user) => user?.is_service === true);
  const isDisabled = accounts.some((user) => user?.disabled === true);
  const isRep = roles.has("rep") ||
    accounts.some((user) => Boolean(user?.team_manager_id)) ||
    liveMember;
  const manager = roles.has("manager");
  const hasNoAppRole = roles.size === 0;
  const hasPaidAccount = accounts.some(isPaid);
  const invalidEmail = !validEmail(email);
  const testEmail = isReservedOrTestEmail(email);
  const unverifiedEmail = accounts.some((user) => user?.is_verified === false);
  const hasUsableRoute = usableRoutes.length > 0;
  const hasDirectProductActivity = directInteractions.length > 0;

  let cohort = "";
  let reason = "";
  if (hasNoAppRole && !isRep && !hasUsableRoute) {
    cohort = "A — Signup stopped before customer workspace setup";
    reason = matchingJobs.length
      ? "signup_no_role_with_import"
      : "signup_no_role";
  } else if (manager && !hasUsableRoute) {
    cohort = "B — Manager stopped before first Precision route";
    if (!latestJob) {
      if (anyTrue(accounts, "has_pulled_data")) reason = "legacy_pull_no_route";
      else if (anyTrue(accounts, "has_defined_market")) {
        reason = "drawing_started_no_import";
      } else reason = "manager_no_market";
    } else if (["pending", "running"].includes(latestJobStatus)) {
      reason = latestJobAgeMs <= ACTIVE_JOB_GRACE_MS
        ? "import_active_fresh"
        : "import_stale_pending";
    } else if (latestJobStatus === "failed") reason = "import_failed";
    else if (latestJobStatus === "cancelled") reason = "import_cancelled";
    else if (latestJobStatus === "completed") {
      reason = Number(latestJob?.precision_usage_count || 0) > 0
        ? "import_completed_no_route"
        : "import_completed_no_matches";
    } else reason = "import_unknown_no_route";
  } else {
    continue;
  }

  let reviewBucket = "campaign_review";
  let suppressionReason =
    "Deletion/opt-out/bounce/complaint check not available in app data";
  if (isAdmin || isService) {
    reviewBucket = "excluded_internal";
    suppressionReason = "Owner, admin, or service account";
  } else if (isDisabled) {
    reviewBucket = "excluded_disabled";
    suppressionReason = "Disabled account";
  } else if (isRep) {
    reviewBucket = "excluded_rep";
    suppressionReason = "Rep or active TeamMember account";
  } else if (invalidEmail || testEmail) {
    reviewBucket = "excluded_test_or_invalid";
    suppressionReason = invalidEmail
      ? "Invalid email syntax"
      : "Reserved or obvious test email";
  } else if (hasDirectProductActivity) {
    reviewBucket = "excluded_active_product_use";
    suppressionReason =
      "Direct door activity exists despite no persisted usable route";
  } else if (accountAgeMs < SIGNUP_GRACE_MS) {
    reviewBucket = "hold_recent_signup";
    suppressionReason = "Account is less than 24 hours old";
  } else if (reason === "import_active_fresh") {
    reviewBucket = "hold_active_import";
    suppressionReason = "Precision import updated within the last 60 minutes";
  } else if (hasPaidAccount) {
    reviewBucket = "customer_success_review";
    suppressionReason =
      "Paid account; route to customer success, not a general reactivation blast";
  } else if (
    unverifiedEmail || reason === "signup_no_role_with_import" ||
    reason === "import_unknown_no_route"
  ) {
    reviewBucket = "manual_review";
    suppressionReason = unverifiedEmail
      ? "Authentication email is explicitly unverified"
      : "Inconsistent or unknown account state";
  }

  const latestDelivered = Number(latestJob?.precision_usage_count || 0);
  const detail = reasonDetails(reason);
  const bucketAction = reviewBucket === "excluded_active_product_use"
    ? "Do not include in the reactivation campaign; verify the active account context first."
    : reviewBucket === "excluded_rep"
    ? "Do not email as a customer dropout; this is a rep or team-member account."
    : reviewBucket.startsWith("excluded_")
    ? "Keep out of outreach."
    : reviewBucket.startsWith("hold_")
    ? "Hold and recheck the account state before any outreach."
    : detail.action;
  rows.push({
    primary_user_id: String(accounts[0]?.id || ""),
    full_name: firstNonEmpty(accounts, "full_name"),
    email,
    created_at: createdAt,
    days_since_signup: createdAtMs
      ? Math.floor((now - createdAtMs) / DAY_MS)
      : null,
    account_count: accounts.length,
    app_role: manager
      ? "manager"
      : hasNoAppRole
      ? "not selected"
      : [...roles].join(", "),
    email_verified: unverifiedEmail ? "no" : "not explicitly false",
    has_seen_onboarding: anyTrue(accounts, "has_seen_onboarding"),
    has_defined_market: anyTrue(accounts, "has_defined_market"),
    has_pulled_data: anyTrue(accounts, "has_pulled_data"),
    last_data_pull: firstNonEmpty(accounts, "last_data_pull"),
    area_pulls_count: maxNumber(accounts, "area_pulls_count"),
    territory_property_count: maxNumber(accounts, "territory_property_count"),
    subscription_status: firstNonEmpty(accounts, "subscription_status"),
    stripe_customer_started: accounts.some((user) =>
      Boolean(user?.stripe_customer_id)
    ),
    paid_account: hasPaidAccount,
    precision_job_count: matchingJobs.length,
    latest_precision_job_id: String(latestJob?.id || ""),
    latest_precision_job_status: latestJobStatus,
    latest_precision_job_phase: normalized(latestJob?.phase),
    latest_precision_job_updated_at: latestJob
      ? new Date(newestTimestamp(latestJob)).toISOString()
      : "",
    latest_precision_job_age_minutes: latestJob
      ? Math.max(0, Math.floor(latestJobAgeMs / 60000))
      : null,
    precision_properties_delivered: latestDelivered,
    latest_job_total_fetched: Number(latestJob?.total_fetched || 0),
    latest_job_total_inserted: Number(latestJob?.total_inserted || 0),
    latest_job_progress_pct: Number(latestJob?.progress_pct || 0),
    latest_job_failure_category: categorizeFailure(
      latestJob?.error_message,
      latestJobStatus,
    ),
    usable_route_count: usableRoutes.length,
    precision_route_count: precisionRoutes.length,
    direct_interaction_count: directInteractions.length,
    cohort,
    reason_code: reason,
    review_bucket: reviewBucket,
    email_ready: false,
    suppression_reason: suppressionReason,
    recommended_email_angle: detail.angle,
    recommended_action: bucketAction,
  });
}

const bucketCounts: Record<string, number> = {};
const reasonCounts: Record<string, number> = {};
for (const row of rows) {
  bucketCounts[row.review_bucket] = (bucketCounts[row.review_bucket] || 0) + 1;
  reasonCounts[row.reason_code] = (reasonCounts[row.reason_code] || 0) + 1;
}

rows.sort((left, right) => (
  left.review_bucket.localeCompare(right.review_bucket) ||
  right.days_since_signup - left.days_since_signup ||
  left.email.localeCompare(right.email)
));

const payload = {
  generated_at: new Date().toISOString(),
  data_environment: "prod",
  precision_only_targeting: true,
  email_ready: false,
  safety_note:
    "Join against deletion requests and ESP unsubscribe, complaint, and hard-bounce suppressions before sending.",
  grace_periods: {
    signup_hours: SIGNUP_GRACE_MS / HOUR_MS,
    active_job_minutes: ACTIVE_JOB_GRACE_MS / 60000,
  },
  source_counts: globalCounts,
  bucket_counts: bucketCounts,
  reason_counts: reasonCounts,
  review_rows: rows,
};

await Deno.writeTextFile(exportPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({
  ok: true,
  review_rows: rows.length,
  bucket_counts: bucketCounts,
  reason_counts: reasonCounts,
}));
