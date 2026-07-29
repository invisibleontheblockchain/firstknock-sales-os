import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Film,
  Image,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FIRSTKNOCK_AUDITED_SOURCES } from '@/data/firstKnockAuditedSources';

const PLATFORM_LABELS = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

const JOB_LABELS = {
  queued: 'Queued for Buffer',
  processing: 'Sending to Buffer',
  retry_wait: 'Retry queued',
  create_reconcile: 'Needs reconciliation',
  delivery_reconcile: 'Reconciling measurement plan',
  approval_wait: 'Buffer approval',
  scheduled: 'Scheduled',
  sending: 'Publishing',
  measurement_retry: 'Syncing measurement',
  sent: 'Published',
  review_required: 'Needs attention',
  failed: 'Failed',
  canceled: 'Canceled',
};

const TERMINAL_JOB_STATES = new Set(['sent', 'failed', 'canceled']);
const CANCELABLE_JOB_STATES = new Set(['queued', 'retry_wait']);
const FAST_POLLING_JOB_STATES = new Set([
  'queued',
  'processing',
  'create_reconcile',
  'sending',
]);
const SLOW_POLLING_JOB_STATES = new Set([
  'retry_wait',
  'delivery_reconcile',
  'approval_wait',
  'scheduled',
  'measurement_retry',
]);
const SUPPORTED_MEDIA_TYPES = new Set(['video/mp4', 'image/jpeg', 'image/png', 'image/webp']);
const MAX_SOCIAL_POST_TEXT = 2200;
const PHOENIX_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const MINIMUM_SCHEDULE_LEAD_MS = 15 * 60 * 1000;
const PHOENIX_CADENCE_SLOTS = [
  [9, 30],
  [13, 30],
  [18, 30],
];

const PILLARS = [
  'Product proof',
  'Route Command',
  'Rep workflow',
  'Manager coaching',
  'Route operations',
  'Build in public',
];

function conceptIdForToday() {
  const date = new Date(Date.now() - PHOENIX_UTC_OFFSET_MS);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `fk-${y}${m}${d}-01`;
}

function nextConceptIdForToday(artifacts = []) {
  const first = conceptIdForToday();
  const prefix = first.slice(0, -2);
  const used = new Set(
    artifacts
      .map((artifact) => String(artifact?.concept_id || ''))
      .filter((conceptId) => conceptId.startsWith(prefix)),
  );
  let sequence = 1;
  while (used.has(`${prefix}${String(sequence).padStart(2, '0')}`)) {
    sequence += 1;
  }
  return `${prefix}${String(sequence).padStart(2, '0')}`;
}

function phoenixDayKey(timestamp) {
  const wallClock = new Date(timestamp - PHOENIX_UTC_OFFSET_MS);
  return [
    wallClock.getUTCFullYear(),
    String(wallClock.getUTCMonth() + 1).padStart(2, '0'),
    String(wallClock.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function phoenixLocalInput(timestamp) {
  return new Date(timestamp - PHOENIX_UTC_OFFSET_MS).toISOString().slice(0, 16);
}

function cadenceJobTimes(jobs, platform) {
  return (jobs || [])
    .filter((job) => (
      (!platform || job?.platform === platform)
      &&
      job?.state !== 'canceled'
      && (job?.state !== 'failed' || job?.provider_post_id)
    ))
    .map((job) => new Date(job?.due_at).getTime())
    .filter(Number.isFinite);
}

function nextScheduleSlot(jobs = [], now = Date.now(), platform = '') {
  const earliest = now + MINIMUM_SCHEDULE_LEAD_MS;
  const existingTimes = cadenceJobTimes(jobs, platform);
  const phoenixToday = new Date(now - PHOENIX_UTC_OFFSET_MS);
  const year = phoenixToday.getUTCFullYear();
  const month = phoenixToday.getUTCMonth();
  const day = phoenixToday.getUTCDate();

  for (let dayOffset = 0; dayOffset < 90; dayOffset += 1) {
    const dayStart = Date.UTC(year, month, day + dayOffset, 7, 0, 0, 0);
    const dayKey = phoenixDayKey(dayStart);
    const jobsOnDay = existingTimes.filter((timestamp) => phoenixDayKey(timestamp) === dayKey);
    if (jobsOnDay.length >= PHOENIX_CADENCE_SLOTS.length) continue;

    for (const [hour, minute] of PHOENIX_CADENCE_SLOTS) {
      const candidate = Date.UTC(year, month, day + dayOffset, hour + 7, minute, 0, 0);
      if (candidate < earliest) continue;
      const slotOccupied = jobsOnDay.some(
        (timestamp) => Math.abs(timestamp - candidate) < 75 * 60 * 1000,
      );
      if (!slotOccupied) return phoenixLocalInput(candidate);
    }
  }

  const fallback = Date.UTC(year, month, day + 90, 16, 30, 0, 0);
  return phoenixLocalInput(fallback);
}

function dateLabel(value) {
  if (!value) return 'Not planned';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Not planned';
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Phoenix',
    timeZoneName: 'short',
  });
}

function phoenixLocalToIso(value) {
  const parsed = new Date(`${value}:00-07:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function defaultSchedulingType(artifact) {
  return artifact?.audio_mode === 'silent' ? 'notification' : 'automatic';
}

function draftFromArtifact(artifact) {
  return {
    hook: artifact?.hook || '',
    caption: artifact?.caption || '',
    overlay_text: (artifact?.overlay_text || []).join('\n'),
    shot_list: (artifact?.shot_list || []).join('\n'),
    cta_label: artifact?.cta_label || '',
    cta_url: artifact?.cta_url || '',
    disclosure: artifact?.disclosure || '',
    media_url: artifact?.media_url || '',
    media_sha256: artifact?.media_sha256 || '',
    mime_type: artifact?.mime_type || (artifact?.format === 'video' ? 'video/mp4' : 'image/jpeg'),
    width: artifact?.width || '',
    height: artifact?.height || '',
    duration_ms: artifact?.duration_ms || '',
    thumbnail_offset_ms: artifact?.thumbnail_offset_ms || '',
  };
}

function checksFromArtifact(artifact) {
  return {
    privacy_cleared: artifact?.privacy_cleared === true,
    demo_labeled: artifact?.demo_labeled === true,
    claims_supported: artifact?.claims_supported === true,
    media_rights_confirmed: artifact?.media_rights_confirmed === true,
    note: artifact?.review_note || '',
  };
}

function stablePublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const unbracketedHost = host.replace(/^\[|\]$/g, '');
    if (
      !host
      || unbracketedHost.includes(':')
      || host === 'localhost'
      || host.endsWith('.localhost')
    ) {
      return false;
    }
    const ipv4 = unbracketedHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return true;
    const octets = ipv4.slice(1).map(Number);
    const [first, second] = octets;
    return !(
      octets.some((octet) => octet < 0 || octet > 255)
      || first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224
    );
  } catch {
    return false;
  }
}

function socialPostText(artifact) {
  const caption = String(artifact?.caption || '').trim();
  const disclosure = String(artifact?.disclosure || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  const ctaLabel = String(artifact?.cta_label || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const ctaUrl = String(artifact?.cta_url || '').trim().slice(0, 2048);
  const blocks = caption ? [caption] : [];
  const normalizedCaption = caption.toLowerCase();
  if (disclosure && !normalizedCaption.includes(disclosure.toLowerCase())) {
    blocks.push(disclosure);
  }
  const cta = [ctaLabel, ctaUrl].filter(Boolean).join(': ');
  const ctaAlreadyPresent = ctaUrl
    ? caption.includes(ctaUrl)
    : ctaLabel && normalizedCaption.includes(ctaLabel.toLowerCase());
  if (cta && !ctaAlreadyPresent) blocks.push(cta);
  return blocks.join('\n\n');
}

function artifactMediaReady(artifact) {
  const sha256 = String(artifact?.media_sha256 || '').trim().toLowerCase();
  const mimeType = String(artifact?.mime_type || '').trim().toLowerCase();
  if (
    !stablePublicHttpsUrl(artifact?.media_url)
    || !/^[a-f0-9]{64}$/.test(sha256)
    || !SUPPORTED_MEDIA_TYPES.has(mimeType)
    || Number(artifact?.width || 0) < 1
    || Number(artifact?.height || 0) < 1
    || artifact?.provider_text !== socialPostText(artifact)
    || !artifact?.provider_text
    || artifact.provider_text.length > MAX_SOCIAL_POST_TEXT
  ) {
    return false;
  }
  try {
    const pathname = decodeURIComponent(new URL(artifact.media_url).pathname).toLowerCase();
    if (!pathname.includes(sha256)) return false;
  } catch {
    return false;
  }
  if (artifact?.format === 'video') {
    return mimeType === 'video/mp4' && Number(artifact?.duration_ms || 0) > 0;
  }
  return artifact?.format === 'photo' && mimeType.startsWith('image/');
}

function publishJobRefetchInterval(data) {
  const jobs = data?.jobs || [];
  if (jobs.some((job) => FAST_POLLING_JOB_STATES.has(job?.state))) return 10_000;
  if (jobs.some((job) => SLOW_POLLING_JOB_STATES.has(job?.state))) return 60_000;
  return false;
}

function statusTone(value) {
  if (['approved', 'passed', 'scheduled', 'sent'].includes(value)) {
    return 'border-green-400/25 bg-green-400/10 text-green-100';
  }
  if (['review_required', 'changes_requested', 'create_reconcile', 'delivery_reconcile', 'failed'].includes(value)) {
    return 'border-red-400/25 bg-red-400/10 text-red-100';
  }
  if (['queued', 'processing', 'sending', 'approval_wait', 'measurement_retry'].includes(value)) {
    return 'border-blue-400/25 bg-blue-400/10 text-blue-100';
  }
  return 'border-white/10 bg-white/5 text-white/55';
}

function Pill({ children, tone = '' }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.12em] ${tone || 'border-white/10 bg-white/5 text-white/55'}`}>
      {children}
    </span>
  );
}

