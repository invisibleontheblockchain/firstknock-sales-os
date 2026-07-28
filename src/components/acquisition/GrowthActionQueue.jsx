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
import { buildInstagramTrackedLink } from '@/lib/acquisitionTracking';

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
  }[channel] || channel;
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
  const items = queue?.items || [];
  const nextPublish = queue?.next_publish;
  const nextSnapshot = queue?.next_snapshot;
  const nextDecision = queue?.next_decision;
  const summary = queue?.summary || {};

  React.useEffect(() => {
    setDecisionNote('');
  }, [nextDecision?.content]);

  const copyLink = async (item) => {
    const link = buildInstagramTrackedLink({
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
  const suggestedDecision = nextDecision?.activated_workspaces > 0
    || nextDecision?.activated_reps > 0
    ? 'Repeat is supported by downstream activation.'
    : nextDecision?.owned_intents > 0 || nextDecision?.signups > 0
      ? 'Iterate the clearest downstream leak.'
      : 'Review the hook and handoff before choosing.';

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
            <span className="rounded-full border border-blue-400/20 bg-blue-400/10 px-2.5 py-1 text-blue-200">
              {Number(summary.review_due || 0)} decisions due
            </span>
            <span className="rounded-full border border-green-400/20 bg-green-400/10 px-2.5 py-1 text-green-200">
              {Number(summary.reviewed || 0)} reviewed
            </span>
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
              </div>
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
              title="Sprint published"
              detail="All planned assets have a recorded publication time."
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
                disabled={busy || !snapshotAge}
                style={snapshotAge === nextSnapshot.snapshot_days
                  ? { background: accent, color: accentText }
                  : undefined}
                variant={snapshotAge === nextSnapshot.snapshot_days ? 'default' : 'outline'}
                className={`mt-4 w-full font-black ${
                  snapshotAge === nextSnapshot.snapshot_days
                    ? ''
                    : 'border-white/15 bg-white/5 text-white hover:bg-white/10'
                }`}
              >
                <Camera className="mr-2 h-4 w-4" />
                {snapshotAge === nextSnapshot.snapshot_days
                  ? `Log ${snapshotAge}-day snapshot`
                  : snapshotAge
                    ? `Log ${snapshotAge}-day early read`
                    : 'Early read available after 24h'}
              </Button>
            </div>
          ) : (
            <EmptyAction
              title="No snapshot waiting"
              detail="Publish the next asset to start its fixed-age measurement clock."
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
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{Number(nextDecision.reach || 0).toLocaleString()}</p>
                  <p className="text-[8px] uppercase text-white/35">Reach</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{nextDecision.landing_sessions}</p>
                  <p className="text-[8px] uppercase text-white/35">Landings</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{nextDecision.signups}</p>
                  <p className="text-[8px] uppercase text-white/35">Signups</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{nextDecision.activated_workspaces}</p>
                  <p className="text-[8px] uppercase text-white/35">Workspaces</p>
                </div>
                <div className="rounded-lg bg-white/5 p-2">
                  <p className="text-lg font-black">{nextDecision.activated_reps}</p>
                  <p className="text-[8px] uppercase text-white/35">Rep outcomes</p>
                </div>
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-white/40">{suggestedDecision}</p>
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
                A note is required. Hold unlocks after three same-campaign,
                same-age snapshots in this comparison group.
              </p>
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                <Button
                  type="button"
                  onClick={() => onDecision(nextDecision, 'repeat', decisionNote)}
                  disabled={busy || decisionNote.trim().length < 5}
                  className="h-10 bg-green-500/15 px-2 text-[10px] font-black text-green-100 hover:bg-green-500/25"
                >
                  <Repeat2 className="mr-1 h-3.5 w-3.5" />
                  Repeat
                </Button>
                <Button
                  type="button"
                  onClick={() => onDecision(nextDecision, 'iterate', decisionNote)}
                  disabled={busy || decisionNote.trim().length < 5}
                  className="h-10 bg-blue-500/15 px-2 text-[10px] font-black text-blue-100 hover:bg-blue-500/25"
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                  Iterate
                </Button>
                <Button
                  type="button"
                  onClick={() => onDecision(nextDecision, 'hold', decisionNote)}
                  disabled={busy || decisionNote.trim().length < 5 || !nextDecision.hold_eligible}
                  title={nextDecision.hold_eligible
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
            <div key={`${item.campaign}-${item.content}`} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-[9px] font-black" style={{ color: accent }}>{item.content}</p>
                <span className="text-[8px] font-black uppercase text-white/30">{item.format}</span>
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
