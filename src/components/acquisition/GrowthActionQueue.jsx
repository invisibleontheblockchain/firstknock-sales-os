import React from 'react';
import {
  CalendarClock,
  Camera,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  FileText,
  PauseCircle,
  Repeat2,
  Send,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { buildPlatformTrackedLink } from '@/lib/acquisitionTracking';

function dateLabel(value) {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

function dueLabel(item) {
  if (!item?.snapshot_due_at) return 'Publish before the snapshot clock starts';
  if (item?.snapshot_status === 'missed') {
    return `Window closed ${dateLabel(item.snapshot_window_closes_at)}`;
  }
  const due = new Date(item.snapshot_due_at).getTime();
  const daysUntil = Math.ceil(Math.max(0, due - Date.now()) / (24 * 60 * 60 * 1000));
  const overdueDays = Math.max(
    1,
    Math.floor(Math.max(0, Date.now() - due) / (24 * 60 * 60 * 1000)),
  );
  if (item.snapshot_status === 'overdue') {
    return `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`;
  }
  if (item.snapshot_status === 'due') return 'Due now';
  return daysUntil <= 1
    ? `Due ${dateLabel(item.snapshot_due_at)}`
    : `Due ${dateLabel(item.snapshot_due_at)} · ${daysUntil} days`;
}

function stateLabel(item) {
  const labels = {
    planned: `Scheduled ${dateLabel(item.planned_publish_at)}`,
    publish_due: 'Publish overdue',
    published: dueLabel(item),
    snapshot_due: dueLabel(item),
    snapshot_missed: 'Canonical snapshot window missed',
    review_due: item.decision_stale ? 'Decision needs refresh' : 'Decision due',
    reviewed: `Decision: ${item.decision}`,
  };
  return labels[item.state] || item.state;
}

function channelLabel(channel) {
  return {
    story_link: 'Story link sticker',
    dm_reply: 'Manual DM reply',
    comment_reply: 'Comment → manual DM',
    bio: 'Profile bio link',
    caption_url: 'Caption URL',
  }[channel] || channel;
}

function hasMetricValue(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function optionalCount(value) {
  return hasMetricValue(value) ? Number(value).toLocaleString() : '—';
}

function optionalPercent(value, digits = 1) {
  if (!hasMetricValue(value)) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function isInconclusiveConversion(item) {
  return String(item?.conversion_conclusion || '').startsWith('inconclusive_');
}

function conversionConclusionLabel(value) {
  const labels = {
    exact_declared_link: 'Declared-link cohort',
    observed_declared_link: 'Declared-link cohort',
    inconclusive_no_declared_link: 'Social evidence only',
    inconclusive_missing_timestamps: 'Conversion timing incomplete',
  };
  if (!value) return 'Conversion conclusion unavailable';
  return labels[value] || String(value).replaceAll('_', ' ');
}

function conversionConclusionDetail(item) {
  if (item?.conversion_conclusion === 'inconclusive_no_declared_link') {
    return 'This ordinary social-only post has no declared clickable handoff, so it has no post conversion claim. Review can still proceed from its reach, views, and engagement evidence.';
  }
  if (isInconclusiveConversion(item)) {
    return 'Post-level conversion evidence is inconclusive. Unavailable conversion and retention fields are withheld rather than treated as zero; review can still proceed using the available evidence.';
  }
  if (item?.post_conversion_eligible === true) {
    return 'Conversions are bounded to this post through its declared clickable handoff and measurement cutoff.';
  }
  return 'No post-level conversion conclusion is available. Unavailable fields are not observed zeros.';
}

function suggestedDecisionFor(item) {
  if (!item) return '';
  if (item.conversion_conclusion === 'inconclusive_no_declared_link') {
    return 'Iterate is supported by the social evidence. Repeat needs a separate, explicit social-only override because no post-level conversion claim is available.';
  }
  if (isInconclusiveConversion(item)) {
    return 'Use only the available social and funnel evidence. Missing conversion or retention fields are not zeros and should not drive the decision.';
  }

  const paidUsers = hasMetricValue(item.paid_users) ? Number(item.paid_users) : null;
  const retainedUsers = item.retention_mature === true && hasMetricValue(item.retained_users)
    ? Number(item.retained_users)
    : null;
  const activatedWorkspaces = hasMetricValue(item.activated_workspaces)
    ? Number(item.activated_workspaces)
    : null;
  const activatedReps = hasMetricValue(item.activated_reps)
    ? Number(item.activated_reps)
    : null;
  const ownedIntents = hasMetricValue(item.owned_intents)
    ? Number(item.owned_intents)
    : null;
  const signups = hasMetricValue(item.signups) ? Number(item.signups) : null;

  if (paidUsers > 0) return 'Repeat is supported by bounded paid-user evidence.';
  if (retainedUsers > 0) return 'Repeat is supported by mature, bounded retention evidence.';
  if (activatedWorkspaces > 0 || activatedReps > 0) {
    return 'Repeat is supported by bounded downstream activation evidence.';
  }
  if (ownedIntents > 0 || signups > 0) return 'Iterate the clearest measured downstream leak.';

  const hasAnyConversionEvidence = [
    item.landing_sessions,
    item.signups,
    item.activated_workspaces,
    item.activated_reps,
    item.paid_users,
  ].some(hasMetricValue);
  return hasAnyConversionEvidence
    ? 'Review the measured hook and handoff. Any unavailable fields remain unknown, not zero.'
    : 'Conversion evidence is unavailable. Decide from social evidence without making a post-level conversion claim.';
}

function isNontrivialRepeatOverride(value) {
  const note = String(value || '').trim().replace(/\s+/g, ' ');
  const words = note.toLowerCase().match(/[a-z0-9]+/g) || [];
  return note.length >= 24 && words.length >= 5 && new Set(words).size >= 4;
}

function exactRepeatOutcomeSupported(item) {
  if (
    item?.conversion_conclusion !== 'exact_declared_link'
    || item?.conversion_counters_available !== true
  ) {
    return false;
  }
  const activationSupported = [
    item?.activated_workspaces,
    item?.activated_users,
    item?.activated_reps,
  ].some((value) => hasMetricValue(value) && Number(value) > 0);
  const retentionSupported = item?.retention_mature === true
    && hasMetricValue(item?.retained_users)
    && Number(item.retained_users) > 0;
  const paidSupported = hasMetricValue(item?.paid_users)
    && Number(item.paid_users) > 0;
  return activationSupported || retentionSupported || paidSupported;
}

function ActionCard({ eyebrow, icon: Icon, children }) {
  return (
    <article className="min-w-0 rounded-2xl border border-white/10 bg-black/45 p-4">
      <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-white/40">
        <Icon className="h-4 w-4 text-white/55" />
        {eyebrow}
      </p>
      {children}
    </article>
  );
}

function EmptyAction({ title, detail }) {
  return (
    <div className="mt-4">
      <p className="font-black text-white">{title}</p>
      <p className="mt-2 text-xs leading-relaxed text-white/40">{detail}</p>
    </div>
  );
}

export default function GrowthActionQueue({
  queue,
  accent,
  accentText,
  busy,
  onSeed,
  onPublish,
  onSnapshot,
  onDecision,
}) {
  const [decisionNote, setDecisionNote] = React.useState('');
  const [repeatOverrideNote, setRepeatOverrideNote] = React.useState('');
  const items = queue?.items || [];
  const nextPublish = queue?.next_publish;
  const nextSnapshot = queue?.next_snapshot;
  const nextDecision = queue?.next_decision;
  const summary = queue?.summary || {};
  const providerManagedPublish = nextPublish?.delivery_managed_by === 'buffer'
    || nextPublish?.sprint === 'content-engine';

  React.useEffect(() => {
    setDecisionNote('');
    setRepeatOverrideNote('');
  }, [nextDecision?.platform, nextDecision?.campaign, nextDecision?.content]);

  const copyLink = async (item) => {
    const link = buildPlatformTrackedLink({
      platform: item.platform || 'instagram',
      campaign: item.campaign,
      contentId: item.content,
    });
    try {
      await navigator.clipboard.writeText(link);
      toast.success(`Tracked link copied for ${item.content}`);
    } catch {
      toast.error('Could not copy the tracked link');
    }
  };

  const snapshotAge = Number(nextSnapshot?.snapshot_action_days || 0) || null;
  const providerManagedSnapshot = nextSnapshot?.delivery_managed_by === 'buffer';
  const manualSnapshotAllowed = !providerManagedSnapshot
    || nextSnapshot?.snapshot_manual_entry_allowed === true;
  const providerCheckpointStatus =
    nextSnapshot?.snapshot_provider_checkpoint_status || 'collecting';
  const providerCheckpointCopy = {
    collecting: 'Buffer is still collecting this fixed-age checkpoint. Manual entry stays locked so it cannot conflict with provider evidence.',
    captured: 'Buffer recorded this checkpoint. Refresh the report if its metric row is not visible; manual replacement is not authorized.',
    complete: 'Buffer completed its metric sync without authorizing a manual repair for this checkpoint.',
    unlinked: 'The measurement plan is not linked to one exact Buffer metric job. Resolve that linkage before entering evidence.',
    conflict: 'Conflicting Buffer metric jobs or checkpoints need repair before any manual evidence can be accepted.',
  };
  const suggestedDecision = suggestedDecisionFor(nextDecision);
  const policyBaseSupported = nextDecision?.decision_policy_base_supported === true;
  const socialOnlyDecision = nextDecision?.conversion_conclusion
    === 'inconclusive_no_declared_link';
  const repeatOverrideValid = isNontrivialRepeatOverride(repeatOverrideNote);
  const repeatSupported = policyBaseSupported && (
    exactRepeatOutcomeSupported(nextDecision)
    || (socialOnlyDecision && repeatOverrideValid)
  );
  const comparableSnapshots = Number(
    nextDecision?.comparable_fixed_age_snapshots || 0,
  );
  const holdSupported = policyBaseSupported && comparableSnapshots >= 3;

  if (!items.length) {
    return (
      <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em]" style={{ color: accent }}>
              Today&apos;s growth queue
            </p>
            <h2 className="mt-2 text-xl font-black">Load the first 30-day sprint</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
              Add the 20 approved assets with their exact content IDs, briefs, CTAs,
              hypotheses, publish dates, and seven-day measurement checkpoints.
            </p>
          </div>
          <Button
            type="button"
            onClick={onSeed}
            disabled={busy}
            style={{ background: accent, color: accentText }}
            className="h-11 shrink-0 font-black"
          >
            <CalendarClock className="mr-2 h-4 w-4" />
            Load 30-day sprint
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em]" style={{ color: accent }}>
            Today&apos;s growth queue
          </p>
          <h2 className="mt-2 text-xl font-black">Publish → measure → decide</h2>
          <p className="mt-1 text-xs text-white/45">
            The queue keeps content IDs, fixed-age snapshots, and decisions connected.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-1.5 text-[9px] font-black uppercase tracking-wider text-white/45">
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
              {Number(summary.total || 0)} assets
            </span>
            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-amber-200">
              {Number(summary.snapshot_due || 0)} snapshots due
            </span>
            {Number(summary.snapshot_missed || 0) > 0 && (
              <span className="rounded-full border border-red-400/20 bg-red-400/10 px-2.5 py-1 text-red-200">
                {Number(summary.snapshot_missed)} windows missed
              </span>
            )}
            <span className="rounded-full border border-blue-400/20 bg-blue-400/10 px-2.5 py-1 text-blue-200">
              {Number(summary.review_due || 0)} decisions due
            </span>
            <span className="rounded-full border border-green-400/20 bg-green-400/10 px-2.5 py-1 text-green-200">
              {Number(summary.reviewed || 0)} reviewed
            </span>
            {Number(summary.canceled || 0) > 0 && (
              <span className="rounded-full border border-red-400/20 bg-red-400/10 px-2.5 py-1 text-red-200">
                {Number(summary.canceled)} canceled
              </span>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onSeed}
            disabled={busy}
            className="h-8 px-2 text-[10px] font-black text-white/55 hover:bg-white/5 hover:text-white"
          >
            <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
            Sync 30-day sprint
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        <ActionCard eyebrow="Next publish" icon={Send}>
          {nextPublish ? (
            <div className="mt-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] font-black" style={{ color: accent }}>
                    Asset {nextPublish.sequence} · {nextPublish.content}
                  </p>
                  <h3 className="mt-2 text-base font-black text-white">{nextPublish.hook}</h3>
                </div>
                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[9px] font-black uppercase text-white/45">
                  {nextPublish.format}
                </span>
              </div>
              <p className="mt-2 text-xs font-bold text-amber-200">{stateLabel(nextPublish)}</p>
              <p className="mt-3 text-xs leading-relaxed text-white/45">
                CTA: <strong className="text-white/70">{nextPublish.cta_label}</strong>
                {' · '}{channelLabel(nextPublish.cta_channel)}
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyLink(nextPublish)}
                  className="border-white/15 bg-white/5 text-white hover:bg-white/10"
                >
                  <ClipboardCopy className="mr-2 h-4 w-4" />
                  Copy link
                </Button>
                {providerManagedPublish ? (
                  <Button
                    type="button"
                    disabled
                    variant="outline"
                    className="border-blue-300/20 bg-blue-300/10 font-black text-blue-100"
                  >
                    <CalendarClock className="mr-2 h-4 w-4" />
                    Buffer managed
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => onPublish(nextPublish)}
                    disabled={busy}
                    style={{ background: accent, color: accentText }}
                    className="font-black"
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Mark published
                  </Button>
                )}
              </div>
              {providerManagedPublish && (
                <p className="mt-2 rounded-lg border border-blue-400/20 bg-blue-400/10 px-3 py-2 text-[10px] leading-relaxed text-blue-100/70">
                  Buffer owns publication for this content-engine plan. FirstKnock will start its measurement clock automatically after Buffer confirms the post was sent.
                </p>
              )}
              <details className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-bold text-white/60">
                  View brief
                  <ChevronDown className="h-4 w-4" />
                </summary>
                <p className="mt-3 text-xs leading-relaxed text-white/55">{nextPublish.script}</p>
                <p className="mt-3 text-[10px] leading-relaxed text-white/35">
                  <strong className="text-white/55">Measure:</strong> {nextPublish.primary_metric}
                </p>
                <p className="mt-2 text-[10px] leading-relaxed text-white/35">
                  <strong className="text-white/55">Hypothesis:</strong> {nextPublish.hypothesis}
                </p>
              </details>
            </div>
          ) : (
            <EmptyAction
              title={Number(summary.canceled || 0) > 0 ? 'No publish action' : 'Sprint published'}
              detail={Number(summary.canceled || 0) > 0
                ? 'Remaining provider-managed plans were canceled. Create or reschedule approved content before treating the sprint as published.'
                : 'All planned assets have a recorded publication time.'}
            />
          )}
        </ActionCard>

        <ActionCard eyebrow="Snapshot checkpoint" icon={Camera}>
          {nextSnapshot ? (
            <div className="mt-4">
              <p className="font-mono text-[10px] font-black" style={{ color: accent }}>
                {nextSnapshot.content}
              </p>
              <h3 className="mt-2 text-base font-black text-white">{nextSnapshot.hook}</h3>
              <p className={`mt-2 text-xs font-bold ${
                nextSnapshot.snapshot_status === 'overdue' ? 'text-red-200' : 'text-amber-200'
              }`}>
                {snapshotAge && snapshotAge !== nextSnapshot.snapshot_days
                  ? `${snapshotAge}-day early read due`
                  : dueLabel(nextSnapshot)}
              </p>
              {nextSnapshot.early_snapshot_captured_at && (
                <p className="mt-2 rounded-lg border border-blue-400/20 bg-blue-400/10 px-2.5 py-2 text-[10px] text-blue-100">
                  {nextSnapshot.early_snapshot_days}-day early read saved. The canonical
                  {` ${nextSnapshot.snapshot_days}`}-day checkpoint remains open.
                </p>
              )}
              <p className="mt-3 text-xs leading-relaxed text-white/45">
                Published {dateLabel(nextSnapshot.published_at)}. Canonical comparisons
                use the {nextSnapshot.snapshot_days}-day snapshot.
              </p>
              <Button
                type="button"
                onClick={() => onSnapshot(nextSnapshot, snapshotAge)}
                disabled={busy || !snapshotAge || !manualSnapshotAllowed}
                style={manualSnapshotAllowed && snapshotAge === nextSnapshot.snapshot_days
                  ? { background: accent, color: accentText }
                  : undefined}
                variant={manualSnapshotAllowed && snapshotAge === nextSnapshot.snapshot_days
                  ? 'default'
                  : 'outline'}
                className={`mt-4 w-full font-black ${
                  manualSnapshotAllowed && snapshotAge === nextSnapshot.snapshot_days
                    ? ''
                    : 'border-white/15 bg-white/5 text-white hover:bg-white/10'
                }`}
              >
                <Camera className="mr-2 h-4 w-4" />
                {providerManagedSnapshot && providerCheckpointStatus === 'review_needed'
                  ? `Repair ${snapshotAge}-day snapshot`
                  : providerManagedSnapshot
                    ? providerCheckpointStatus === 'captured'
                      ? 'Buffer checkpoint captured'
                      : 'Buffer collecting'
                    : snapshotAge === nextSnapshot.snapshot_days
                      ? `Log ${snapshotAge}-day snapshot`
                      : snapshotAge
                        ? `Log ${snapshotAge}-day early read`
                        : 'Early read available after 24h'}
              </Button>
              {providerManagedSnapshot && (
                <p className={`mt-2 rounded-lg border px-3 py-2 text-[10px] leading-relaxed ${
                  providerCheckpointStatus === 'review_needed'
                    ? 'border-amber-400/20 bg-amber-400/10 text-amber-100'
                    : 'border-blue-400/20 bg-blue-400/10 text-blue-100/75'
                }`}>
                  {providerCheckpointStatus === 'review_needed'
                    ? 'Buffer explicitly marked this exact checkpoint for review. Manual repair is now available and will remain separate from provider evidence.'
                    : providerCheckpointCopy[providerCheckpointStatus]
                      || providerCheckpointCopy.collecting}
                </p>
              )}
            </div>
          ) : (
            <EmptyAction
              title={Number(summary.snapshot_missed || 0) > 0
                ? 'A canonical window was missed'
                : 'No snapshot waiting'}
              detail={Number(summary.snapshot_missed || 0) > 0
                ? 'Reschedule a fresh experiment instead of labeling late cumulative analytics as fixed-age evidence.'
                : 'Publish the next asset to start its fixed-age measurement clock.'}
            />
          )}
        </ActionCard>

        <ActionCard eyebrow="Decision due" icon={FileText}>
          {nextDecision ? (
            <div className="mt-4">
              <p className="font-mono text-[10px] font-black" style={{ color: accent }}>
                {nextDecision.content}
              </p>
              <h3 className="mt-2 text-base font-black text-white">{nextDecision.hook}</h3>
              {nextDecision.decision_stale && (
                <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-2.5 py-2 text-[10px] text-amber-100">
                  The snapshot changed after the prior decision. Review the current evidence again.
                </p>
              )}
              <div className={`mt-2 rounded-lg border px-2.5 py-2 ${
                nextDecision.conversion_conclusion === 'inconclusive_no_declared_link'
                  ? 'border-cyan-400/20 bg-cyan-400/10'
                  : isInconclusiveConversion(nextDecision)
                    ? 'border-amber-400/20 bg-amber-400/10'
                    : 'border-white/10 bg-white/[0.035]'
              }`}>
                <p className={`text-[9px] font-black uppercase tracking-wider ${
                  nextDecision.conversion_conclusion === 'inconclusive_no_declared_link'
                    ? 'text-cyan-100'
                    : isInconclusiveConversion(nextDecision)
                      ? 'text-amber-100'
                      : 'text-white/55'
                }`}>
                  {conversionConclusionLabel(nextDecision.conversion_conclusion)}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-white/45">
                  {conversionConclusionDetail(nextDecision)}
                </p>
              </div>
              <p className="mt-2 text-[9px] font-bold uppercase tracking-wider text-white/35">
                30-day retention: {nextDecision.retention_mature === true
                  ? 'mature'
                  : nextDecision.retention_mature === false
                    ? 'maturing'
                    : 'maturity unavailable'}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{optionalCount(nextDecision.reach)}</p>
                  <p className="text-[8px] uppercase text-white/35">Reach</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{optionalCount(nextDecision.landing_sessions)}</p>
                  <p className="text-[8px] uppercase text-white/35">Landings</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{optionalCount(nextDecision.signups)}</p>
                  <p className="text-[8px] uppercase text-white/35">Signups</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{optionalCount(nextDecision.activated_workspaces)}</p>
                  <p className="text-[8px] uppercase text-white/35">Workspaces</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{optionalCount(nextDecision.activated_reps)}</p>
                  <p className="text-[8px] uppercase text-white/35">Rep outcomes</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{optionalCount(nextDecision.paid_users)}</p>
                  <p className="text-[8px] uppercase text-white/35">Paid users</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">
                    {nextDecision.retention_mature === true
                      && hasMetricValue(nextDecision.retained_users)
                      && hasMetricValue(nextDecision.retention_eligible_users)
                      ? `${optionalCount(nextDecision.retained_users)} / ${optionalCount(nextDecision.retention_eligible_users)}`
                      : '—'}
                  </p>
                  <p className="text-[8px] uppercase text-white/35">Retained / eligible</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">
                    {nextDecision.retention_mature === true
                      ? optionalPercent(nextDecision.retention_rate)
                      : '—'}
                  </p>
                  <p className="text-[8px] uppercase text-white/35">Retention rate</p>
                </div>
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-white/40">{suggestedDecision}</p>
              <div className={`mt-3 rounded-lg border px-2.5 py-2 ${
                policyBaseSupported
                  ? 'border-emerald-400/20 bg-emerald-400/10'
                  : 'border-amber-400/20 bg-amber-400/10'
              }`}>
                <p className="text-[9px] font-black uppercase tracking-wider text-white/65">
                  Decision policy · {nextDecision.decision_policy_id || 'unavailable'}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-white/45">
                  {policyBaseSupported
                    ? `Base evidence ready: ${(nextDecision.observed_platform_native_exposure_fields || []).join(' + ')} observed at the canonical checkpoint. ${comparableSnapshots} comparable fixed-age snapshot${comparableSnapshots === 1 ? '' : 's'}.`
                    : 'Decision controls are blocked until a canonical fixed-age snapshot includes an explicitly observed reach or views field.'}
                </p>
                {Array.isArray(nextDecision.decision_policy_reason_codes)
                  && nextDecision.decision_policy_reason_codes.length > 0 && (
                  <p className="mt-1 font-mono text-[9px] text-white/35">
                    Bound reasons: {nextDecision.decision_policy_reason_codes.join(', ')}
                  </p>
                )}
              </div>
              <label
                htmlFor="growth-decision-note"
                className="mt-3 block text-[10px] font-black uppercase tracking-wider text-white/55"
              >
                Decision note
              </label>
              <Textarea
                id="growth-decision-note"
                value={decisionNote}
                onChange={(event) => setDecisionNote(event.target.value)}
                maxLength={500}
                aria-describedby="growth-decision-help"
                placeholder="What did we learn, and what one variable changes or stays?"
                className="mt-1.5 min-h-20 border-white/10 bg-black text-xs text-white"
              />
              <p id="growth-decision-help" className="mt-1.5 text-[9px] leading-relaxed text-white/35">
                A note is required. Iterate uses the base social evidence. Repeat
                requires a positive exact activation, mature retained user, paid user,
                or the separate social-only override below. Hold needs three comparable
                fixed-age snapshots.
              </p>
              {socialOnlyDecision && (
                <>
                  <label
                    htmlFor="growth-repeat-override-note"
                    className="mt-3 block text-[10px] font-black uppercase tracking-wider text-cyan-100/75"
                  >
                    Social-only Repeat override
                  </label>
                  <Textarea
                    id="growth-repeat-override-note"
                    value={repeatOverrideNote}
                    onChange={(event) => setRepeatOverrideNote(event.target.value)}
                    maxLength={500}
                    aria-describedby="growth-repeat-override-help"
                    placeholder="Why is repeating justified despite unavailable post-level conversion evidence?"
                    className="mt-1.5 min-h-20 border-cyan-400/20 bg-cyan-950/10 text-xs text-white"
                  />
                  <p id="growth-repeat-override-help" className="mt-1.5 text-[9px] leading-relaxed text-cyan-100/45">
                    Required only for social-only Repeat: at least 24 characters and five
                    words. The server hashes and binds this separate override to the review.
                  </p>
                </>
              )}
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                <Button
                  type="button"
                  onClick={() => onDecision(
                    nextDecision,
                    'repeat',
                    decisionNote,
                    repeatOverrideNote,
                  )}
                  disabled={busy || decisionNote.trim().length < 5 || !repeatSupported}
                  title={repeatSupported
                    ? 'Repeat this evidence-backed pattern'
                    : socialOnlyDecision
                      ? 'Add a nontrivial social-only override to Repeat'
                      : 'Repeat requires a positive exact activation, mature retained user, or paid user'}
                  className="h-10 bg-green-500/15 px-2 text-[10px] font-black text-green-100 hover:bg-green-500/25"
                >
                  <Repeat2 className="mr-1 h-3.5 w-3.5" />
                  Repeat
                </Button>
                <Button
                  type="button"
                  onClick={() => onDecision(nextDecision, 'iterate', decisionNote)}
                  disabled={busy || decisionNote.trim().length < 5 || !policyBaseSupported}
                  className="h-10 bg-blue-500/15 px-2 text-[10px] font-black text-blue-100 hover:bg-blue-500/25"
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                  Iterate
                </Button>
                <Button
                  type="button"
                  onClick={() => onDecision(nextDecision, 'hold', decisionNote)}
                  disabled={busy || decisionNote.trim().length < 5 || !holdSupported}
                  title={holdSupported
                    ? 'Hold this concept'
                    : 'Hold unlocks after three comparable fixed-age snapshots'}
                  className="h-10 bg-white/10 px-2 text-[10px] font-black text-white/70 hover:bg-white/15"
                >
                  <PauseCircle className="mr-1 h-3.5 w-3.5" />
                  Hold
                </Button>
              </div>
            </div>
          ) : (
            <EmptyAction
              title="No decision waiting"
              detail="A decision opens only after the canonical fixed-age snapshot is captured."
            />
          )}
        </ActionCard>
      </div>

      <details className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3">
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-black text-white/60">
          View all {items.length} sprint assets
          <ChevronDown className="h-4 w-4" />
        </summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((item) => (
            <div key={`${item.platform || 'instagram'}-${item.campaign}-${item.content}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[9px] font-black" style={{ color: accent }}>{item.content}</p>
                <span className="text-[8px] font-black uppercase text-white/30">
                  {item.platform || 'instagram'} · {item.format}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs font-bold text-white/70">{item.hook}</p>
              <p className="mt-2 text-[9px] font-bold text-white/35">{stateLabel(item)}</p>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
