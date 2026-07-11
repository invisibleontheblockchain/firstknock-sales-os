import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { X, Zap, Lock, Search } from 'lucide-react';
import { toast } from 'sonner';
import { createPageUrl } from '@/utils';
import PrecisionProUpgradeSheet from '@/components/map/PrecisionProUpgradeSheet';
import { isPrecisionProUser } from '@/lib/precisionAccess';
import {
  getPrecisionPreviewAvailability,
  precisionGenerationBlockedByPreview
} from '@/lib/precisionPreviewAvailability';

const PREMIUM_RECENT_RANGES = [1 / 30, 2 / 30, 0.25, 0.5, 1];
const FREE_PRECISION_HOME_LIMIT = 50;

const SOLD_OPTIONS = [
  { value: 1 / 30, label: '1 day', lockedOnFree: true },
  { value: 2 / 30, label: '2 day', lockedOnFree: true },
  { value: 0.25, label: '1 wk', lockedOnFree: true },
  { value: 0.5, label: '2 wk', lockedOnFree: true },
  { value: 1, label: '1 mo', lockedOnFree: true },
  { value: 3, label: '3 mo' },
  { value: 6, label: '6 mo' },
  { value: 12, label: '12 mo' }
];

function formatMoney(value) {
  if (!value) return '';
  return Number(value).toLocaleString();
}

function moneyInputToNumber(value) {
  const raw = String(value || '').replace(/[^0-9]/g, '');
  return raw ? Number(raw) : '';
}

