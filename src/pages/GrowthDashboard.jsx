import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Copy,
  Download,
  ExternalLink,
  Eye,
  RefreshCw,
  Save,
  Target,
  Users,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ContentEngineQueue from '@/components/acquisition/ContentEngineQueue';
import GrowthActionQueue from '@/components/acquisition/GrowthActionQueue';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { INSTAGRAM_FIRST_30_DAYS } from '@/data/instagramFirst30Days';
import { buildPlatformTrackedLink } from '@/lib/acquisitionTracking';
import { csvCell } from '@/lib/csvExport';
import {
  buildGrowthPaceFromReport,
  getGrowthPaceStatus,
  GROWTH_HORIZON_WEEKS,
  MIN_OBSERVED_CONTENT_ASSETS,
} from '@/lib/growthPace';

const PACE_ACCENT = '#39FF4A';
const PLATFORM_LABELS = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

function contentIdForToday(platform = 'instagram') {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${platform === 'tiktok' ? 'tt' : 'ig'}-${y}${m}${d}-01`;
}

function localDate(value = new Date()) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function percent(value, digits = 0) {
  const number = Number(value || 0) * 100;
  return `${number.toFixed(number > 0 && number < 1 ? Math.max(1, digits) : digits)}%`;
}

function paceNumber(value, digits = 1) {
  const number = Number(value || 0);
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function MetricCard({ label, value, helper, icon: Icon, color, available = true }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/45">{label}</p>
        <Icon className="h-4 w-4" style={{ color }} />
      </div>
      <p className="mt-3 text-3xl font-black text-white">
        {available ? Number(value || 0).toLocaleString() : '—'}
      </p>
      <p className="mt-1 text-xs text-white/45">{helper}</p>
    </div>
  );
}

function PaceRow({
  label,
  observed,
  required,
  ratio,
  observedAvailable,
  lowerBound28,
  unavailableDetail,
  accent,
}) {
  const percentage = Number.isFinite(ratio) ? Math.max(0, ratio * 100) : 0;
  const visualPercentage = Math.min(100, percentage);
  return (
    <div className="rounded-xl border border-white/10 bg-black/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-[0.15em] text-white/60">
            {label}
          </p>
          <p className="mt-1 text-sm font-black tabular-nums text-white">
            {observedAvailable
              ? `${paceNumber(observed)} / week`
              : Number.isFinite(lowerBound28)
                ? `${Number(lowerBound28).toLocaleString()} / 28d lower bound`
                : '—'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] font-bold text-white/55">Need</p>
          <p className="mt-1 text-sm font-black tabular-nums text-white/70">
            {paceNumber(required)} / week
          </p>
        </div>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"
        role={observedAvailable ? 'progressbar' : undefined}
        aria-label={observedAvailable ? `${label} pace` : undefined}
        aria-valuemin={observedAvailable ? 0 : undefined}
        aria-valuemax={observedAvailable ? 100 : undefined}
        aria-valuenow={observedAvailable ? Math.round(visualPercentage) : undefined}
        aria-valuetext={observedAvailable
          ? `${Math.round(percentage)} percent of the weekly planning requirement`
          : undefined}
      >
        {observedAvailable && (
          <div
            className="h-full rounded-full"
            style={{ width: `${visualPercentage}%`, backgroundColor: accent }}
          />
        )}
      </div>
      <p className="mt-2 text-[11px] text-white/55">
        {observedAvailable
          ? `${Math.round(percentage)}% of the weekly planning requirement`
          : unavailableDetail || 'Waiting for current plan-backed evidence'}
      </p>
    </div>
  );
}

function PathToGoalCard({ pace }) {
  const observed = pace.observed_weekly_proxy_28d;
  const constraint = getGrowthPaceStatus(pace);
  const hasCompleteWindow = pace.weekly_proxy_available;
  const coverage = pace.measurement_coverage || {};
  const sampleMature = pace.measured_content_assets >= MIN_OBSERVED_CONTENT_ASSETS
    && pace.observation_window_complete;

  return (
    <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p
            className="text-[11px] font-black uppercase tracking-[0.2em]"
            style={{ color: PACE_ACCENT }}
          >
            Weekly operating control
          </p>
          <h2 className="mt-1 text-xl font-black">Path to 1,000</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/60">
            Required Instagram and TikTok pace if organic social closes the full remaining
            all-source retained-user gap.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white/65">
            {pace.remaining_users.toLocaleString()} remaining
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white/65">
            {GROWTH_HORIZON_WEEKS}-week scenario
          </span>
        </div>
      </div>

      {pace.goal_reached ? (
        <div className="mt-5 rounded-xl border border-green-400/25 bg-green-400/10 p-4">
          <p className="text-lg font-black text-green-100">{constraint.title}</p>
          <p className="mt-1 text-sm text-green-100/70">{constraint.detail}</p>
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-4 lg:grid-cols-[0.75fr_1.25fr]">
            <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] text-white/60">
                All-channel north star
              </p>
              <p className="mt-2 text-3xl font-black tabular-nums text-white">
                {pace.retained_active_users.toLocaleString()}
                <span className="text-base text-white/30"> / {pace.goal_users.toLocaleString()}</span>
              </p>
              <p className="mt-4 text-[11px] font-black uppercase tracking-[0.16em] text-white/60">
                Baseline cumulative post reach still required
              </p>
              <p className="mt-2 text-2xl font-black tabular-nums" style={{ color: PACE_ACCENT }}>
                {Math.ceil(pace.required_total_reach).toLocaleString()}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-white/60">
                Planning baseline, not an observed forecast.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <PaceRow
                label={pace.reach_proxy_available
                  ? 'Instagram cumulative post reach — conservative'
                  : 'Instagram cumulative post reach lower bound'}
                observed={observed.reach}
                required={pace.target_weekly.reach}
                ratio={pace.pace_ratio.reach}
                observedAvailable={pace.reach_proxy_available}
                lowerBound28={pace.observed_totals_28d.reach}
                unavailableDetail={`Instagram reach coverage ${Number(coverage.reach_observed_assets || 0).toLocaleString()}/${Number(coverage.reach_expected_due_assets || 0).toLocaleString()} due Instagram assets; weekly reach pace is withheld until complete`}
                accent={PACE_ACCENT}
              />
              <PaceRow
                label="Published checkpoints due"
                observed={observed.content_assets}
                required={pace.target_weekly.content_assets}
                ratio={pace.pace_ratio.content_assets}
                observedAvailable={hasCompleteWindow}
                accent={PACE_ACCENT}
              />
              <PaceRow
                label="Activated workspaces"
                observed={observed.activated_workspaces}
                required={pace.target_weekly.activated_workspaces}
                ratio={pace.pace_ratio.activated_workspaces}
                observedAvailable={hasCompleteWindow}
                accent={PACE_ACCENT}
              />
              <PaceRow
                label="Gross retained cohort"
                observed={observed.retained_users}
                required={pace.target_weekly.retained_users}
                ratio={pace.pace_ratio.retained_users}
                observedAvailable={hasCompleteWindow}
                accent={PACE_ACCENT}
              />
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-black/35 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="font-black text-white">{constraint.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-white/60">{constraint.detail}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white/60">
                  {sampleMature
                    ? `${pace.measured_content_assets} captured assets · descriptive`
                    : `${pace.measured_content_assets}/${MIN_OBSERVED_CONTENT_ASSETS} captured assets`}
                </span>
                <span className="text-[10px] font-bold text-white/40">
                  28d checkpoints {Number(coverage.captured_assets || 0)}/{Number(coverage.expected_due_assets || 0)}
                  {' · '}Instagram reach {Number(coverage.reach_observed_assets || 0)}/{Number(coverage.reach_expected_due_assets || 0)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <p className="mt-4 text-xs leading-relaxed text-white/60">
        Weekly values use plan-backed last-28-day totals divided by four. Asset pace counts
        every Instagram and TikTok checkpoint that became due. The conservative reach row
        uses Instagram cumulative post reach only; each account may repeat across posts, so
        it is not unique campaign reach. TikTok views stay diagnostic and are never added to
        reach. Captured and reach-observed coverage stay separate. The retained
        value is a gross social-attributed signup-cohort
        contribution, not net growth in the rolling active-user stock. FirstKnock keeps
        ETA off until weekly stock history can support one.
      </p>
    </section>
  );
}

function FunnelStage({
  label,
  value,
  helper,
  available = true,
}) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 p-3">
      <p className="text-[9px] font-black uppercase tracking-[0.16em] text-white/35">{label}</p>
      <p className="mt-2 text-xl font-black text-white">
        {available ? Number(value || 0).toLocaleString() : '—'}
      </p>
      <p className="mt-1 truncate text-[10px] text-white/35">{helper}</p>
    </div>
  );
}

function NumberField({ label, value, onChange }) {
  return (
    <label className="space-y-2 text-xs font-bold text-white/60">
      {label}
      <Input
        type="number"
        min="0"
        step="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-white/10 bg-black text-white"
      />
    </label>
  );
}

function optionalMetricValue(value) {
  return String(value ?? '').trim() === '' ? undefined : Number(value);
}

function hasMetricValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function optionalCount(value) {
  return hasMetricValue(value) ? Number(value).toLocaleString() : '—';
}

function optionalPercent(value, digits = 0) {
  return hasMetricValue(value) ? percent(value, digits) : '—';
}

function isInconclusiveConversion(row) {
  return String(row?.conversion_conclusion || '').startsWith('inconclusive_');
}

function signalFor(row) {
  if (row?.conversion_conclusion === 'inconclusive_no_declared_link') {
    return { label: 'Social only', className: 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200' };
  }
  if (isInconclusiveConversion(row)) {
    return { label: 'Evidence incomplete', className: 'border-amber-400/25 bg-amber-400/10 text-amber-200' };
  }
  if (!hasMetricValue(row.reach)) {
    return { label: 'Reach unavailable', className: 'border-white/10 bg-white/5 text-white/45' };
  }
  if (Number(row.reach) === 0) {
    return { label: 'Add reach', className: 'border-white/10 bg-white/5 text-white/45' };
  }
  if (!row.signups && row.self_reported_signup_assists) {
    return { label: 'Assist only', className: 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200' };
  }
  if (!hasMetricValue(row.landing_sessions)) {
    return { label: 'Conversion unavailable', className: 'border-white/10 bg-white/5 text-white/45' };
  }
  if (Number(row.landing_sessions) === 0) return { label: 'Link', className: 'border-blue-400/25 bg-blue-400/10 text-blue-200' };
  if (!hasMetricValue(row.signup_cta_sessions)) {
    return { label: 'CTA unavailable', className: 'border-white/10 bg-white/5 text-white/45' };
  }
  if (Number(row.signup_cta_sessions) === 0) return { label: 'Landing', className: 'border-amber-400/25 bg-amber-400/10 text-amber-200' };
  if (!hasMetricValue(row.signups)) {
    return { label: 'Signup unavailable', className: 'border-white/10 bg-white/5 text-white/45' };
  }
  if (Number(row.signups) === 0) return { label: 'Signup', className: 'border-orange-400/25 bg-orange-400/10 text-orange-200' };
  if (!hasMetricValue(row.activated_users)) {
    return { label: 'Activation unavailable', className: 'border-white/10 bg-white/5 text-white/45' };
  }
  if (Number(row.activated_users) === 0) return { label: 'Activation', className: 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-200' };
  return { label: 'Scale', className: 'border-green-400/25 bg-green-400/10 text-green-200' };
}

function attributionLabel(row) {
  const labels = {
    static_bio: 'Platform-level bio',
    source_inferred_or_unassigned: 'Platform-level source',
    declared_content_link: 'Declared content link',
    social_evidence_only: 'Social evidence only',
    visitor_assist_only: 'Visitor assist only',
    post_exposure_only: 'Post exposure only',
  };
  return labels[row?.attribution_method] || 'Evidence not classified';
}

function conversionConclusionLabel(value) {
  const labels = {
    exact_declared_link: 'Declared-link conversion cohort',
    observed_declared_link: 'Declared-link conversion cohort',
    inconclusive_no_declared_link: 'No post conversion claim · review social evidence',
    inconclusive_missing_timestamps: 'Conversion conclusion inconclusive · timing incomplete',
  };
  if (!value) return 'Conversion conclusion unavailable';
  return labels[value] || String(value).replaceAll('_', ' ');
}

export default function GrowthDashboard() {
  const queryClient = useQueryClient();
  const { accent } = useTheme();
  const accentText = contrastText(accent);
  const [platform, setPlatform] = React.useState('instagram');
  const [campaign, setCampaign] = React.useState('1000-users');
  const [contentId, setContentId] = React.useState(contentIdForToday);
  const [snapshot, setSnapshot] = React.useState({
    format: 'reel',
    hook: '',
    published_date: localDate(),
    snapshot_days: '7',
    reach: '',
    views: '',
    shares: '',
    saves: '',
    comments: '',
    follows: '',
    profile_visits: '',
    link_clicks: '',
    dm_intents: '',
  });
  const [queueSnapshotLock, setQueueSnapshotLock] = React.useState(null);

  const {
    data: report,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['acquisitionReport'],
    queryFn: async () => {
      const response = await base44.functions.invoke('getAcquisitionReport', {});
      return response?.data || response;
    },
    retry: false,
  });

  const saveSnapshot = useMutation({
    mutationFn: async () => {
      const response = await base44.functions.invoke('upsertGrowthContentMetric', {
        platform: queueSnapshotLock?.platform || platform,
        campaign,
        content: contentId,
        format: queueSnapshotLock?.format || snapshot.format,
        hook: queueSnapshotLock?.hook || snapshot.hook,
        cta_variant: queueSnapshotLock?.ctaVariant,
        published_at: queueSnapshotLock?.publishedAt
          || (snapshot.published_date
            ? new Date(`${snapshot.published_date}T12:00:00`).toISOString()
            : undefined),
        snapshot_days: Number(snapshot.snapshot_days),
        snapshot_captured_at: new Date().toISOString(),
        reach: optionalMetricValue(snapshot.reach),
        views: optionalMetricValue(snapshot.views),
        shares: optionalMetricValue(snapshot.shares),
        saves: optionalMetricValue(snapshot.saves),
        comments: optionalMetricValue(snapshot.comments),
        follows: optionalMetricValue(snapshot.follows),
        profile_visits: optionalMetricValue(snapshot.profile_visits),
        link_clicks: optionalMetricValue(snapshot.link_clicks),
        dm_intents: optionalMetricValue(snapshot.dm_intents),
      });
      return response?.data || response;
    },
    onSuccess: async () => {
      toast.success(`${PLATFORM_LABELS[queueSnapshotLock?.platform || platform]} snapshot saved`);
      setQueueSnapshotLock(null);
      await refetch();
    },
    onError: (mutationError) => {
      const code = mutationError?.response?.data?.error;
      const messages = {
        growth_admin_required: 'Owner or admin access is required',
        stale_content_snapshot: 'A newer snapshot already exists for this checkpoint',
        content_snapshot_conflict: 'This checkpoint already has different values at the same capture time',
        content_plan_conflict: 'Conflicting content plans must be resolved before repairing this checkpoint',
        buffer_checkpoint_conflict: 'Conflicting Buffer checkpoint evidence must be resolved before manual repair',
        buffer_checkpoint_identity_mismatch: 'This repair does not match the Buffer publication clock. Refresh the queue before retrying',
        buffer_checkpoint_still_collecting: 'Buffer is still responsible for this checkpoint. Manual repair unlocks only after the worker marks it for review',
        invalid_content_metric: 'Enter reach or views, using whole non-negative numbers',
        invalid_content_metric_timestamp: 'Check the publication and snapshot dates',
      };
      toast.error(
        messages[code] || `Could not save this ${PLATFORM_LABELS[platform]} snapshot`,
      );
    },
  });

  const manageContentPlan = useMutation({
    mutationFn: async (payload) => {
      const response = await base44.functions.invoke('manageGrowthContentPlan', payload);
      return response?.data || response;
    },
    onSuccess: async (_result, variables) => {
      const messages = {
        seed: 'The 20-asset Instagram sprint is loaded',
        publish: 'Content marked published; its snapshot clock is running',
        review: 'Growth decision saved against the current fixed-age snapshot',
      };
      toast.success(messages[variables?.action] || 'Growth queue updated');
      await refetch();
    },
    onError: (mutationError) => {
      const code = mutationError?.response?.data?.error;
      const policyReasons = mutationError?.response?.data?.reason_codes || [];
      const messages = {
        fixed_age_snapshot_required: 'The canonical fixed-age snapshot is required first',
        fixed_age_snapshot_window_missed: 'This fixed-age window closed; reschedule a fresh experiment instead of using late cumulative analytics',
        hold_requires_three_comparable_snapshots: 'Hold unlocks after three comparable fixed-age snapshots',
        content_plan_not_found: 'Reload the first 30-day sprint before updating this asset',
        content_plan_conflict: 'Conflicting queue rows were detected; no evidence was changed',
        content_snapshot_conflict: 'Conflicting snapshot rows were detected; no decision was changed',
        provider_managed_publication: 'Buffer owns publication for this content-engine plan; refresh to see its delivery state',
        growth_review_lineage_locked: 'This decision already has an active downstream batch. Revoke that batch before changing its evidence lineage',
        growth_batch_lineage_conflict: 'Too many downstream batch records exist for this decision; repair the lineage before reviewing it again',
        invalid_growth_decision_policy: 'The decision policy changed. Refresh the queue before reviewing this evidence',
        growth_decision_policy_stale: 'The fixed-age or comparison evidence changed. Refresh before deciding',
        growth_decision_not_supported: policyReasons.includes('repeat_social_only_override_required')
          ? 'Repeat needs a separate nontrivial social-only override note'
          : policyReasons.includes('repeat_positive_exact_outcome_required')
            ? 'Repeat needs a positive exact activation, mature retained user, or paid user'
            : policyReasons.includes('hold_three_comparable_snapshots_required')
              ? 'Hold needs three comparable fixed-age snapshots'
              : 'This decision is not supported by the current fixed-age evidence',
        invalid_growth_decision_override: 'The Repeat override is allowed only for social-only evidence',
        invalid_published_at: 'The publication time is invalid',
        growth_admin_required: 'Owner or admin access is required',
      };
      toast.error(messages[code] || 'Could not update the growth queue');
    },
  });

  const trackedLink = buildPlatformTrackedLink({
    platform,
    campaign,
    contentId,
  });
  const totals = report?.all_time || {};
  const socialWindow = report?.last_28_days || {};
  const platformLabel = PLATFORM_LABELS[platform];
  const platformMetric = (field) => Number(socialWindow?.[`${platform}_${field}`] || 0);
  const pace = buildGrowthPaceFromReport(report);
  const retainedActive = Number(totals.retained_active_users_30d || 0);
  const remaining = pace.remaining_users;
  const reach28 = Number(
    socialWindow?.[`${platform}_cumulative_post_reach`]
      ?? socialWindow?.[`${platform}_reach`]
      ?? 0,
  );
  const views28 = platformMetric('views');
  const reachObservedAssets28 = platformMetric('reach_observed_assets');
  const viewsObservedAssets28 = platformMetric('views_observed_assets');
  const contentAssets28 = platformMetric('content_assets');
  const linkClicks28 = platformMetric('link_clicks');
  const dmIntents28 = platformMetric('dm_intents');
  const ownedIntents28 = platformMetric('owned_intents');
  const ownedIntentObservedAssets28 = platformMetric('owned_intents_observed_assets');
  const ownedIntentCompleteAssets28 = platformMetric('owned_intents_complete_assets');
  const landings28 = platformMetric('landing_sessions');
  const cta28 = platformMetric('signup_cta_sessions');
  const signups28 = platformMetric('signups');
  const activatedWorkspaces28 = platformMetric('activated_workspaces');
  const activated28 = platformMetric('activated_users');
  const paidUsers28 = platformMetric('paid_users');
  const activeRepRoster28 = platformMetric('active_rep_roster');
  const joinedReps28 = platformMetric('joined_reps');
  const activatedReps28 = platformMetric('activated_reps');
  const repIdentityConflicts = Number(
    totals?.instagram_rep_identity_conflicts || 0,
  ) + Number(totals?.tiktok_rep_identity_conflicts || 0);
  const intentCoverage = contentAssets28 > 0
    ? `${ownedIntentCompleteAssets28.toLocaleString()}/${contentAssets28.toLocaleString()} full-field assets`
    : 'no measured assets';
  const intentCoverageState = contentAssets28 > 0
    && ownedIntentCompleteAssets28 === contentAssets28
    ? 'complete'
    : ownedIntentObservedAssets28 > 0
    ? 'partial'
    : 'unavailable';

  const updateSnapshot = (field, value) => {
    setSnapshot((current) => ({ ...current, [field]: value }));
  };
  const changePlatform = (nextPlatform) => {
    setPlatform(nextPlatform);
    if (nextPlatform === 'tiktok') {
      setSnapshot((current) => ({
        ...current,
        format: ['story', 'collab'].includes(current.format) ? 'reel' : current.format,
      }));
    }
    if (/^(ig|tt)-\d{8}-\d{2}$/.test(contentId)) {
      setContentId(contentIdForToday(nextPlatform));
    }
  };

  const seedContentSprint = () => {
    manageContentPlan.mutate({
      action: 'seed',
      plans: INSTAGRAM_FIRST_30_DAYS.map((plan) => ({
        ...plan,
        platform: 'instagram',
      })),
    });
  };

  const markContentPublished = (item) => {
    manageContentPlan.mutate({
      action: 'publish',
      platform: item.platform || 'instagram',
      campaign: item.campaign,
      content: item.content,
      published_at: new Date().toISOString(),
    });
  };

  const refreshGrowthSystem = async () => {
    await Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ['growthContentEngine'] }),
    ]);
  };

  const prepareQueueSnapshot = (item, snapshotDays) => {
    if (!item || !snapshotDays) return;
    if (
      item.delivery_managed_by === 'buffer'
      && item.snapshot_manual_entry_allowed !== true
    ) {
      toast.info('Buffer is still collecting this checkpoint. Manual repair is not available yet.');
      return;
    }
    const itemPlatform = item.platform || 'instagram';
    setPlatform(itemPlatform);
    setCampaign(item.campaign);
    setContentId(item.content);
    setQueueSnapshotLock({
      campaign: item.campaign,
      content: item.content,
      platform: itemPlatform,
      snapshotDays: Number(snapshotDays),
      publishedAt: item.published_at,
      format: item.format || 'reel',
      hook: item.hook || '',
      ctaVariant: `${item.cta_channel || 'unknown'}:${item.cta_label || 'unknown'}`,
    });
    setSnapshot({
      format: item.format || 'reel',
      hook: item.hook || '',
      published_date: item.published_at ? localDate(item.published_at) : localDate(),
      snapshot_days: String(snapshotDays),
      reach: '',
      views: '',
      shares: '',
      saves: '',
      comments: '',
      follows: '',
      profile_visits: '',
      link_clicks: '',
      dm_intents: '',
    });
    requestAnimationFrame(() => {
      document.getElementById('social-snapshot-form')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  const saveGrowthDecision = (item, decision, note, overrideNote = '') => {
    manageContentPlan.mutate({
      action: 'review',
      platform: item.platform || 'instagram',
      campaign: item.campaign,
      content: item.content,
      decision,
      note,
      decision_policy_id: item.decision_policy_id,
      expected_social_evidence_hash: item.social_evidence_hash,
      expected_snapshot_captured_at: item.fixed_snapshot_captured_at,
      expected_comparable_fixed_age_snapshots:
        item.comparable_fixed_age_snapshots,
      ...(overrideNote.trim() ? { override_note: overrideNote } : {}),
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(trackedLink);
      toast.success(`Tracked ${platformLabel} landing link copied`);
    } catch {
      toast.error('Could not copy the link');
    }
  };

  const downloadCsv = () => {
    const headers = [
      'source',
      'medium',
      'campaign',
      'content_id',
      'attribution_granularity',
      'attribution_method',
      'conversion_evidence',
      'conversion_conclusion',
      'post_conversion_eligible',
      'format',
      'hook',
      'planned_publish_at',
      'published_at',
      'snapshot_days',
      'snapshot_due_at',
      'queue_state',
      'decision',
      'decision_note',
      'decision_at',
      'reach',
      'views',
      'shares',
      'saves',
      'comments',
      'follows',
      'profile_visits',
      'link_clicks',
      'dm_intents',
      'landing_sessions',
      'signup_cta_sessions',
      'self_reported_landing_assists',
      'self_reported_signup_cta_assists',
      'self_reported_signup_assists',
      'self_reported_activated_workspace_assists',
      'self_reported_paid_assists',
      'self_reported_assist_method',
      'signups',
      'acquired_users',
      'activated_workspaces',
      'activated_users',
      'paid_users',
      'retention_mature',
      'retention_eligible_users',
      'retained_users',
      'retention_rate',
      'active_rep_roster',
      'joined_reps',
      'activated_reps',
      'rep_identity_conflicts',
      'reach_to_landing_rate',
      'landing_to_cta_rate',
      'cta_to_signup_rate',
      'reach_to_signup_rate',
      'reach_to_activation_rate',
      'activation_rate',
      'paid_rate',
      'roster_to_join_rate',
      'joined_to_activation_rate',
      'first_signup_at',
      'last_signup_at',
    ];
    const queueItems = report?.content_queue?.items || [];
    const queueByKey = new Map(queueItems.map((item) => [
      `${item.platform || 'instagram'}|${item.campaign}|${item.content}`,
      item,
    ]));
    const exportByKey = new Map((report?.by_content || []).map((row) => [
      `${row.source || 'instagram'}|${row.campaign}|${row.content}`,
      row,
    ]));
    for (const item of queueItems) {
      const key = `${item.platform || 'instagram'}|${item.campaign}|${item.content}`;
      if (!exportByKey.has(key)) {
        exportByKey.set(key, {
          source: item.platform || 'instagram',
          medium: 'organic_social',
          campaign: item.campaign,
          content: item.content,
          format: item.format,
          hook: item.hook,
        });
      }
    }
    const rows = [...exportByKey.values()].map((row) => {
      const queueItem = queueByKey.get(
        `${row.source || 'instagram'}|${row.campaign}|${row.content}`,
      ) || {};
      return headers.map((header) => {
        if (header === 'content_id') return row.content;
        if (header === 'queue_state') return queueItem.state;
        if ([
          'planned_publish_at',
          'published_at',
          'snapshot_due_at',
          'decision',
          'decision_note',
          'decision_at',
        ].includes(header)) {
          return queueItem[header];
        }
        return row[header] ?? queueItem[header];
      });
    });
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `firstknock-social-funnel-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full overflow-y-auto bg-black px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6 pb-16">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em]" style={{ color: accent }}>
              <Target className="h-4 w-4" />
              One goal
            </div>
            <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">1,000-user growth system</h1>
            <p className="mt-2 max-w-3xl text-sm text-white/55">
              Buffer captures fresh fixed-age reach and view checkpoints automatically. Manual entry unlocks for a Buffer-managed asset only after the exact worker checkpoint is marked for review. FirstKnock joins that exposure evidence to anonymous landing sessions, signup clicks, activated manager workspaces, their active rep rosters, first rep outcomes, and paid users.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={refreshGrowthSystem}
            disabled={isFetching}
            className="border-white/15 bg-white/[0.04] text-white hover:bg-white/10"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {isError && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
            {error?.response?.data?.error === 'growth_admin_required'
              ? 'This dashboard is restricted to the FirstKnock owner or an admin.'
              : error?.response?.data?.error === 'growth_content_conflict'
                ? 'Conflicting content evidence was detected. The report stopped instead of choosing a row arbitrarily; resolve the duplicate checkpoint or lifecycle records, then refresh.'
                : 'The acquisition report is not available yet. Deploy the growth entities and backend functions together, then refresh.'}
          </div>
        )}

        {repIdentityConflicts > 0 && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
            {repIdentityConflicts.toLocaleString()} roster identity conflict(s) were excluded from joined and activated rep totals. Review duplicate active roster records.
          </div>
        )}

        {!isError && !isLoading && (
          <GrowthActionQueue
            queue={report?.content_queue}
            accent={accent}
            accentText={accentText}
            busy={manageContentPlan.isPending}
            onSeed={seedContentSprint}
            onPublish={markContentPublished}
            onSnapshot={prepareQueueSnapshot}
            onDecision={saveGrowthDecision}
          />
        )}

        {!isError && !isLoading && (
          <PathToGoalCard pace={pace} />
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Retained active · 30d"
            value={retainedActive}
            helper={`${remaining.toLocaleString()} remaining to goal`}
            icon={Users}
            color={accent}
          />
          <MetricCard
            label={`${platformLabel} cumulative post reach · 28d`}
            value={reach28}
            available={reachObservedAssets28 > 0}
            helper={`${viewsObservedAssets28
              ? `${views28.toLocaleString()} views`
              : 'Views unavailable'} · ${platformMetric('content_assets').toLocaleString()} measured assets`}
            icon={Eye}
            color="#60a5fa"
          />
          <MetricCard
            label={`${platformLabel} signups · 28d`}
            value={signups28}
            helper={reachObservedAssets28
              ? `${percent(reach28 ? signups28 / reach28 : 0, 2)} signups per cumulative post reach`
              : 'Reach unavailable'}
            icon={BarChart3}
            color="#facc15"
          />
          <MetricCard
            label="28d signup cohort activated"
            value={activated28}
            helper={`${activatedWorkspaces28.toLocaleString()} workspaces now activated`}
            icon={Zap}
            color="#22c55e"
          />
        </div>

        <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <FunnelStage
              label="Cumulative post reach"
              value={reach28}
              available={reachObservedAssets28 > 0}
              helper={reachObservedAssets28 > 0
                ? `${platform === 'instagram' ? 'Instagram Insights' : 'TikTok analytics'} · ${reachObservedAssets28.toLocaleString()}/${contentAssets28.toLocaleString()} assets`
                : 'Reach metrics unavailable'}
            />
            <span className="hidden text-white/20 lg:block">→</span>
            <FunnelStage
              label="Owned intent"
              value={ownedIntents28}
              available={ownedIntentObservedAssets28 > 0}
              helper={`${linkClicks28.toLocaleString()} link + ${dmIntents28.toLocaleString()} DM · ${intentCoverageState} ${intentCoverage}`}
            />
            <span className="hidden text-white/20 lg:block">→</span>
            <FunnelStage
              label="Landing sessions"
              value={landings28}
              helper={percent(reach28 ? landings28 / reach28 : 0, 2)}
            />
            <span className="hidden text-white/20 lg:block">→</span>
            <FunnelStage
              label="Signup clicks"
              value={cta28}
              helper={percent(landings28 ? cta28 / landings28 : 0)}
            />
            <span className="hidden text-white/20 lg:block">→</span>
            <FunnelStage
              label="Signups"
              value={signups28}
              helper={percent(cta28 ? signups28 / cta28 : 0)}
            />
            <span className="hidden text-white/20 lg:block">→</span>
            <FunnelStage
              label="Signup cohort activated"
              value={activatedWorkspaces28}
              helper={`${activated28.toLocaleString()} total users`}
            />
            <span className="hidden text-white/20 lg:block">→</span>
            <FunnelStage
              label="Paid"
              value={paidUsers28}
              helper={`${percent(activatedWorkspaces28 ? paidUsers28 / activatedWorkspaces28 : 0)} of activated workspaces`}
            />
          </div>
        </section>

        <ContentEngineQueue
          accent={accent}
          accentText={accentText}
          contentQueue={report?.content_queue}
        />

        <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
          <div className="mb-4">
            <h2 className="text-lg font-black">Manager → team multiplier</h2>
            <p className="mt-1 text-xs text-white/45">
              Current team adoption created by {platformLabel}-attributed managers in the 28-day signup cohort.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FunnelStage
              label="Manager workspaces"
              value={signups28}
              helper={`${platformLabel}-attributed signups`}
            />
            <FunnelStage
              label="Active roster seats"
              value={activeRepRoster28}
              helper={`${signups28 ? (activeRepRoster28 / signups28).toFixed(1) : '0.0'} per manager`}
            />
            <FunnelStage
              label="Rep accounts joined"
              value={joinedReps28}
              helper={`${percent(activeRepRoster28 ? joinedReps28 / activeRepRoster28 : 0)} of roster`}
            />
            <FunnelStage
              label="Reps with first outcome"
              value={activatedReps28}
              helper={`${percent(joinedReps28 ? activatedReps28 / joinedReps28 : 0)} of joined reps`}
            />
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
            <h2 className="text-lg font-black">Tracked landing link</h2>
            <p className="mt-1 text-xs text-white/45">
              Give every Instagram or TikTok post and controlled link handoff one lowercase content ID.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="space-y-2 text-xs font-bold text-white/60">
                Platform
                <select
                  value={platform}
                  onChange={(event) => changePlatform(event.target.value)}
                  disabled={Boolean(queueSnapshotLock)}
                  className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white"
                >
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                </select>
              </label>
              <label className="space-y-2 text-xs font-bold text-white/60">
                Campaign
                <Input
                  value={campaign}
                  onChange={(event) => setCampaign(event.target.value)}
                  disabled={Boolean(queueSnapshotLock)}
                  className="border-white/10 bg-black text-white"
                  placeholder="1000-users"
                />
              </label>
              <label className="space-y-2 text-xs font-bold text-white/60">
                Content ID
                <Input
                  value={contentId}
                  onChange={(event) => setContentId(event.target.value)}
                  disabled={Boolean(queueSnapshotLock)}
                  className="border-white/10 bg-black text-white"
                  placeholder={platform === 'instagram' ? 'ig-20260728-01' : 'tt-20260728-01'}
                />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black p-3">
              <code className="min-w-0 flex-1 truncate text-xs text-white/60">{trackedLink}</code>
              <Button
                type="button"
                size="sm"
                onClick={copyLink}
                style={{ background: accent, color: accentText }}
                className="shrink-0 font-black"
              >
                <Copy className="mr-2 h-4 w-4" />
                Copy
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-white/35">
              The neutral /start link records {platformLabel}, campaign, and content before sign-in, then attaches the first touch to the account after authentication.
            </p>
          </section>

          <section
            id="social-snapshot-form"
            className="scroll-mt-6 rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">Log {platformLabel} snapshot</h2>
                <p className="mt-1 text-xs text-white/45">
                  Use the canonical seven-day snapshot for comparison. Optional early reads stay separate.
                </p>
              </div>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-white/40">
                {contentId || 'Content ID'}
              </span>
            </div>

            {queueSnapshotLock && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-blue-400/20 bg-blue-400/10 p-3">
                <p className="text-xs leading-relaxed text-blue-100">
                  Queue selection locked to <strong>{queueSnapshotLock.content}</strong>
                  {' · '}{PLATFORM_LABELS[queueSnapshotLock.platform]} · {queueSnapshotLock.snapshotDays}-day checkpoint.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setQueueSnapshotLock(null)}
                  className="shrink-0 text-blue-100 hover:bg-blue-400/10 hover:text-white"
                >
                  Clear
                </Button>
              </div>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="space-y-2 text-xs font-bold text-white/60">
                Format
                <select
                  value={snapshot.format}
                  onChange={(event) => updateSnapshot('format', event.target.value)}
                  disabled={Boolean(queueSnapshotLock)}
                  className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white"
                >
                  <option value="reel">{platform === 'instagram' ? 'Reel' : 'Video'}</option>
                  <option value="carousel">{platform === 'instagram' ? 'Carousel' : 'Photo post'}</option>
                  {platform === 'instagram' && <option value="story">Story</option>}
                  {platform === 'instagram' && <option value="collab">Collab</option>}
                  <option value="live">Live</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="space-y-2 text-xs font-bold text-white/60">
                Published
                <Input
                  type="date"
                  value={snapshot.published_date}
                  onChange={(event) => updateSnapshot('published_date', event.target.value)}
                  disabled={Boolean(queueSnapshotLock)}
                  className="border-white/10 bg-black text-white"
                />
              </label>
              <label className="space-y-2 text-xs font-bold text-white/60">
                Snapshot age
                <select
                  value={snapshot.snapshot_days}
                  onChange={(event) => updateSnapshot('snapshot_days', event.target.value)}
                  disabled={Boolean(queueSnapshotLock)}
                  className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white"
                >
                  <option value="1">24 hours</option>
                  <option value="3">72 hours</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
            </div>

            <label className="mt-3 block space-y-2 text-xs font-bold text-white/60">
              Hook / concept
              <Input
                value={snapshot.hook}
                onChange={(event) => updateSnapshot('hook', event.target.value)}
                disabled={Boolean(queueSnapshotLock)}
                className="border-white/10 bg-black text-white"
                placeholder="What six overlapping canvassers cost"
              />
            </label>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <NumberField label="Reach" value={snapshot.reach} onChange={(value) => updateSnapshot('reach', value)} />
              <NumberField label="Views" value={snapshot.views} onChange={(value) => updateSnapshot('views', value)} />
              <NumberField label="Shares" value={snapshot.shares} onChange={(value) => updateSnapshot('shares', value)} />
              <NumberField label="Saves" value={snapshot.saves} onChange={(value) => updateSnapshot('saves', value)} />
              <NumberField label="Comments" value={snapshot.comments} onChange={(value) => updateSnapshot('comments', value)} />
              <NumberField label="Follows" value={snapshot.follows} onChange={(value) => updateSnapshot('follows', value)} />
              <NumberField label="Profile visits" value={snapshot.profile_visits} onChange={(value) => updateSnapshot('profile_visits', value)} />
              <NumberField label="Link clicks" value={snapshot.link_clicks} onChange={(value) => updateSnapshot('link_clicks', value)} />
              <NumberField label="DM intents" value={snapshot.dm_intents} onChange={(value) => updateSnapshot('dm_intents', value)} />
            </div>

            <Button
              type="button"
              onClick={() => saveSnapshot.mutate()}
              disabled={
                !contentId.trim()
                || (snapshot.reach === '' && snapshot.views === '')
                || saveSnapshot.isPending
              }
              style={{ background: accent, color: accentText }}
              className="mt-4 w-full font-black"
            >
              <Save className="mr-2 h-4 w-4" />
              {saveSnapshot.isPending ? 'Saving…' : 'Save snapshot'}
            </Button>
          </section>
        </div>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b0b]">
          <div className="flex flex-col gap-3 border-b border-white/10 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-black">Content → conversion evidence</h2>
              <p className="mt-1 text-xs text-white/45">
                Reach and views are post-level. Conversions are post-associated only when a controlled link preserves the content ID; static profile-link traffic stays platform-level, and visitor selections appear only as assists. Ordinary posts without a declared clickable handoff have no post conversion claim, but review can still proceed from their social evidence.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={downloadCsv}
              disabled={!report?.by_content?.length && !report?.content_queue?.items?.length}
              className="border-white/15 bg-transparent text-white hover:bg-white/10"
            >
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1750px] text-left text-sm">
              <thead className="bg-white/[0.03] text-[10px] uppercase tracking-[0.14em] text-white/40">
                <tr>
                  <th className="px-5 py-3">Content ID</th>
                  <th className="px-4 py-3">Signal</th>
                  <th className="px-4 py-3 text-right">Reach</th>
                  <th className="px-4 py-3 text-right">Views</th>
                  <th className="px-4 py-3 text-right">Landed</th>
                  <th className="px-4 py-3 text-right">CTA</th>
                  <th className="px-4 py-3 text-right">Assist L / S / A</th>
                  <th className="px-4 py-3 text-right">Signups</th>
                  <th className="px-4 py-3 text-right">Activated</th>
                  <th className="px-4 py-3 text-right">Rep loop I / J / A</th>
                  <th className="px-4 py-3 text-right">Reach → signup</th>
                  <th className="px-4 py-3 text-right">Signup → workspace</th>
                  <th className="px-4 py-3 text-right">First paid</th>
                  <th className="px-4 py-3 text-right">Retained / eligible</th>
                  <th className="px-5 py-3 text-right">30d retention</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {isLoading ? (
                  <tr><td colSpan={15} className="px-5 py-10 text-center text-white/40">Loading funnel…</td></tr>
                ) : report?.by_content?.length ? (
                  report.by_content.map((row) => {
                    const signal = signalFor(row);
                    return (
                      <tr key={`${row.source}-${row.campaign}-${row.content}`} className="hover:bg-white/[0.025]">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <p className="font-mono text-xs font-bold" style={{ color: accent }}>{row.content}</p>
                            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[8px] font-black uppercase text-white/40">
                              {row.source}
                            </span>
                          </div>
                          <p className="mt-1 max-w-[260px] truncate text-[10px] text-white/35">{row.hook || row.campaign}</p>
                          <p className="mt-1 text-[9px] font-bold uppercase tracking-wider text-white/25">
                            {attributionLabel(row)}
                          </p>
                          <p
                            className={`mt-1 max-w-[290px] text-[9px] font-bold ${
                              row.conversion_conclusion === 'inconclusive_no_declared_link'
                                ? 'text-cyan-200/75'
                                : isInconclusiveConversion(row)
                                  ? 'text-amber-200/75'
                                  : 'text-white/30'
                            }`}
                            title={row.conversion_conclusion || 'conversion conclusion unavailable'}
                          >
                            {conversionConclusionLabel(row.conversion_conclusion)}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${signal.className}`}>
                            {signal.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-bold">
                          {row.reach_observed && hasMetricValue(row.reach)
                            ? Number(row.reach || 0).toLocaleString()
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-bold">
                          {row.views_observed && hasMetricValue(row.views)
                            ? Number(row.views || 0).toLocaleString()
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-bold">{optionalCount(row.landing_sessions)}</td>
                        <td className="px-4 py-3 text-right font-bold">{optionalCount(row.signup_cta_sessions)}</td>
                        <td
                          className="px-4 py-3 text-right font-bold text-cyan-100/80"
                          title="Visitor-reported landing / signup / activated-workspace assists. Excluded from winner decisions."
                        >
                          {optionalCount(row.self_reported_landing_assists)} / {optionalCount(row.self_reported_signup_assists)} / {optionalCount(row.self_reported_activated_workspace_assists)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold">{optionalCount(row.signups)}</td>
                        <td className="px-4 py-3 text-right font-bold">{optionalCount(row.activated_users)}</td>
                        <td
                          className="px-4 py-3 text-right font-bold"
                          title="Active roster seats / joined rep accounts / reps with a first outcome"
                        >
                          {optionalCount(row.active_rep_roster)} / {optionalCount(row.joined_reps)} / {optionalCount(row.activated_reps)}
                        </td>
                        <td className="px-4 py-3 text-right text-white/55">
                          {row.reach_to_signup_rate === null
                            || !hasMetricValue(row.reach_to_signup_rate)
                            ? '—'
                            : optionalPercent(row.reach_to_signup_rate, 2)}
                        </td>
                        <td className="px-4 py-3 text-right text-white/55">{optionalPercent(row.activation_rate)}</td>
                        <td className="px-4 py-3 text-right font-bold">{optionalCount(row.paid_users)}</td>
                        <td className="px-4 py-3 text-right font-bold">
                          {row.retention_mature === true
                            && hasMetricValue(row.retained_users)
                            && hasMetricValue(row.retention_eligible_users)
                            ? `${optionalCount(row.retained_users)} / ${optionalCount(row.retention_eligible_users)}`
                            : '—'}
                        </td>
                        <td
                          className="px-5 py-3 text-right"
                          title={row.retention_mature === true
                            ? 'Thirty-day retention window is mature for this content cohort.'
                            : 'Thirty-day retention window is not mature; unavailable retention values are not zeros.'}
                        >
                          <p className="font-bold text-white/70">
                            {row.retention_mature === true
                              ? optionalPercent(row.retention_rate, 1)
                              : '—'}
                          </p>
                          <p className="mt-0.5 text-[8px] font-black uppercase tracking-wider text-white/30">
                            {row.retention_mature === true
                              ? 'Mature'
                              : row.retention_mature === false
                                ? 'Maturing'
                                : 'Maturity —'}
                          </p>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={15} className="px-5 py-10 text-center">
                      <p className="font-semibold text-white/60">No measured content yet</p>
                      <p className="mt-1 text-xs text-white/35">Create a tracked link; Buffer will capture the first fixed-age platform snapshot after publication.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
            <h3 className="font-black">How to diagnose the leak</h3>
            <ol className="mt-3 space-y-2 text-sm text-white/55">
              <li>1. Cumulative post reach but no landing sessions: distribution, CTA, or link placement.</li>
              <li>2. Landings but no signup clicks: promise, proof, or page clarity.</li>
              <li>3. Clicks but no accounts: authentication or signup friction.</li>
              <li>4. Accounts but no activation: onboarding or product-value friction.</li>
              <li>5. Activated managers but few joined or active reps: invitation or rep onboarding friction.</li>
              <li>6. Activation but no paid users: packaging, timing, or trust.</li>
            </ol>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
            <h3 className="font-black">Measurement boundary</h3>
            <p className="mt-3 text-sm leading-relaxed text-white/55">
              Reach and engagement come from the matching Buffer checkpoint or owner-entered Instagram/TikTok analytics snapshot. Aggregate reach is cumulative post reach: canonical per-post reach summed across assets, where the same account may appear more than once; it is not unique campaign reach. TikTok views are reported separately and are never converted into reach. Anonymous events use rotating pseudonymous session IDs and store no names, emails, or contact fields. Signup, activation, roster-seat, and paid milestones come from authenticated product records, but their content association remains a client-declared first touch. Static bio visits are never distributed across posts. The optional landing-page question records a separate visitor-reported assist and cannot trigger Repeat, Iterate, or Hold evidence.
            </p>
            <a
              href="https://www.facebook.com/help/instagram/788388387972460"
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center text-xs font-bold hover:underline"
              style={{ color: accent }}
            >
              Instagram Insights definitions
              <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
