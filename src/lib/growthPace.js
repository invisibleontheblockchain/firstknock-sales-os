export const GROWTH_GOAL_USERS = 1000;
export const GROWTH_HORIZON_WEEKS = 50;
export const MIN_OBSERVED_CONTENT_ASSETS = 30;

const PLANNING_REACH_PER_RETAINED_USER = 476_667 / 1000;
const PLANNING_WORKSPACES_PER_RETAINED_USER = 250 / 1000;
const PLANNING_REACH_PER_ASSET = 476_667 / (50 * 5);

function nonnegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function safeRatio(actual, target) {
  if (!Number.isFinite(actual) || target <= 0) return null;
  return actual / target;
}

export function buildGrowthPace({
  goalUsers = GROWTH_GOAL_USERS,
  retainedActiveUsers = 0,
  instagramReach28 = 0,
  instagramActivatedWorkspaces28 = 0,
  instagramRetainedActiveUsers28 = 0,
  measuredContentAssets = 0,
  measuredContentAssets28 = 0,
  observationWindowComplete = false,
  horizonWeeks = GROWTH_HORIZON_WEEKS,
} = {}) {
  const goal = Math.max(1, Math.round(nonnegative(goalUsers) || GROWTH_GOAL_USERS));
  const retained = Math.round(nonnegative(retainedActiveUsers));
  const remainingUsers = Math.max(0, goal - retained);
  const reach28 = nonnegative(instagramReach28);
  const workspaces28 = nonnegative(instagramActivatedWorkspaces28);
  const instagramRetained28 = nonnegative(instagramRetainedActiveUsers28);
  const measuredAssets = Math.floor(nonnegative(measuredContentAssets));
  const measuredAssets28 = Math.floor(nonnegative(measuredContentAssets28));
  const weeks = Math.max(1, Math.round(nonnegative(horizonWeeks) || GROWTH_HORIZON_WEEKS));
  const windowComplete = Boolean(observationWindowComplete);
  const targetRetainedPerWeek = remainingUsers / weeks;
  const targetReachPerWeek = targetRetainedPerWeek
    * PLANNING_REACH_PER_RETAINED_USER;
  const targetWorkspacesPerWeek = targetRetainedPerWeek
    * PLANNING_WORKSPACES_PER_RETAINED_USER;
  const targetAssetsPerWeek = targetReachPerWeek / PLANNING_REACH_PER_ASSET;
  const actualReachPerWeek = windowComplete ? reach28 / 4 : null;
  const actualWorkspacesPerWeek = windowComplete ? workspaces28 / 4 : null;
  const actualRetainedPerWeek = windowComplete ? instagramRetained28 / 4 : null;
  const actualAssetsPerWeek = windowComplete ? measuredAssets28 / 4 : null;
  const observedRatesReady = windowComplete
    && measuredAssets >= MIN_OBSERVED_CONTENT_ASSETS
    && reach28 > 0
    && workspaces28 > 0
    && instagramRetained28 > 0;

  return {
    goal_users: goal,
    retained_active_users: retained,
    remaining_users: remainingUsers,
    horizon_weeks: weeks,
    rate_basis: 'planning_baseline',
    observed_rates_ready: observedRatesReady,
    observation_window_complete: windowComplete,
    weekly_proxy_available: windowComplete,
    measured_content_assets: measuredAssets,
    measured_content_assets_28d: measuredAssets28,
    observed_rate_unlock_assets: MIN_OBSERVED_CONTENT_ASSETS,
    reach_per_retained_user: PLANNING_REACH_PER_RETAINED_USER,
    workspaces_per_retained_user: PLANNING_WORKSPACES_PER_RETAINED_USER,
    reach_per_asset: PLANNING_REACH_PER_ASSET,
    required_total_reach: remainingUsers * PLANNING_REACH_PER_RETAINED_USER,
    target_weekly: {
      reach: targetReachPerWeek,
      activated_workspaces: targetWorkspacesPerWeek,
      retained_users: targetRetainedPerWeek,
      content_assets: targetAssetsPerWeek,
    },
    observed_totals_28d: {
      reach: reach28,
      activated_workspaces: workspaces28,
      retained_users: instagramRetained28,
      content_assets: measuredAssets28,
    },
    observed_weekly_proxy_28d: {
      reach: actualReachPerWeek,
      activated_workspaces: actualWorkspacesPerWeek,
      retained_users: actualRetainedPerWeek,
      content_assets: actualAssetsPerWeek,
    },
    pace_ratio: {
      reach: safeRatio(actualReachPerWeek, targetReachPerWeek),
      activated_workspaces: safeRatio(
        actualWorkspacesPerWeek,
        targetWorkspacesPerWeek,
      ),
      retained_users: safeRatio(actualRetainedPerWeek, targetRetainedPerWeek),
      content_assets: safeRatio(actualAssetsPerWeek, targetAssetsPerWeek),
    },
    goal_reached: remainingUsers === 0,
    forecast_available: false,
  };
}

