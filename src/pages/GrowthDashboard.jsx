import React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
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
import GrowthActionQueue from '@/components/acquisition/GrowthActionQueue';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { INSTAGRAM_FIRST_30_DAYS } from '@/data/instagramFirst30Days';
import { buildInstagramTrackedLink } from '@/lib/acquisitionTracking';
import { csvCell } from '@/lib/csvExport';

const GOAL_USERS = 1000;

function contentIdForToday() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `ig-${y}${m}${d}-01`;
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

function MetricCard({ label, value, helper, icon: Icon, color }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/45">{label}</p>
        <Icon className="h-4 w-4" style={{ color }} />
      </div>
      <p className="mt-3 text-3xl font-black text-white">{Number(value || 0).toLocaleString()}</p>
      <p className="mt-1 text-xs text-white/45">{helper}</p>
    </div>
  );
}

function FunnelStage({ label, value, helper }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 p-3">
      <p className="text-[9px] font-black uppercase tracking-[0.16em] text-white/35">{label}</p>
      <p className="mt-2 text-xl font-black text-white">{Number(value || 0).toLocaleString()}</p>
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

function signalFor(row) {
  if (!row.reach) return { label: 'Add reach', className: 'border-white/10 bg-white/5 text-white/45' };
  if (!row.landing_sessions) return { label: 'Link', className: 'border-blue-400/25 bg-blue-400/10 text-blue-200' };
  if (!row.signup_cta_sessions) return { label: 'Landing', className: 'border-amber-400/25 bg-amber-400/10 text-amber-200' };
  if (!row.signups) return { label: 'Signup', className: 'border-orange-400/25 bg-orange-400/10 text-orange-200' };
  if (!row.activated_users) return { label: 'Activation', className: 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-200' };
  return { label: 'Scale', className: 'border-green-400/25 bg-green-400/10 text-green-200' };
}

export default function GrowthDashboard() {
  const { accent } = useTheme();
  const accentText = contrastText(accent);
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
        reach: Number(snapshot.reach || 0),
        views: Number(snapshot.views || 0),
        shares: Number(snapshot.shares || 0),
        saves: Number(snapshot.saves || 0),
        link_clicks: Number(snapshot.link_clicks || 0),
        dm_intents: Number(snapshot.dm_intents || 0),
      });
      return response?.data || response;
    },
    onSuccess: async () => {
      toast.success('Instagram snapshot saved');
      setQueueSnapshotLock(null);
      await refetch();
    },
    onError: (mutationError) => {
      const code = mutationError?.response?.data?.error;
      const messages = {
        growth_admin_required: 'Owner or admin access is required',
        stale_content_snapshot: 'A newer snapshot already exists for this checkpoint',
        content_snapshot_conflict: 'This checkpoint already has different values at the same capture time',
        invalid_content_metric: 'Use whole, non-negative numbers for every Instagram metric',
        invalid_content_metric_timestamp: 'Check the publication and snapshot dates',
      };
      toast.error(
        messages[code] || 'Could not save this Instagram snapshot',
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
      const messages = {
        fixed_age_snapshot_required: 'The canonical fixed-age snapshot is required first',
        hold_requires_three_comparable_snapshots: 'Hold unlocks after three comparable fixed-age snapshots',
        content_plan_not_found: 'Reload the first 30-day sprint before updating this asset',
        content_plan_conflict: 'Conflicting queue rows were detected; no evidence was changed',
        content_snapshot_conflict: 'Conflicting snapshot rows were detected; no decision was changed',
        invalid_published_at: 'The publication time is invalid',
        growth_admin_required: 'Owner or admin access is required',
      };
      toast.error(messages[code] || 'Could not update the growth queue');
    },
  });

  const trackedLink = buildInstagramTrackedLink({
    campaign,
    contentId,
  });
  const totals = report?.all_time || {};
  const instagram = report?.last_28_days || {};
  const retainedActive = Number(totals.retained_active_users_30d || 0);
  const remaining = Math.max(0, GOAL_USERS - retainedActive);
  const reach28 = Number(instagram.instagram_reach || 0);
  const landings28 = Number(instagram.instagram_landing_sessions || 0);
  const cta28 = Number(instagram.instagram_signup_cta_sessions || 0);
  const signups28 = Number(instagram.instagram_signups || 0);
  const activatedWorkspaces28 = Number(instagram.instagram_activated_workspaces || 0);
  const activated28 = Number(instagram.instagram_activated_users || 0);
  const activeRepRoster28 = Number(instagram.instagram_active_rep_roster || 0);
  const joinedReps28 = Number(instagram.instagram_joined_reps || 0);
  const activatedReps28 = Number(instagram.instagram_activated_reps || 0);
  const repIdentityConflicts = Number(totals.instagram_rep_identity_conflicts || 0);

  const updateSnapshot = (field, value) => {
    setSnapshot((current) => ({ ...current, [field]: value }));
  };

  const seedContentSprint = () => {
    manageContentPlan.mutate({
      action: 'seed',
      plans: INSTAGRAM_FIRST_30_DAYS,
    });
  };

  const markContentPublished = (item) => {
    manageContentPlan.mutate({
      action: 'publish',
      campaign: item.campaign,
      content: item.content,
      published_at: new Date().toISOString(),
    });
  };

  const prepareQueueSnapshot = (item, snapshotDays) => {
    if (!item || !snapshotDays) return;
    setCampaign(item.campaign);
    setContentId(item.content);
    setQueueSnapshotLock({
      campaign: item.campaign,
      content: item.content,
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
      link_clicks: '',
      dm_intents: '',
    });
    requestAnimationFrame(() => {
      document.getElementById('instagram-snapshot-form')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  const saveGrowthDecision = (item, decision, note) => {
    manageContentPlan.mutate({
      action: 'review',
      campaign: item.campaign,
      content: item.content,
      decision,
      note,
    });
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(trackedLink);
      toast.success('Tracked Instagram landing link copied');
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
      'link_clicks',
      'dm_intents',
      'landing_sessions',
      'signup_cta_sessions',
      'signups',
      'acquired_users',
      'activated_workspaces',
      'activated_users',
      'paid_users',
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
      `${item.campaign}|${item.content}`,
      item,
    ]));
    const exportByKey = new Map((report?.by_content || []).map((row) => [
      `${row.campaign}|${row.content}`,
      row,
    ]));
    for (const item of queueItems) {
      const key = `${item.campaign}|${item.content}`;
      if (!exportByKey.has(key)) {
        exportByKey.set(key, {
          source: 'instagram',
          medium: 'organic_social',
          campaign: item.campaign,
          content: item.content,
          format: item.format,
          hook: item.hook,
        });
      }
    }
    const rows = [...exportByKey.values()].map((row) => {
      const queueItem = queueByKey.get(`${row.campaign}|${row.content}`) || {};
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
    anchor.download = `firstknock-instagram-funnel-${new Date().toISOString().slice(0, 10)}.csv`;
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
              Enter each asset&apos;s Instagram Insights snapshot once. FirstKnock joins reach to anonymous landing sessions, signup clicks, activated manager workspaces, their active rep rosters, first rep outcomes, and paid users.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => refetch()}
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

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Retained active · 30d"
            value={retainedActive}
            helper={`${remaining.toLocaleString()} remaining to goal`}
            icon={Users}
            color={accent}
          />
          <MetricCard
            label="Instagram reach · 28d"
            value={reach28}
            helper={`${Number(instagram.instagram_content_assets || 0).toLocaleString()} measured assets`}
            icon={Eye}
            color="#60a5fa"
          />
          <MetricCard
            label="Instagram signups · 28d"
            value={signups28}
            helper={`${percent(reach28 ? signups28 / reach28 : 0, 2)} of reach`}
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
            <FunnelStage label="Reach" value={reach28} helper="Meta Insights" />
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
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
          <div className="mb-4">
            <h2 className="text-lg font-black">Manager → team multiplier</h2>
            <p className="mt-1 text-xs text-white/45">
              Current team adoption created by Instagram-attributed managers in the 28-day signup cohort.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FunnelStage
              label="Manager workspaces"
              value={signups28}
              helper="Instagram-attributed signups"
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
              Give every Reel, post, Story, Collab, or DM response one lowercase content ID.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
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
                  placeholder="ig-20260728-01"
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
              The link opens the public Instagram landing page. Attribution is captured before sign-in and attached to the account after authentication.
            </p>
          </section>

          <section
            id="instagram-snapshot-form"
            className="scroll-mt-6 rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">Log Instagram snapshot</h2>
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
                  {' · '}{queueSnapshotLock.snapshotDays}-day checkpoint.
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
                  <option value="reel">Reel</option>
                  <option value="carousel">Carousel</option>
                  <option value="story">Story</option>
                  <option value="collab">Collab</option>
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
              <NumberField label="Link clicks" value={snapshot.link_clicks} onChange={(value) => updateSnapshot('link_clicks', value)} />
              <NumberField label="DM intents" value={snapshot.dm_intents} onChange={(value) => updateSnapshot('dm_intents', value)} />
            </div>

            <Button
              type="button"
              onClick={() => saveSnapshot.mutate()}
              disabled={!contentId.trim() || saveSnapshot.isPending}
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
              <h2 className="text-lg font-black">Content → conversion</h2>
              <p className="mt-1 text-xs text-white/45">
                Find the exact stage that each Instagram asset wins or loses.
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
            <table className="w-full min-w-[1220px] text-left text-sm">
              <thead className="bg-white/[0.03] text-[10px] uppercase tracking-[0.14em] text-white/40">
                <tr>
                  <th className="px-5 py-3">Content ID</th>
                  <th className="px-4 py-3">Signal</th>
                  <th className="px-4 py-3 text-right">Reach</th>
                  <th className="px-4 py-3 text-right">Landed</th>
                  <th className="px-4 py-3 text-right">CTA</th>
                  <th className="px-4 py-3 text-right">Signups</th>
                  <th className="px-4 py-3 text-right">Activated</th>
                  <th className="px-4 py-3 text-right">Rep loop I / J / A</th>
                  <th className="px-4 py-3 text-right">Reach → signup</th>
                  <th className="px-4 py-3 text-right">Signup → workspace</th>
                  <th className="px-5 py-3 text-right">First paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {isLoading ? (
                  <tr><td colSpan={11} className="px-5 py-10 text-center text-white/40">Loading funnel…</td></tr>
                ) : report?.by_content?.length ? (
                  report.by_content.map((row) => {
                    const signal = signalFor(row);
                    return (
                      <tr key={`${row.campaign}-${row.content}`} className="hover:bg-white/[0.025]">
                        <td className="px-5 py-3">
                          <p className="font-mono text-xs font-bold" style={{ color: accent }}>{row.content}</p>
                          <p className="mt-1 max-w-[260px] truncate text-[10px] text-white/35">{row.hook || row.campaign}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-wider ${signal.className}`}>
                            {signal.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-bold">{Number(row.reach || 0).toLocaleString()}</td>
                        <td className="px-4 py-3 text-right font-bold">{row.landing_sessions}</td>
                        <td className="px-4 py-3 text-right font-bold">{row.signup_cta_sessions}</td>
                        <td className="px-4 py-3 text-right font-bold">{row.signups}</td>
                        <td className="px-4 py-3 text-right font-bold">{row.activated_users}</td>
                        <td
                          className="px-4 py-3 text-right font-bold"
                          title="Active roster seats / joined rep accounts / reps with a first outcome"
                        >
                          {Number(row.active_rep_roster || 0)} / {Number(row.joined_reps || 0)} / {Number(row.activated_reps || 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-white/55">{percent(row.reach_to_signup_rate, 2)}</td>
                        <td className="px-4 py-3 text-right text-white/55">{percent(row.activation_rate)}</td>
                        <td className="px-5 py-3 text-right font-bold">{row.paid_users}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={11} className="px-5 py-10 text-center">
                      <p className="font-semibold text-white/60">No measured content yet</p>
                      <p className="mt-1 text-xs text-white/35">Create a tracked link and save its first Instagram snapshot.</p>
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
              <li>1. Reach but no landing sessions: distribution, CTA, or link placement.</li>
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
              Reach and engagement are copied from Instagram Insights. Anonymous FirstKnock events use rotating pseudonymous session IDs and store no names, emails, or contact fields. Signup, activation, active roster-seat counts, and paid status come from authenticated product records; this report returns aggregate counts rather than rep contact details.
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
