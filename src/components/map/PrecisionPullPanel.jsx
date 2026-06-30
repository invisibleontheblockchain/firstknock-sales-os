import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { X, Zap, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { createPageUrl } from '@/utils';
import PrecisionProUpgradeSheet from '@/components/map/PrecisionProUpgradeSheet';

const SOLD_OPTIONS = [
  { value: 2 / 30, label: '2 day', lockedOnFree: true },
  { value: 0.25, label: '1 wk', lockedOnFree: true },
  { value: 0.5, label: '2 wk', lockedOnFree: true },
  { value: 1, label: '1 mo', lockedOnFree: true },
  { value: 3, label: '3 mo' },
  { value: 6, label: '6 mo' },
  { value: 9, label: '9 mo' },
  { value: 12, label: '12 mo' }
];

function isPrecisionProUser(user) {
  const tier = String(user?.subscription_tier || '').toLowerCase();
  const status = String(user?.subscription_status || '').toLowerCase();
  if (user?.is_owner || user?.role === 'admin') return true;
  return ['active', 'trialing'].includes(status) && ['pro', 'precision'].includes(tier);
}

function formatMoney(value) {
  if (!value) return '';
  return Number(value).toLocaleString();
}

function moneyInputToNumber(value) {
  const raw = String(value || '').replace(/[^0-9]/g, '');
  return raw ? Number(raw) : '';
}

export default function PrecisionPullPanel({
  areaLabel,
  maxProperties,
  requestedPropertyCount,
  setRequestedPropertyCount,
  minHomeValue,
  setMinHomeValue,
  maxHomeValue,
  setMaxHomeValue,
  soldMonths,
  setSoldMonths,
  onClose,
  onGenerate,
  generating,
  onClearArea,
  user
}) {
  const navigate = useNavigate();
  const [hoveredLockedOption, setHoveredLockedOption] = useState(null);
  const [showUpgradeSheet, setShowUpgradeSheet] = useState(false);
  const hasShownFallbackToast = useRef(false);
  const isProPlan = isPrecisionProUser(user);

  const goToUpgrade = () => navigate(createPageUrl('Billing') + '?plan=precision');

  useEffect(() => {
    if (!isProPlan && [2 / 30, 0.25, 0.5, 1].includes(Number(soldMonths))) {
      setSoldMonths(3);
      if (!hasShownFallbackToast.current) {
        hasShownFallbackToast.current = true;
        toast.info('Your date range has been updated to 3 months. Upgrade to Pro for shorter ranges.');
      }
    }
  }, [isProPlan, soldMonths, setSoldMonths]);

  return (
    <>
    <div className="fixed inset-0 z-[2400] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6">
      <div className="w-full max-w-md rounded-3xl border border-[#2EEB57]/25 bg-[#070707] shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 sm:zoom-in-95">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-white/10">
          <div>
            <p className="text-[10px] font-bold tracking-[0.25em] text-[#39FF4A] uppercase">Precision Generate</p>
            <h2 className="text-xl font-extrabold text-white mt-1">Build your route</h2>
            <p className="text-xs text-gray-400 mt-1">Area selected: <span className="text-white font-bold">{areaLabel}</span></p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Property count</label>
                <p className="text-[10px] text-gray-600">Over 50 requires an upgraded account.</p>
              </div>
              <input
                type="number"
                min="1"
                max={maxProperties}
                value={requestedPropertyCount}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === '') return setRequestedPropertyCount('');
                  setRequestedPropertyCount(Math.min(Number(value) || 1, maxProperties));
                }}
                onBlur={() => setRequestedPropertyCount(Math.max(1, Math.min(Number(requestedPropertyCount) || 1, maxProperties)))}
                className="w-24 h-10 rounded-lg bg-black/40 border border-white/10 px-3 text-white text-sm outline-none focus:border-[#2EEB57]"
              />
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
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400">Homes sold in the last</label>
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
                        <p className="text-xs font-semibold text-white">Unlock shorter date ranges with a Pro plan</p>
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
            {!isProPlan && (
              <p className="text-[10px] text-gray-600 leading-tight">
                Shorter ranges are available on Pro. Your current free range starts at 3 months.
              </p>
            )}
          </div>

        </div>

        <div className="p-5 border-t border-white/10 bg-black">
          <Button
            disabled={generating}
            onClick={onGenerate}
            className="w-full h-12 rounded-xl bg-[#2EEB57] hover:bg-[#39FF4A] text-black font-extrabold tracking-wide"
          >
            {generating ? 'GENERATING...' : <><Zap className="w-4 h-4 mr-2" /> GENERATE</>}
          </Button>
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