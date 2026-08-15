import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Pencil, X, Trash2, Loader2, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { createPageUrl } from '@/utils';
import { calculatePolygonAreaSqMiles, formatSqMiles } from '@/components/logic/geoArea';
import { savePolygonToHistory } from '@/components/map/PolygonHistory';
import PrecisionPullPanel from '@/components/map/PrecisionPullPanel';
import { hasUnsettledPrecisionReservation } from '@/lib/precisionUsage';
import { getPrecisionWorkspaceId } from '@/lib/precisionIdentity';
import { usePrecisionUsage } from '@/hooks/usePrecisionUsage';
import { normalizeOwnershipRangeDays as normalizeStrictOwnershipRangeDays } from '@/components/logic/soldDateRange';
import { validateCanvasBoundary } from '@/components/canvas/canvasPlannerUtils';

const DEFAULT_PRECISION_PROPERTY_COUNT = 50;
const DEFAULT_PRECISION_COUNT_MODE = 'max_available';
const DEFAULT_PRECISION_MIN_HOME_VALUE = 100000;
const DEFAULT_PRECISION_MAX_HOME_VALUE = '';
const DEFAULT_PRECISION_SOLD_MONTHS = 12;
const DEFAULT_PRECISION_OWNERSHIP_RANGE_DAYS = [30, 180];
const DEFAULT_PRECISION_ROUTE_FILTERS = Object.freeze({
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true
});

function formatWholeNumber(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  return number.toLocaleString();
}