function formatHistoryDate(value) {
  if (!value) return 'previous pull';
  const date = new Date(value);
  if (isNaN(date.getTime())) return 'previous pull';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMaxSinceRange(value) {
  const start = formatHistoryDate(value);
  const end = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${start} → ${end}`;
}

function formatCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString();
}

export default function PrecisionPullPanel({
  areaLabel,
  maxProperties,
  requestedPropertyCount,
  setRequestedPropertyCount,
  propertyCountMode = 'fixed',
  setPropertyCountMode,
  minHomeValue,
  setMinHomeValue,
  minimumHomeValueFloor = 100000,
  maxHomeValue,
  setMaxHomeValue,
  soldMonths,
  setSoldMonths,
  onClose,
  onPreview,
  previewing,
  previewResult,
  onGenerate,
  generating,
  pullError,
  onUpgrade,
  onClearArea,
  user,
  selectedHistoryArea,
  repullMode = 'fill_gaps',
  setRepullMode,
  forceFullRefresh,
  setForceFullRefresh,
  includeUnresolvedFollowUps = true,
  setIncludeUnresolvedFollowUps,
  savedRouteHomeCount = 0
}) {
  const navigate = useNavigate();
  const [hoveredLockedOption, setHoveredLockedOption] = useState(null);
  const [showUpgradeSheet, setShowUpgradeSheet] = useState(false);
  const hasShownFallbackToast = useRef(false);
  const isProPlan = isPrecisionProUser(user);
  const selectedSoldMonths = Number(soldMonths || 12);
  const previewAvailability = getPrecisionPreviewAvailability(previewResult);
  const providerCandidateCount = previewAvailability.count;
  const hasProviderCount = previewAvailability.hasCount;
  const requiresShortWindowPreflight = !selectedHistoryArea && selectedSoldMonths < 0.5;
  const zeroCandidatePreview = !selectedHistoryArea && previewAvailability.definitiveZero;
  const generationBlockedByAvailability = precisionGenerationBlockedByPreview(previewResult, {
    selectedHistoryArea: !!selectedHistoryArea,
    requiresShortWindowPreflight
  });

  const goToUpgrade = () => navigate(createPageUrl('Billing') + '?plan=precision');
  const historyCriteria = selectedHistoryArea?.criteria || {};
  const historyDate = selectedHistoryArea?.last_pull_date || selectedHistoryArea?.date;

  // Max Available is the default — keep the count input synced to the plan max.
  useEffect(() => {
    if (propertyCountMode === 'max_available' && Number(requestedPropertyCount) !== Number(maxProperties)) {
      setRequestedPropertyCount(maxProperties);
    }
  }, [propertyCountMode, maxProperties, requestedPropertyCount, setRequestedPropertyCount]);

  useEffect(() => {
    if (!isProPlan && PREMIUM_RECENT_RANGES.includes(Number(soldMonths))) {
      setSoldMonths(3);
      if (!hasShownFallbackToast.current) {
        hasShownFallbackToast.current = true;
        toast.info('Your date range has been updated to 3 months. Upgrade to Pro for shorter ranges.');
      }
    }
  }, [isProPlan, soldMonths, setSoldMonths]);

  return (
    <>
    <div className="fixed inset-0 z-[2400] flex items-start sm:items-center justify-center overflow-y-auto bg-black/70 backdrop-blur-sm px-3 pb-[calc(env(safe-area-inset-bottom)+5rem)] pt-[calc(env(safe-area-inset-top)+5rem)] sm:p-6">
      <div className="flex max-h-[calc(100dvh-env(safe-area-inset-top)-6rem)] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-[#2EEB57]/25 bg-[#070707] shadow-2xl animate-in slide-in-from-bottom-4 sm:zoom-in-95">
        <div className="flex items-start justify-between gap-3 p-4 sm:p-5 border-b border-white/10 shrink-0">
          <div>
            <p className="text-[10px] font-bold tracking-[0.25em] text-[#39FF4A] uppercase">{selectedHistoryArea ? 'Ghost Builder' : 'Precision Generate'}</p>
            <h2 className="text-xl font-extrabold text-white mt-1">{selectedHistoryArea ? 'Refresh previous area' : 'Build your route'}</h2>
            <p className="text-xs text-gray-400 mt-1">Area selected: <span className="text-white font-bold">{areaLabel}</span></p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 sm:space-y-5">
          {selectedHistoryArea && (
            <div className="rounded-2xl border border-[#2EEB57]/25 bg-[#2EEB57]/[0.06] p-3 space-y-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#39FF4A]">Previous area pull</p>
                <p className="text-[11px] text-gray-400">Last pulled {formatHistoryDate(historyDate)}. Choose the ghost-mode refresh type.</p>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setRepullMode?.('fill_gaps');
                    setForceFullRefresh?.(true);
                    if (historyCriteria.requested_properties) setRequestedPropertyCount(historyCriteria.requested_properties);
                    if (historyCriteria.sold_months) setSoldMonths(historyCriteria.sold_months);
                    if (historyCriteria.min_price !== undefined && historyCriteria.min_price !== null) setMinHomeValue(historyCriteria.min_price);
                    if (historyCriteria.max_price !== undefined && historyCriteria.max_price !== null) setMaxHomeValue(historyCriteria.max_price || '');
                  }}
                  className={`rounded-xl px-2 py-2 text-[9px] font-black transition-all ${repullMode === 'fill_gaps' || forceFullRefresh ? 'bg-[#2EEB57] text-black' : 'bg-white/5 text-gray-300 border border-white/10'}`}>
                  Fill Gaps
                </button>
                <button
                  type="button"
                  onClick={() => { setRepullMode?.('max_since_last'); setForceFullRefresh?.(false); setRequestedPropertyCount(maxProperties); }}
                  className={`rounded-xl px-2 py-2 text-[9px] font-black transition-all ${repullMode === 'max_since_last' ? 'bg-[#2EEB57] text-black' : 'bg-white/5 text-gray-300 border border-white/10'}`}>
                  Max Since Last
                </button>
              </div>
              {repullMode === 'max_since_last' ? (
                <p className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[11px] leading-snug text-gray-300">
                  This sends a sold date window from <span className="font-bold text-white">{formatMaxSinceRange(historyDate)}</span> depending on the search criteria. It will be unique for each previous area.
                </p>
              ) : (
                <label className="flex items-start gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[11px] leading-snug text-gray-300">
                  <input
                    type="checkbox"
                    checked={includeUnresolvedFollowUps}
                    onChange={(event) => setIncludeUnresolvedFollowUps?.(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-white/20 accent-[#2EEB57]"
                  />
                  <span>When routing this refreshed area, include unresolved follow-ups like Not Home, Callback, DM Not Home, or other non-final decisions.</span>
                </label>
              )}
            </div>
          )}

          {!isProPlan && (
            <div className="rounded-2xl border border-yellow-400/25 bg-yellow-400/[0.08] p-3">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-yellow-300">
                Free Precision limit
              </p>
              <p className="mt-1 text-[11px] leading-snug text-yellow-100/90">
                Free accounts can generate up to {FREE_PRECISION_HOME_LIMIT} total single-family Precision route homes. This account has {formatCount(Math.max(0, FREE_PRECISION_HOME_LIMIT - Number(savedRouteHomeCount || 0)))} remaining for included generation.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Property count</label>
                <p className="text-[10px] text-gray-600">Choose a fixed cap or pull every match available for your plan.</p>
              </div>
              <input
                type="number"
                min="1"
                max={maxProperties}
                value={requestedPropertyCount}
                onChange={(e) => {
                  setPropertyCountMode?.('fixed');
                  const value = e.target.value;
                  if (value === '') return setRequestedPropertyCount('');
                  setRequestedPropertyCount(Math.min(Number(value) || 1, maxProperties));
                }}
                onBlur={() => setRequestedPropertyCount(Math.max(1, Math.min(Number(requestedPropertyCount) || 1, maxProperties)))}
                className="w-24 h-10 rounded-lg bg-black/40 border border-white/10 px-3 text-white text-sm outline-none focus:border-[#2EEB57]"
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5">
              <button
                type="button"
                onClick={() => {
                  setPropertyCountMode?.('max_available');
                  setRequestedPropertyCount(maxProperties);
                }}
                className={`rounded-xl px-3 py-2 text-[10px] font-black transition-all ${propertyCountMode === 'max_available' ? 'bg-[#2EEB57] text-black' : 'text-[#39FF4A] hover:bg-[#2EEB57]/10'}`}
              >
                Max Available
              </button>
              <button
                type="button"
                onClick={() => setPropertyCountMode?.('fixed')}
                className={`rounded-xl px-3 py-2 text-[10px] font-black transition-all ${propertyCountMode === 'fixed' ? 'bg-white text-black' : 'text-gray-400 hover:text-white'}`}
              >
                Fixed Count
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400">Home value range</label>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                <input
                  inputMode="numeric"
                  placeholder="Min"
                  value={formatMoney(minHomeValue)}
                  onChange={(e) => setMinHomeValue(moneyInputToNumber(e.target.value))}
                  onBlur={() => {
                    const parsed = Number(minHomeValue);
                    setMinHomeValue(Number.isFinite(parsed) && parsed > minimumHomeValueFloor ? parsed : minimumHomeValueFloor);
                  }}
                  className="w-full h-12 rounded-xl bg-white/5 border border-white/10 pl-7 pr-3 text-white text-base outline-none focus:border-[#2EEB57]"
                />
              </div>
              <span className="text-gray-600 text-xs font-bold">to</span>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                <input
                  inputMode="numeric"
                  placeholder="Max"
                  value={formatMoney(maxHomeValue)}
                  onChange={(e) => setMaxHomeValue(moneyInputToNumber(e.target.value))}
                  className="w-full h-12 rounded-xl bg-white/5 border border-white/10 pl-7 pr-3 text-white text-base outline-none focus:border-[#2EEB57]"
                />
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-gray-500">
              Precision routes require a returned estimated home value of at least ${formatMoney(minimumHomeValueFloor)}. You can raise this minimum, but it cannot be disabled.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400">{selectedHistoryArea && repullMode === 'max_since_last' ? 'Sold-date window' : 'Homes sold in the last'}</label>
            {selectedHistoryArea && repullMode === 'max_since_last' ? (
              <div className="rounded-2xl border border-[#2EEB57]/25 bg-[#2EEB57]/[0.06] px-3 py-3 text-sm font-extrabold text-white">
                {formatMaxSinceRange(historyDate)}
                <p className="mt-1 text-[10px] font-medium text-gray-400">The 12-month selector is bypassed for Max Since Last.</p>
              </div>
            ) : (
            <div className="grid grid-cols-4 gap-1.5">
              {SOLD_OPTIONS.map(option => {
                const isLocked = !isProPlan && option.lockedOnFree;
                const isActive = Number(soldMonths || 12) === option.value;

                return (
                  <div
                    key={option.value}
                    className="relative"
                    onMouseEnter={() => isLocked && setHoveredLockedOption(option.value)}
                    onMouseLeave={() => setHoveredLockedOption(null)}
                  >
                    <button
                      type="button"
                      aria-disabled={isLocked}
                      onClick={() => {
                        if (isLocked) {
                          setShowUpgradeSheet(true);
                          return;
                        }
                        setSoldMonths(option.value);
                      }}
                      className={`h-11 w-full rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-1 ${
                        isLocked
                          ? 'bg-white/[0.03] text-gray-500 border border-white/[0.06] cursor-not-allowed grayscale opacity-50'
                          : isActive
                            ? 'bg-[#2EEB57] text-black shadow-lg'
                            : 'bg-white/5 text-gray-400 border border-white/10 hover:text-white'
                      }`}
                    >
                      {isLocked && <Lock className="w-3 h-3" />}
                      {option.label}
                      {isLocked && <span className="ml-0.5 rounded bg-[#2EEB57]/15 px-1 py-0.5 text-[8px] font-black text-[#39FF4A]">Pro</span>}
                    </button>

                    {isLocked && hoveredLockedOption === option.value && (
                      <div className="hidden sm:block absolute bottom-full left-1/2 z-[2700] mb-2 w-64 -translate-x-1/2 rounded-xl border border-[#2EEB57]/30 bg-black p-3 text-center shadow-2xl">
                        <p className="text-xs font-semibold text-white">Unlock 1 day, 2 day, 1 week, 2 week, and 1 month ranges with Pro</p>
                        <button
                          type="button"
                          onClick={goToUpgrade}
                          className="mt-2 h-8 rounded-lg bg-[#2EEB57] px-4 text-xs font-extrabold text-black hover:bg-[#39FF4A]"
                        >
                          Upgrade
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
            {!isProPlan && !(selectedHistoryArea && repullMode === 'max_since_last') && (
              <p className="text-[10px] text-gray-600 leading-tight">
                1 day, 2 day, 1 week, 2 week, and 1 month are available on Pro. Your current free range starts at 3 months.
              </p>
            )}
            {isProPlan && !selectedHistoryArea && selectedSoldMonths <= 0.5 && (
              <div className={`rounded-xl border px-3 py-2 text-[10px] leading-snug ${
                zeroCandidatePreview
                  ? 'border-amber-400/35 bg-amber-400/[0.08] text-amber-100'
                  : 'border-white/10 bg-white/[0.03] text-gray-400'
              }`}>
                {zeroCandidatePreview
                  ? 'No provider candidates were found for this date range. Broaden the window before generating.'
                  : previewAvailability.partial
                    ? 'One provider date-predicate count is unavailable. The displayed count is only a partial lower bound, so Generate remains available for the full Intel/Sale union.'
                  : requiresShortWindowPreflight && !previewAvailability.hasSuccessfulPredicate
                    ? 'Short-window inventory is often sparse. Check Count is required before generating a 1-day, 2-day, or 1-week route.'
                    : 'Short-window availability varies by market. This is a lower-bound count after BatchData applied the recent-sale, R2, $100k value, and not-Active/Pending predicates; the paid pull computes the de-duplicated Intel/Sale union.'}
              </div>
            )}
          </div>

        </div>

        <div className="shrink-0 p-4 sm:p-5 border-t border-white/10 bg-black">
          {pullError && (
            <div className="mb-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3">
              <p className="text-xs font-bold text-red-300">Route size needs an upgrade</p>
              <p className="mt-1 text-[11px] leading-snug text-red-200/90">{pullError.message}</p>
              {pullError.upgrade && (
                <button
                  type="button"
                  onClick={onUpgrade}
                  className="mt-2 h-8 rounded-lg bg-[#2EEB57] px-4 text-xs font-extrabold text-black hover:bg-[#39FF4A]">
                  View Plans
                </button>
              )}
            </div>
          )}
          {previewResult && (
            <div className={`mb-3 rounded-xl border p-3 ${previewResult.count_probe?.ok === false || previewAvailability.partial ? 'border-amber-500/40 bg-amber-500/10' : 'border-[#2EEB57]/30 bg-[#2EEB57]/[0.07]'}`}>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#39FF4A]">Live area availability</p>
              {previewAvailability.partial ? (
                <p className="mt-1 text-xs text-amber-200">
                  BatchData returned a partial lower bound{hasProviderCount ? ` of ${formatCount(providerCandidateCount)}` : ''}. One of Intel/Sale is still unknown, so this is not an authoritative zero and Generate remains available.
                </p>
              ) : previewResult.provider_candidate_count !== null && previewResult.provider_candidate_count !== undefined && previewResult.provider_candidate_count !== '' && Number.isFinite(Number(previewResult.provider_candidate_count)) ? (
                <p className="mt-1 text-xs text-white">
                  At least <span className="font-extrabold">{formatCount(previewResult.provider_candidate_count)}</span> qualified provider candidates are in this exact polygon after the R2, value, and listing predicates. Up to <span className="font-extrabold">{formatCount(previewResult.returned_property_count)}</span> can be requested under the account cap; the paid pull computes the exact de-duplicated Intel/Sale union.
                </p>
              ) : (
                <p className="mt-1 text-xs text-amber-200">{previewResult.count_probe?.error || previewResult.message || 'Provider count unavailable.'}</p>
              )}
              <p className="mt-1 text-[10px] text-gray-400">
                {previewResult.count_probe?.cache_hit
                  ? 'Count served from the five-minute cache; no new BatchData request.'
                  : previewResult.count_probe?.coalesced_request
                    ? 'Count shared an in-flight BatchData request; no duplicate request was sent from this server instance.'
                  : `Count-only check made ${formatCount(previewResult.count_probe_requests)} BatchData API request.`}
                {' '}Credit billing for count-only requests is unverified; confirm it in the BatchData dashboard. Duplicate, saved-route, contradiction, and cooldown gates can reduce the route after the exact union is pulled.
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              disabled={previewing || generating}
              onClick={onPreview}
              className="h-12 rounded-xl border-[#2EEB57]/40 bg-transparent text-[#39FF4A] hover:bg-[#2EEB57]/10 hover:text-[#39FF4A] font-extrabold tracking-wide"
            >
              <Search className="w-4 h-4 mr-2" /> {previewing ? 'CHECKING...' : 'CHECK COUNT'}
            </Button>
            <Button
              disabled={generating || previewing || generationBlockedByAvailability}
              onClick={onGenerate}
              className="h-12 rounded-xl bg-[#2EEB57] hover:bg-[#39FF4A] text-black font-extrabold tracking-wide"
            >
              {generating
                ? 'GENERATING...'
                : generationBlockedByAvailability
                  ? <><Search className="w-4 h-4 mr-2" /> {zeroCandidatePreview ? 'BROADEN DATE RANGE' : 'CHECK COUNT FIRST'}</>
                  : <><Zap className="w-4 h-4 mr-2" /> {selectedHistoryArea ? 'REFRESH AREA' : 'GENERATE'}</>}
            </Button>
          </div>
          <p className="text-[10px] text-gray-500 text-center mt-2">Pulls newly sold homes in your selected range, then prepares them for optimized routing.</p>
        </div>
      </div>
    </div>
    {showUpgradeSheet && (
      <PrecisionProUpgradeSheet
        onClose={() => setShowUpgradeSheet(false)}
        onUpgrade={goToUpgrade}
      />
    )}
    </>
  );
}
