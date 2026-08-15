import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
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
import {
  growthBatchScheduleRequest,
  inspectGrowthBatchActivation,
} from '@/lib/growthBatchActivation';

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
const TIKTOK_SOCIAL_POST_TEXT_LIMIT = 2200;
const PHOENIX_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const MINIMUM_SCHEDULE_LEAD_MS = 15 * 60 * 1000;
const PHOENIX_CADENCE_SLOTS = [
  [9, 30],
  [13, 30],
  [18, 30],
];
const MEASURED_BATCH_SLOT_TIMES = {
  morning: '09:30',
  midday: '13:30',
  evening: '18:30',
};
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SEED_MANIFEST_BYTES = 150_000;
const MAX_BATCH_NOTE_LENGTH = 500;
const LEGACY_MEASURED_PROFILE = 'measured-next-batch-v1';
const FEATURE_EXPLAINER_VIDEO_PROFILE = 'feature_explainer_video_v1';
const FEATURE_EXPLAINER_SOURCE_KINDS = new Set(['video', 'image']);

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

function nextPhoenixTargetDate(now = Date.now()) {
  return phoenixDayKey(now + DAY_MS);
}

function nextBootstrapTargetDate(batches = [], now = Date.now()) {
  const floor = nextPhoenixTargetDate(now);
  const latest = batches
    .filter((batch) => (
      batch?.batch_input_mode === 'audited_seed_bootstrap'
      && !['revoked', 'superseded'].includes(batch?.state)
      && /^\d{4}-\d{2}-\d{2}$/.test(String(batch?.target_date || ''))
    ))
    .map((batch) => batch.target_date)
    .sort()
    .at(-1);
  if (!latest || latest < floor) return floor;
  return phoenixDayKey(Date.parse(`${latest}T07:00:00.000Z`) + DAY_MS);
}

function measuredParentKey(item) {
  return [
    item?.platform || 'instagram',
    item?.campaign || '1000-users',
    item?.content || '',
  ].join('|');
}

function reviewedBatchParents(contentQueue) {
  return (contentQueue?.items || []).filter((item) => (
    item?.state === 'reviewed'
    && item?.decision_stale !== true
    && ['repeat', 'iterate'].includes(item?.decision)
  ));
}

function growthToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._~-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function exactSha256(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function seedDonorRequirements(pack, contentProfile = LEGACY_MEASURED_PROFILE) {
  const videoFeatureExplainer =
    contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE;
  const sourceByKey = new Map();
  for (const source of pack?.sources || []) {
    const assetKey = growthToken(source?.asset_key);
    const sourceReference = String(source?.source_reference || '').trim();
    const sourceSha256 = exactSha256(source?.source_sha256);
    if (
      !assetKey
      || sourceByKey.has(assetKey)
      || !['asset_pack', 'repository_public'].includes(growthToken(source?.source_origin))
      || !sourceReference
      || !sourceSha256
      || growthToken(source?.privacy_status) !== 'safe'
      || growthToken(source?.rights_status) !== 'firstknock_owned'
      || (
        videoFeatureExplainer
        && !FEATURE_EXPLAINER_SOURCE_KINDS.has(growthToken(source?.media_kind))
      )
    ) {
      continue;
    }
    sourceByKey.set(assetKey, {
      asset_key: assetKey,
      source_reference: sourceReference,
      source_sha256: sourceSha256,
      media_kind: growthToken(source?.media_kind),
    });
  }

  const artifactsByConcept = new Map();
  for (const artifact of pack?.artifacts || []) {
    const conceptId = growthToken(artifact?.concept_id);
    const platform = growthToken(artifact?.platform);
    const sourceKey = growthToken(artifact?.source_asset_key);
    if (
      !conceptId
      || !['instagram', 'tiktok'].includes(platform)
      || growthToken(artifact?.distribution_state) !== 'publish_candidate'
      || growthToken(artifact?.format) !== 'video'
      || !sourceByKey.has(sourceKey)
      || !artifact?.render
      || typeof artifact.render !== 'object'
    ) {
      continue;
    }
    if (!artifactsByConcept.has(conceptId)) artifactsByConcept.set(conceptId, []);
    artifactsByConcept.get(conceptId).push({ platform, sourceKey });
  }

  const requiredBySource = new Map();
  for (const artifacts of artifactsByConcept.values()) {
    if (
      artifacts.length !== 2
      || new Set(artifacts.map((artifact) => artifact.platform)).size !== 2
      || !artifacts.some((artifact) => artifact.platform === 'instagram')
      || !artifacts.some((artifact) => artifact.platform === 'tiktok')
      || artifacts[0].sourceKey !== artifacts[1].sourceKey
    ) {
      continue;
    }
    const requirement = sourceByKey.get(artifacts[0].sourceKey);
    requiredBySource.set(requirement.asset_key, requirement);
  }
  return [...requiredBySource.values()];
}

function seedSourceReadiness(
  pack,
  registeredSources,
  conceptCount,
  contentProfile = LEGACY_MEASURED_PROFILE,
) {
  const requirements = seedDonorRequirements(pack, contentProfile);
  const registeredByKey = new Map();
  for (const source of registeredSources || []) {
    const assetKey = growthToken(source?.asset_key);
    if (!registeredByKey.has(assetKey)) registeredByKey.set(assetKey, []);
    registeredByKey.get(assetKey).push(source);
  }
  const missing = [];
  const changed = [];
  for (const requirement of requirements) {
    const matches = registeredByKey.get(requirement.asset_key) || [];
    if (!matches.length) {
      missing.push(requirement.asset_key);
      continue;
    }
    const current = matches[0];
    if (
      matches.length !== 1
      || current?.active === false
      || growthToken(current?.privacy_status) !== 'safe'
      || String(current?.source_reference || '').trim() !== requirement.source_reference
      || exactSha256(current?.source_sha256) !== requirement.source_sha256
      || (
        contentProfile === FEATURE_EXPLAINER_VIDEO_PROFILE
        && (
          !FEATURE_EXPLAINER_SOURCE_KINDS.has(growthToken(current?.media_kind))
          || growthToken(current?.media_kind) !== requirement.media_kind
        )
      )
    ) {
      changed.push(requirement.asset_key);
    }
  }
  return {
    requirements,
    missing,
    changed,
    ready: requirements.length >= conceptCount
      && !missing.length
      && !changed.length,
  };
}

function normalizeBatchNoteInput(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_BATCH_NOTE_LENGTH);
}

function compactBatchNote(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_BATCH_NOTE_LENGTH);
}

function renderPackFromSeedFile(value) {
  const pack = value?.schema_version === 'growth-render-result.v1'
    ? value?.pack
    : value;
  if (
    pack?.schema_version !== 'growth-render-pack.v1'
    || !Array.isArray(pack?.artifacts)
    || !pack.artifacts.length
    || !seedDonorRequirements(pack).length
  ) {
    throw new Error('invalid_seed_pack');
  }
  return pack;
}

