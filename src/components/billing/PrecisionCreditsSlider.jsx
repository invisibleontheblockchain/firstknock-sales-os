import React from 'react';

export default function PrecisionCreditsSlider({ value, onChange, disabled = false, actionLabel, onAction, loading = false }) {
  const extraProperties = Math.max(0, value - 1000);
  const extraBlocks = extraProperties / 1000;
  const addOnPrice = extraBlocks * 49;

  return (
    <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/[0.06] p-4 text-left">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-white">Monthly Precision usage</p>
          <p className="mt-1 text-xs text-gray-400">Unused paid credits roll over while your $99 plan stays paid.</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-extrabold text-yellow-400">{value.toLocaleString()}</p>
          <p className="text-[10px] uppercase tracking-wider text-gray-500">properties</p>
        </div>
      </div>
      <input
        type="range"
        min="1000"
        max="50000"
        step="1000"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={disabled}
        className="mt-4 w-full accent-yellow-500 disabled:opacity-40"
        aria-label="Monthly Precision properties"
      />
      <div className="mt-2 flex justify-between text-[10px] text-gray-500"><span>1,000</span><span>50,000</span></div>
      <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
        <span className="text-gray-400">{extraBlocks.toLocaleString()} extra {extraBlocks === 1 ? 'block' : 'blocks'} at $49 per 1,000</span>
        <span className="font-bold text-white">${(99 + addOnPrice).toFixed(2)}/mo</span>
      </div>
      {onAction && (
        <button type="button" onClick={onAction} disabled={disabled || loading} className="mt-3 h-10 w-full rounded-lg bg-yellow-500 font-bold text-black hover:bg-yellow-400 disabled:opacity-50">
          {loading ? 'UPDATING…' : actionLabel}
        </button>
      )}
    </div>
  );
}