import React from 'react';
import { Button } from '@/components/ui/button';
import { X, Zap } from 'lucide-react';

const SOLD_OPTIONS = [1, 3, 6, 9, 12];

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
  onClearArea
}) {
  return (
    <div className="fixed inset-0 z-[2400] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6">
      <div className="w-full max-w-md rounded-3xl border border-yellow-500/25 bg-[#070707] shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 sm:zoom-in-95">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-white/10">
          <div>
            <p className="text-[10px] font-bold tracking-[0.25em] text-yellow-400 uppercase">Precision Generate</p>
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
                className="w-24 h-10 rounded-lg bg-black/40 border border-white/10 px-3 text-white text-sm outline-none focus:border-yellow-500"
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
                  className="w-full h-12 rounded-xl bg-white/5 border border-white/10 pl-7 pr-3 text-white text-base outline-none focus:border-yellow-500"
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
                  className="w-full h-12 rounded-xl bg-white/5 border border-white/10 pl-7 pr-3 text-white text-base outline-none focus:border-yellow-500"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400">Homes sold in the last</label>
            <div className="grid grid-cols-5 gap-1.5">
              {SOLD_OPTIONS.map(months => (
                <button
                  key={months}
                  onClick={() => setSoldMonths(months)}
                  className={`h-11 rounded-xl text-xs font-extrabold transition-all ${Number(soldMonths || 12) === months ? 'bg-yellow-500 text-black shadow-lg' : 'bg-white/5 text-gray-400 border border-white/10 hover:text-white'}`}
                >
                  {months}mo
                </button>
              ))}
            </div>
          </div>

          <button onClick={onClearArea} className="text-[11px] font-bold text-red-300 hover:text-red-200">Clear drawn area</button>
        </div>

        <div className="p-5 border-t border-white/10 bg-black">
          <Button
            disabled={generating}
            onClick={onGenerate}
            className="w-full h-12 rounded-xl bg-yellow-500 hover:bg-yellow-400 text-black font-extrabold tracking-wide"
          >
            {generating ? 'GENERATING...' : <><Zap className="w-4 h-4 mr-2" /> GENERATE</>}
          </Button>
          <p className="text-[10px] text-gray-500 text-center mt-2">Pulls newly sold homes in your selected range, then prepares them for optimized routing.</p>
        </div>
      </div>
    </div>
  );
}