function SummaryChip({ label, value }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/35 px-3 py-2">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-white/40">{label}</p>
      <p className="mt-1 text-lg font-black text-white">{Number(value || 0).toLocaleString()}</p>
    </div>
  );
}

function fieldError(code) {
  const messages = {
    content_generation_not_configured: 'Draft generation is not configured yet',
    publishing_not_configured: 'Add Buffer credentials, channel IDs, and the immutable media origin before scheduling',
    publisher_worker_unavailable: 'The Buffer worker has no recent healthy heartbeat. Run and verify the worker before scheduling',
    publishable_media_required: 'Add a stable public media URL, SHA-256, MIME type, and dimensions first',
    content_review_required: 'All four review checks must pass before approval',
    source_privacy_clearance_required: 'Every source must be marked safe before approval',
    source_asset_unavailable: 'One of the selected source assets is blocked or unavailable',
    source_privacy_change_in_progress: 'Another source safety or render-identity change is still in progress',
    source_privacy_cancellation_required: 'Cancel or resolve dependent Buffer work before changing this source',
    source_asset_changed_during_update: 'The source changed elsewhere; refresh and retry the exact update',
    approved_artifact_required: 'The exact approved revision is required',
    publish_preflight_failed: 'Media, source safety, or source lineage changed after approval',
    source_render_lineage_changed: 'The registered source reference or hash changed; rerender and review this content',
    invalid_publish_schedule: 'Choose a time at least 15 minutes from now',
    platform_content_already_scheduled: 'This platform content ID already has an active job',
    platform_content_already_published: 'This platform content ID already published; create a new content ID',
    terminal_job_has_provider_evidence: 'The prior job has a Buffer post ID. Verify it in Buffer, then create a new content ID instead of retrying',
    provider_cancellation_required: 'This post may already exist in Buffer. Cancel it there and verify its state before revoking or retrying',
    publish_schedule_in_progress: 'Another scheduling request is finishing; retry in a moment',
    publish_job_changed_before_retry: 'The prior delivery changed while retrying; refresh and inspect it',
    provider_resolution_confirmation_required: 'Verify in Buffer that the post was deleted or canceled before closing this job',
    publish_job_not_reviewable: 'This delivery no longer needs manual resolution; refresh and inspect its current state',
    provider_post_already_sent: 'Buffer reports this post as published, so it cannot be closed as canceled',
    publish_job_changed_before_resolution: 'The delivery changed during resolution; refresh and verify its latest Buffer state',
    content_plan_conflict: 'The social measurement plan has conflicting records and must be repaired first',
    content_plan_already_published: 'This platform content ID is already recorded as published; use a new content ID',
    creative_changed_before_save: 'The creative changed elsewhere; refresh before saving again',
    creative_changed_before_review: 'The creative changed during review; refresh and inspect the latest revision',
    creative_changed_before_approval: 'The review changed before approval; refresh and inspect every gate again',
    creative_artifact_request_conflict: 'That content ID already exists with different copy; open a new brief to use the next daily ID',
    creative_artifact_conflict: 'Duplicate creative rows need repair before this content ID can continue',
    partial_generation_conflict: 'One platform draft already exists; open a new brief or finish the existing concept',
    approved_artifact_immutable: 'Approved creative is immutable; create a new content ID for changes',
    invalid_render_result: 'This result is not bound to the configured media origin and trusted render-pack hash',
    invalid_render_result_artifact: 'A rendered artifact failed identity, codec, attribution, or QC validation',
    render_result_has_no_publish_candidates: 'This pack contains previews only and has no publish candidates',
    render_source_lineage_unavailable: 'Register the exact privacy-safe source hashes before importing this render pack',
    creative_changed_during_render_import: 'A creative changed during import; refresh and safely retry the same pack',
    silent_media_decision_required: 'Choose notification finishing, or explicitly select automatic delivery for this silent rendition',
    growth_owner_required: 'Only the FirstKnock owner can approve or schedule content',
    growth_admin_required: 'Owner or admin access is required',
  };
  return messages[code] || 'The content engine could not complete that action';
}

function initialBrief(conceptId = conceptIdForToday()) {
  return {
    concept_id: conceptId,
    title: '',
    pillar: PILLARS[0],
    direction: '',
    source_asset_keys: [],
    platforms: ['instagram', 'tiktok'],
    platform: 'instagram',
    format: 'video',
    hook: '',
    caption: '',
    cta_label: 'Try FirstKnock',
  };
}

function DetailField({ label, children, helper }) {
  return (
    <label className="block space-y-2 text-xs font-bold text-white/65">
      <span>{label}</span>
      {children}
      {helper && <span className="block text-[10px] font-normal leading-relaxed text-white/35">{helper}</span>}
    </label>
  );
}