function downloadJsonFile(fileName, value) {
  const url = URL.createObjectURL(new Blob(
    [`${JSON.stringify(value, null, 2)}\n`],
    { type: 'application/json;charset=utf-8' },
  ));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
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

function measuredBatchScheduleLocal(artifact) {
  const targetDate = String(artifact?.growth_batch_target_date || '').trim();
  const localTime = MEASURED_BATCH_SLOT_TIMES[artifact?.growth_batch_slot_key];
  return /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && localTime
    ? `${targetDate}T${localTime}`
    : '';
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
  const isTikTok = artifact?.platform === 'tiktok';
  const blocks = caption ? [caption] : [];
  const normalizedCaption = caption.toLowerCase();
  if (disclosure && !normalizedCaption.includes(disclosure.toLowerCase())) {
    blocks.push(disclosure);
  }
  const cta = isTikTok
    ? ctaLabel
    : [ctaLabel, ctaUrl].filter(Boolean).join(': ');
  const ctaAlreadyPresent = isTikTok
    ? ctaLabel && normalizedCaption.includes(ctaLabel.toLowerCase())
    : ctaUrl
      ? caption.includes(ctaUrl)
      : ctaLabel && normalizedCaption.includes(ctaLabel.toLowerCase());
  if (cta && !ctaAlreadyPresent) blocks.push(cta);
  return blocks.join('\n\n');
}

function socialPostTextLimit(platform) {
  return platform === 'tiktok'
    ? TIKTOK_SOCIAL_POST_TEXT_LIMIT
    : MAX_SOCIAL_POST_TEXT;
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
    || artifact.provider_text.length > socialPostTextLimit(artifact?.platform)
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

function contentEngineRefetchInterval(data) {
  const batches = data?.batches || [];
  if (batches.some((batch) => batch?.state === 'generating')) return 10_000;
  const jobs = data?.jobs || [];
  if (jobs.some((job) => FAST_POLLING_JOB_STATES.has(job?.state))) return 10_000;
  if (jobs.some((job) => SLOW_POLLING_JOB_STATES.has(job?.state))) return 60_000;
  return false;
}

function statusTone(value) {
  if (['approved', 'passed', 'scheduled', 'sent', 'ready', 'render_authorized'].includes(value)) {
    return 'border-green-400/25 bg-green-400/10 text-green-100';
  }
  if (['review_required', 'changes_requested', 'create_reconcile', 'delivery_reconcile', 'failed', 'revoked', 'superseded'].includes(value)) {
    return 'border-red-400/25 bg-red-400/10 text-red-100';
  }
  if (['queued', 'processing', 'sending', 'approval_wait', 'measurement_retry', 'generating'].includes(value)) {
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

function MeasuredBatchPanel({
  accent,
  accentText,
  contentQueue,
  sources,
  artifacts,
  jobs,
  batches,
  capabilities,
  summary,
  busy,
  activationBusy,
  onAction,
  onActivateBatch,
}) {
  const seedInputRef = React.useRef(null);
  const bootstrapSeedInputRef = React.useRef(null);
  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [bootstrapOpen, setBootstrapOpen] = React.useState(false);
  const [retrievingBatchKey, setRetrievingBatchKey] = React.useState('');
  const [batchDecision, setBatchDecision] = React.useState(null);
  const [activationDecision, setActivationDecision] = React.useState(null);
  const [draft, setDraft] = React.useState(() => ({
    parent_key: '',
    target_date: nextPhoenixTargetDate(),
    content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE,
    concept_count: '2',
    seed_pack: null,
    seed_file_name: '',
  }));
  const [bootstrapDraft, setBootstrapDraft] = React.useState(() => ({
    target_date: nextPhoenixTargetDate(),
    seed_pack: null,
    seed_file_name: '',
    acknowledged: false,
    authorization_note: '',
  }));
  const eligibleParents = reviewedBatchParents(contentQueue);
  const eligibleByKey = new Map(
    eligibleParents.map((item) => [measuredParentKey(item), item]),
  );
  const selectedParentKey = eligibleByKey.has(draft.parent_key)
    ? draft.parent_key
    : measuredParentKey(eligibleParents[0]);
  const selectedParent = eligibleByKey.get(selectedParentKey);
  const generationReady = capabilities.measured_batch_generation_ready === true;
  const canAuthorize = capabilities.can_approve === true;
  const readyBatches = Number(summary.batches_ready || 0);
  const authorizedBatches = Number(summary.batches_authorized || 0);
  const featureExplainerSelected =
    draft.content_profile === FEATURE_EXPLAINER_VIDEO_PROFILE;
  const conceptCount = Number(draft.concept_count);
  const seedSources = seedSourceReadiness(
    draft.seed_pack,
    sources,
    conceptCount,
    draft.content_profile,
  );
  const bootstrapSeedSources = seedSourceReadiness(
    bootstrapDraft.seed_pack,
    sources,
    2,
    FEATURE_EXPLAINER_VIDEO_PROFILE,
  );
  const bootstrapBatchCount = batches.filter((batch) => (
    batch?.batch_input_mode === 'audited_seed_bootstrap'
    && !['revoked', 'superseded'].includes(batch?.state)
  )).length;
  const registeredSafeSourceCount = (sources || []).filter((source) => (
    source?.active !== false
    && growthToken(source?.privacy_status) === 'safe'
    && exactSha256(source?.source_sha256)
    && String(source?.source_reference || '').trim()
    && (
      !featureExplainerSelected
      || FEATURE_EXPLAINER_SOURCE_KINDS.has(growthToken(source?.media_kind))
    )
  )).length;
  const hasRegisteredSafeSource = registeredSafeSourceCount >= (
    featureExplainerSelected ? 2 : 1
  );
  const normalizedDecisionNote = compactBatchNote(batchDecision?.note);
  const normalizedBootstrapNote = compactBatchNote(
    bootstrapDraft.authorization_note,
  );

  const chooseSeedPack = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setDraft((current) => ({
      ...current,
      seed_pack: null,
      seed_file_name: '',
    }));
    if (file.size > MAX_SEED_MANIFEST_BYTES) {
      toast.error('Seed manifest must be 150 KB or smaller');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      const pack = renderPackFromSeedFile(parsed);
      setDraft((current) => ({
        ...current,
        seed_pack: pack,
        seed_file_name: file.name,
      }));
    } catch {
      toast.error('Choose a growth-render-pack.v1 file or a growth-render-result.v1 file containing .pack');
    }
  };

  const chooseBootstrapSeedPack = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBootstrapDraft((current) => ({
      ...current,
      seed_pack: null,
      seed_file_name: '',
    }));
    if (file.size > MAX_SEED_MANIFEST_BYTES) {
      toast.error('Seed manifest must be 150 KB or smaller');
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      const pack = renderPackFromSeedFile(parsed);
      setBootstrapDraft((current) => ({
        ...current,
        seed_pack: pack,
        seed_file_name: file.name,
      }));
    } catch {
      toast.error('Choose the exact allowlisted growth-render-pack.v1 seed JSON');
    }
  };

  const buildBatch = () => {
    if (!selectedParent || !draft.seed_pack || !seedSources.ready) return;
    onAction({
      action: 'build_next_batch',
      parent: {
        platform: selectedParent.platform || 'instagram',
        campaign: selectedParent.campaign,
        content: selectedParent.content,
      },
      target_date: draft.target_date,
      content_profile: draft.content_profile,
      concept_count: Number(draft.concept_count),
      seed_pack: draft.seed_pack,
    }, {
      onSuccess: () => setBuilderOpen(false),
    });
  };

  const buildBootstrapBatch = () => {
    if (
      !bootstrapDraft.seed_pack
      || !bootstrapSeedSources.ready
      || bootstrapDraft.acknowledged !== true
      || normalizedBootstrapNote.length < 10
    ) {
      return;
    }
    onAction({
      action: 'build_audited_bootstrap_batch',
      target_date: bootstrapDraft.target_date,
      content_profile: FEATURE_EXPLAINER_VIDEO_PROFILE,
      concept_count: 2,
      bootstrap_acknowledged: true,
      authorization_note: normalizedBootstrapNote,
      seed_pack: bootstrapDraft.seed_pack,
    }, {
      onSuccess: () => setBootstrapOpen(false),
    });
  };

  const downloadBatch = async (batch) => {
    setRetrievingBatchKey(batch.batch_key);
    try {
      const response = await base44.functions.invoke('manageGrowthContentEngine', {
        action: 'get_batch',
        batch_key: batch.batch_key,
      });
      const result = response?.data || response;
      if (
        result?.render_pack?.schema_version !== 'growth-render-pack.v1'
        || result?.pack_sha256 !== batch.canonical_pack_sha256
      ) {
        throw new Error('growth_batch_render_pack_tampered');
      }
      const suffix = String(batch.batch_key || '').slice(0, 12);
      downloadJsonFile(
        `firstknock-${batch.target_date || 'daily'}-${suffix}-render-pack.json`,
        result.render_pack,
      );
      toast.success('Exact generated render pack downloaded');
    } catch (error) {
      toast.error(
        error?.response?.data?.message
        || fieldError(error?.response?.data?.error || error?.message),
      );
    } finally {
      setRetrievingBatchKey('');
    }
  };

  const openBatchDecision = (mode, batch) => {
    setBatchDecision({
      mode,
      batch,
      acknowledged: false,
      note: '',
    });
  };

  const submitBatchDecision = () => {
    if (!batchDecision?.batch) return;
    const isAuthorization = batchDecision.mode === 'authorize';
    const note = compactBatchNote(batchDecision.note);
    if (
      note.length < 5
      || (isAuthorization && batchDecision.acknowledged !== true)
    ) {
      return;
    }
    setBatchDecision((current) => (current ? { ...current, note } : current));
    onAction({
      action: isAuthorization ? 'authorize_batch' : 'revoke_batch',
      batch_key: batchDecision.batch.batch_key,
      ...(isAuthorization
        ? {
          expected_pack_sha256: batchDecision.batch.canonical_pack_sha256,
          inspection_acknowledged: true,
        }
        : {}),
      note,
    }, {
      onSuccess: () => setBatchDecision(null),
    });
  };

  const activationForBatch = (batch) => inspectGrowthBatchActivation({
    batch,
    artifacts,
    jobs,
    capabilities,
    isMediaReady: artifactMediaReady,
  });

  const openActivationDecision = (batch) => {
    setActivationDecision({
      batch,
      inspection: activationForBatch(batch),
      acknowledged: false,
    });
  };

  const submitActivationDecision = () => {
    if (
      !activationDecision?.batch
      || activationDecision.acknowledged !== true
    ) {
      return;
    }
    onActivateBatch({
      batch_key: activationDecision.batch.batch_key,
      silent_automatic_confirmed: true,
    }, {
      onSuccess: () => setActivationDecision(null),
    });
  };

  return (
    <>
      <div className="mt-4 rounded-2xl border border-blue-300/15 bg-blue-300/[0.06] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-black text-white">Measured daily batches</p>
              <Pill tone="border-blue-300/20 bg-blue-300/10 text-blue-100">
                {readyBatches} ready
              </Pill>
              <Pill tone="border-green-300/20 bg-green-300/10 text-green-100">
                {authorizedBatches} authorized
              </Pill>
            </div>
            <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-white/45">
              The recommended profile turns audited app recordings into exactly two daily feature-explainer videos, each with Instagram and TikTok copy tied to measured evidence.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setBootstrapDraft((current) => ({
                  ...current,
                  target_date: nextBootstrapTargetDate(batches),
                  seed_pack: current.seed_pack || draft.seed_pack,
                  seed_file_name: current.seed_file_name || draft.seed_file_name,
                  acknowledged: false,
                }));
                setBootstrapOpen(true);
              }}
              disabled={
                !generationReady
                || !canAuthorize
                || bootstrapBatchCount >= 7
                || busy
              }
              className="border-fuchsia-300/25 bg-fuchsia-300/10 font-black text-fuchsia-100 hover:bg-fuchsia-300/20"
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              Start audited week
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  target_date: nextPhoenixTargetDate(),
                }));
                setBuilderOpen(true);
              }}
              disabled={
                !generationReady
                || !eligibleParents.length
                || busy
              }
              style={{ background: accent, color: accentText }}
              className="font-black"
            >
              <CalendarClock className="mr-2 h-4 w-4" />
              Build next batch
            </Button>
          </div>
        </div>

        {!generationReady && (
          <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-[11px] leading-relaxed text-amber-100/70">
            Measured generation needs server-side generation plus an allowlisted trusted seed pack.
          </p>
        )}
        {generationReady && !eligibleParents.length && (
          <p className="mt-3 rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] leading-relaxed text-white/45">
            No eligible measured parent yet. The owner can start the bounded audited week
            above, then use its fixed-age results for normal Repeat or Iterate batches.
            Hold and stale decisions cannot seed a batch.
          </p>
        )}
        {generationReady && !hasRegisteredSafeSource && (
          <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-[11px] leading-relaxed text-amber-100/70">
            Load the audited source inventory before building. {featureExplainerSelected
              ? 'Video explainers stay locked until two active, privacy-safe video sources have exact reference and SHA-256 evidence.'
              : 'Generation stays locked until one active, privacy-safe source has exact reference and SHA-256 evidence.'}
          </p>
        )}

        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.08] p-3">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
          <p className="text-[10px] leading-relaxed text-amber-100/65">
            {featureExplainerSelected
              ? `Video capacity: this profile needs 2 distinct safe, publish-candidate video or image donors now and 14 for a seven-day rotation. Every platform rendition still exports as video. ${
                draft.seed_pack
                  ? `The loaded seed currently exposes ${seedSources.requirements.length}.`
                  : 'Load the audited video seed to check current capacity.'
              } Audited bootstrap: ${bootstrapBatchCount}/7 daily batches claimed.`
              : 'Legacy capacity: a seven-day source rotation needs 14 safe donors at 2/day or 21 at 3/day.'}
          </p>
        </div>

        {batches.length > 0 && (
          <div className="mt-3 space-y-2">
            {batches.slice(0, 8).map((batch) => {
              const downloadable = ['ready', 'render_authorized'].includes(batch.state);
              const revocable = ['ready', 'render_authorized', 'failed'].includes(batch.state);
              const videoExplainerBatch =
                batch.content_profile === FEATURE_EXPLAINER_VIDEO_PROFILE;
              const activation = videoExplainerBatch
                ? activationForBatch(batch)
                : null;
              return (
                <div
                  key={batch.batch_key}
                  className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-3 lg:flex-row lg:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-[11px] font-black text-white">
                        {batch.target_date} · {batch.concept_count} concepts
                      </p>
                      <Pill tone={statusTone(batch.state)}>
                        {batch.state?.replaceAll('_', ' ')}
                      </Pill>
                      <Pill>
                        {batch.batch_input_mode === 'audited_seed_bootstrap'
                          ? 'audited bootstrap'
                          : batch.review_decision || 'review'}
                      </Pill>
                      {batch.content_profile === FEATURE_EXPLAINER_VIDEO_PROFILE && (
                        <Pill tone="border-fuchsia-300/20 bg-fuchsia-300/10 text-fuchsia-100">
                          video explainer
                        </Pill>
                      )}
                      {activation?.complete && (
                        <Pill tone="border-green-300/20 bg-green-300/10 text-green-100">
                          activation submitted
                        </Pill>
                      )}
                      {activation && !activation.complete && activation.protected_count > 0 && (
                        <Pill tone="border-blue-300/20 bg-blue-300/10 text-blue-100">
                          {activation.protected_count}/4 submitted
                        </Pill>
                      )}
                    </div>
                    <p className="mt-1 truncate text-[10px] text-white/40">
                      {batch.batch_input_mode === 'audited_seed_bootstrap'
                        ? 'Audited FirstKnock seed · first-week evidence'
                        : `${PLATFORM_LABELS[batch.parent_platform] || batch.parent_platform} · ${batch.parent_content}`}
                      {' · '}{batch.pack_artifact_count || batch.concept_count * 2} paired artifacts
                    </p>
                    {batch.canonical_pack_sha256 && (
                      <p className="mt-1 truncate font-mono text-[9px] text-white/25">
                        SHA-256 {batch.canonical_pack_sha256}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => downloadBatch(batch)}
                      disabled={!downloadable || retrievingBatchKey === batch.batch_key || busy}
                      className="border-white/15 bg-transparent text-white hover:bg-white/10"
                    >
                      {retrievingBatchKey === batch.batch_key
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Download className="mr-2 h-4 w-4" />}
                      Download JSON
                    </Button>
                    {batch.state === 'ready' && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => openBatchDecision('authorize', batch)}
                        disabled={!canAuthorize || busy}
                        className="bg-green-300 font-black text-black hover:bg-green-200"
                      >
                        <ShieldCheck className="mr-2 h-4 w-4" />
                        Authorize exact pack
                      </Button>
                    )}
                    {videoExplainerBatch && batch.state === 'render_authorized' && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => openActivationDecision(batch)}
                        disabled={
                          busy
                          || activationBusy
                          || !activation?.can_activate
                        }
                        title={activation?.blockers?.[0] || ''}
                        className="bg-fuchsia-300 font-black text-black hover:bg-fuchsia-200"
                      >
                        {activationBusy
                          ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          : <Send className="mr-2 h-4 w-4" />}
                        {activation?.complete
                          ? 'Activation submitted'
                          : activation?.protected_count
                            ? `Resume ${4 - activation.protected_count} posts`
                            : activation?.can_activate
                              ? 'Activate 4 posts'
                              : 'Review 4 posts'}
                      </Button>
                    )}
                    {revocable && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => openBatchDecision('revoke', batch)}
                        disabled={!canAuthorize || busy}
                        className="text-red-200 hover:bg-red-400/10 hover:text-red-100"
                      >
                        <XCircle className="mr-2 h-4 w-4" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-3 text-[10px] leading-relaxed text-white/35">
          Authorization and import do not publish. Every imported rendition still requires the normal four-gate review—privacy, demo labeling, supported claims, and media rights—plus exact-revision owner approval and separate delivery scheduling.
        </p>
      </div>

      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent className="border-white/10 bg-[#080808] text-white sm:max-w-xl">
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl font-black">Build the next measured batch</DialogTitle>
            <DialogDescription className="text-white/45">
              Video feature explainer is recommended. The backend rechecks fixed-age evidence, exact owned donor lineage, cooldowns, and the trusted seed before generation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <DetailField
              label="Generation profile"
              helper="The recommended profile uses audited video sources and server-assembled feature captions."
            >
              <select
                value={draft.content_profile}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  content_profile: event.target.value,
                  concept_count: event.target.value === FEATURE_EXPLAINER_VIDEO_PROFILE
                    ? '2'
                    : current.concept_count,
                }))}
                className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white"
              >
                <option value={FEATURE_EXPLAINER_VIDEO_PROFILE}>
                  Video feature explainer · Recommended
                </option>
                <option value={LEGACY_MEASURED_PROFILE}>
                  General measured remix · Legacy
                </option>
              </select>
            </DetailField>
            <DetailField
              label="Reviewed parent"
              helper="Only current Repeat or Iterate decisions are selectable."
            >
              <select
                value={selectedParentKey}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  parent_key: event.target.value,
                }))}
                className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white"
              >
                {eligibleParents.map((item) => (
                  <option key={measuredParentKey(item)} value={measuredParentKey(item)}>
                    {PLATFORM_LABELS[item.platform] || item.platform} · {item.content} · {item.decision}
                  </option>
                ))}
              </select>
            </DetailField>
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailField label="Production date" helper="America/Phoenix">
                <Input
                  type="date"
                  min={phoenixDayKey(Date.now())}
                  value={draft.target_date}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    target_date: event.target.value,
                  }))}
                  className="border-white/10 bg-black text-white"
                />
              </DetailField>
              <DetailField label="Concepts per platform">
                <select
                  value={draft.concept_count}
                  disabled={featureExplainerSelected}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    concept_count: event.target.value,
                  }))}
                  className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white"
                >
                  <option value="2">2 per platform · 4 artifacts</option>
                  <option value="3">3 per platform · 6 artifacts</option>
                </select>
                {featureExplainerSelected && (
                  <p className="mt-1 text-[10px] leading-relaxed text-white/35">
                    Locked to two concepts: two owned source recipes, each rendered as video once for Instagram and once for TikTok.
                  </p>
                )}
              </DetailField>
            </div>
            <DetailField
              label="Trusted seed manifest"
              helper="Accepts growth-render-pack.v1, or growth-render-result.v1 and extracts its .pack."
            >
              <input
                ref={seedInputRef}
                type="file"
                accept="application/json,.json"
                onChange={chooseSeedPack}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => seedInputRef.current?.click()}
                className="w-full justify-start border-white/15 bg-black text-white hover:bg-white/10"
              >
                <Upload className="mr-2 h-4 w-4" />
                {draft.seed_file_name || 'Choose trusted seed JSON'}
              </Button>
            </DetailField>
            {draft.seed_pack && (
              <div className={`rounded-xl border p-3 text-[11px] leading-relaxed ${
                seedSources.ready
                  ? 'border-green-300/20 bg-green-300/[0.07] text-green-100/70'
                  : 'border-amber-400/20 bg-amber-400/[0.08] text-amber-100/70'
                }`}>
                {seedSources.requirements.length < conceptCount
                  ? `This seed has ${seedSources.requirements.length} usable paired ${
                    featureExplainerSelected ? 'video ' : ''
                  }donor source(s); ${conceptCount} are required.`
                  : seedSources.missing.length
                    ? `${seedSources.missing.length} exact donor source(s) are not registered in this content engine.`
                    : seedSources.changed.length
                      ? `${seedSources.changed.length} donor source(s) are inactive, no longer privacy-safe, duplicated, or do not match the seed reference and SHA-256.`
                      : `${seedSources.requirements.length} exact ${
                        featureExplainerSelected ? 'video ' : ''
                      }donor source(s) are registered, active, and privacy-safe.`}
              </div>
            )}
            <Button
              type="button"
              onClick={buildBatch}
              disabled={
                busy
                || !generationReady
                || !selectedParent
                || !draft.target_date
                || !draft.seed_pack
                || !seedSources.ready
              }
              style={{ background: accent, color: accentText }}
              className="w-full font-black"
            >
              {busy
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Sparkles className="mr-2 h-4 w-4" />}
              {featureExplainerSelected
                ? 'Build two video explainers'
                : 'Build paired batch'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bootstrapOpen} onOpenChange={setBootstrapOpen}>
        <DialogContent className="border-white/10 bg-[#080808] text-white sm:max-w-xl">
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl font-black">
              Start the audited first week
            </DialogTitle>
            <DialogDescription className="text-white/45">
              Build one deterministic two-video day from the exact allowlisted FirstKnock
              seed. No LLM is called and no fake performance evidence is created.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <DetailField label="Production date" helper="America/Phoenix">
                <Input
                  type="date"
                  min={phoenixDayKey(Date.now())}
                  value={bootstrapDraft.target_date}
                  onChange={(event) => setBootstrapDraft((current) => ({
                    ...current,
                    target_date: event.target.value,
                  }))}
                  className="border-white/10 bg-black text-white"
                />
              </DetailField>
              <div className="rounded-xl border border-fuchsia-300/20 bg-fuchsia-300/[0.07] p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-fuchsia-100/55">
                  Locked bootstrap policy
                </p>
                <p className="mt-2 text-sm font-black text-white">
                  2 videos · 4 platform posts
                </p>
                <p className="mt-1 text-[10px] text-white/40">
                  Day {Math.min(bootstrapBatchCount + 1, 7)} of 7 maximum
                </p>
              </div>
            </div>
            <DetailField
              label="Exact audited seed manifest"
              helper="Use firstknock-weekly-rights-safe-seed.json; the server verifies its full SHA-256 allowlist entry."
            >
              <input
                ref={bootstrapSeedInputRef}
                type="file"
                accept="application/json,.json"
                onChange={chooseBootstrapSeedPack}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => bootstrapSeedInputRef.current?.click()}
                className="w-full justify-start border-white/15 bg-black text-white hover:bg-white/10"
              >
                <Upload className="mr-2 h-4 w-4" />
                {bootstrapDraft.seed_file_name || 'Choose audited weekly seed JSON'}
              </Button>
            </DetailField>
            {bootstrapDraft.seed_pack && (
              <div className={`rounded-xl border p-3 text-[11px] leading-relaxed ${
                bootstrapSeedSources.ready
                  ? 'border-green-300/20 bg-green-300/[0.07] text-green-100/70'
                  : 'border-amber-400/20 bg-amber-400/[0.08] text-amber-100/70'
              }`}>
                {bootstrapSeedSources.requirements.length < 2
                  ? 'This seed does not contain two usable paired video-output donors.'
                  : bootstrapSeedSources.missing.length
                    ? `${bootstrapSeedSources.missing.length} exact donor source(s) are not registered.`
                    : bootstrapSeedSources.changed.length
                      ? `${bootstrapSeedSources.changed.length} donor source(s) changed or are no longer privacy-safe.`
                      : `${bootstrapSeedSources.requirements.length} exact safe donors are available for deterministic rotation.`}
              </div>
            )}
            <label className="flex items-start gap-3 rounded-xl border border-green-300/20 bg-green-300/[0.07] p-3 text-xs leading-relaxed text-green-100/75">
              <input
                type="checkbox"
                checked={bootstrapDraft.acknowledged}
                onChange={(event) => setBootstrapDraft((current) => ({
                  ...current,
                  acknowledged: event.target.checked,
                }))}
                className="mt-0.5 h-4 w-4 accent-green-300"
              />
              I authorize one day from this exact audited seed. I understand the
              seven-day cap and that every rendition still requires render inspection,
              four-gate review, owner approval, and separate activation.
            </label>
            <DetailField
              label="Bootstrap authorization note"
              helper="Required · whitespace is normalized · 10–500 characters"
            >
              <Textarea
                value={bootstrapDraft.authorization_note}
                onChange={(event) => setBootstrapDraft((current) => ({
                  ...current,
                  authorization_note: normalizeBatchNoteInput(
                    event.target.value,
                  ),
                }))}
                onBlur={() => setBootstrapDraft((current) => ({
                  ...current,
                  authorization_note: compactBatchNote(
                    current.authorization_note,
                  ),
                }))}
                maxLength={MAX_BATCH_NOTE_LENGTH}
                className="min-h-24 border-white/10 bg-black text-white"
                placeholder="Use the exact audited seed to establish the first measured week."
              />
              <span className="block text-right font-mono text-[9px] text-white/30">
                {normalizedBootstrapNote.length}/{MAX_BATCH_NOTE_LENGTH} normalized characters
              </span>
            </DetailField>
            <Button
              type="button"
              onClick={buildBootstrapBatch}
              disabled={
                busy
                || !generationReady
                || !canAuthorize
                || bootstrapBatchCount >= 7
                || !bootstrapDraft.target_date
                || !bootstrapDraft.seed_pack
                || !bootstrapSeedSources.ready
                || bootstrapDraft.acknowledged !== true
                || normalizedBootstrapNote.length < 10
              }
              className="w-full bg-fuchsia-300 font-black text-black hover:bg-fuchsia-200"
            >
              {busy
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <ShieldCheck className="mr-2 h-4 w-4" />}
              Build audited day {Math.min(bootstrapBatchCount + 1, 7)}
            </Button>
            <p className="text-[10px] leading-relaxed text-white/35">
              This creates and stores a render manifest only. It does not host media,
              import renditions, schedule Buffer, or publish to either platform.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(batchDecision)}
        onOpenChange={(open) => {
          if (!open) setBatchDecision(null);
        }}
      >
        <DialogContent className="border-white/10 bg-[#080808] text-white sm:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl font-black">
              {batchDecision?.mode === 'authorize'
                ? 'Authorize exact generated pack'
                : 'Revoke generated batch'}
            </DialogTitle>
            <DialogDescription className="text-white/45">
              {batchDecision?.mode === 'authorize'
                ? 'This owner action allows only the displayed SHA-256 pack to enter trusted render-result import.'
                : 'Revocation removes this batch from the dynamic import allowlist.'}
            </DialogDescription>
          </DialogHeader>
          {batchDecision?.batch && (
            <div className="space-y-4">
              <div className="rounded-xl border border-white/10 bg-black/40 p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-white/35">
                  Exact pack SHA-256
                </p>
                <p className="mt-2 break-all font-mono text-[10px] text-white/70">
                  {batchDecision.batch.canonical_pack_sha256 || 'No completed pack hash'}
                </p>
              </div>
              {batchDecision.mode === 'authorize' && (
                <label className="flex items-start gap-3 rounded-xl border border-green-300/20 bg-green-300/[0.07] p-3 text-xs leading-relaxed text-green-100/75">
                  <input
                    type="checkbox"
                    checked={batchDecision.acknowledged}
                    onChange={(event) => setBatchDecision((current) => ({
                      ...current,
                      acknowledged: event.target.checked,
                    }))}
                    className="mt-0.5 h-4 w-4 accent-green-300"
                  />
                  I downloaded and inspected this exact manifest, its source lineage, and paired render recipes.
                </label>
              )}
              <DetailField
                label={batchDecision.mode === 'authorize' ? 'Authorization note' : 'Revocation reason'}
                helper="Required · whitespace is normalized · 5–500 characters"
              >
                <Textarea
                  value={batchDecision.note}
                  onChange={(event) => setBatchDecision((current) => ({
                    ...current,
                    note: normalizeBatchNoteInput(event.target.value),
                  }))}
                  onBlur={() => setBatchDecision((current) => (
                    current
                      ? { ...current, note: compactBatchNote(current.note) }
                      : current
                  ))}
                  maxLength={MAX_BATCH_NOTE_LENGTH}
                  className="min-h-24 border-white/10 bg-black text-white"
                  placeholder={batchDecision.mode === 'authorize'
                    ? 'Inspected exact source lineage and paired recipes.'
                  : 'Evidence or source changed; regenerate.'}
                />
                <span className="block text-right font-mono text-[9px] text-white/30">
                  {normalizedDecisionNote.length}/{MAX_BATCH_NOTE_LENGTH} normalized characters
                </span>
              </DetailField>
              <p className="text-[10px] leading-relaxed text-white/35">
                This action does not publish, schedule, or bypass the normal four-gate rendition review and exact-revision owner approval.
              </p>
              <Button
                type="button"
                onClick={submitBatchDecision}
                disabled={
                  busy
                  || normalizedDecisionNote.length < 5
                  || (
                    batchDecision.mode === 'authorize'
                    && (
                      !batchDecision.acknowledged
                      || !batchDecision.batch.canonical_pack_sha256
                    )
                  )
                }
                className={`w-full font-black ${
                  batchDecision.mode === 'authorize'
                    ? 'bg-green-300 text-black hover:bg-green-200'
                    : 'bg-red-300 text-black hover:bg-red-200'
                }`}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {batchDecision.mode === 'authorize'
                  ? 'Authorize this exact pack for import'
                  : 'Revoke this batch'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(activationDecision)}
        onOpenChange={(open) => {
          if (!open && !activationBusy) setActivationDecision(null);
        }}
      >
        <DialogContent className="border-white/10 bg-[#080808] text-white sm:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl font-black">
              Activate two daily videos
            </DialogTitle>
            <DialogDescription className="text-white/45">
              Queue the two approved concepts for both Instagram and TikTok: four exact
              Buffer posts at 9:30 AM and 1:30 PM America/Phoenix.
            </DialogDescription>
          </DialogHeader>
          {activationDecision?.inspection && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <SummaryChip
                  label="Already protected"
                  value={activationDecision.inspection.protected_count}
                />
                <SummaryChip
                  label="Will queue now"
                  value={activationDecision.inspection.schedule_candidates.length}
                />
              </div>
              <div className="rounded-xl border border-white/10 bg-black/40 p-3">
                <p className="text-[10px] font-black uppercase tracking-wider text-white/35">
                  Exact batch
                </p>
                <p className="mt-2 break-all font-mono text-[10px] text-white/70">
                  {activationDecision.batch.canonical_pack_sha256}
                </p>
              </div>
              <label className="flex items-start gap-3 rounded-xl border border-fuchsia-300/20 bg-fuchsia-300/[0.07] p-3 text-xs leading-relaxed text-fuchsia-100/75">
                <input
                  type="checkbox"
                  checked={activationDecision.acknowledged}
                  onChange={(event) => setActivationDecision((current) => ({
                    ...current,
                    acknowledged: event.target.checked,
                  }))}
                  className="mt-0.5 h-4 w-4 accent-fuchsia-300"
                />
                I reviewed and approved all four exact renditions. I intend Buffer to
                publish the approved bytes automatically, including any silent audio
                tracks, without a native-app finishing step.
              </label>
              <p className="text-[10px] leading-relaxed text-white/35">
                FirstKnock refetches, then the server revalidates both channels, every
                approval and media hash, and the exact four-post batch before the first
                request. It then queues morning Instagram, morning TikTok, midday
                Instagram, and midday TikTok sequentially. This preflight is not an
                external-provider transaction; a safe retry resumes only unfinished posts.
              </p>
              <Button
                type="button"
                onClick={submitActivationDecision}
                disabled={
                  activationBusy
                  || !activationDecision.acknowledged
                  || !activationDecision.inspection.can_activate
                }
                className="w-full bg-fuchsia-300 font-black text-black hover:bg-fuchsia-200"
              >
                {activationBusy
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <Send className="mr-2 h-4 w-4" />}
                Submit automatic activation
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
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
    invalid_growth_batch_request: 'Choose a reviewed parent, Phoenix production date, and 2 or 3 concepts',
    invalid_bootstrap_batch_request: 'Choose a Phoenix date, acknowledge the audited bootstrap, and add a 10–500 character owner note',
    bootstrap_authorization_conflict: 'This audited day already exists under a different owner authorization',
    bootstrap_daily_batch_conflict: 'A different audited bootstrap already owns this Phoenix production date',
    bootstrap_batch_limit_reached: 'The seven-day audited bootstrap is complete; use measured Repeat or Iterate evidence now',
    growth_batch_bootstrap_stale: 'The audited seed allowlist or bootstrap authorization changed; do not render this batch',
    invalid_audited_bootstrap_caption: 'An audited donor caption is incomplete',
    invalid_audited_bootstrap_hooks: 'The audited donor pair does not contain coherent platform hooks',
    invalid_audited_bootstrap_contract: 'The audited seed no longer satisfies the locked two-video caption contract',
    invalid_content_profile: 'Choose one of the server-supported measured content profiles',
    feature_explainer_requires_two_concepts: 'Video feature explainer is locked to exactly two concepts',
    insufficient_eligible_video_donors: 'Two distinct, audited publish-candidate video or image donors are required outside the seven-day cooldown; every platform rendition still exports as video',
    reviewed_parent_not_published: 'The selected parent is not recorded as published',
    reviewed_parent_on_hold: 'Hold decisions cannot seed a new content batch',
    reviewed_parent_required: 'Save a current Repeat or Iterate decision before building a batch',
    reviewed_parent_evidence_stale: 'The parent evidence changed; refresh the report and review it again',
    trusted_seed_pack_not_configured: 'Allowlist the trusted starter pack before measured generation',
    untrusted_seed_render_pack: 'This seed manifest is not the exact allowlisted trusted starter pack',
    invalid_seed_render_pack: 'The seed manifest does not contain valid paired Instagram and TikTok donors',
    insufficient_eligible_donors: 'There are not enough safe donors outside the seven-day source cooldown',
    seed_donor_source_unavailable: 'A selected seed source changed or is no longer privacy-safe',
    growth_batch_request_conflict: 'This measured batch already exists with a different request',
    growth_batch_generation_in_progress: 'This measured batch is already being generated; refresh shortly',
    growth_batch_not_found: 'The measured batch no longer exists',
    growth_batch_not_ready: 'The measured batch is not ready to download',
    growth_batch_pack_mismatch: 'The generated pack hash changed; refresh before authorizing',
    growth_batch_profile_conflict: 'The generated pack no longer matches its locked content profile',
    growth_batch_activation_not_ready: 'Finish all four rendition reviews and approvals, verify both Buffer channels, then retry activation',
    growth_batch_activation_partial: 'Activation stopped safely. Refresh and resume only the unfinished posts',
    growth_batch_render_pack_tampered: 'The stored render pack no longer matches its exact SHA-256',
    growth_batch_not_authorized: 'The exact measured batch is not currently authorized for import',
    invalid_batch_authorization: 'Inspect the exact pack, acknowledge it, and add an authorization note',
    invalid_batch_revocation: 'Add a revocation reason of at least 5 characters',
    growth_batch_authorization_conflict: 'This batch was already authorized with a different note',
    growth_batch_authorization_contended: 'The batch changed while authorizing; refresh and inspect it again',
    growth_batch_not_revocable: 'This measured batch can no longer be revoked from this state',
    growth_batch_published_history_immutable: 'Published batch history must stay recorded for source cooldown and hook deduplication',
    growth_batch_schedule_slot_mismatch: 'Measured batches must use their reserved Phoenix cadence date and time',
    production_batch_required: 'The 1000-user campaign only schedules complete two-video Instagram and TikTok batches',
    production_batch_incomplete: 'The exact four-post production batch is incomplete; rebuild or finish its missing rendition',
    production_batch_not_schedulable: 'One or more production renditions changed or is not ready; refresh and complete every review before retrying',
    production_batch_automatic_required: 'The 1000-user campaign uses automatic paired-batch delivery only',
    source_cooldown_conflict: 'That source is already reserved inside the seven-day cooldown',
    hook_dedupe_conflict: 'That hook is too similar to approved or scheduled content in the active 28-day window',
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
    local: measuredBatchScheduleLocal(artifact)
      || nextScheduleSlot(jobs, Date.now(), artifact?.platform),
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
      local: measuredBatchScheduleLocal(artifact)
        || nextScheduleSlot(jobs, Date.now(), artifact.platform),
      scheduling_type: defaultSchedulingType(artifact),
    });
  }, [
    artifact?.id,
    artifact?.platform,
    artifact?.audio_mode,
    artifact?.growth_batch_target_date,
    artifact?.growth_batch_slot_key,
    jobs,
  ]);

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
  const providerTextLimit = socialPostTextLimit(artifact.platform);
  const draftProviderText = socialPostText({
    ...draft,
    platform: artifact.platform,
  });
  const providerText = artifact.provider_text || socialPostText(artifact);
  const captionReady = providerText.length > 0
    && providerText.length <= providerTextLimit;
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
                {providerText.length.toLocaleString()} / {providerTextLimit.toLocaleString()}
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
              helper={`${draftProviderText.length.toLocaleString()} / ${providerTextLimit.toLocaleString()} characters after platform disclosure and CTA${artifact.platform === 'tiktok' ? '; tracked URL stays on the profile-link artifact' : ', including the content URL'}`}
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
                <span className={`text-[10px] font-black ${draftProviderText.length <= providerTextLimit ? 'text-green-200' : 'text-red-200'}`}>
                  {draftProviderText.length.toLocaleString()} / {providerTextLimit.toLocaleString()}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
                {draftProviderText || (artifact.platform === 'tiktok'
                  ? 'Caption, disclosure, and profile-link CTA will appear here.'
                  : 'Caption, disclosure, CTA, and content URL will appear here.')}
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
                helper={measuredBatchScheduleLocal(artifact)
                  ? `Reserved ${artifact.growth_batch_slot_key} slot from the measured batch; this exact Phoenix cadence time cannot be moved.`
                  : 'Suggested from the 9:30 AM, 1:30 PM, and 6:30 PM America/Phoenix cadence; existing non-canceled jobs are skipped.'}
              >
                <Input
                  type="datetime-local"
                  value={schedule.local}
                  onChange={(event) => setSchedule((current) => ({ ...current, local: event.target.value }))}
                  disabled={Boolean(measuredBatchScheduleLocal(artifact))}
                  className="border-white/10 bg-black text-white"
                />
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
                <p className="mt-1 text-xs opacity-70">
                  {dateLabel(displayJob.due_at)} · requested {displayJob.scheduling_type}
                  {displayJob.provider_scheduling_type
                    ? ` · Buffer confirmed ${displayJob.provider_scheduling_type}`
                    : ''}
                </p>
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