function formatSoldWindow(months) {
  const value = Number(months);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 1) {
    const days = Math.max(1, Math.round(value * 30));
    if (days <= 2) return `${days} day${days === 1 ? '' : 's'} sold window`;
    const weeks = Math.max(1, Math.round(days / 7));
    return `${weeks} week${weeks === 1 ? '' : 's'} sold window`;
  }
  const label = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${label} month${value === 1 ? '' : 's'} sold window`;
}

function normalizeOwnershipRangeDays(value) {
  const min = Number(Array.isArray(value) ? value[0] : value?.min);
  const max = Number(Array.isArray(value) ? value[1] : value?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const normalizedMin = Math.max(1, Math.min(365, Math.round(min)));
  const normalizedMax = Math.max(1, Math.min(365, Math.round(max)));
  if (normalizedMin >= normalizedMax) return null;
  return [normalizedMin, normalizedMax];
}

function ownershipRangeMaxToMonths(range) {
  const normalized = normalizeOwnershipRangeDays(range);
  if (!normalized) return null;
  return normalized[1] === 365 ? 12 : normalized[1] / 30;
}

function ownershipRangeCriteria(range) {
  const normalized = normalizeOwnershipRangeDays(range);
  return normalized ? { min: normalized[0], max: normalized[1] } : null;
}

function defaultSoldMonthsForUser(user) {
  const value = Number(user?.pull_months_back);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PRECISION_SOLD_MONTHS;
}

function normalizeRouteFilters(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  const hasPropertyTypes = Object.prototype.hasOwnProperty.call(candidate, 'propertyTypes');
  const propertyTypes = hasPropertyTypes && Array.isArray(candidate.propertyTypes)
    ? candidate.propertyTypes.filter(Boolean)
    : [...DEFAULT_PRECISION_ROUTE_FILTERS.propertyTypes];
  return {
    propertyTypes,
    excludeCommercial: candidate.excludeCommercial !== false,
    excludeCondos: candidate.excludeCondos !== false,
    excludeLand: candidate.excludeLand !== false
  };
}

function normalizeRouteBounds(value) {
  if (!value || value.enabled !== true) return { enabled: false };
  const startLocation = value.startLocation || value.start_location;
  const endLocation = value.endLocation || value.end_location;
  const normalizePoint = (point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
    return { lat, lng };
  };
  const start = normalizePoint(startLocation);
  const end = normalizePoint(endLocation);
  if (!start || !end) return { enabled: false };
  return {
    enabled: true,
    mode: value.mode === 'current_to_home' ? 'current_to_home' : 'home_round_trip',
    startLocation: start,
    endLocation: end
  };
}

const PRECISION_CRITERIA_SCHEMA_VERSION = 1;
const REQUIRED_PRECISION_CRITERIA_FIELDS = Object.freeze([
  'criteria_schema_version',
  'polygon_hash',
  'count_mode',
  'entered_count',
  'effective_count',
  'min_price',
  'max_price',
  'sold_months',
  'ownership_range_mode',
  'ownership_range_days',
  'route_filters',
  'repull_mode',
  'previous_pull_date',
  'force_full_refresh',
  'include_unresolved_followups',
  'route_bounds',
  'immutable_user_id',
  'workspace_id'
]);

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveInteger(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && Number.isSafeInteger(value);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isStrictOwnershipRangeDays(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.min === 'number'
    && typeof value.max === 'number'
    && Number.isInteger(value.min)
    && Number.isInteger(value.max)
    && value.min >= 1
    && value.max <= 365
    && value.min < value.max;
}

function isStrictRouteFilters(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray(value.propertyTypes)
    && value.propertyTypes.length === 1
    && value.propertyTypes[0] === 'Single Family'
    && value.excludeCommercial === true
    && value.excludeCondos === true
    && value.excludeLand === true;
}

function isStrictRoutePoint(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.lat === 'number'
    && typeof value.lng === 'number'
    && Number.isFinite(value.lat)
    && Number.isFinite(value.lng)
    && value.lat >= -90
    && value.lat <= 90
    && value.lng >= -180
    && value.lng <= 180;
}

function isStrictRouteBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') {
    return false;
  }
  if (value.enabled === false) return true;
  return ['home_round_trip', 'current_to_home'].includes(value.mode)
    && isStrictRoutePoint(value.start_location)
    && isStrictRoutePoint(value.end_location);
}

function normalizeServerPrecisionPolygon(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  if (value.some((point) => !isStrictRoutePoint(point))) return null;
  const normalized = value.map((point) => ({ lat: point.lat, lng: point.lng }));
  const unique = new Set(normalized.map((point) => `${point.lat.toFixed(8)}:${point.lng.toFixed(8)}`));
  return unique.size >= 3 ? normalized : null;
}

function getVerifiedServerPrecisionPolygon(job, criteria) {
  const polygon = normalizeServerPrecisionPolygon(job?.polygon);
  if (!polygon) return null;
  const jobHash = typeof job?.polygon_hash === 'string' ? job.polygon_hash.toLowerCase() : '';
  const criteriaHash = typeof criteria?.polygon_hash === 'string' ? criteria.polygon_hash.toLowerCase() : '';
  return jobHash && jobHash === criteriaHash ? polygon : null;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function isCompleteServerPrecisionCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return false;
  if (REQUIRED_PRECISION_CRITERIA_FIELDS.some((field) => !hasOwn(criteria, field))) return false;
  if (criteria.criteria_schema_version !== PRECISION_CRITERIA_SCHEMA_VERSION) return false;
  if (typeof criteria.polygon_hash !== 'string' || !/^[a-f0-9]{16}$/i.test(criteria.polygon_hash)) return false;
  if (!['fixed', 'max_available'].includes(criteria.count_mode)) return false;
  if (!isPositiveInteger(criteria.entered_count) || !isPositiveInteger(criteria.effective_count)) return false;
  if (criteria.count_mode === 'fixed' && criteria.effective_count > criteria.entered_count) return false;

  const minPrice = criteria.min_price;
  if (!isPositiveNumber(minPrice)) return false;
  if (criteria.max_price !== null) {
    if (!isPositiveNumber(criteria.max_price) || criteria.max_price < minPrice) return false;
  }

  if (!isPositiveNumber(criteria.sold_months)) return false;
  if (!['quick', 'custom'].includes(criteria.ownership_range_mode)) return false;
  if (criteria.ownership_range_mode === 'quick') {
    if (criteria.ownership_range_days !== null) return false;
  } else if (!isStrictOwnershipRangeDays(criteria.ownership_range_days)) {
    return false;
  }

  if (!isStrictRouteFilters(criteria.route_filters)) return false;

  if (!['new_area', 'fill_gaps', 'max_since_last'].includes(criteria.repull_mode)) return false;
  if (criteria.repull_mode === 'new_area') {
    if (criteria.previous_pull_date !== null) return false;
  } else if (!isValidTimestamp(criteria.previous_pull_date)) {
    return false;
  }
  if (typeof criteria.force_full_refresh !== 'boolean') return false;
  if (typeof criteria.include_unresolved_followups !== 'boolean') return false;
  if (!isStrictRouteBounds(criteria.route_bounds)) return false;
  if (typeof criteria.immutable_user_id !== 'string' || !criteria.immutable_user_id.trim()) return false;
  if (typeof criteria.workspace_id !== 'string' || !criteria.workspace_id.trim()) return false;
  return true;
}

function getServerPrecisionCriteria(job = {}) {
  if (job?.criteria_verified !== true) return null;
  const candidates = [
    job.criteria,
    job.precision_criteria,
    job.diagnostics?.precision_criteria,
    job.dry_run_metadata?.precision_criteria
  ];
  return candidates.find(isCompleteServerPrecisionCriteria) || null;
}

function getServerPrecisionCounts(job = {}, criteria = getServerPrecisionCriteria(job)) {
  if (!criteria) return null;
  const deliveredValue = hasOwn(job, 'delivered_count')
    ? job.delivered_count
    : job.precision_usage_count;
  const hasDeliveredCount = typeof deliveredValue === 'number'
    && Number.isSafeInteger(deliveredValue)
    && deliveredValue >= 0;
  return {
    countMode: criteria.count_mode,
    enteredCount: criteria.entered_count,
    effectiveCount: criteria.effective_count,
    deliveredCount: hasDeliveredCount ? deliveredValue : null
  };
}

function precisionCriteriaToUi(criteria) {
  if (!isCompleteServerPrecisionCriteria(criteria)) return null;
  const ownershipRangeDays = criteria.ownership_range_mode === 'custom'
    ? normalizeOwnershipRangeDays(criteria.ownership_range_days)
    : null;
  return {
    requestedPropertyCount: criteria.count_mode === 'fixed'
      ? Math.round(Number(criteria.entered_count))
      : Math.round(Number(criteria.effective_count)),
    propertyCountMode: criteria.count_mode,
    minHomeValue: Number(criteria.min_price),
    maxHomeValue: criteria.max_price === null ? DEFAULT_PRECISION_MAX_HOME_VALUE : Number(criteria.max_price),
    soldMonths: Number(criteria.sold_months),
    ownershipRangeMode: criteria.ownership_range_mode,
    ownershipRangeDays: ownershipRangeDays || DEFAULT_PRECISION_OWNERSHIP_RANGE_DAYS,
    repullMode: criteria.repull_mode,
    forceFullRefresh: criteria.force_full_refresh,
    includeUnresolvedFollowUps: criteria.include_unresolved_followups,
    routeFilters: normalizeRouteFilters(criteria.route_filters),
    routeBounds: normalizeRouteBounds(criteria.route_bounds)
  };
}

function normalizedHistoryCriteria(historyEntry) {
  if (
    historyEntry?.criteria_verified !== true ||
    historyEntry?.criteria_status !== 'server_verified'
  ) return null;
  return precisionCriteriaToUi(historyEntry.criteria);
}

function precisionHistoryFetchJobId(eventDetail) {
  if (
    !eventDetail ||
    typeof eventDetail !== 'object' ||
    typeof eventDetail.fetch_job_id !== 'string'
  ) return null;
  const jobId = eventDetail.fetch_job_id.trim();
  return jobId || null;
}

function resolvedPrecisionHistorySelection(resolution, expectedJobId, user) {
  if (resolution?.state !== 'single' || !expectedJobId) return null;
  const job = resolution.job;
  const jobId = typeof job?.job_id === 'string' ? job.job_id.trim() : '';
  const criteria = getServerPrecisionCriteria(job);
  const counts = getServerPrecisionCounts(job, criteria);
  const polygon = getVerifiedServerPrecisionPolygon(job, criteria);
  const restored = normalizedHistoryCriteria(job);
  const expectedWorkspaceId = getPrecisionWorkspaceId(user);
  const criteriaTimestamp = new Date(job?.criteria_timestamp || '').getTime();
  if (
    jobId !== expectedJobId ||
    job?.status !== 'completed' ||
    job?.criteria_verified !== true ||
    job?.criteria_status !== 'server_verified' ||
    String(job?.criteria_source_fetch_job_id || '') !== jobId ||
    !criteria ||
    !counts ||
    counts.deliveredCount === null ||
    counts.deliveredCount > counts.effectiveCount ||
    !polygon ||
    !restored ||
    !Number.isFinite(criteriaTimestamp) ||
    job.criteria_schema_version !== criteria.criteria_schema_version ||
    job.entered_count !== counts.enteredCount ||
    job.effective_count !== counts.effectiveCount ||
    job.delivered_count !== counts.deliveredCount ||
    String(criteria.immutable_user_id) !== String(user?.id || '') ||
    String(criteria.workspace_id) !== expectedWorkspaceId
  ) return null;
  return { job, criteria, counts, polygon, restored };
}

function precisionFunctionErrorDetails(error) {
  const payload = error?.response?.data || error?.data || {};
  return {
    code: payload.error || error?.code || error?.name || '',
    message: payload.message || payload.error || error?.message || 'Could not start the property import.',
    status: Number(error?.response?.status || error?.status || 0) || null
  };
}

function activeJobCriteriaConflictMessage(serverMessage) {
  const detail = String(serverMessage || '').trim();
  const suffix = detail && detail !== 'active_job_criteria_conflict' ? ` ${detail}` : '';
  return `A different Precision import is already running. This request was not started, and FirstKnock will not resume the older job because its criteria do not match.${suffix}`;
}

function precisionControlErrorMessage(code, serverMessage) {
  const detail = String(serverMessage || '').trim();
  if (code === 'active_job_criteria_conflict') return activeJobCriteriaConflictMessage(detail);
  if (code === 'multiple_active_precision_jobs') {
    return detail || 'Multiple Precision imports are active for this account. No job was selected or changed. Contact support to reconcile them before starting another import.';
  }
  if (code === 'precision_job_active') {
    return detail || 'A Precision import is already active for this account. Continue monitoring that job before starting another import.';
  }
  if (code === 'precision_provider_outcome_unverifiable') {
    return detail || 'A prior paid-provider attempt has an ambiguous outcome. No new import can start until support verifies the result.';
  }
  if (code === 'precision_reservation_unsettled' || code === 'precision_retry_reservation_unsettled') {
    return detail || 'A prior Precision reservation has not been settled. No new import was started. Contact support to reconcile the reservation.';
  }
  if (code === 'legacy_precision_criteria_unverifiable') {
    return detail || 'This older Precision job does not contain a complete verified criteria snapshot. It cannot be resumed or retried automatically.';
  }
  if (code === 'precision_retry_polygon_unverifiable') {
    return detail || 'The original Precision area could not be verified. No retry was started.';
  }
  if (code === 'precision_retry_partial_delivery_unverifiable') {
    return detail || 'The failed attempt already delivered properties whose provenance cannot be safely replaced in Phase 1. No retry was started.';
  }
  if (code === 'precision_history_evidence_unverifiable' || code === 'precision_history_job_not_found') {
    return detail || 'This previous Precision area could not be reverified with the server. It remains display-only.';
  }
  return detail || 'Could not start the property import.';
}

function buildPrecisionShortfallMessage({
  loadedCount,
  requestedCount,
  intendedCount,
  diagnostics,
  soldMonths,
  ownershipRangeMode,
  ownershipRangeDays,
  minHomeValue,
  maxHomeValue
}) {
  const loaded = Math.max(0, Number(loadedCount) || 0);
  const requested = Math.max(0, Number(requestedCount) || 0);
  const intended = Math.max(requested, Number(intendedCount) || 0);

  if (diagnostics?.limited_by_free_home_cap && requested > 0 && intended > requested) {
    return `This pull was capped at ${formatWholeNumber(requested)} homes because that is how many included single-family Precision route homes remain on this account. Upgrade to Precision for larger routes.`;
  }

  if (requested <= 0 || loaded >= requested) return null;

  const filters = [];
  const customRange = normalizeOwnershipRangeDays(ownershipRangeDays ?? diagnostics?.ownership_range_days);
  const usesCustomRange = (ownershipRangeMode ?? diagnostics?.ownership_range_mode) === 'custom' && customRange;
  const soldWindow = usesCustomRange
    ? `${customRange[0]}\u2013${customRange[1]} days since recorded sale`
    : formatSoldWindow(soldMonths ?? diagnostics?.sold_months);
  if (soldWindow) filters.push(soldWindow);

  const minValue = Number(minHomeValue ?? diagnostics?.filters?.min_price);
  if (Number.isFinite(minValue) && minValue > 0) filters.push(`minimum value $${formatWholeNumber(minValue)}`);

  const maxValue = Number(maxHomeValue ?? diagnostics?.filters?.max_price);
  if (Number.isFinite(maxValue) && maxValue > 0) filters.push(`maximum value $${formatWholeNumber(maxValue)}`);

  const filterText = filters.length ? ` with your ${filters.join(', ')}` : '';
  const summary = diagnostics?.batchdata_summary || {};
  const reviewed = Number(summary.reviewed || 0);
  const skippedExisting = Number(summary.skipped_existing_route || 0);
  const skippedRouteType = Number(summary.skipped_route_type || 0);
  const reviewedText = reviewed > 0 ? ` We checked ${formatWholeNumber(reviewed)} provider records.` : '';
  const skippedText = skippedExisting > 0 ? ` We skipped ${formatWholeNumber(skippedExisting)} homes already in saved routes.` : '';
  const routeTypeText = skippedRouteType > 0 ? ` ${formatWholeNumber(skippedRouteType)} provider records were not single-family residential homes.` : '';
  const nextStep = summary.scan_limit_reached === true
    ? 'We reached the provider scan safety limit before filling the request. Try a fixed count, a smaller area, or a wider recorded-sale window.'
    : skippedRouteType > 0
    ? 'Precision routes only use single-family residential homes, so draw a larger residential area to find more eligible homes.'
    : skippedExisting > 0
    ? 'Draw beyond the previous route area or widen the boundary to reach new homes.'
    : 'Draw a larger area, widen the sold-date range, or loosen the value range, then generate again to keep filling the route.';

  return `Found ${formatWholeNumber(loaded)} new qualifying sold homes in this area${filterText}; you requested ${formatWholeNumber(requested)}.${reviewedText}${skippedText}${routeTypeText} ${nextStep}`;
}

export default function TerritoryPrompt({
  mode,
  routeMode = 'precision',
  setMode,
  activeRoute,
  routesGenerating,
  showCompare,
  setShowCompare,
  showRoutePanel,
  setShowRoutePanel,
  drawingMode,
  setDrawingMode,
  drawnPolygon,
  setDrawnPolygon,
  draftPolygon,
  setDraftPolygon,
  drawShape,
  setDrawShape,
  drawSizeMiles,
  setDrawSizeMiles,
  user,
  savedRoutes = [],
  setZipCodeFilter,
  routeConfig = {},
  homeBase = null,
  onSaveHomeBase,
  onRouteBoundsPrepared,
  onPullComplete
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const {
    data: precisionUsage,
    isLoading: precisionUsageLoading,
    isFetching: precisionUsageFetching,
    isError: precisionUsageError,
    refetch: refetchPrecisionUsage
  } = usePrecisionUsage(routeMode === 'precision' ? user : null);
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState('');
  const [fetchMonths, setFetchMonths] = useState(() => defaultSoldMonthsForUser(user));
  const [ownershipRangeMode, setOwnershipRangeMode] = useState('quick');
  const [ownershipRangeDays, setOwnershipRangeDays] = useState(DEFAULT_PRECISION_OWNERSHIP_RANGE_DAYS);
  const [pullPct, setPullPct] = useState(0);
  const [displayPct, setDisplayPct] = useState(0);
  const [etaText, setEtaText] = useState('');
  const [totalExpected, setTotalExpected] = useState(0);
  const [isDeltaPull, setIsDeltaPull] = useState(false);
  const [forceFullRefresh, setForceFullRefresh] = useState(false);
  const [selectedHistoryArea, setSelectedHistoryArea] = useState(null);
  const [repullMode, setRepullMode] = useState('fill_gaps');
  const [includeUnresolvedFollowUps, setIncludeUnresolvedFollowUps] = useState(true);
  const [recoverableJob, setRecoverableJob] = useState(null);
  const [requestedPropertyCount, setRequestedPropertyCount] = useState(DEFAULT_PRECISION_PROPERTY_COUNT);
  const [propertyCountMode, setPropertyCountMode] = useState(DEFAULT_PRECISION_COUNT_MODE);
  const [minHomeValue, setMinHomeValue] = useState(DEFAULT_PRECISION_MIN_HOME_VALUE);
  const [maxHomeValue, setMaxHomeValue] = useState(DEFAULT_PRECISION_MAX_HOME_VALUE);
  const [precisionRouteFilters, setPrecisionRouteFilters] = useState(() => normalizeRouteFilters());
  const [restoredRouteBounds, setRestoredRouteBounds] = useState({ enabled: false });
  const [showPrecisionPullPanel, setShowPrecisionPullPanel] = useState(false);
  const [pullError, setPullError] = useState(null); // { message, upgrade } — persistent in-panel error, not a transient toast
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [paidPullStarting, setPaidPullStarting] = useState(false);
  const [ghostAreasVisible, setGhostAreasVisible] = useState(() => {
    try {return localStorage.getItem('fk_showGhostAreas') === 'true';} catch {return false;}
  });
  // v15: MLS Phase 2 always runs with verification — no toggle needed
  const pollRef = useRef(null);
  const activeJobIdRef = useRef(null);
  const animRef = useRef(null);
  const pctHistoryRef = useRef([]);
  const targetPctRef = useRef(0);
  const restoredCompletedJobRef = useRef(false);
  const pullIntentRef = useRef({});
  const requestTokenRef = useRef(0);
  const pollTokenRef = useRef(0);
  const terminalPollTokenRef = useRef(null);
  const routeModeRef = useRef(routeMode);
  routeModeRef.current = routeMode;

  const isCurrentRequest = (requestToken) => requestTokenRef.current === requestToken;
  const isCurrentPoll = (pollToken, jobId) => (
    pollTokenRef.current === pollToken
    && String(activeJobIdRef.current || '') === String(jobId || '')
  );
  const invalidateActivePolling = () => {
    pollTokenRef.current += 1;
    terminalPollTokenRef.current = null;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    activeJobIdRef.current = null;
  };
  const beginPrecisionRequest = () => {
    requestTokenRef.current += 1;
    invalidateActivePolling();
    return requestTokenRef.current;
  };
  const claimTerminalPoll = (pollToken, jobId) => {
    if (!isCurrentPoll(pollToken, jobId) || terminalPollTokenRef.current === pollToken) return false;
    terminalPollTokenRef.current = pollToken;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    return true;
  };
  const finishPollIfCurrent = (pollToken, jobId) => {
    if (!isCurrentPoll(pollToken, jobId)) return false;
    activeJobIdRef.current = null;
    pollTokenRef.current += 1;
    terminalPollTokenRef.current = null;
    return true;
  };
  const resetPrecisionCriteriaForNewArea = () => {
    beginPrecisionRequest();
    setFetchMonths(defaultSoldMonthsForUser(user));
    setOwnershipRangeMode('quick');
    setOwnershipRangeDays(DEFAULT_PRECISION_OWNERSHIP_RANGE_DAYS);
    setRequestedPropertyCount(DEFAULT_PRECISION_PROPERTY_COUNT);
    setPropertyCountMode(DEFAULT_PRECISION_COUNT_MODE);
    setMinHomeValue(DEFAULT_PRECISION_MIN_HOME_VALUE);
    setMaxHomeValue(DEFAULT_PRECISION_MAX_HOME_VALUE);
    setSelectedHistoryArea(null);
    setRepullMode('fill_gaps');
    setForceFullRefresh(false);
    setIncludeUnresolvedFollowUps(true);
    setPrecisionRouteFilters(normalizeRouteFilters());
    setRestoredRouteBounds({ enabled: false });
    setIsDeltaPull(false);
    setPreviewLoading(false);
    setPreviewResult(null);
    setPaidPullStarting(false);
    Promise.resolve(onRouteBoundsPrepared?.({ enabled: false })).catch(() => {});
  };

  // Smooth progress animation — ticks display forward toward real target
  useEffect(() => {
    if (pulling) {
      animRef.current = setInterval(() => {
        setDisplayPct((prev) => {
          const target = targetPctRef.current;
          if (prev >= target) return prev;
          // Move 20% of the gap each tick for smooth easing
          const step = Math.max(0.3, (target - prev) * 0.2);
          return Math.min(target, prev + step);
        });
      }, 100);
    } else {
      if (animRef.current) clearInterval(animRef.current);
    }
    return () => {if (animRef.current) clearInterval(animRef.current);};
  }, [pulling]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      requestTokenRef.current += 1;
      invalidateActivePolling();
    };
  }, []);

  useEffect(() => {
    if (routeMode === 'precision') return;
    requestTokenRef.current += 1;
    invalidateActivePolling();
    setPulling(false);
    setPaidPullStarting(false);
    setPreviewLoading(false);
  }, [routeMode]);

  // Auto-resume only from the server-owned Precision resolver. Browser storage,
  // email filters, and "newest job wins" logic are not authorization.
  useEffect(() => {
    if (routeMode !== 'precision') return;
    if (!user?.id) return;
    if (activeJobIdRef.current) return;
    let cancelled = false;
    const requestVersionAtCheckStart = requestTokenRef.current;
    const checkIsCurrent = () => (
      !cancelled
      && routeModeRef.current === 'precision'
      && requestTokenRef.current === requestVersionAtCheckStart
    );

    const checkRunningJobs = async () => {
      try {
        const response = await base44.functions.invoke('resolveActivePrecisionJobs', {});
        if (!checkIsCurrent()) return;
        const resolution = response.data || {};
        if (resolution.error) {
          const error = new Error(resolution.message || resolution.error);
          error.name = resolution.error;
          error.data = resolution;
          throw error;
        }
        if (resolution.state === 'none') {
          setRecoverableJob(null);
          return;
        }
        if (resolution.state === 'multiple') {
          const error = new Error(resolution.message || 'Multiple Precision imports are active.');
          error.name = 'multiple_active_precision_jobs';
          error.data = resolution;
          throw error;
        }
        if (resolution.state !== 'single' || !resolution.job?.id) {
          throw new Error('The active Precision resolver returned an invalid state.');
        }

        setRecoverableJob(null);
        const job = resolution.job;
        const canonicalCriteria = getServerPrecisionCriteria(job);
        const resumedCriteria = precisionCriteriaToUi(canonicalCriteria);
        const verifiedPolygon = getVerifiedServerPrecisionPolygon(job, canonicalCriteria);
        if (job.criteria_verified !== true || !canonicalCriteria || !resumedCriteria || !verifiedPolygon) {
          const error = new Error('The active Precision job does not contain complete verified criteria and polygon evidence.');
          error.name = 'legacy_precision_criteria_unverifiable';
          throw error;
        }
        if (checkIsCurrent() && !pulling) {
          const requestToken = beginPrecisionRequest();
          console.log('[TerritoryPrompt] Resuming running job:', job.id);
          const resumedRouteBounds = resumedCriteria.routeBounds;
          pullIntentRef.current[job.id] = {
            polygon: verifiedPolygon,
            requestedCount: resumedCriteria.requestedPropertyCount,
            canonicalCriteria,
            countMode: resumedCriteria.propertyCountMode,
            soldMonths: resumedCriteria.soldMonths,
            ownershipRangeMode: resumedCriteria.ownershipRangeMode,
            ownershipRangeDays: resumedCriteria.ownershipRangeDays,
            minHomeValue: resumedCriteria.minHomeValue,
            maxHomeValue: resumedCriteria.maxHomeValue,
            routeFilters: resumedCriteria.routeFilters,
            routeBounds: resumedRouteBounds,
            repullMode: resumedCriteria.repullMode
          };
          setRequestedPropertyCount(resumedCriteria.requestedPropertyCount);
          setPropertyCountMode(resumedCriteria.propertyCountMode);
          setFetchMonths(resumedCriteria.soldMonths);
          setOwnershipRangeMode(resumedCriteria.ownershipRangeMode);
          setOwnershipRangeDays(resumedCriteria.ownershipRangeDays);
          setMinHomeValue(resumedCriteria.minHomeValue);
          setMaxHomeValue(resumedCriteria.maxHomeValue);
          setRepullMode(resumedCriteria.repullMode);
          setForceFullRefresh(resumedCriteria.forceFullRefresh);
          setIncludeUnresolvedFollowUps(resumedCriteria.includeUnresolvedFollowUps);
          setPrecisionRouteFilters(resumedCriteria.routeFilters);
          setRestoredRouteBounds(resumedRouteBounds);
          await onRouteBoundsPrepared?.(resumedRouteBounds);
          if (!isCurrentRequest(requestToken)) return;
          try { localStorage.setItem('fk_drawnPolygonQueried', 'true'); } catch {}
          setDrawnPolygon(verifiedPolygon, true);
          setPulling(true);
          setPullProgress('Resuming data import...');
          const pct = job.progress_pct || 0;
          setPullPct(pct);
          setDisplayPct(Math.max(pct - 5, 0)); // Start close to real progress instead of 0
          targetPctRef.current = pct;
          setEtaText('Resuming...');
          pctHistoryRef.current = [];
          startPolling(job.id, requestToken);
        }
      } catch (e) {
        if (checkIsCurrent()) {
          const details = precisionFunctionErrorDetails(e);
          const message = precisionControlErrorMessage(details.code, details.message);
          setPullError({ message, upgrade: false });
          console.warn('[TerritoryPrompt] Active Precision resolver failed:', e);
        }
      }
    };

    checkRunningJobs();
    return () => {cancelled = true;};
  }, [routeMode, user?.id]);

  // Clear unqueried restored areas so draft polygons do not come back as ghost map areas.
  useEffect(() => {
    if (routeMode !== 'precision') return;
    const restoredPolygon = localStorage.getItem('fk_drawnPolygon');
    if (drawnPolygon?.length > 2 && restoredPolygon && localStorage.getItem('fk_drawnPolygonQueried') !== 'true') {
      localStorage.removeItem('fk_drawnPolygon');
      setDrawnPolygon(null);
    }
  }, [routeMode, drawnPolygon, setDrawnPolygon]);

  // Clear only in-progress drawing when switching away; keep the confirmed area
  // so users can return after a pull/reload and still generate routes for it.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fk-builder-mode-change', { detail: { mode } }));
    if (mode !== 'generate') {
      setDrawingMode(false);
      setDraftPolygon([]);
      setForceFullRefresh(false);
      setSelectedHistoryArea(null);
    }
  }, [mode]);

  useEffect(() => {
    const handler = (event) => {
      const visible = !!event.detail?.visible;
      setGhostAreasVisible(visible);
      if (!visible && selectedHistoryArea) {
        resetPrecisionCriteriaForNewArea();
      }
    };
    window.addEventListener('fk-ghost-areas-visibility', handler);
    return () => window.removeEventListener('fk-ghost-areas-visibility', handler);
  }, [selectedHistoryArea]);

  useEffect(() => {
    if (routeMode !== 'precision') return;
    if (!selectedHistoryArea) return;
    const historyPolygon = selectedHistoryArea.polygon || [];
    const samePolygon = ghostAreasVisible && drawnPolygon?.length === historyPolygon.length && drawnPolygon.every((point, index) => {
      const historyPoint = historyPolygon[index] || {};
      return Math.abs(Number(point.lat) - Number(historyPoint.lat)) < 0.000001 && Math.abs(Number(point.lng) - Number(historyPoint.lng)) < 0.000001;
    });
    if (!samePolygon) {
      resetPrecisionCriteriaForNewArea();
    }
  }, [routeMode, drawnPolygon, ghostAreasVisible, selectedHistoryArea]);

  // Listen for toolbar draw button and previous-area selection events
  useEffect(() => {
    const drawHandler = () => {
      setDrawnPolygon(null);
      setDraftPolygon([]);
      resetPrecisionCriteriaForNewArea();
      setDrawingMode(true);
    };
    const precisionPullHandler = () => {
      if (routeMode !== 'precision') return;
      if (!drawnPolygon || drawnPolygon.length < 3) {
        toast.error('Draw a freehand area first.');
        return;
      }
      setMode('generate');
      setShowCompare(false);
      setShowRoutePanel(false);
      if (!ghostAreasVisible) {
        setSelectedHistoryArea(null);
        setRepullMode('fill_gaps');
        setForceFullRefresh(false);
        setIncludeUnresolvedFollowUps(true);
      }
      setShowPrecisionPullPanel(true);
    };
    const historyHandler = async (event) => {
      if (routeMode !== 'precision') return;
      let ghostOn = false;
      try {ghostOn = localStorage.getItem('fk_showGhostAreas') === 'true';} catch {}
      if (!ghostOn) return;
      const fetchJobId = precisionHistoryFetchJobId(event.detail);
      if (!fetchJobId) {
        toast.info('This older area is display-only because its original Precision criteria cannot be verified.');
        return;
      }
      const requestToken = beginPrecisionRequest();
      setPreviewLoading(false);
      setPreviewResult(null);
      try {
        const response = await base44.functions.invoke('resolvePrecisionHistory', {
          fetch_job_id: fetchJobId
        });
        if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
        const selection = resolvedPrecisionHistorySelection(response.data || {}, fetchJobId, user);
        if (!selection) {
          const error = new Error('The selected Precision history record failed client-side response verification.');
          error.name = 'precision_history_evidence_unverifiable';
          throw error;
        }
        const { job: historyEntry, polygon, restored } = selection;
        const restoredHistoryEntry = {
          ...historyEntry,
          polygon,
          repull_mode: restored.repullMode,
          route_bounds: restored.routeBounds,
          criteria: historyEntry.criteria
        };
        setPullError(null);
        setMode('generate');
        setDrawnPolygon(polygon);
        setDraftPolygon([]);
        setDrawingMode(false);
        setSelectedHistoryArea(restoredHistoryEntry);
        setRequestedPropertyCount(restored.requestedPropertyCount);
        setPropertyCountMode(restored.propertyCountMode);
        setFetchMonths(restored.soldMonths);
        setOwnershipRangeMode(restored.ownershipRangeMode);
        setOwnershipRangeDays(restored.ownershipRangeDays);
        setMinHomeValue(restored.minHomeValue);
        setMaxHomeValue(restored.maxHomeValue);
        setRepullMode(restored.repullMode);
        setForceFullRefresh(restored.forceFullRefresh);
        setIncludeUnresolvedFollowUps(restored.includeUnresolvedFollowUps);
        setPrecisionRouteFilters(restored.routeFilters);
        setRestoredRouteBounds(restored.routeBounds);
        await Promise.resolve(onRouteBoundsPrepared?.(restored.routeBounds)).catch(() => {});
        if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
        setShowPrecisionPullPanel(true);
        toast.success('Previous area selected');
      } catch (error) {
        if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
        const details = precisionFunctionErrorDetails(error);
        setMode('generate');
        setShowPrecisionPullPanel(true);
        setPullError({
          message: precisionControlErrorMessage(details.code, details.message),
          upgrade: false
        });
      }
    };
    window.addEventListener('fk-start-drawing', drawHandler);
    window.addEventListener('fk-open-precision-pull', precisionPullHandler);
    window.addEventListener('fk-select-polygon-history', historyHandler);
    return () => {
      window.removeEventListener('fk-start-drawing', drawHandler);
      window.removeEventListener('fk-open-precision-pull', precisionPullHandler);
      window.removeEventListener('fk-select-polygon-history', historyHandler);
    };
  }, [routeMode, setMode, setDrawnPolygon, setDraftPolygon, setDrawingMode, setShowCompare, setShowRoutePanel, drawnPolygon, ghostAreasVisible, user]);

  const stopMapTouch = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.nativeEvent?.stopImmediatePropagation?.();
  };

  const monthsSinceHistoryPull = (value) => {
    const date = value ? new Date(value) : null;
    const ms = date && !isNaN(date.getTime()) ? Date.now() - date.getTime() : 30 * 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    return Math.max(1 / 30, Math.min(12, days / 30));
  };

  const confirmDraftPolygon = (event) => {
    stopMapTouch(event);
    window.__fkSuppressMapFitUntil = Date.now() + 8000;
    if (!draftPolygon || draftPolygon.length < 3) {
      toast.error('Draw a complete area first.');
      return;
    }
    const canvasBoundary = routeMode === 'canvas' ? validateCanvasBoundary(draftPolygon) : null;
    if (canvasBoundary && !canvasBoundary.valid) {
      toast.error(canvasBoundary.message);
      return;
    }
    const confirmedPolygon = canvasBoundary?.points || draftPolygon;
    setDrawnPolygon(confirmedPolygon);
    setDraftPolygon([]);
    if (routeMode === 'precision') resetPrecisionCriteriaForNewArea();
    setDrawingMode(false);
    if (routeMode === 'canvas') {
      setShowCompare(true);
      toast.success('Canvas global area selected. Choose reps or a territory count, then divide the streets.');
    } else {
      toast.success('Area selected. Run Preview to check available data.');
    }
  };

  const activeAreaPolygon = drawingMode && draftPolygon?.length > 2 ? draftPolygon : drawnPolygon;
  const actualAreaSqMiles = useMemo(() => calculatePolygonAreaSqMiles(activeAreaPolygon), [activeAreaPolygon]);
  const actualAreaLabel = actualAreaSqMiles > 0 ? formatSqMiles(actualAreaSqMiles) : `${drawSizeMiles}mi²`;
  const isLargeArea = actualAreaSqMiles >= 250 || drawSizeMiles === 300;

  const hasPulledData = !!user?.has_pulled_data;
  const hasDefinedMarket = user?.has_defined_market || user?.territory_zip_codes?.length > 0;
  const isPaid = precisionUsage?.paidAccess === true;
  const maxRequestedProperties = precisionUsage?.remaining || 0;
  const precisionStartBlockerCode = precisionUsage?.startBlockerCode || null;
  const precisionStartBlockerTitle = ({
    multiple_active_precision_jobs: 'Multiple Precision imports detected',
    precision_provider_outcome_unverifiable: 'Provider outcome needs review',
    precision_job_active: 'Precision import already active',
    precision_reservation_unsettled: 'Precision reservation needs reconciliation'
  })[precisionStartBlockerCode] || '';
  const precisionStartBlockerMessage = precisionStartBlockerCode
    ? precisionControlErrorMessage(precisionStartBlockerCode)
    : '';
  const enteredRequestedPropertyCount = Number(requestedPropertyCount);
  const validEnteredRequestedPropertyCount = Number.isSafeInteger(enteredRequestedPropertyCount) && enteredRequestedPropertyCount > 0
    ? enteredRequestedPropertyCount
    : null;
  const previewRequestedPropertyCount = propertyCountMode === 'max_available'
    ? Math.max(0, Number(maxRequestedProperties) || 0)
    : validEnteredRequestedPropertyCount;
  const pullCount = user?.area_pulls_count || 0;
  const maxPulls = 9999; // unlimited for testing
  const canPullAgain = pullCount < maxPulls;

  const showInitialPrompt = hasPulledData && hasDefinedMarket && mode === 'generate' && !activeRoute && !routesGenerating && !showCompare && !showRoutePanel && !drawingMode && (!drawnPolygon || drawnPolygon.length === 0);

  const startPolling = (jobId, requestToken = requestTokenRef.current) => {
    if (!jobId || routeModeRef.current !== 'precision' || !isCurrentRequest(requestToken)) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollTokenRef.current += 1;
    const pollToken = pollTokenRef.current;
    terminalPollTokenRef.current = null;
    activeJobIdRef.current = jobId;

    let pollCount = 0;
    const MAX_POLLS = 450; // ~30 minutes at slower intervals
    const pollStartTime = Date.now();
    const pollIsCurrent = () => (
      routeModeRef.current === 'precision'
      && isCurrentRequest(requestToken)
      && isCurrentPoll(pollToken, jobId)
    );

    const doPoll = async () => {
      if (!pollIsCurrent() || terminalPollTokenRef.current === pollToken) return;
      pollCount++;
      if (pollCount > MAX_POLLS) {
        if (!claimTerminalPoll(pollToken, jobId)) return;
        toast.info("Still running in the background — come back and your data will be here!");
        if (finishPollIfCurrent(pollToken, jobId) && isCurrentRequest(requestToken)) {
          setPulling(false);
        }
        return;
      }

      // After first 30s, slow polling to reduce backend rate-limit pressure.
      if (pollCount === 30 && pollIsCurrent()) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(doPoll, 5000);
      }

      try {
        const res = await base44.functions.invoke('fetchJobStatus', { job_id: jobId });
        if (routeModeRef.current !== 'precision') return;
        if (!pollIsCurrent() || terminalPollTokenRef.current === pollToken) return;
        const d = res.data;
        if (!d) return;
        const responseJobId = d.job_id ?? d.fetch_job_id ?? d.id;
        if (!responseJobId || String(responseJobId) !== String(jobId)) {
          console.warn('[TerritoryPrompt] Ignoring status response for a different or unidentified Precision job.');
          return;
        }

        const pct = d.progress_pct || 0;
        setPullPct(pct);
        targetPctRef.current = pct;
        const phase = d.phase || '';
        const diagnostics = d.diagnostics || {};
        const processorRekickRequested = diagnostics.processor_rekick_requested === true;
        const fetched = d.total_fetched || 0;
        const expected = d.total_expected || 0;
        const inserted = d.total_inserted || 0;
        setTotalExpected(expected);

        // Detect delta pull from job status (important for resume).
        if (d.is_delta_pull) setIsDeltaPull(true);

        // Track progress history for ETA calculation
        pctHistoryRef.current.push({ pct, time: Date.now() });
        // Keep last 10 samples
        if (pctHistoryRef.current.length > 10) pctHistoryRef.current.shift();

        const elapsedSec = Math.max(1, Math.round((Date.now() - pollStartTime) / 1000));
        if (pct < 100) {
          if (processorRekickRequested && fetched === 0) {
            setEtaText('Restarting import...');
          } else if (phase === 'batchdata_requesting') {
            setEtaText('Contacting property provider...');
          } else if (pct < 8 || elapsedSec < 10) {
            setEtaText('Starting import...');
          } else if (pct < 85) {
            setEtaText('Usually under 2 minutes');
          } else {
            setEtaText('Almost done');
          }
        }

        const readyCount = Math.max(d.active_count || 0, inserted + (d.total_existed || 0), inserted + (d.total_updated || 0));
        if (processorRekickRequested && fetched === 0) {
          setPullProgress('Restarting data processor...');
        } else if (phase === 'batchdata_requesting' && fetched === 0) {
          setPullProgress(expected > 0
            ? `Contacting property provider for up to ${expected.toLocaleString()} homes...`
            : 'Contacting property provider...');
        } else if (expected > 0) {
          setPullProgress(`${fetched.toLocaleString()} of ${expected.toLocaleString()} records checked • ${readyCount.toLocaleString()} ready for routes`);
        } else {
          setPullProgress(`${fetched.toLocaleString()} records checked • ${readyCount.toLocaleString()} ready for routes`);
        }

        if (d.status === 'completed') {
          if (!claimTerminalPoll(pollToken, jobId)) return;
          const canonicalCriteria = getServerPrecisionCriteria(d);
          const completedCounts = getServerPrecisionCounts(d, canonicalCriteria);
          const completedPolygon = getVerifiedServerPrecisionPolygon(d, canonicalCriteria);
          if (
            d.criteria_verified !== true ||
            !canonicalCriteria ||
            !completedCounts ||
            completedCounts.deliveredCount === null ||
            !completedPolygon
          ) {
            await refetchPrecisionUsage();
            if (!pollIsCurrent()) return;
            delete pullIntentRef.current[jobId];
            if (finishPollIfCurrent(pollToken, jobId) && isCurrentRequest(requestToken)) {
              setPulling(false);
              setEtaText('');
              setPullProgress('Import completed, but verification failed');
              setPullError({
                message: 'The import completed, but its canonical criteria, delivered count, or server polygon evidence could not be verified. Automatic route generation was stopped.',
                upgrade: false
              });
            }
            return;
          }
          // Immediately show 100% — skip animation
          setPullPct(100);
          targetPctRef.current = 100;
          setDisplayPct(100);
          setEtaText('Building routes now');
          setPullProgress('Data ready — building optimized routes...');

          const totalLoaded = completedCounts.deliveredCount;
          const requestedCount = completedCounts.effectiveCount;
          const intendedCount = completedCounts.countMode === 'fixed'
            ? completedCounts.enteredCount
            : completedCounts.effectiveCount;
          const completedUiCriteria = precisionCriteriaToUi(canonicalCriteria);
          const completedSoldMonths = completedUiCriteria.soldMonths;
          const completedOwnershipRangeMode = completedUiCriteria.ownershipRangeMode;
          const completedOwnershipRangeDays = completedOwnershipRangeMode === 'custom'
            ? normalizeOwnershipRangeDays(canonicalCriteria.ownership_range_days)
            : null;
          const shortfallMessage = buildPrecisionShortfallMessage({
            loadedCount: totalLoaded,
            requestedCount,
            intendedCount,
            diagnostics,
            soldMonths: completedSoldMonths,
            ownershipRangeMode: completedOwnershipRangeMode,
            ownershipRangeDays: completedOwnershipRangeDays,
            minHomeValue: canonicalCriteria.min_price,
            maxHomeValue: canonicalCriteria.max_price
          });
          if (shortfallMessage) {
            toast.info(shortfallMessage, { duration: 14000 });
          }
          toast.success(`${totalLoaded.toLocaleString()} properties ready. Building routes now...`, { duration: 4000 });

          // Update user status
          try {
            await base44.auth.updateMe({
              has_pulled_data: true,
              last_data_pull: new Date().toISOString()
            });
          } catch (e) {
            if (pollIsCurrent()) console.warn('Failed to update pull status', e);
          }
          if (!pollIsCurrent()) return;

          // Signal to MapToolbar that data is now available for this territory
          window.dispatchEvent(new CustomEvent('fk-territory-data-ready'));

          const completedJobStatus = {
            ...d,
            job_id: d.job_id || d.fetch_job_id || d.id || jobId,
            criteria: canonicalCriteria,
            requested_properties: completedCounts.effectiveCount,
            requested_properties_before_cap: completedCounts.enteredCount,
            delivered_count: completedCounts.deliveredCount,
            count_mode: completedCounts.countMode,
            polygon: completedPolygon,
            diagnostics: {
              ...diagnostics,
              precision_criteria: canonicalCriteria,
              requested_properties: completedCounts.effectiveCount,
              requested_properties_before_cap: completedCounts.enteredCount,
              delivered_count: completedCounts.deliveredCount,
              count_mode: completedCounts.countMode,
              ownership_range_mode: completedOwnershipRangeMode,
              ownership_range_days: ownershipRangeCriteria(completedOwnershipRangeDays),
              route_filters: canonicalCriteria.route_filters
            },
            route_bounds: canonicalCriteria.route_bounds
          };

          if (!pollIsCurrent()) return;
          if (onPullComplete) {
            setMode('generate');
            setShowRoutePanel(false);
            setShowCompare(false);
            await onPullComplete(completedSoldMonths, isPaid, completedJobStatus);
            if (routeModeRef.current !== 'precision') return;
            if (!pollIsCurrent()) return;
          } else {
            queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
            queryClient.invalidateQueries({ queryKey: ['user'] });
            setMode('generate');
            setShowRoutePanel(false);
            setShowCompare(false);
          }
          await refetchPrecisionUsage();
          if (!pollIsCurrent()) return;
          queryClient.invalidateQueries({ queryKey: ['precisionFetchJobs'] });
          delete pullIntentRef.current[jobId];
          if (finishPollIfCurrent(pollToken, jobId) && isCurrentRequest(requestToken)) {
            setPulling(false);
          }
        } else if (d.status === 'cancelled') {
          if (!claimTerminalPoll(pollToken, jobId)) return;
          setEtaText('');
          setPullProgress('Cancelled');
          await refetchPrecisionUsage();
          if (!pollIsCurrent()) return;
          await onRouteBoundsPrepared?.({ enabled: false });
          if (!pollIsCurrent()) return;
          delete pullIntentRef.current[jobId];
          if (finishPollIfCurrent(pollToken, jobId) && isCurrentRequest(requestToken)) {
            setPulling(false);
            toast.info('Data import cancelled.');
          }
        } else if (d.status === 'failed') {
          if (!claimTerminalPoll(pollToken, jobId)) return;
          await onRouteBoundsPrepared?.({ enabled: false });
          if (!pollIsCurrent()) return;
          await refetchPrecisionUsage();
          if (!pollIsCurrent()) return;
          const failedJob = {
            ...d,
            id: d.job_id || d.fetch_job_id || d.id || jobId
          };
          delete pullIntentRef.current[jobId];
          if (finishPollIfCurrent(pollToken, jobId) && isCurrentRequest(requestToken)) {
            setPulling(false);
            setRecoverableJob(failedJob);
            toast.error(d.error_message || 'Fetch job failed.');
          }
        }
      } catch (e) {
        if (!pollIsCurrent()) return;
        if (terminalPollTokenRef.current === pollToken) {
          if (finishPollIfCurrent(pollToken, jobId) && isCurrentRequest(requestToken)) {
            setPulling(false);
            setPullError({
              message: e?.message || 'The import finished, but final route preparation failed. Generate the area again.',
              upgrade: false
            });
            toast.error(e?.message || 'Final route preparation failed.');
          }
          return;
        }
        // A transient network error does not terminate the current poll owner.
        console.warn('Poll error:', e.message);
      }
    };

    // Start fast — poll every 1s for the first 30 polls, then every 5s.
    pollRef.current = setInterval(doPoll, 1000);
    // Also fire first poll immediately
    doPoll();
  };

  const handleCancelImport = async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId) {
      setPulling(false);
      return;
    }
    if (!confirm('Cancel this data import? Any data already saved will stay, but no more records will be added.')) return;
    const requestToken = beginPrecisionRequest();
    setPullProgress('Cancelling import...');
    try {
      await base44.functions.invoke('cancelFetchJob', { job_id: jobId });
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      await onRouteBoundsPrepared?.({ enabled: false });
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      setPulling(false);
      setEtaText('');
      setPullProgress('Cancelled');
      delete pullIntentRef.current[jobId];
      queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
      toast.info('Data import cancelled.');
    } catch (error) {
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      setPullProgress('Import is still running...');
      setPullError({
        message: error?.response?.data?.message || error?.message || 'Could not cancel this import. Progress tracking has resumed.',
        upgrade: false
      });
      startPolling(jobId, requestToken);
    }
  };

  const retryRecoverableJob = async () => {
    const retryFetchJobId = recoverableJob?.id || recoverableJob?.job_id || recoverableJob?.fetch_job_id;
    if (!retryFetchJobId) {
      setPullError({
        message: 'This failed import is missing its server FetchJob ID and cannot be retried automatically.',
        upgrade: false
      });
      return;
    }
    const requestToken = beginPrecisionRequest();
    const jobToRecover = recoverableJob;
    setRecoverableJob(null);
    setPulling(true);
    setPullProgress('Starting a new attempt using the verified original criteria...');
    setPullPct(0);
    setDisplayPct(0);
    targetPctRef.current = 0;
    setEtaText('Verifying original import...');
    try {
      const res = await base44.functions.invoke('fetchAreaProperties', {
        retry_fetch_job_id: retryFetchJobId
      });
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      const data = res.data || {};
      if (data.error) {
        const error = new Error(data.message || data.error);
        error.name = data.error;
        error.data = data;
        throw error;
      }
      if (!data.job_id) throw new Error('The retry did not return a new job id.');
      const canonicalCriteria = getServerPrecisionCriteria(data);
      const retryUiCriteria = precisionCriteriaToUi(canonicalCriteria);
      const retryCounts = getServerPrecisionCounts(data, canonicalCriteria);
      const verifiedPolygon = getVerifiedServerPrecisionPolygon(data, canonicalCriteria);
      if (
        data.criteria_verified !== true ||
        !canonicalCriteria ||
        !retryUiCriteria ||
        !retryCounts ||
        !verifiedPolygon
      ) {
        throw new Error('The retry response did not include a complete server-verified criteria snapshot and polygon.');
      }
      const recoveryRouteBounds = retryUiCriteria.routeBounds;
      await onRouteBoundsPrepared?.(recoveryRouteBounds);
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      pullIntentRef.current[data.job_id] = {
        polygon: verifiedPolygon,
        canonicalCriteria,
        requestedCount: retryCounts.countMode === 'fixed' ? retryCounts.enteredCount : retryCounts.effectiveCount,
        serverRequestedCount: retryCounts.effectiveCount,
        soldMonths: retryUiCriteria.soldMonths,
        ownershipRangeMode: retryUiCriteria.ownershipRangeMode,
        ownershipRangeDays: retryUiCriteria.ownershipRangeDays,
        minHomeValue: retryUiCriteria.minHomeValue,
        maxHomeValue: retryUiCriteria.maxHomeValue,
        countMode: retryCounts.countMode,
        routeFilters: retryUiCriteria.routeFilters,
        routeBounds: recoveryRouteBounds
      };
      setRequestedPropertyCount(retryUiCriteria.requestedPropertyCount);
      setPropertyCountMode(retryUiCriteria.propertyCountMode);
      setFetchMonths(retryUiCriteria.soldMonths);
      setOwnershipRangeMode(retryUiCriteria.ownershipRangeMode);
      setOwnershipRangeDays(retryUiCriteria.ownershipRangeDays);
      setMinHomeValue(retryUiCriteria.minHomeValue);
      setMaxHomeValue(retryUiCriteria.maxHomeValue);
      setRepullMode(retryUiCriteria.repullMode);
      setForceFullRefresh(retryUiCriteria.forceFullRefresh);
      setIncludeUnresolvedFollowUps(retryUiCriteria.includeUnresolvedFollowUps);
      setPrecisionRouteFilters(retryUiCriteria.routeFilters);
      setRestoredRouteBounds(recoveryRouteBounds);
      try { localStorage.setItem('fk_drawnPolygonQueried', 'true'); } catch {}
      setDrawnPolygon(verifiedPolygon, true);
      setPullProgress(data.status === 'already_running'
        ? 'Continuing the exact compatible active attempt...'
        : 'New verified attempt started...');
      setEtaText('Starting import...');
      startPolling(data.job_id, requestToken);
    } catch (error) {
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      const details = precisionFunctionErrorDetails(error);
      const message = precisionControlErrorMessage(details.code, details.message || 'Could not retry this import.');
      setPulling(false);
      setEtaText('');
      setPullProgress('Retry failed');
      setRecoverableJob(jobToRecover);
      setPullError({
        message,
        upgrade: ['paid_precision_required', 'upgrade_required'].includes(details.code)
      });
      toast.error(message);
    }
  };

  const handleFetchData = async () => {
    if (previewLoading || pulling) return;
    if (!drawnPolygon || drawnPolygon.length < 3) {
      toast.error('Draw a freehand area first.');
      return;
    }
    if (!precisionUsage || precisionUsageError || precisionUsageFetching) {
      setPullError({
        message: precisionUsageError
          ? 'Precision usage is unavailable. Retry the usage check before previewing.'
          : 'Checking your Precision allowance. Please wait a moment.',
        upgrade: false
      });
      return;
    }
    if (hasUnsettledPrecisionReservation(precisionUsage)) {
      setPullError({
        code: 'precision_reservation_unsettled',
        message: precisionControlErrorMessage('precision_reservation_unsettled'),
        upgrade: false
      });
      return;
    }
    if (propertyCountMode === 'fixed' && validEnteredRequestedPropertyCount === null) {
      setPullError({ message: 'Fixed Count must be a positive whole number.', upgrade: false });
      return;
    }
    const previewOwnershipRangeDays = ownershipRangeMode === 'custom'
      ? normalizeOwnershipRangeDays(ownershipRangeDays)
      : null;
    const previewOwnershipRangeMode = previewOwnershipRangeDays ? 'custom' : 'quick';
    const previewSoldMonths = previewOwnershipRangeDays
      ? ownershipRangeMaxToMonths(previewOwnershipRangeDays)
      : fetchMonths;
    const requestToken = beginPrecisionRequest();

    setPreviewLoading(true);
    setPreviewResult(null);

    try {
      const res = await base44.functions.invoke('previewBatchDataArea', {
        polygon: drawnPolygon,
        requested_properties: previewRequestedPropertyCount,
        count_mode: propertyCountMode,
        sandbox: true,
        sandbox_probe: true
      });
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      const d = res.data || {};
      setPreviewResult(d);

      if (d.error || d.hard_rejected) {
        toast.error(d.message || d.rejection_reason || d.error || 'Area rejected. Please redraw smaller.');
        return;
      }

      savePolygonToHistory(drawnPolygon, {
        previewed_at: new Date().toISOString(),
        criteria_status: 'criteria_unverified',
        criteria: {
          requested_properties: d.requested_properties ?? previewRequestedPropertyCount,
          count_mode: propertyCountMode,
          sold_months: previewSoldMonths,
          ownership_range_mode: previewOwnershipRangeMode,
          ownership_range_days: ownershipRangeCriteria(previewOwnershipRangeDays),
          min_price: minHomeValue ? Number(minHomeValue) : null,
          max_price: maxHomeValue ? Number(maxHomeValue) : null,
          repull_mode: selectedHistoryArea ? repullMode : 'new_area',
          force_full_refresh: selectedHistoryArea ? repullMode === 'fill_gaps' || forceFullRefresh : false,
          include_unresolved_followups: selectedHistoryArea ? includeUnresolvedFollowUps : false,
          route_filters: precisionRouteFilters,
          route_bounds: restoredRouteBounds
        }
      });
      localStorage.setItem('fk_drawnPolygonQueried', 'true');
      setDrawnPolygon(drawnPolygon, true);
      window.dispatchEvent(new CustomEvent('fk-polygon-history-updated'));
      toast.success(`Preview ready: up to ${(d.returned_property_count ?? previewRequestedPropertyCount).toLocaleString()} homes can be requested. Final count depends on sold homes in the area.`);
    } catch (e) {
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      const msg = e.response?.data?.message || e.message;
      toast.error(`Sandbox preview failed: ${msg}`);
    } finally {
      if (isCurrentRequest(requestToken)) setPreviewLoading(false);
    }
  };

  const handlePaidBatchDataPull = async (routeBounds = { enabled: false }) => {
    if (paidPullStarting || pulling) return;
    if (!drawnPolygon || drawnPolygon.length < 3) {
      toast.error('Draw a freehand area first.');
      return;
    }

    const isPreviousAreaPull = ghostAreasVisible && !!selectedHistoryArea;
    const historyDate = isPreviousAreaPull ? selectedHistoryArea?.last_pull_date || selectedHistoryArea?.date : null;
    const isMaxSinceLast = isPreviousAreaPull && repullMode === 'max_since_last';
    const effectiveOwnershipRangeDays = !isMaxSinceLast && ownershipRangeMode === 'custom'
      ? normalizeOwnershipRangeDays(ownershipRangeDays)
      : null;
    const effectiveOwnershipRangeMode = effectiveOwnershipRangeDays ? 'custom' : 'quick';
    if (!isMaxSinceLast && ownershipRangeMode === 'custom' && !effectiveOwnershipRangeDays) {
      setPullError({ message: 'Choose a valid recorded-sale window between 1 and 365 days.', upgrade: false });
      return;
    }
    const effectiveSoldMonths = isMaxSinceLast
      ? monthsSinceHistoryPull(historyDate)
      : effectiveOwnershipRangeDays
        ? ownershipRangeMaxToMonths(effectiveOwnershipRangeDays)
        : Number(fetchMonths || 12);
    const usingMaxAvailable = (isPreviousAreaPull && repullMode === 'max_since_last') || propertyCountMode === 'max_available';
    const effectiveMinPrice = minHomeValue ? Number(minHomeValue) : null;
    const effectiveMaxPrice = maxHomeValue ? Number(maxHomeValue) : null;
    const premiumRecentRange = effectiveSoldMonths <= 1;
    routeBounds = normalizeRouteBounds(routeBounds);
    const requestToken = beginPrecisionRequest();
    const finishPaidPullStart = () => {
      if (isCurrentRequest(requestToken)) setPaidPullStarting(false);
    };
    setPaidPullStarting(true);
    setPullError(null);
    let freshUsage;
    try {
      const refreshed = await refetchPrecisionUsage();
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      freshUsage = refreshed.data;
      if (!freshUsage || refreshed.error) throw refreshed.error || new Error('Usage snapshot is incomplete.');
    } catch (error) {
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      setPullError({
        message: error?.message || 'Could not verify your current Precision allowance. Please retry.',
        upgrade: false
      });
      finishPaidPullStart();
      return;
    }
    // Fail early from a fresh server snapshot for truthful UX. This is not an
    // authorization decision; startBatchDataPull repeats the check under lock.
    if (hasUnsettledPrecisionReservation(freshUsage)) {
      setPullError({
        code: 'precision_reservation_unsettled',
        message: precisionControlErrorMessage('precision_reservation_unsettled'),
        upgrade: false
      });
      finishPaidPullStart();
      return;
    }
    const freshMaxProperties = Math.max(0, Number(freshUsage.remaining) || 0);
    const fixedEnteredCount = Number(requestedPropertyCount);
    const hasPaidPrecision = freshUsage.paidAccess;
    const hasPrecisionPro = freshUsage.proAccess;

    if (!usingMaxAvailable && (!Number.isSafeInteger(fixedEnteredCount) || fixedEnteredCount <= 0)) {
      setPullError({ message: 'Fixed Count must be a positive whole number.', upgrade: false });
      finishPaidPullStart();
      return;
    }
    if (freshMaxProperties <= 0) {
      setPullError(hasPaidPrecision
        ? {
            message: 'This account has used all paid Precision properties for the current billing cycle.',
            upgrade: false
          }
          : {
            message: 'This account has already received its included 50 single-family Precision route homes. Upgrade to Precision for larger routes.',
            upgrade: true
          });
      finishPaidPullStart();
      return;
    }

    if (effectiveOwnershipRangeMode === 'custom' && !hasPrecisionPro) {
      const message = 'Custom recorded-sale ranges require a Precision Pro plan. Upgrade to target an exact recorded-sale window.';
      toast.info(message);
      setPullError({ message, upgrade: true });
      finishPaidPullStart();
      return;
    }

    if (premiumRecentRange && !hasPrecisionPro) {
      toast.info('Your date range has been updated to 3 months. Upgrade to Pro for shorter ranges.');
      setFetchMonths(3);
      finishPaidPullStart();
      return;
    }

    try {
      const pullRequest = {
        polygon: drawnPolygon,
        count_mode: usingMaxAvailable ? 'max_available' : 'fixed',
        ...(usingMaxAvailable
          ? { allowance_estimate: freshMaxProperties }
          : { requested_properties: fixedEnteredCount }),
        sold_months: effectiveSoldMonths,
        ownership_range_mode: effectiveOwnershipRangeMode,
        ...(effectiveOwnershipRangeMode === 'custom' ? {
          ownership_min_days: effectiveOwnershipRangeDays[0],
          ownership_max_days: effectiveOwnershipRangeDays[1]
        } : {}),
        min_price: effectiveMinPrice,
        max_price: effectiveMaxPrice,
        route_filters: normalizeRouteFilters(precisionRouteFilters),
        route_bounds: routeBounds,
        force_full_refresh: isPreviousAreaPull ? repullMode === 'fill_gaps' || forceFullRefresh : false,
        include_unresolved_followups: isPreviousAreaPull ? includeUnresolvedFollowUps : false,
        repull_mode: isPreviousAreaPull ? repullMode : 'new_area',
        previous_pull_date: isPreviousAreaPull ? selectedHistoryArea?.last_pull_date || selectedHistoryArea?.date || null : null
      };

      // Custom Range requires coordinated frontend + function support. Probe the
      // start function without creating a job or spending provider credits, then
      // fail closed if an older deployment would treat the maximum as a cumulative
      // lookback and accidentally include newer sales.
      if (effectiveOwnershipRangeMode === 'custom') {
        const preflight = await base44.functions.invoke('startBatchDataPull', {
          ...pullRequest,
          dry_run: true
        });
        if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
        const preflightData = preflight.data || {};
        if (preflightData.error) {
          const error = new Error(preflightData.message || preflightData.error);
          error.name = preflightData.error;
          error.data = preflightData;
          throw error;
        }
        const preflightRange = normalizeStrictOwnershipRangeDays(
          preflightData.ownership_range_days ?? {
            min: preflightData.ownership_min_days,
            max: preflightData.ownership_max_days
          }
        );
        if (
          preflightData.dry_run !== true ||
          preflightData.ownership_range_mode !== 'custom' ||
          !preflightRange ||
          preflightRange[0] !== effectiveOwnershipRangeDays[0] ||
          preflightRange[1] !== effectiveOwnershipRangeDays[1]
        ) {
          setPullError({
            message: 'Custom Range is temporarily unavailable because the deployed import function does not support both date boundaries yet. No property import was started and no provider credits were used.',
            upgrade: false
          });
          return;
        }
      }

      const res = await base44.functions.invoke('startBatchDataPull', pullRequest);
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      const data = res.data || {};
      if (data.error) {
        const isPlanGate = ['trial_required', 'paid_precision_required', 'upgrade_required'].includes(data.error);
        setPullError({
          message: precisionControlErrorMessage(data.error, data.message || data.error),
          upgrade: isPlanGate
        });
        return;
      }
      const responseCriteria = getServerPrecisionCriteria(data);
      const responseUiCriteria = precisionCriteriaToUi(responseCriteria);
      const responseCounts = getServerPrecisionCounts(data, responseCriteria);
      const verifiedPolygon = getVerifiedServerPrecisionPolygon(data, responseCriteria);
      if (
        data.criteria_verified !== true ||
        !responseCriteria ||
        !responseUiCriteria ||
        !responseCounts ||
        !verifiedPolygon
      ) {
        throw new Error('The Precision start response did not include complete server-verified criteria and polygon evidence.');
      }
      await refetchPrecisionUsage();
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      if (effectiveOwnershipRangeMode === 'custom') {
        const confirmedRange = normalizeStrictOwnershipRangeDays(
          responseCriteria.ownership_range_days
        );
        if (
          responseCriteria.ownership_range_mode !== 'custom' ||
          !confirmedRange ||
          confirmedRange[0] !== effectiveOwnershipRangeDays[0] ||
          confirmedRange[1] !== effectiveOwnershipRangeDays[1]
        ) {
          setPullError({
            message: 'The property import did not confirm the selected custom recorded-sale range. Automatic route generation was stopped so newer or older sales cannot be mixed into this route.',
            upgrade: false
          });
          return;
        }
      }
      if (data.status === 'already_running') {
        if (!data.job_id) {
          setPullError({ message: data.message || 'An import is already running, but its job id is missing.', upgrade: false });
          return;
        }
        const resumedCriteria = responseUiCriteria;
        const resumedRouteBounds = resumedCriteria.routeBounds;
        await onRouteBoundsPrepared?.(resumedRouteBounds);
        if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
        setRequestedPropertyCount(resumedCriteria.requestedPropertyCount);
        setPropertyCountMode(resumedCriteria.propertyCountMode);
        setFetchMonths(resumedCriteria.soldMonths);
        setOwnershipRangeMode(resumedCriteria.ownershipRangeMode);
        setOwnershipRangeDays(resumedCriteria.ownershipRangeDays);
        setMinHomeValue(resumedCriteria.minHomeValue);
        setMaxHomeValue(resumedCriteria.maxHomeValue);
        setRepullMode(resumedCriteria.repullMode);
        setForceFullRefresh(resumedCriteria.forceFullRefresh);
        setIncludeUnresolvedFollowUps(resumedCriteria.includeUnresolvedFollowUps);
        setPrecisionRouteFilters(resumedCriteria.routeFilters);
        setRestoredRouteBounds(resumedRouteBounds);
        pullIntentRef.current[data.job_id] = {
          polygon: verifiedPolygon,
          canonicalCriteria: responseCriteria,
          requestedCount: responseCounts.countMode === 'fixed'
            ? responseCounts.enteredCount
            : responseCounts.effectiveCount,
          serverRequestedCount: responseCounts.effectiveCount,
          countMode: resumedCriteria.propertyCountMode,
          soldMonths: resumedCriteria.soldMonths,
          ownershipRangeMode: resumedCriteria.ownershipRangeMode,
          ownershipRangeDays: resumedCriteria.ownershipRangeDays,
          minHomeValue: resumedCriteria.minHomeValue,
          maxHomeValue: resumedCriteria.maxHomeValue,
          routeFilters: resumedCriteria.routeFilters,
          routeBounds: resumedRouteBounds
        };
        try { localStorage.setItem('fk_drawnPolygonQueried', 'true'); } catch {}
        setDrawnPolygon(verifiedPolygon, true);
        setPulling(true);
        setPullPct(0);
        setDisplayPct(0);
        targetPctRef.current = 0;
        setPullProgress('Resuming the active property import...');
        setEtaText('Checking active import...');
        startPolling(data.job_id, requestToken);
        setShowPrecisionPullPanel(false);
        toast.info(data.message || 'A property import is already running. Resuming its progress.');
        return;
      }
      if (!data.job_id) {
        setPullError({
          message: 'The property import did not return a job id, so progress tracking and route generation were stopped.',
          upgrade: false
        });
        return;
      }
      const startedRequestedCount = responseCounts.effectiveCount;
      const startedRouteBounds = responseUiCriteria.routeBounds;
      await onRouteBoundsPrepared?.(startedRouteBounds);
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      setRestoredRouteBounds(startedRouteBounds);
      pullIntentRef.current[data.job_id] = {
        polygon: verifiedPolygon,
        canonicalCriteria: responseCriteria,
        requestedCount: responseCounts.countMode === 'fixed'
          ? responseCounts.enteredCount
          : responseCounts.effectiveCount,
        serverRequestedCount: startedRequestedCount,
        countMode: responseCounts.countMode,
        soldMonths: responseUiCriteria.soldMonths,
        ownershipRangeMode: responseUiCriteria.ownershipRangeMode,
        ownershipRangeDays: responseUiCriteria.ownershipRangeDays,
        minHomeValue: responseUiCriteria.minHomeValue,
        maxHomeValue: responseUiCriteria.maxHomeValue,
        routeFilters: responseUiCriteria.routeFilters,
        routeBounds: startedRouteBounds,
        repullMode: responseUiCriteria.repullMode,
        limitedByFreeHomeCap: data.limited_by_free_home_cap === true
      };
      savePolygonToHistory(verifiedPolygon, {
        last_pull_date: new Date().toISOString(),
        job_id: data.job_id,
        repull_mode: responseUiCriteria.repullMode,
        criteria_status: 'criteria_unverified',
        criteria: responseCriteria
      });
      localStorage.setItem('fk_drawnPolygonQueried', 'true');
      setDrawnPolygon(verifiedPolygon, true);
      window.dispatchEvent(new CustomEvent('fk-polygon-history-updated'));
      setPulling(true);
      setPullPct(0);
      setDisplayPct(0);
      targetPctRef.current = 0;
      setPullProgress('Starting property import...');
      setEtaText('Starting import...');
      startPolling(data.job_id, requestToken);
      setShowPrecisionPullPanel(false);
      toast.success(`Property import started for up to ${startedRequestedCount.toLocaleString()} homes. Routes will build automatically.`);
    } catch (e) {
      if (!isCurrentRequest(requestToken) || routeModeRef.current !== 'precision') return;
      const details = precisionFunctionErrorDetails(e);
      const msg = precisionControlErrorMessage(details.code, details.message);
      const isPlanGate = ['trial_required', 'paid_precision_required', 'upgrade_required'].includes(details.code);
      // Persistent in-panel error — a transient toast made blocked pulls look like a silent failure.
      setPullError({ message: msg, upgrade: isPlanGate });
    } finally {
      finishPaidPullStart();
    }
  };

  return (
    <>
            {/* Simple prompt for returning users who already have data */}
            {/* Returning user prompt — skip straight to map, no modal blocking */}

            {/* Active Drawing Controls */}
            {drawingMode &&
      <div
        className="absolute top-3 left-3 right-3 sm:top-16 sm:left-4 sm:right-auto z-[2000] animate-in slide-in-from-top-4"
        onPointerDown={stopMapTouch}
        onTouchStart={stopMapTouch}
        onMouseDown={stopMapTouch}
      >
                    <div className="bg-black/85 backdrop-blur-md border border-[#2EEB57]/30 rounded-2xl px-3 py-2 shadow-2xl flex flex-wrap items-center gap-2 max-w-[calc(100vw-1.5rem)] sm:max-w-[640px]">
                        <div className="flex items-center gap-2 shrink-0">
                            <div className="w-6 h-6 rounded-full bg-[#2EEB57]/20 flex items-center justify-center">
                                <Pencil className="w-3 h-3 text-[#39FF4A]" />
                            </div>
                            <span className="text-xs font-bold text-white whitespace-nowrap">Draw Territory</span>
                        </div>

                        <div className="flex flex-col gap-0.5 min-w-[210px] flex-1">
                            <span className="text-[10px] text-[#39FF4A] font-bold">Freehand draw mode</span>
                            <span className="text-[10px] text-gray-400 leading-tight">Hold and drag on the map to outline the area, then tap the checkmark.</span>
                        </div>

                        {draftPolygon?.length > 2 &&
          <button
            type="button"
            onPointerDown={stopMapTouch}
            onPointerUp={confirmDraftPolygon}
            onTouchStart={stopMapTouch}
            onTouchEnd={(event) => {
              if (!window.PointerEvent) confirmDraftPolygon(event);
            }}
            onMouseDown={stopMapTouch}
            onClick={stopMapTouch}
            className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-400 text-black flex items-center justify-center transition-all shrink-0 shadow-[0_0_18px_rgba(34,197,94,0.45)] touch-manipulation"
            aria-label="Confirm drawn area">
            
                                <Check className="w-5 h-5" />
                            </button>
          }

                        <button
            onClick={() => {setDrawingMode(false);setDraftPolygon([]);}}
            className="ml-auto w-7 h-7 rounded-full bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 flex items-center justify-center transition-all shrink-0">
            
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                </div>
      }

            {/* Recover incomplete fetch job */}
            {routeMode === 'precision' && !pulling && recoverableJob && mode === 'generate' &&
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                    <div className="bg-black/90 backdrop-blur-md border border-[#2EEB57]/50 rounded-xl p-4 shadow-2xl">
                        <p className="text-xs font-bold text-white mb-1">Incomplete data pull found</p>
                        <p className="text-[10px] text-gray-400 mb-3">Your import stopped before completion. Retry starts a new attempt only after the server verifies the original job, polygon, criteria, ownership, workspace, and settled reservation.</p>
                        <div className="flex gap-2">
                            <Button onClick={retryRecoverableJob} className="h-8 flex-1 text-xs bg-[#2EEB57] text-black hover:bg-[#39FF4A]">Start Verified Retry</Button>
                            <Button
              onClick={() => {
                if (recoverableJob?.id) {
                  localStorage.setItem(`fk_dismissedRecoverableJob_${recoverableJob.id}`, '1');
                }
                setRecoverableJob(null);
              }}
              variant="outline"
              className="h-8 text-xs">
              
                                Dismiss
                            </Button>
                        </div>
                    </div>
                </div>
      }

            {/* Pull Progress Bar */}
            {routeMode === 'precision' && pulling &&
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                    <div className="bg-black/90 backdrop-blur-md border border-[#2EEB57]/50 rounded-xl p-4 shadow-2xl">
                        <div className="flex items-center gap-3 mb-2">
                            <Loader2 className="w-5 h-5 text-[#2EEB57] animate-spin shrink-0" />
                            <div className="flex-1">
                                <p className="text-xs font-bold text-white">
                                    {isDeltaPull ? '⚡ Smart Refresh (Delta Sync)' : 'Importing Property Data'}
                                </p>
                                <p className="text-[10px] text-gray-400">{pullProgress}</p>
                            </div>
                            <span className="text-sm font-mono font-bold text-[#2EEB57]">{Math.round(displayPct)}%</span>
                        </div>
                        <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                            <div
              className="h-full bg-gradient-to-r from-[#2EEB57] to-[#39FF4A] rounded-full transition-all duration-300 ease-out"
              style={{ width: `${Math.max(displayPct, 2)}%` }} />
            
                        </div>
                        {etaText &&
          <p className="text-[11px] text-[#39FF4A] font-semibold mt-2 text-center">
                                ⏱ {etaText}
                            </p>
          }
                        <div className="mt-2 bg-gray-900/80 rounded-lg p-2.5 border border-gray-800">
                            <p className="text-[10px] text-gray-300 leading-relaxed text-center">
                                {isDeltaPull ?
              displayPct < 30 ?
              '⚡ Smart sync — only fetching what changed since your last pull.' :
              displayPct < 80 ?
              '🔄 Skipping unchanged records — writing only what is new.' :
              '✅ Almost done! Only fresh leads are being added.' :
              displayPct < 5 ?
              '🗺️ Mapping every door in your territory — one-time setup.' :
              displayPct < 30 ?
              '📦 Fetching property records in batches. Bigger areas take a little longer.' :
              displayPct < 70 ?
              '⚡ Deduplicating leads. Feel free to close — this keeps running in the background.' :
              displayPct < 95 ?
              '🏁 Almost there! Writing your final records to the map.' :
              '✅ Done! Your territory is ready to route.'}
                            </p>
                        </div>
                        <div className="mt-3 flex items-center justify-center">
                            <button
              onClick={handleCancelImport}
              className="px-4 py-1.5 rounded-lg text-[10px] font-bold tracking-wide border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors">
              
                                Cancel Import
                            </button>
                        </div>
                        <p className="text-[9px] text-gray-600 mt-1.5 text-center">
                            Safe to leave — data imports continue in the background unless cancelled
                        </p>
                    </div>
                </div>
      }

            {/* Drawn Polygon Controls */}
            {!drawingMode && !pulling && routeMode === 'precision' && drawnPolygon && drawnPolygon.length > 2 && mode === 'generate' &&
      <div className="absolute top-3 sm:top-16 left-3 right-3 sm:left-4 sm:right-auto z-[1001] max-w-[calc(100vw-1.5rem)] sm:max-w-none backdrop-blur-md border border-gray-800 rounded-2xl sm:rounded-full p-3 sm:px-4 sm:py-2 shadow-2xl flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 animate-in fade-in slide-in-from-top-2 overflow-visible bg-[#000000]">
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="w-2 h-2 rounded-full bg-[#2EEB57] animate-pulse shrink-0" />
                        <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                    </div>
                    <div className="flex items-center gap-2 flex-1 sm:flex-none min-w-0 sm:ml-2">
                        <Button
            disabled={paidPullStarting || pulling}
            onClick={() => setShowPrecisionPullPanel(true)}
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-4 text-[11px] font-black tracking-wide text-white shadow-none hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/15 sm:h-9 sm:flex-none min-w-0">
            
                            PULL DATA
                        </Button>
                    </div>
                    <button
          onClick={() => {
            setDrawnPolygon(null);
            setDraftPolygon([]);
            setDrawingMode(false);
            setShowPrecisionPullPanel(false);
            resetPrecisionCriteriaForNewArea();
          }}
          type="button"
          aria-label="Clear selected area"
          title="Clear selected area"
          className="absolute top-2 right-2 sm:static text-gray-400 hover:text-red-500 transition-colors p-2 sm:p-1 bg-white/5 rounded-full shrink-0 ml-auto sm:ml-0">
          
                        <Trash2 className="w-3 h-3" />
                    </button>
                    <div className="static sm:absolute sm:top-full sm:left-0 sm:right-auto mt-1 sm:mt-2 w-full sm:w-72 bg-white/5 sm:bg-black/90 border border-gray-800 rounded-xl sm:rounded-lg p-2 shadow-xl animate-in fade-in slide-in-from-top-1">
                        <p className="text-[9px] text-gray-400 leading-tight">
                            <span className="text-[#2EEB57] font-bold">Area:</span> selected freehand polygon is about <span className="text-white">{actualAreaLabel}</span>.
                            <br /><span className="text-[#39FF4A] font-bold">FirstKnock:</span> pulls up to <span className="text-white">{maxRequestedProperties}</span> properties for this account.
                        </p>
                    </div>
                </div>
      }

            {showPrecisionPullPanel && !drawingMode && !pulling && routeMode === 'precision' && drawnPolygon && drawnPolygon.length > 2 &&
      <PrecisionPullPanel
        areaLabel={actualAreaLabel}
        maxProperties={maxRequestedProperties}
        usageLoading={precisionUsageLoading || precisionUsageFetching}
        usageError={precisionUsageError}
        usageReady={!!precisionUsage && !precisionUsageError && !precisionUsageFetching}
        startAvailable={precisionUsage?.startAvailable === true}
        startBlockerTitle={precisionStartBlockerTitle}
        startBlockerMessage={precisionStartBlockerMessage}
        usageKind={precisionUsage?.kind || null}
        proAccess={precisionUsage?.proAccess === true}
        onRetryUsage={() => refetchPrecisionUsage()}
        requestedPropertyCount={requestedPropertyCount}
        setRequestedPropertyCount={setRequestedPropertyCount}
        propertyCountMode={propertyCountMode}
        setPropertyCountMode={setPropertyCountMode}
        minHomeValue={minHomeValue}
        setMinHomeValue={setMinHomeValue}
        maxHomeValue={maxHomeValue}
        setMaxHomeValue={setMaxHomeValue}
        soldMonths={fetchMonths}
        setSoldMonths={setFetchMonths}
        ownershipRangeMode={ownershipRangeMode}
        setOwnershipRangeMode={setOwnershipRangeMode}
        ownershipRangeDays={ownershipRangeDays}
        setOwnershipRangeDays={setOwnershipRangeDays}
        onClose={() => {setShowPrecisionPullPanel(false);setPullError(null);}}
        onGenerate={handlePaidBatchDataPull}
        generating={paidPullStarting}
        pullError={pullError}
        onUpgrade={() => {setShowPrecisionPullPanel(false);setPullError(null);navigate(createPageUrl('Billing') + '?plan=precision');}}
        selectedHistoryArea={ghostAreasVisible ? selectedHistoryArea : null}
        repullMode={repullMode}
        setRepullMode={setRepullMode}
        forceFullRefresh={forceFullRefresh}
        setForceFullRefresh={setForceFullRefresh}
        includeUnresolvedFollowUps={includeUnresolvedFollowUps}
        setIncludeUnresolvedFollowUps={setIncludeUnresolvedFollowUps}
        homeBase={homeBase}
        onSaveHomeBase={onSaveHomeBase}
        restoredRouteBounds={restoredRouteBounds}
        onClearArea={() => {
          setDrawnPolygon(null);
          setDraftPolygon([]);
          setDrawingMode(false);
          setShowPrecisionPullPanel(false);
          resetPrecisionCriteriaForNewArea();
        }}
      />
      }
        </>);

}