function ContentDetailDialog({
  artifact,
  activeJob,
  latestJob,
  jobs,
  sources,
  open,
  onOpenChange,
  busy,
  onAction,
  publishingReady,
  canApprove,
  canSchedule,
}) {
  const [draft, setDraft] = React.useState(null);
  const [checks, setChecks] = React.useState({
    privacy_cleared: false,
    demo_labeled: false,
    claims_supported: false,
    media_rights_confirmed: false,
    note: '',
  });
  const [schedule, setSchedule] = React.useState({
    local: nextScheduleSlot(jobs, Date.now(), artifact?.platform),
    scheduling_type: defaultSchedulingType(artifact),
  });
  const [mediaInspection, setMediaInspection] = React.useState({
    status: 'idle',
    width: 0,
    height: 0,
    durationMs: 0,
    error: '',
  });
  const [renditionConfirmed, setRenditionConfirmed] = React.useState(false);
  const scheduledArtifactRef = React.useRef('');

  React.useEffect(() => {
    if (!artifact) return;
    setDraft(draftFromArtifact(artifact));
    setChecks(checksFromArtifact(artifact));
  }, [artifact]);

  React.useEffect(() => {
    if (!artifact?.id) {
      scheduledArtifactRef.current = '';
      return;
    }
    if (scheduledArtifactRef.current === artifact.id) return;
    scheduledArtifactRef.current = artifact.id;
    setSchedule({
      local: nextScheduleSlot(jobs, Date.now(), artifact.platform),
      scheduling_type: defaultSchedulingType(artifact),
    });
  }, [artifact?.id, artifact?.platform, artifact?.audio_mode, jobs]);

  const renditionKey = [
    artifact?.id,
    artifact?.revision,
    artifact?.media_url,
    artifact?.media_sha256,
    artifact?.width,
    artifact?.height,
    artifact?.duration_ms,
  ].join('|');
  React.useEffect(() => {
    setMediaInspection({
      status: artifact?.media_url ? 'loading' : 'idle',
      width: 0,
      height: 0,
      durationMs: 0,
      error: '',
    });
    setRenditionConfirmed(false);
  }, [renditionKey, artifact?.media_url]);

  if (!artifact || !draft) return null;
  const approved = artifact.approval_status === 'approved';
  const reviewed = artifact.review_status === 'passed';
  const isDirty = JSON.stringify(draft) !== JSON.stringify(draftFromArtifact(artifact));
  const reviewDirty = JSON.stringify(checks) !== JSON.stringify(checksFromArtifact(artifact));
  const mediaReady = artifactMediaReady(artifact);
  const mediaPreviewLoaded = mediaInspection.status === 'verified';
  const renditionInspected = mediaReady && mediaPreviewLoaded && renditionConfirmed;
  const draftProviderText = socialPostText(draft);
  const providerText = artifact.provider_text || socialPostText(artifact);
  const captionReady = providerText.length > 0
    && providerText.length <= MAX_SOCIAL_POST_TEXT;
  const sourceByKey = new Map((sources || []).map((source) => [source.asset_key, source]));
  const lineageByKey = new Map(
    (artifact.render_source_lineage || []).map((source) => [source.asset_key, source]),
  );
  const selectedSources = (artifact.source_asset_keys || []).map((assetKey) => ({
    assetKey,
    source: sourceByKey.get(assetKey),
    lineage: lineageByKey.get(assetKey),
  }));
  const sourcesReady = selectedSources.length > 0 && selectedSources.every(({ source, lineage }) => (
    source?.active !== false
    && source?.privacy_status === 'safe'
    && (
      !artifact.render_result_schema
      || (
        lineage?.source_sha256 === source?.source_sha256
        && lineage?.source_reference === source?.source_reference
      )
    )
  ));
  const terminalRetryAvailable = latestJob
    && ['failed', 'canceled'].includes(latestJob.state)
    && !latestJob.provider_post_id
    && !activeJob;
  const terminalProviderEvidence = latestJob
    && ['failed', 'canceled'].includes(latestJob.state)
    && latestJob.provider_post_id
    && !activeJob;
  const providerCancellationRequired = activeJob
    && (
      activeJob.provider_post_id
      || !CANCELABLE_JOB_STATES.has(activeJob.state)
    );
  const deliveryComplete = latestJob?.state === 'sent' && !activeJob;
  const canPlanDelivery = approved
    && !activeJob
    && !deliveryComplete
    && !terminalProviderEvidence;
  const displayJob = activeJob || latestJob;
  const allChecks = Object.entries(checks)
    .filter(([key]) => key !== 'note')
    .every(([, value]) => value === true);
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  const inspectLoadedMedia = ({ width, height, durationMs = 0 }) => {
    const actualWidth = Number(width || 0);
    const actualHeight = Number(height || 0);
    const actualDurationMs = Number(durationMs || 0);
    const expectedWidth = Number(artifact.width || 0);
    const expectedHeight = Number(artifact.height || 0);
    let error = '';
    if (actualWidth !== expectedWidth || actualHeight !== expectedHeight) {
      error = `Loaded dimensions ${actualWidth}×${actualHeight} do not match the saved ${expectedWidth}×${expectedHeight}.`;
    } else if (artifact.format === 'video') {
      const expectedDurationMs = Number(artifact.duration_ms || 0);
      const toleranceMs = Math.max(1500, expectedDurationMs * 0.03);
      if (
        !Number.isFinite(actualDurationMs)
        || actualDurationMs <= 0
        || Math.abs(actualDurationMs - expectedDurationMs) > toleranceMs
      ) {
        error = `Loaded duration ${Math.round(actualDurationMs).toLocaleString()} ms does not match the saved ${expectedDurationMs.toLocaleString()} ms.`;
      }
    }
    setMediaInspection({
      status: error ? 'failed' : 'verified',
      width: actualWidth,
      height: actualHeight,
      durationMs: actualDurationMs,
      error,
    });
    setRenditionConfirmed(false);
  };

  const failMediaInspection = () => {
    setMediaInspection({
      status: 'failed',
      width: 0,
      height: 0,
      durationMs: 0,
      error: 'The browser could not load this final rendition. Verify that the hosted URL is public and immutable.',
    });
    setRenditionConfirmed(false);
  };

  const saveDraft = () => onAction({
    action: 'update_draft',
    artifact_id: artifact.id,
    artifact: {
      ...draft,
      overlay_text: draft.overlay_text.split('\n').map((value) => value.trim()).filter(Boolean),
      shot_list: draft.shot_list.split('\n').map((value) => value.trim()).filter(Boolean),
      width: Number(draft.width || 0),
      height: Number(draft.height || 0),
      duration_ms: Number(draft.duration_ms || 0),
      thumbnail_offset_ms: Number(draft.thumbnail_offset_ms || 0),
    },
  });

  const saveReview = () => onAction({
    action: 'review',
    artifact_id: artifact.id,
    ...checks,
  });

  const schedulePost = () => {
    const dueAt = phoenixLocalToIso(schedule.local);
    if (!dueAt) return;
    onAction({
      action: 'schedule',
      artifact_id: artifact.id,
      due_at: dueAt,
      timezone: 'America/Phoenix',
      scheduling_type: schedule.scheduling_type,
      confirm_silent_automatic:
        artifact.audio_mode === 'silent'
        && schedule.scheduling_type === 'automatic',
      retry_terminal: terminalRetryAvailable,
    });
  };

  const revokeApproval = () => {
    const note = latestJob?.state === 'sent'
      ? 'Revoke approval for future delivery? This does not remove the post that Buffer already published.'
      : 'Revoke this approval? Queued delivery will be canceled where it is still safe to do so.';
    if (!window.confirm(note)) return;
    onAction({
      action: 'revoke',
      artifact_id: artifact.id,
      note: 'Approval revoked from the Content Engine.',
    });
  };

  const cancelJob = () => {
    if (!activeJob?.id || !window.confirm('Cancel this queued Buffer delivery?')) return;
    onAction({ action: 'cancel_job', job_id: activeJob.id });
  };

  const resolveJob = () => {
    if (
      !activeJob?.id
      || !window.confirm(
        'Only continue if you opened Buffer and verified this post was deleted or canceled and will not publish. This permanently closes the FirstKnock delivery job. Have you verified the Buffer post is canceled?',
      )
    ) {
      return;
    }
    onAction({
      action: 'resolve_job',
      job_id: activeJob.id,
      provider_cancellation_verified: true,
      resolution_evidence_note: activeJob.provider_post_id
        ? `Owner verified Buffer post ${activeJob.provider_post_id} was canceled or deleted.`
        : `Owner verified no Buffer post remains for ${activeJob.platform_content_id}.`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto border-white/10 bg-[#080808] text-white sm:max-w-2xl">
        <DialogHeader className="text-left">
          <DialogTitle className="pr-8 text-xl font-black">{artifact.title}</DialogTitle>
          <DialogDescription className="text-white/45">
            {PLATFORM_LABELS[artifact.platform]} · {artifact.platform_content_id} · revision {artifact.revision}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Pill>{artifact.generation_status === 'draft_ready' ? 'AI draft' : 'Manual draft'}</Pill>
          <Pill tone={statusTone(artifact.review_status)}>
            {reviewed ? 'Review passed' : artifact.review_status?.replaceAll('_', ' ')}
          </Pill>
          <Pill tone={statusTone(artifact.approval_status)}>
            {approved ? 'Approved' : 'Not approved'}
          </Pill>
          {displayJob && (
            <Pill tone={statusTone(displayJob.state)}>
              {JOB_LABELS[displayJob.state] || displayJob.state}
            </Pill>
          )}
        </div>

        <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-black">Approval evidence</h3>
              <p className="mt-1 text-xs text-white/40">
                Inspect the final rendition and every selected source before passing review.
              </p>
            </div>
            <Pill tone={renditionInspected ? statusTone('passed') : statusTone('review_required')}>
              {renditionInspected
                ? 'Rendition inspected'
                : mediaPreviewLoaded
                  ? 'Preview loaded'
                  : mediaReady
                    ? 'Saved metadata only'
                    : 'Metadata incomplete'}
            </Pill>
          </div>

          {artifact.media_url ? (
            <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
              {artifact.format === 'video' ? (
                <video
                  controls
                  playsInline
                  preload="metadata"
                  src={artifact.media_url}
                  onLoadedMetadata={(event) => inspectLoadedMedia({
                    width: event.currentTarget.videoWidth,
                    height: event.currentTarget.videoHeight,
                    durationMs: event.currentTarget.duration * 1000,
                  })}
                  onError={failMediaInspection}
                  aria-label={`${artifact.title} final media preview`}
                  className="max-h-80 w-full bg-black object-contain"
                />
              ) : (
                <img
                  src={artifact.media_url}
                  alt={`${artifact.title} final media preview`}
                  onLoad={(event) => inspectLoadedMedia({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })}
                  onError={failMediaInspection}
                  className="max-h-80 w-full bg-black object-contain"
                />
              )}
              <div className="space-y-2 border-t border-white/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] font-bold text-white/45">
                    {artifact.mime_type || 'Unknown MIME'}
                    {' · '}{Number(artifact.width || 0)}×{Number(artifact.height || 0)}
                  </p>
                  <a
                    href={artifact.media_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-md text-xs font-black text-blue-200 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                  >
                    Open final media
                    <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </div>
                <p className="break-all font-mono text-[9px] leading-relaxed text-white/35">
                  SHA-256: {artifact.media_sha256 || 'Not recorded'}
                </p>
                {artifact.render_result_schema && (
                  <div className="grid gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[9px] leading-relaxed text-white/40 sm:grid-cols-2">
                    <span>Renderer: {artifact.render_profile_id || 'unknown'}</span>
                    <span>Audio: {artifact.audio_mode === 'silent' ? 'silent track' : 'owned/licensed baked audio'}</span>
                    <span>Bytes: {Number(artifact.media_byte_size || 0).toLocaleString()}</span>
                    <span>Template: {artifact.render_template_version || 'unknown'}</span>
                  </div>
                )}
                <div className={`rounded-lg border px-3 py-2 text-[10px] leading-relaxed ${
                  mediaInspection.status === 'failed'
                    ? 'border-red-300/20 bg-red-300/10 text-red-100'
                    : mediaPreviewLoaded
                      ? 'border-green-300/20 bg-green-300/10 text-green-100'
                      : 'border-white/10 bg-white/5 text-white/45'
                }`}>
                  {mediaInspection.status === 'failed'
                    ? mediaInspection.error
                    : mediaPreviewLoaded
                      ? `Browser-loaded metadata matches the saved ${mediaInspection.width}×${mediaInspection.height}${artifact.format === 'video' ? ` and ${Math.round(mediaInspection.durationMs).toLocaleString()} ms duration` : ''}. The browser has not verified the saved SHA-256; the publish worker performs that byte check.`
                      : mediaInspection.status === 'loading'
                        ? 'Loading the hosted rendition and inspecting browser-visible metadata…'
                        : 'No hosted rendition is available to inspect.'}
                </div>
                <label className={`flex items-start gap-3 rounded-lg border p-3 text-[11px] leading-relaxed ${
                  mediaPreviewLoaded
                    ? 'border-blue-300/20 bg-blue-300/10 text-blue-100'
                    : 'border-white/10 bg-white/[0.03] text-white/35'
                }`}>
                  <input
                    type="checkbox"
                    checked={renditionConfirmed}
                    disabled={!mediaPreviewLoaded}
                    onChange={(event) => setRenditionConfirmed(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-blue-300"
                  />
                  I inspected the loaded final rendition and confirmed it is the intended post.
                </label>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-white/15 bg-black/30 p-4 text-center">
              <Film className="mx-auto h-5 w-5 text-white/30" />
              <p className="mt-2 text-xs font-bold text-white/55">No final media saved</p>
              <p className="mt-1 text-[10px] text-white/35">Save a content-addressed rendition before review.</p>
            </div>
          )}

          <div className="rounded-xl border border-white/10 bg-black/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/40">
                Exact provider text
              </p>
              <span className={`text-[10px] font-black ${captionReady ? 'text-green-200' : 'text-red-200'}`}>
                {providerText.length.toLocaleString()} / {MAX_SOCIAL_POST_TEXT.toLocaleString()}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
              {providerText || 'No publishable provider text is saved.'}
            </p>
          </div>

          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/40">
              Selected sources
            </p>
            <div className="mt-2 space-y-2">
              {selectedSources.map(({ assetKey, source }) => (
                <div key={assetKey} className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-black text-white">{source?.title || assetKey}</p>
                    <Pill tone={source?.privacy_status === 'safe' ? statusTone('passed') : statusTone('review_required')}>
                      {source?.privacy_status?.replaceAll('_', ' ') || 'Source unavailable'}
                    </Pill>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-white/45">
                    {source?.safe_summary || 'This source record could not be loaded.'}
                  </p>
                  {source?.privacy_note && (
                    <p className="mt-2 text-[10px] leading-relaxed text-amber-100/65">
                      Privacy note: {source.privacy_note}
                    </p>
                  )}
                  <p className="mt-2 break-all font-mono text-[9px] text-white/30">
                    Source SHA-256: {source?.source_sha256 || 'Not recorded'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {!approved && (
          <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div>
              <h3 className="font-black">Creative revision</h3>
              <p className="mt-1 text-xs text-white/40">
                Save caption, overlay, shot list, and the final hosted rendition before review.
              </p>
            </div>
            <DetailField label="Hook">
              <Input value={draft.hook} onChange={(event) => updateDraft('hook', event.target.value)} className="border-white/10 bg-black text-white" />
            </DetailField>
            <DetailField
              label="Caption"
              helper={`${draftProviderText.length.toLocaleString()} / ${MAX_SOCIAL_POST_TEXT.toLocaleString()} characters after disclosure, CTA, and content URL`}
            >
              <Textarea value={draft.caption} onChange={(event) => updateDraft('caption', event.target.value)} className="min-h-28 border-white/10 bg-black text-white" />
            </DetailField>
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailField label="Overlay lines" helper="One short line per row.">
                <Textarea value={draft.overlay_text} onChange={(event) => updateDraft('overlay_text', event.target.value)} className="min-h-24 border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="Shot list" helper="One shot or edit instruction per row.">
                <Textarea value={draft.shot_list} onChange={(event) => updateDraft('shot_list', event.target.value)} className="min-h-24 border-white/10 bg-black text-white" />
              </DetailField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailField label="CTA">
                <Input value={draft.cta_label} onChange={(event) => updateDraft('cta_label', event.target.value)} className="border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField
                label="CTA URL"
                helper={artifact.platform === 'instagram'
                  ? 'The content ID is preserved in the neutral /start URL, but Instagram caption URLs are not reliably clickable. Use a controlled bio, Story, or comment/DM handoff before treating conversions as attributable.'
                  : 'The content ID is preserved in the neutral /start URL. Use a controlled TikTok profile-link or comment/DM handoff so viewers can reach the tracked URL.'}
              >
                <Input
                  value={draft.cta_url}
                  onChange={(event) => updateDraft('cta_url', event.target.value)}
                  placeholder="https://firstknock.online"
                  disabled
                  className="border-white/10 bg-black text-white"
                />
              </DetailField>
            </div>
            <DetailField label="Disclosure">
              <Input value={draft.disclosure} onChange={(event) => updateDraft('disclosure', event.target.value)} placeholder="Demo data shown." className="border-white/10 bg-black text-white" />
            </DetailField>
            <div className="rounded-xl border border-white/10 bg-black/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/40">
                  Exact provider text
                </p>
                <span className={`text-[10px] font-black ${draftProviderText.length <= MAX_SOCIAL_POST_TEXT ? 'text-green-200' : 'text-red-200'}`}>
                  {draftProviderText.length.toLocaleString()} / {MAX_SOCIAL_POST_TEXT.toLocaleString()}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
                {draftProviderText || 'Caption, disclosure, CTA, and content URL will appear here.'}
              </p>
            </div>

            <div className="rounded-xl border border-blue-400/20 bg-blue-400/10 p-3">
              <p className="text-xs font-black text-blue-100">Final media rendition</p>
              <p className="mt-1 text-[11px] leading-relaxed text-blue-100/60">
                Use a stable public HTTPS URL with no signed query string. Saved fields are configuration metadata only; the reviewer must load and inspect the hosted rendition before approval.
              </p>
            </div>
            <DetailField label="Stable media URL">
              <Input value={draft.media_url} onChange={(event) => updateDraft('media_url', event.target.value)} placeholder="https://media.example.com/fk/asset-sha.mp4" className="border-white/10 bg-black text-white" />
            </DetailField>
            <DetailField label="Media SHA-256">
              <Input value={draft.media_sha256} onChange={(event) => updateDraft('media_sha256', event.target.value)} placeholder="64 lowercase hexadecimal characters" className="font-mono text-xs border-white/10 bg-black text-white" />
            </DetailField>
            <div className="grid gap-3 sm:grid-cols-4">
              <DetailField label="MIME type">
                <select value={draft.mime_type} onChange={(event) => updateDraft('mime_type', event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white">
                  <option value="video/mp4">video/mp4</option>
                  <option value="image/jpeg">image/jpeg</option>
                  <option value="image/png">image/png</option>
                  <option value="image/webp">image/webp</option>
                </select>
              </DetailField>
              <DetailField label="Width">
                <Input type="number" min="1" value={draft.width} onChange={(event) => updateDraft('width', event.target.value)} className="border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="Height">
                <Input type="number" min="1" value={draft.height} onChange={(event) => updateDraft('height', event.target.value)} className="border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="Duration ms">
                <Input type="number" min="0" value={draft.duration_ms} onChange={(event) => updateDraft('duration_ms', event.target.value)} disabled={artifact.format !== 'video'} className="border-white/10 bg-black text-white" />
              </DetailField>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={saveDraft}
              disabled={busy || !isDirty}
              className="w-full border-white/15 bg-transparent text-white hover:bg-white/10"
            >
              <Save className="mr-2 h-4 w-4" />
              {isDirty ? 'Save revision' : 'Revision saved'}
            </Button>
          </div>
        )}

        {!approved && (
          <fieldset className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <legend className="sr-only">Privacy and claims review</legend>
            <div>
              <h3 className="flex items-center gap-2 font-black"><ShieldCheck className="h-4 w-4 text-green-300" /> Privacy and claims review</h3>
              <p className="mt-1 text-xs text-white/40">Every blocking check must pass. Editing the creative resets this review.</p>
            </div>
            {[
              ['privacy_cleared', 'Names, emails, addresses, account details, and device-private content are removed'],
              ['demo_labeled', 'Demo or synthetic data is clearly labeled'],
              ['claims_supported', 'Performance claims have evidence or were rewritten'],
              ['media_rights_confirmed', 'Music, footage, screenshots, and visual rights are cleared'],
            ].map(([key, label]) => (
              <label key={key} className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3 text-xs leading-relaxed text-white/65">
                <input
                  type="checkbox"
                  checked={checks[key]}
                  onChange={(event) => setChecks((current) => ({ ...current, [key]: event.target.checked }))}
                  className="mt-0.5 h-4 w-4 accent-green-400"
                />
                {label}
              </label>
            ))}
            <DetailField label="Review note">
              <Textarea value={checks.note} onChange={(event) => setChecks((current) => ({ ...current, note: event.target.value }))} className="min-h-20 border-white/10 bg-black text-white" />
            </DetailField>
            {(isDirty || !mediaReady || !renditionInspected || !captionReady || !sourcesReady) && (
              <div aria-live="polite" className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-3 text-[11px] leading-relaxed text-amber-100">
                {isDirty
                  ? 'Save this creative revision before reviewing it.'
                  : !mediaReady
                    ? 'Add and save valid rendition metadata before review.'
                    : !renditionInspected
                      ? 'Load the hosted preview, inspect it, and confirm the final rendition before review.'
                    : !captionReady
                      ? 'Shorten the exact provider text to 2,200 characters or fewer before review.'
                      : 'Every selected source must be available, active, and privacy-safe before review.'}
              </div>
            )}
            <Button
              type="button"
              onClick={saveReview}
              disabled={busy || !reviewDirty || isDirty || !mediaReady || !renditionInspected || !captionReady || !sourcesReady}
              className="w-full bg-green-400 font-black text-black hover:bg-green-300"
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {allChecks ? 'Pass review' : 'Save review blockers'}
            </Button>
          </fieldset>
        )}

        {reviewed && !approved && (
          <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4">
            <h3 className="font-black text-amber-100">Owner approval</h3>
            <p className="mt-1 text-xs leading-relaxed text-amber-100/65">
              Approval locks this exact revision, caption, media URL, and media SHA-256. Later changes require a new review.
            </p>
            <Button
              type="button"
              onClick={() => onAction({ action: 'approve', artifact_id: artifact.id })}
              disabled={busy || isDirty || reviewDirty || !allChecks || !mediaReady || !renditionInspected || !captionReady || !sourcesReady || !canApprove}
              className="mt-3 w-full bg-amber-300 font-black text-black hover:bg-amber-200"
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {canApprove ? 'Approve this revision' : 'Owner approval required'}
            </Button>
            {(isDirty || reviewDirty || !renditionInspected) && (
              <p aria-live="polite" className="mt-2 text-[10px] leading-relaxed text-amber-100/60">
                {isDirty
                  ? 'Save the creative before approval.'
                  : reviewDirty
                    ? 'Save the updated review before approval.'
                    : 'Load, inspect, and confirm the hosted rendition before approval.'}
              </p>
            )}
          </div>
        )}

        {approved && (
          <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-black text-white">Revision {artifact.revision} approved</p>
              <p className="mt-1 text-[10px] leading-relaxed text-white/40">
                {providerCancellationRequired
                  ? 'This delivery has reached Buffer or is being reconciled. Cancel and verify it in Buffer before revoking.'
                  : 'Revoking stops queued work where possible; it cannot remove an already published post.'}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={revokeApproval}
              disabled={busy || !canApprove || providerCancellationRequired}
              className="shrink-0 border-red-300/25 bg-transparent text-red-100 hover:bg-red-400/10"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {!canApprove
                ? 'Owner only'
                : providerCancellationRequired
                  ? 'Cancel in Buffer first'
                  : 'Revoke approval'}
            </Button>
          </div>
        )}

        {approved && terminalProviderEvidence && (
          <div className="rounded-2xl border border-red-300/25 bg-red-300/10 p-4 text-red-100">
            <h3 className="font-black">Create a new content ID before publishing again</h3>
            <p className="mt-1 text-xs leading-relaxed text-red-100/70">
              The terminal delivery still has Buffer provider evidence
              {` (${latestJob.provider_post_id})`}. Verify that post in Buffer, then revoke this
              approval and create a new content ID. Reusing this ID could publish the same content twice.
            </p>
          </div>
        )}

        {canPlanDelivery && (
          <div className="space-y-3 rounded-2xl border border-green-400/20 bg-green-400/[0.07] p-4">
            <div>
              <h3 className="flex items-center gap-2 font-black text-green-100"><CalendarClock className="h-4 w-4" /> Buffer delivery</h3>
              <p className="mt-1 text-xs leading-relaxed text-green-100/60">
                {terminalRetryAvailable
                  ? 'The previous attempt is terminal. Queue a new delivery when its failure is resolved.'
                  : 'The time is saved as an exact UTC instant. Planning timezone: America/Phoenix.'}
              </p>
            </div>
            {!publishingReady && (
              <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-100">
                Buffer delivery is not ready for this platform. Add its channel ID and server credentials, enable the publisher, then verify a recent healthy worker heartbeat before scheduling.
              </div>
            )}
            {!canSchedule && (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs leading-relaxed text-white/55">
                Only the FirstKnock owner can queue delivery.
              </div>
            )}
            {artifact.audio_mode === 'silent' && (
              <div className="rounded-xl border border-blue-300/25 bg-blue-300/10 p-3 text-xs leading-relaxed text-blue-100">
                This rendition has a silent audio track. Notification finish is selected by default so you can add owned, licensed, or native platform audio. Choosing Automatic explicitly confirms that publishing it silent is intentional.
              </div>
            )}
            {(!mediaReady || !captionReady || !sourcesReady) && (
              <div className="rounded-xl border border-red-300/25 bg-red-300/10 p-3 text-xs leading-relaxed text-red-100">
                Delivery is blocked because the approved media, caption, source safety, or source lineage no longer passes preflight. Revoke approval and create a reviewed revision.
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailField
                label="Publish date and time"
                helper="Suggested from the 9:30 AM, 1:30 PM, and 6:30 PM America/Phoenix cadence; existing non-canceled jobs are skipped."
              >
                <Input type="datetime-local" value={schedule.local} onChange={(event) => setSchedule((current) => ({ ...current, local: event.target.value }))} className="border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="Delivery mode">
                <select value={schedule.scheduling_type} onChange={(event) => setSchedule((current) => ({ ...current, scheduling_type: event.target.value }))} className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white">
                  <option value="automatic">Automatic</option>
                  <option value="notification">Notification finish</option>
                </select>
              </DetailField>
            </div>
            <Button
              type="button"
              onClick={schedulePost}
              disabled={busy || !publishingReady || !canSchedule || !mediaReady || !captionReady || !sourcesReady}
              className="w-full bg-green-400 font-black text-black hover:bg-green-300"
            >
              <Send className="mr-2 h-4 w-4" />
              Queue for Buffer worker
            </Button>
            <p className="text-[10px] leading-relaxed text-white/35">
              Use notification mode when a post needs native trending audio or a final in-app edit. Automatic delivery publishes the exact approved bytes.
            </p>
          </div>
        )}

        {displayJob && (
          <div className={`rounded-2xl border p-4 ${statusTone(displayJob.state)}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-black">{JOB_LABELS[displayJob.state] || displayJob.state}</p>
                <p className="mt-1 text-xs opacity-70">{dateLabel(displayJob.due_at)} · {displayJob.scheduling_type}</p>
              </div>
              <Pill>{displayJob.attempt_count} attempt{displayJob.attempt_count === 1 ? '' : 's'}</Pill>
            </div>
            {displayJob.last_error_message && (
              <p className="mt-3 text-xs leading-relaxed opacity-75">{displayJob.last_error_message}</p>
            )}
            {displayJob.provider_external_link && (
              <a
                href={displayJob.provider_external_link}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex rounded-sm text-xs font-black underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
              >
                Open published post
                <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </a>
            )}
            {activeJob && CANCELABLE_JOB_STATES.has(activeJob.state) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={cancelJob}
                disabled={busy || !canSchedule}
                className="mt-3 border-current/25 bg-transparent text-current hover:bg-black/10"
              >
                <XCircle className="mr-2 h-4 w-4" />
                {canSchedule ? 'Cancel queued delivery' : 'Owner only'}
              </Button>
            )}
            {activeJob?.state === 'review_required' && (
              <div className="mt-3 rounded-xl border border-current/20 bg-black/15 p-3">
                <p className="text-[11px] font-black">Manual Buffer verification required</p>
                <p className="mt-1 text-[10px] leading-relaxed opacity-75">
                  Open Buffer, delete or cancel any matching post, then close this job only after confirming it cannot publish.
                </p>
                <p className="mt-2 break-all font-mono text-[10px] opacity-80">
                  Buffer post ID: {activeJob.provider_post_id || 'Not recorded—search by content ID and scheduled time'}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={resolveJob}
                  disabled={busy || !canSchedule}
                  className="mt-3 border-current/25 bg-transparent text-current hover:bg-black/10"
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {canSchedule ? 'I verified cancellation in Buffer' : 'Owner verification required'}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-col gap-3 border-t border-white/10 bg-[#080808]/95 px-6 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite" className="text-[11px] font-bold text-white/55">
            {isDirty
              ? 'Unsaved creative changes'
              : reviewDirty
                ? 'Unsaved review changes'
                : approved
                  ? (JOB_LABELS[displayJob?.state] || 'Approved and ready')
                  : `Revision ${artifact.revision} saved`}
          </p>
          {!approved && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={isDirty ? saveDraft : saveReview}
              disabled={busy || (!isDirty && (
                !reviewDirty || !mediaReady || !renditionInspected || !captionReady || !sourcesReady
              ))}
              className="w-full border-white/15 bg-black text-white hover:bg-white/10 sm:w-auto"
            >
              {reviewDirty && !isDirty
                ? <ShieldCheck className="mr-2 h-4 w-4" />
                : <Save className="mr-2 h-4 w-4" />}
              {isDirty
                ? 'Save revision'
                : reviewDirty
                  ? (allChecks ? 'Pass review' : 'Save blockers')
                  : 'Revision saved'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ContentEngineQueue({ accent, accentText }) {
  const queryClient = useQueryClient();
  const renderImportRef = React.useRef(null);
  const [briefOpen, setBriefOpen] = React.useState(false);
  const [brief, setBrief] = React.useState(initialBrief);
  const [selectedId, setSelectedId] = React.useState('');

  const query = useQuery({
    queryKey: ['growthContentEngine'],
    queryFn: async () => {
      const result = await base44.functions.invoke('manageGrowthContentEngine', { action: 'list' });
      return result?.data || result;
    },
    retry: false,
    refetchInterval: (currentQuery) => publishJobRefetchInterval(currentQuery.state.data),
    refetchIntervalInBackground: false,
  });

  const action = useMutation({
    mutationFn: async (payload) => {
      const result = await base44.functions.invoke('manageGrowthContentEngine', payload);
      return result?.data || result;
    },
    onSuccess: async (result, variables) => {
      const messages = {
        register_sources: 'Audited FirstKnock source inventory loaded',
        create_draft: 'Manual content draft created',
        generate_drafts: 'Selected platform drafts generated',
        update_draft: 'Creative revision saved; review reset',
        review: 'Privacy and claims review saved',
        approve: 'This exact creative revision is approved',
        revoke: 'Creative approval revoked',
        schedule: 'Approved post queued for Buffer worker',
        cancel_job: 'Queued Buffer delivery canceled',
        resolve_job: 'Buffer cancellation recorded; delivery job closed',
      };
      if (variables?.action === 'import_render_result') {
        const previewNote = Number(result?.preview_skipped || 0)
          ? `; ${Number(result.preview_skipped)} sanitized preview-only rendition(s) skipped`
          : '';
        toast.success(`${Number(result?.imported || 0)} rendered artifact(s) imported${previewNote}`);
      } else {
        toast.success(messages[variables?.action] || 'Content engine updated');
      }
      if (['create_draft', 'generate_drafts'].includes(variables?.action)) {
        setBriefOpen(false);
        setBrief(initialBrief());
      }
      await query.refetch();
      if (['schedule', 'cancel_job', 'revoke', 'resolve_job'].includes(variables?.action)) {
        await queryClient.invalidateQueries({ queryKey: ['acquisitionReport'] });
      }
    },
    onError: async (error, variables) => {
      toast.error(
        error?.response?.data?.message
        || fieldError(error?.response?.data?.error),
      );
      await query.refetch();
      if (['schedule', 'cancel_job', 'revoke', 'resolve_job'].includes(variables?.action)) {
        await queryClient.invalidateQueries({ queryKey: ['acquisitionReport'] });
      }
    },
  });

  const data = query.data || {};
  const sources = data.sources || [];
  const artifacts = data.artifacts || [];
  const jobs = data.jobs || [];
  const sentJobSignature = jobs
    .filter((job) => job.state === 'sent')
    .map((job) => `${job.id}:${job.provider_sent_at || ''}`)
    .sort()
    .join('|');
  const priorSentJobSignature = React.useRef('');
  React.useEffect(() => {
    if (!sentJobSignature || sentJobSignature === priorSentJobSignature.current) return;
    priorSentJobSignature.current = sentJobSignature;
    queryClient.invalidateQueries({ queryKey: ['acquisitionReport'] });
  }, [queryClient, sentJobSignature]);
  const latestJobsByArtifact = new Map();
  const activeJobsByArtifact = new Map();
  for (const job of jobs) {
    if (!latestJobsByArtifact.has(job.artifact_id)) {
      latestJobsByArtifact.set(job.artifact_id, job);
    }
    if (
      !TERMINAL_JOB_STATES.has(job.state)
      && !activeJobsByArtifact.has(job.artifact_id)
    ) {
      activeJobsByArtifact.set(job.artifact_id, job);
    }
  }
  const selected = artifacts.find((artifact) => artifact.id === selectedId) || null;
  const capabilities = data.capabilities || {};
  const publishingReady = capabilities.publishing_enabled === true;
  const renderImportReady = capabilities.render_result_import_ready === true;
  const canApprove = capabilities.can_approve === true;
  const canSchedule = capabilities.can_schedule === true;
  const summary = data.summary || {};
  const openBrief = () => {
    setBrief(initialBrief(nextConceptIdForToday(artifacts)));
    setBriefOpen(true);
  };
  const updateBrief = (field, value) => setBrief((current) => ({ ...current, [field]: value }));
  const importRenderResult = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 200_000) {
      toast.error('Render result must be 200 KB or smaller');
      return;
    }
    try {
      const renderResult = JSON.parse(await file.text());
      if (
        renderResult?.schema_version !== 'growth-render-result.v1'
        || !Array.isArray(renderResult?.artifacts)
        || !renderResult.artifacts.length
      ) {
        throw new Error('invalid');
      }
      action.mutate({ action: 'import_render_result', render_result: renderResult });
    } catch {
      toast.error('Choose a valid growth-render-result.v1 JSON file');
    }
  };

  const toggleSource = (assetKey) => {
    setBrief((current) => ({
      ...current,
      source_asset_keys: current.source_asset_keys.includes(assetKey)
        ? current.source_asset_keys.filter((key) => key !== assetKey)
        : [...current.source_asset_keys, assetKey],
    }));
  };

  const togglePlatform = (platform) => {
    setBrief((current) => {
      const next = current.platforms.includes(platform)
        ? current.platforms.filter((value) => value !== platform)
        : [...current.platforms, platform];
      return { ...current, platforms: next.length ? next : [platform] };
    });
  };

  const createManual = () => action.mutate({
    action: 'create_draft',
    artifact: {
      concept_id: brief.concept_id,
      campaign: '1000-users',
      platform: brief.platform,
      title: brief.title,
      pillar: brief.pillar,
      format: brief.format,
      source_asset_keys: brief.source_asset_keys,
      hook: brief.hook,
      caption: brief.caption,
      overlay_text: brief.hook ? [brief.hook] : [],
      shot_list: ['Frame the product behavior clearly', 'Add captions and one CTA'],
      cta_label: brief.cta_label,
      disclosure: 'Demo data shown.',
    },
  });

  const generateDrafts = () => action.mutate({
    action: 'generate_drafts',
    concept_id: brief.concept_id,
    campaign: '1000-users',
    title: brief.title,
    pillar: brief.pillar,
    direction: brief.direction,
    source_asset_keys: brief.source_asset_keys,
    platforms: brief.platforms,
  });

  const canCreateManual = brief.title.trim()
    && brief.hook.trim()
    && brief.caption.trim()
    && brief.source_asset_keys.length;
  const canGenerate = brief.title.trim()
    && brief.direction.trim()
    && brief.source_asset_keys.length
    && brief.platforms.length;

  return (
    <>
      <section className="rounded-2xl border border-white/10 bg-[#0b0b0b] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em]" style={{ color: accent }}>
              Production system
            </p>
            <h2 className="mt-1 text-xl font-black">Content engine</h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/50">
              Turn sanitized FirstKnock product moments into reviewed Instagram and TikTok drafts, then prepare the exact approved rendition for Buffer when delivery is configured.
            </p>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-2 sm:flex-row lg:w-auto">
            <input
              ref={renderImportRef}
              type="file"
              accept="application/json,.json"
              onChange={importRenderResult}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => renderImportRef.current?.click()}
              disabled={!sources.length || !renderImportReady || query.isLoading || action.isPending}
              className="w-full border-white/15 bg-transparent font-black text-white hover:bg-white/10 lg:w-auto"
            >
              <Upload className="mr-2 h-4 w-4" />
              Import render result
            </Button>
            <Button
              type="button"
              onClick={openBrief}
              disabled={!sources.length || query.isLoading}
              style={{ background: accent, color: accentText }}
              className="w-full font-black lg:w-auto"
            >
              <Plus className="mr-2 h-4 w-4" />
              New brief
            </Button>
          </div>
        </div>

        {query.isLoading ? (
          <div className="mt-5 space-y-3">
            {[0, 1, 2].map((value) => <div key={value} className="h-24 animate-pulse rounded-xl bg-white/[0.05]" />)}
          </div>
        ) : query.isError ? (
          <div className="mt-5 rounded-xl border border-red-400/25 bg-red-400/10 p-4">
            <p className="font-black text-red-100">The content queue is unavailable</p>
            <p className="mt-1 text-xs text-red-100/60">Tracking and acquisition reporting are still working.</p>
            <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()} className="mt-3 border-red-200/25 bg-transparent text-red-100 hover:bg-red-400/10">
              Retry queue
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <SummaryChip label="Sources" value={summary.sources} />
              <SummaryChip label="Needs review" value={summary.needs_review} />
              <SummaryChip label="Approved" value={summary.approved} />
              <SummaryChip label="Delivery queue" value={summary.queued} />
              <SummaryChip label="Needs attention" value={summary.attention} />
            </div>

            <div className="mt-4 grid gap-2 text-[10px] sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">Draft generation</p>
                <p className="mt-1 font-bold text-white/70">{capabilities.draft_generation_configured ? 'Configured' : 'Not configured'}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">Media rendering</p>
                <p className="mt-1 font-bold text-white/70">
                  {capabilities.render_result_import_ready
                    ? 'Trusted render import ready'
                    : !capabilities.immutable_media_origin_configured
                      ? 'Renderer built; media host needed'
                      : !capabilities.trusted_render_pack_configured
                        ? 'Approve a render-pack hash'
                        : 'Approve the renderer environment'}
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">Instagram delivery</p>
                <p className="mt-1 font-bold text-white/70">{capabilities.instagram?.delivery === 'buffer' ? 'Buffer worker ready' : 'Not ready'}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">TikTok delivery</p>
                <p className="mt-1 font-bold text-white/70">{capabilities.tiktok?.delivery === 'buffer' ? 'Buffer worker ready' : 'Not ready'}</p>
              </div>
            </div>

            {!renderImportReady && (
              <div className="mt-4 rounded-xl border border-violet-300/20 bg-violet-300/10 p-3">
                <p className="text-xs font-black text-violet-100">Rendered-media import is locked</p>
                <p className="mt-1 text-[11px] leading-relaxed text-violet-100/60">
                  Configure the immutable media origin, then allowlist the reviewed pack and renderer-environment SHA-256 values before importing hosted candidates.
                </p>
              </div>
            )}
            {!capabilities.draft_generation_configured && (
              <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3">
                <p className="text-xs font-black text-amber-100">Draft generation is off</p>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-100/60">
                  Manual briefs, privacy review, and approval remain available. Enable the server-side generation flag to produce caption, overlay, and shot-list drafts from sanitized summaries.
                </p>
              </div>
            )}
            {!publishingReady && (
              <div className="mt-3 rounded-xl border border-blue-400/20 bg-blue-400/10 p-3">
                <p className="text-xs font-black text-blue-100">Publishing is safely disabled</p>
                <p className="mt-1 text-[11px] leading-relaxed text-blue-100/60">
                  No social post can leave FirstKnock until Buffer credentials, the selected platform&apos;s channel ID, a worker secret, the kill switch, and a recent healthy worker heartbeat are verified server-side.
                </p>
                <p className="mt-2 text-[10px] font-bold text-blue-100/45">
                  Worker heartbeat: {capabilities.worker_last_seen_at
                    ? dateLabel(capabilities.worker_last_seen_at)
                    : 'not recorded'}
                </p>
              </div>
            )}

            {!sources.length ? (
              <div className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.025] p-6 text-center">
                <Image className="mx-auto h-6 w-6 text-white/35" />
                <p className="mt-3 font-black">Load the audited starter inventory</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-white/40">
                  This registers five audited, privacy-safe FirstKnock sources by opaque filename, exact SHA-256, and sanitized summary. The local files are not uploaded or copied.
                </p>
                <Button
                  type="button"
                  onClick={() => action.mutate({ action: 'register_sources', sources: FIRSTKNOCK_AUDITED_SOURCES })}
                  disabled={action.isPending}
                  style={{ background: accent, color: accentText }}
                  className="mt-4 font-black"
                >
                  {action.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  Load audited sources
                </Button>
              </div>
            ) : !artifacts.length ? (
              <div className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.025] p-6 text-center">
                <Sparkles className="mx-auto h-6 w-6 text-white/35" />
                <p className="mt-3 font-black">No content briefs yet</p>
                <p className="mt-1 text-xs text-white/40">Turn a sanitized product moment into a reviewed, trackable post.</p>
                <Button type="button" onClick={openBrief} variant="outline" className="mt-4 border-white/15 bg-transparent text-white hover:bg-white/10">
                  Create first brief
                </Button>
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {artifacts.map((artifact) => {
                  const latestJob = latestJobsByArtifact.get(artifact.id);
                  const activeJob = activeJobsByArtifact.get(artifact.id);
                  const displayJob = activeJob || latestJob;
                  const MediaIcon = artifact.format === 'video' ? Film : Image;
                  const primary = activeJob
                    ? JOB_LABELS[activeJob.state] || activeJob.state
                    : artifact.approval_status === 'approved'
                      ? latestJob?.state === 'sent'
                        ? 'Published'
                        : ['failed', 'canceled'].includes(latestJob?.state)
                          ? latestJob?.provider_post_id
                            ? 'New content ID required'
                            : 'Retry delivery'
                          : 'Plan delivery'
                      : artifact.review_status === 'passed'
                        ? 'Approve'
                        : artifact.media_url
                          ? 'Review'
                          : 'Add media';
                  return (
                    <button
                      type="button"
                      key={artifact.id}
                      onClick={() => setSelectedId(artifact.id)}
                      className="flex w-full flex-col gap-3 rounded-xl border border-white/10 bg-black/35 p-4 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:flex-row sm:items-center"
                    >
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                        <MediaIcon className="h-5 w-5 text-white/50" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-black text-white">{artifact.title}</p>
                          <Pill>{PLATFORM_LABELS[artifact.platform]}</Pill>
                        </div>
                        <p className="mt-1 truncate text-[11px] text-white/40">
                          {artifact.pillar} · {artifact.platform_content_id} · revision {artifact.revision}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Pill tone={statusTone(artifact.review_status)}>{artifact.review_status?.replaceAll('_', ' ')}</Pill>
                          <Pill tone={statusTone(artifact.approval_status)}>{artifact.approval_status?.replaceAll('_', ' ')}</Pill>
                          {displayJob && <Pill tone={statusTone(displayJob.state)}>{dateLabel(displayJob.due_at)}</Pill>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                        <span className="text-xs font-black" style={{ color: accent }}>{primary}</span>
                        <ChevronRight className="h-4 w-4 text-white/30" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {artifacts.some((artifact) => artifact.platform === 'tiktok') && (
              <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-white/40" />
                <p className="text-[11px] leading-relaxed text-white/45">
                  TikTok drafts now preserve their platform and content ID in a neutral /start link. Verify a clickable profile-link or comment/DM handoff and TikTok source reporting before using conversions to choose winners.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      <Dialog open={briefOpen} onOpenChange={setBriefOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto border-white/10 bg-[#080808] text-white sm:max-w-2xl">
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl font-black">New content brief</DialogTitle>
            <DialogDescription className="text-white/45">
              One shared concept becomes platform-specific Instagram and TikTok renditions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailField label="Concept ID">
                <Input value={brief.concept_id} onChange={(event) => updateBrief('concept_id', event.target.value)} className="border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="Pillar">
                <select value={brief.pillar} onChange={(event) => updateBrief('pillar', event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white">
                  {PILLARS.map((pillar) => <option key={pillar} value={pillar}>{pillar}</option>)}
                </select>
              </DetailField>
            </div>
            <DetailField label="Concept title">
              <Input value={brief.title} onChange={(event) => updateBrief('title', event.target.value)} placeholder="What managers miss when they only count doors" className="border-white/10 bg-black text-white" />
            </DetailField>
            <fieldset>
              <legend className="text-xs font-bold text-white/65">Sanitized source assets</legend>
              <div className="mt-2 grid gap-2">
                {sources.filter((source) => source.active !== false).map((source) => (
                  <label key={source.asset_key} className="flex items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3">
                    <input type="checkbox" checked={brief.source_asset_keys.includes(source.asset_key)} onChange={() => toggleSource(source.asset_key)} className="mt-0.5 h-4 w-4 accent-green-400" />
                    <span className="min-w-0">
                      <span className="block text-xs font-black text-white">{source.title}</span>
                      <span className="mt-1 block text-[10px] leading-relaxed text-white/40">{source.safe_summary}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-blue-300" />
                <h3 className="font-black">Generate platform drafts</h3>
              </div>
              <p className="mt-1 text-xs text-white/40">Creates copy and an edit plan—not rendered media.</p>
              <fieldset className="mt-3">
                <legend className="text-xs font-bold text-white/65">Platforms</legend>
                <div className="mt-2 flex gap-2">
                  {['instagram', 'tiktok'].map((platform) => (
                    <label key={platform} className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs font-bold text-white/65">
                      <input type="checkbox" checked={brief.platforms.includes(platform)} onChange={() => togglePlatform(platform)} className="h-4 w-4 accent-blue-400" />
                      {PLATFORM_LABELS[platform]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <DetailField label="Creative direction">
                <Textarea value={brief.direction} onChange={(event) => updateBrief('direction', event.target.value)} placeholder="Explain why manager coaching needs conversation rate, close rate, and activity context. Use a punchy 15-second product proof." className="mt-3 min-h-24 border-white/10 bg-black text-white" />
              </DetailField>
              <Button
                type="button"
                onClick={generateDrafts}
                disabled={!capabilities.draft_generation_configured || !canGenerate || action.isPending}
                className="mt-3 w-full bg-blue-300 font-black text-black hover:bg-blue-200"
              >
                {action.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Generate selected drafts
              </Button>
              {!capabilities.draft_generation_configured && (
                <p className="mt-2 text-[10px] text-amber-200/70">Generation is disabled server-side. Use the manual draft below.</p>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <h3 className="font-black">Manual draft</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <DetailField label="Platform">
                  <select value={brief.platform} onChange={(event) => updateBrief('platform', event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white">
                    <option value="instagram">Instagram</option>
                    <option value="tiktok">TikTok</option>
                  </select>
                </DetailField>
                <DetailField label="Format">
                  <select value={brief.format} onChange={(event) => updateBrief('format', event.target.value)} className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white">
                    <option value="video">Video</option>
                    <option value="photo">Photo</option>
                  </select>
                </DetailField>
              </div>
              <DetailField label="Hook">
                <Input value={brief.hook} onChange={(event) => updateBrief('hook', event.target.value)} className="mt-3 border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="Caption">
                <Textarea value={brief.caption} onChange={(event) => updateBrief('caption', event.target.value)} className="mt-3 min-h-24 border-white/10 bg-black text-white" />
              </DetailField>
              <DetailField label="CTA">
                <Input value={brief.cta_label} onChange={(event) => updateBrief('cta_label', event.target.value)} className="mt-3 border-white/10 bg-black text-white" />
              </DetailField>
              <Button
                type="button"
                variant="outline"
                onClick={createManual}
                disabled={!canCreateManual || action.isPending}
                className="mt-3 w-full border-white/15 bg-transparent text-white hover:bg-white/10"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create manual draft
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ContentDetailDialog
        artifact={selected}
        activeJob={selected ? activeJobsByArtifact.get(selected.id) : null}
        latestJob={selected ? latestJobsByArtifact.get(selected.id) : null}
        jobs={jobs}
        sources={sources}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelectedId(''); }}
        busy={action.isPending}
        onAction={(payload) => action.mutate(payload)}
        publishingReady={selected
          ? capabilities[selected.platform]?.delivery === 'buffer'
          : false}
        canApprove={canApprove}
        canSchedule={canSchedule}
      />
    </>
  );
}