export default function ContentEngineQueue({ accent, accentText, contentQueue }) {
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
    refetchInterval: (currentQuery) => contentEngineRefetchInterval(currentQuery.state.data),
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
        build_audited_bootstrap_batch: 'Audited first-week video batch built',
        build_next_batch: 'Measured Instagram and TikTok batch built',
        authorize_batch: 'Exact generated pack authorized for render-result import',
        revoke_batch: 'Generated batch revoked',
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
  const batches = data.batches || [];
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
  const summary = data.summary || {};
  const staticRenderImportReady = capabilities.render_result_import_ready === true;
  const locallyAuthorizedBatchImportAvailable = (
    capabilities.authorized_batch_import_ready === true
    && Number(summary.batches_authorized || 0) > 0
  );
  const renderImportAvailable = (
    staticRenderImportReady || locallyAuthorizedBatchImportAvailable
  );
  const canApprove = capabilities.can_approve === true;
  const canSchedule = capabilities.can_schedule === true;
  const batchActivation = useMutation({
    mutationFn: async ({
      batch_key: batchKey,
      silent_automatic_confirmed: silentAutomaticConfirmed,
    }) => {
      const refreshed = await query.refetch();
      const snapshot = refreshed.data || {};
      const batch = (snapshot.batches || []).find(
        (candidate) => candidate?.batch_key === batchKey,
      );
      const inspection = inspectGrowthBatchActivation({
        batch,
        artifacts: snapshot.artifacts || [],
        jobs: snapshot.jobs || [],
        capabilities: snapshot.capabilities || {},
        isMediaReady: artifactMediaReady,
      });
      if (inspection.complete) {
        return {
          protected_count: 4,
          submitted: 0,
          idempotent: true,
        };
      }
      if (!inspection.can_activate || silentAutomaticConfirmed !== true) {
        const activationError = new Error(
          'The four-post batch changed or is not ready for automatic activation.',
        );
        activationError.code = 'growth_batch_activation_not_ready';
        activationError.protected_count = inspection.protected_count;
        activationError.blockers = inspection.blockers;
        throw activationError;
      }
      const preflightResponse = await base44.functions.invoke(
        'manageGrowthContentEngine',
        {
          action: 'preflight_batch_activation',
          batch_key: batchKey,
        },
      );
      const preflight = preflightResponse?.data || preflightResponse;
      const expectedArtifactIds = [
        ...inspection.schedule_candidates.map(
          (candidate) => String(candidate?.artifact?.id || ''),
        ),
        ...inspection.already_queued.map((artifact) => String(artifact?.id || '')),
        ...inspection.sent.map((artifact) => String(artifact?.id || '')),
      ].sort();
      const preflightArtifactIds = (preflight?.artifacts || [])
        .map((artifact) => String(artifact?.id || ''))
        .sort();
      if (
        preflight?.success !== true
        || preflightArtifactIds.length !== 4
        || JSON.stringify(preflightArtifactIds) !== JSON.stringify(expectedArtifactIds)
      ) {
        const activationError = new Error(
          'The server rejected the exact four-post batch preflight.',
        );
        activationError.code = 'growth_batch_activation_not_ready';
        activationError.protected_count = inspection.protected_count;
        throw activationError;
      }
      const requests = inspection.schedule_candidates.map((candidate) => (
        growthBatchScheduleRequest(candidate, {
          silentAutomaticConfirmed,
        })
      ));
      if (requests.some((request) => !request)) {
        const activationError = new Error(
          'The automatic-delivery request could not be constructed safely.',
        );
        activationError.code = 'growth_batch_activation_not_ready';
        activationError.protected_count = inspection.protected_count;
        throw activationError;
      }

      let protectedCount = inspection.protected_count;
      for (let index = 0; index < requests.length; index += 1) {
        try {
          await base44.functions.invoke(
            'manageGrowthContentEngine',
            requests[index],
          );
          protectedCount += 1;
        } catch (cause) {
          const activationError = new Error(
            `Activation stopped after ${protectedCount} of 4 posts were protected.`,
          );
          activationError.code = 'growth_batch_activation_partial';
          activationError.protected_count = protectedCount;
          activationError.failed_artifact_id =
            inspection.schedule_candidates[index]?.artifact?.id;
          activationError.cause = cause;
          throw activationError;
        }
      }
      return {
        protected_count: protectedCount,
        submitted: requests.length,
        idempotent: false,
      };
    },
    onSuccess: async (result) => {
      toast.success(
        `${Number(result?.protected_count || 0)}/4 posts submitted for automatic Buffer delivery`,
      );
      await query.refetch();
      await queryClient.invalidateQueries({ queryKey: ['acquisitionReport'] });
    },
    onError: async (error) => {
      const sourceError = error?.cause || error;
      const sourceCode = sourceError?.response?.data?.error || error?.code;
      const sourceMessage = sourceError?.response?.data?.message
        || fieldError(sourceCode);
      const protectedCount = Number(error?.protected_count || 0);
      toast.error(
        protectedCount > 0
          ? `${protectedCount}/4 posts are protected. ${sourceMessage}`
          : sourceMessage,
      );
      await query.refetch();
      await queryClient.invalidateQueries({ queryKey: ['acquisitionReport'] });
    },
  });
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
              disabled={!sources.length || !renderImportAvailable || query.isLoading || action.isPending}
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
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              <SummaryChip label="Sources" value={summary.sources} />
              <SummaryChip label="Needs review" value={summary.needs_review} />
              <SummaryChip label="Approved" value={summary.approved} />
              <SummaryChip label="Delivery queue" value={summary.queued} />
              <SummaryChip label="Needs attention" value={summary.attention} />
              <SummaryChip label="Batches ready" value={summary.batches_ready} />
              <SummaryChip label="Batches authorized" value={summary.batches_authorized} />
            </div>

            <div className="mt-4 grid gap-2 text-[10px] sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">Draft generation</p>
                <p className="mt-1 font-bold text-white/70">{capabilities.draft_generation_configured ? 'Configured' : 'Not configured'}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">Media rendering</p>
                <p className="mt-1 font-bold text-white/70">
                  {renderImportAvailable
                    ? (staticRenderImportReady
                      ? 'Static trusted import ready'
                      : 'Locally authorized batch; server revalidates on import')
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
                <p className="mt-1 text-[9px] leading-relaxed text-white/35">Static bio: platform-level; post link or visitor assist stays labeled.</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <p className="font-black uppercase tracking-wider text-white/35">TikTok delivery</p>
                <p className="mt-1 font-bold text-white/70">{capabilities.tiktok?.delivery === 'buffer' ? 'Buffer worker ready' : 'Not ready'}</p>
                <p className="mt-1 text-[9px] leading-relaxed text-white/35">Static bio: platform-level; post link or visitor assist stays labeled.</p>
              </div>
            </div>

            {!renderImportAvailable && (
              <div className="mt-4 rounded-xl border border-violet-300/20 bg-violet-300/10 p-3">
                <p className="text-xs font-black text-violet-100">Rendered-media import is locked</p>
                <p className="mt-1 text-[11px] leading-relaxed text-violet-100/60">
                  Configure the immutable media origin and trusted renderer environment, then either allowlist a static reviewed pack or owner-authorize an exact measured batch before importing hosted candidates.
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

            <MeasuredBatchPanel
              accent={accent}
              accentText={accentText}
              contentQueue={contentQueue}
              sources={sources}
              artifacts={artifacts}
              jobs={jobs}
              batches={batches}
              capabilities={capabilities}
              summary={summary}
              busy={action.isPending}
              activationBusy={batchActivation.isPending}
              onAction={(payload, options) => action.mutate(payload, options)}
              onActivateBatch={(payload, options) => (
                batchActivation.mutate(payload, options)
              )}
            />

            {!sources.length ? (
              <div className="mt-5 rounded-2xl border border-dashed border-white/15 bg-white/[0.025] p-6 text-center">
                <Image className="mx-auto h-6 w-6 text-white/35" />
                <p className="mt-3 font-black">Load the audited starter inventory</p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-white/40">
                  This registers {FIRSTKNOCK_AUDITED_SOURCES.length} audited, privacy-safe FirstKnock sources, including ten approved feature videos and four owned image donors that render as video, by opaque filename, exact SHA-256, and sanitized summary. The local files are not uploaded or copied.
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