export function getGrowthPaceStatus(pace) {
  if (pace.goal_reached) {
    return {
      title: 'Goal reached',
      detail: 'Maintain 1,000+ retained active users in the rolling 30-day window.',
    };
  }
  const observed = pace.observed_weekly_proxy_28d;
  const totals = pace.observed_totals_28d;
  if (
    !pace.measured_content_assets
    && !totals.content_assets
    && !totals.activated_workspaces
    && !totals.retained_users
  ) {
    return {
      title: 'No measured baseline yet',
      detail: 'Publish the first tracked asset and enter its fixed seven-day snapshot.',
    };
  }
  if (!pace.weekly_proxy_available) {
    return {
      title: '28-day observation window incomplete',
      detail: `Recorded so far: ${totals.reach.toLocaleString()} reach, ${totals.content_assets.toLocaleString()} mature assets, ${totals.activated_workspaces.toLocaleString()} activated workspaces, and ${totals.retained_users.toLocaleString()} retained users. Weekly comparisons unlock after 28 days of mature checkpoint history.`,
    };
  }
  if (!pace.measured_content_assets_28d) {
    return {
      title: 'Publishing cadence is the constraint',
      detail: 'No canonical plan-backed checkpoint became due in the current 28-day window.',
    };
  }
  if (!observed.reach && observed.retained_users) {
    return {
      title: 'Attribution baseline is incomplete',
      detail: 'Retained outcomes exist, but the matching mature snapshots record no reach.',
    };
  }
  if (!observed.reach) {
    return {
      title: 'Reach is the constraint',
      detail: 'Current mature plan-backed assets recorded zero reach.',
    };
  }
  if (!observed.activated_workspaces) {
    return {
      title: 'Activation is the constraint',
      detail: 'No activated workspace is present in the current signup cohort.',
    };
  }
  if (!observed.retained_users) {
    return {
      title: 'Retention is the constraint',
      detail: 'No social-attributed retained user is present in the current signup cohort.',
    };
  }
  const ratio = pace.pace_ratio.retained_users || 0;
  return ratio >= 1
    ? {
        title: 'Current cohort contribution meets the scenario',
        detail: 'Keep validating the retained-user stock weekly; this is not yet a forecast.',
      }
    : {
        title: `${Math.round(ratio * 100)}% of needed retained-user pace`,
        detail: 'Fix the earliest weak stage before adding more publishing volume.',
      };
}

export function buildGrowthPaceFromReport(report, options = {}) {
  const evidence = report?.pace_evidence || {};
  const recent = evidence?.last_28_days || {};
  return buildGrowthPace({
    ...options,
    retainedActiveUsers: report?.all_time?.retained_active_users_30d,
    instagramReach28: recent.social_reach ?? recent.instagram_reach,
    instagramActivatedWorkspaces28:
      recent.social_activated_workspaces ?? recent.instagram_activated_workspaces,
    instagramRetainedActiveUsers28:
      recent.social_retained_active_users_30d
      ?? recent.instagram_retained_active_users_30d,
    measuredContentAssets: evidence.measured_content_assets_all_time,
    measuredContentAssets28: recent.social_content_assets ?? recent.instagram_content_assets,
    observationWindowComplete: evidence.observation_window_complete,
  });
}
