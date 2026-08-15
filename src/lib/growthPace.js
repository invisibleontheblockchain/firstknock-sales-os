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
  expectedContentAssets28,
  capturedContentAssets28,
  reachExpectedContentAssets28,
  reachCapturedContentAssets28,
  reachObservedAssets28,
  reachObserved,
  tiktokViews28 = 0,
  tiktokViewsObservedAssets28 = 0,
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
  const expectedAssets28 = expectedContentAssets28 === undefined
    ? measuredAssets28
    : Math.floor(nonnegative(expectedContentAssets28));
  const capturedAssets28 = capturedContentAssets28 === undefined
    ? measuredAssets28
    : Math.floor(nonnegative(capturedContentAssets28));
  const expectedReachAssets28 = reachExpectedContentAssets28 === undefined
    ? expectedAssets28
    : Math.floor(nonnegative(reachExpectedContentAssets28));
  const capturedReachAssets28 = reachCapturedContentAssets28 === undefined
    ? capturedAssets28
    : Math.floor(nonnegative(reachCapturedContentAssets28));
  const observedReachAssets28 = reachObservedAssets28 === undefined
    ? reachObserved === undefined
      ? capturedAssets28
      : reachObserved
        ? expectedReachAssets28
        : 0
    : Math.floor(nonnegative(reachObservedAssets28));
  const weeks = Math.max(1, Math.round(nonnegative(horizonWeeks) || GROWTH_HORIZON_WEEKS));
  const windowComplete = Boolean(observationWindowComplete);
  const captureCoverageComplete = expectedAssets28 > 0
    && capturedAssets28 >= expectedAssets28;
  const reachCaptureCoverageComplete = expectedReachAssets28 > 0
    && capturedReachAssets28 >= expectedReachAssets28;
  const reachCoverageComplete = reachCaptureCoverageComplete
    && observedReachAssets28 >= expectedReachAssets28;
  const reachAvailable = windowComplete && reachCoverageComplete;
  const targetRetainedPerWeek = remainingUsers / weeks;
  const targetReachPerWeek = targetRetainedPerWeek
    * PLANNING_REACH_PER_RETAINED_USER;
  const targetWorkspacesPerWeek = targetRetainedPerWeek
    * PLANNING_WORKSPACES_PER_RETAINED_USER;
  const targetAssetsPerWeek = targetReachPerWeek / PLANNING_REACH_PER_ASSET;
  const actualReachPerWeek = reachAvailable ? reach28 / 4 : null;
  const actualWorkspacesPerWeek = windowComplete ? workspaces28 / 4 : null;
  const actualRetainedPerWeek = windowComplete ? instagramRetained28 / 4 : null;
  const actualAssetsPerWeek = windowComplete ? expectedAssets28 / 4 : null;
  const observedRatesReady = windowComplete
    && reachAvailable
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
    reach_proxy_available: reachAvailable,
    measured_content_assets: measuredAssets,
    measured_content_assets_28d: measuredAssets28,
    expected_due_assets_28d: expectedAssets28,
    captured_content_assets_28d: capturedAssets28,
    reach_expected_due_assets_28d: expectedReachAssets28,
    reach_captured_assets_28d: capturedReachAssets28,
    reach_observed_assets_28d: observedReachAssets28,
    measurement_coverage: {
      expected_due_assets: expectedAssets28,
      captured_assets: capturedAssets28,
      reach_expected_due_assets: expectedReachAssets28,
      reach_captured_assets: capturedReachAssets28,
      reach_observed_assets: observedReachAssets28,
      capture_complete: captureCoverageComplete,
      reach_capture_complete: reachCaptureCoverageComplete,
      reach_complete: reachCoverageComplete,
    },
    reach_metric: 'instagram_cumulative_post_reach',
    exposure_diagnostics_28d: {
      instagram_cumulative_post_reach: reach28,
      tiktok_views: Number(tiktokViewsObservedAssets28) > 0
        ? nonnegative(tiktokViews28)
        : null,
      tiktok_views_observed_assets: Math.floor(nonnegative(tiktokViewsObservedAssets28)),
    },
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
      content_assets: expectedAssets28,
      expected_due_assets: expectedAssets28,
      captured_assets: capturedAssets28,
      reach_expected_due_assets: expectedReachAssets28,
      reach_captured_assets: capturedReachAssets28,
      reach_observed_assets: observedReachAssets28,
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
  const coverage = pace.measurement_coverage || {
    expected_due_assets: Number(totals?.content_assets || 0),
    captured_assets: Number(pace?.measured_content_assets_28d || 0),
    reach_observed_assets: pace?.reach_proxy_available
      ? Number(totals?.content_assets || 0)
      : 0,
  };
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
      detail: `Recorded so far: ${totals.reach.toLocaleString()} Instagram cumulative post reach, ${totals.content_assets.toLocaleString()} mature assets, ${totals.activated_workspaces.toLocaleString()} activated workspaces, and ${totals.retained_users.toLocaleString()} retained users. Weekly comparisons unlock after 28 days of mature checkpoint history.`,
    };
  }
  if (!coverage.expected_due_assets) {
    return {
      title: 'Publishing cadence is the constraint',
      detail: 'No canonical plan-backed checkpoint became due in the current 28-day window.',
    };
  }
  if (coverage.captured_assets < coverage.expected_due_assets) {
    return {
      title: 'Checkpoint capture is incomplete',
      detail: `${coverage.captured_assets.toLocaleString()} of ${coverage.expected_due_assets.toLocaleString()} due plan-backed checkpoints have canonical evidence. Fix collection before diagnosing reach or publishing performance.`,
    };
  }
  if (!pace.reach_proxy_available) {
    const expectedReachAssets = Number(
      coverage.reach_expected_due_assets ?? coverage.expected_due_assets ?? 0,
    );
    return {
      title: 'Reach measurement is incomplete',
      detail: `Instagram reach is observed for ${coverage.reach_observed_assets.toLocaleString()} of ${expectedReachAssets.toLocaleString()} due Instagram assets. The displayed cumulative post reach is a lower bound; TikTok views and missing reach are not treated as reach or as zero.`,
    };
  }
  if (!observed.reach && observed.retained_users) {
    return {
      title: 'Attribution baseline is incomplete',
      detail: 'Retained outcomes exist, but the matching mature Instagram snapshots record no cumulative post reach.',
    };
  }
  if (!observed.reach) {
    return {
      title: 'Instagram reach is the constraint',
      detail: 'Complete plan-backed evidence returned zero cumulative post reach across the due Instagram assets.',
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
  const reachObservedAssets = recent.instagram_reach_observed_assets;
  const instagramCapturedAssets = recent.instagram_captured_assets
    ?? recent.instagram_content_assets;
  const instagramExpectedAssets = recent.instagram_expected_due_assets
    ?? instagramCapturedAssets;
  const capturedAssets = recent.social_captured_assets
    ?? recent.social_content_assets
    ?? instagramCapturedAssets;
  const expectedAssets = recent.social_expected_due_assets
    ?? recent.social_content_assets
    ?? recent.instagram_expected_due_assets
    ?? capturedAssets;
  const reachObserved = reachObservedAssets === undefined
    ? Object.prototype.hasOwnProperty.call(recent, 'instagram_reach')
    : Number(reachObservedAssets) > 0;
  return buildGrowthPace({
    ...options,
    retainedActiveUsers: report?.all_time?.retained_active_users_30d,
    instagramReach28:
      recent.instagram_cumulative_post_reach ?? recent.instagram_reach,
    instagramActivatedWorkspaces28:
      recent.social_activated_workspaces ?? recent.instagram_activated_workspaces,
    instagramRetainedActiveUsers28:
      recent.social_retained_active_users_30d
      ?? recent.instagram_retained_active_users_30d,
    measuredContentAssets: evidence.measured_content_assets_all_time,
    measuredContentAssets28: capturedAssets,
    expectedContentAssets28: expectedAssets,
    capturedContentAssets28: capturedAssets,
    reachExpectedContentAssets28: instagramExpectedAssets,
    reachCapturedContentAssets28: instagramCapturedAssets,
    reachObservedAssets28: reachObservedAssets === undefined
      ? reachObserved
        ? expectedAssets
        : 0
      : reachObservedAssets,
    reachObserved,
    tiktokViews28: recent.tiktok_views,
    tiktokViewsObservedAssets28: recent.tiktok_views_observed_assets,
    observationWindowComplete: evidence.observation_window_complete,
  });
}
