import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Pencil, Check, X, Loader2, Lock, MapPin } from 'lucide-react';

const LOOKBACK_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
];

export default function FindOverlay({
  phase,
  lookbackDays,
  onLookbackChange,
  onSearch,
  searching,
  searchError,
  searchedLabel,
  pointCount,
  estimate,
  onStartDraw,
  onFinishDraw,
  onCancelDraw,
  onReset,
}) {
  const [query, setQuery] = useState('');

  const submitSearch = (e) => {
    e.preventDefault();
    if (query.trim() && !searching) onSearch(query.trim());
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-white/10 bg-black/85 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl">
        {/* Brand */}
        <div className="mb-3 flex items-center gap-2">
          <img
            src="https://media.base44.com/images/public/695eb764b077190880be21de/147abd69b_image.png"
            alt="FirstKnock"
            className="h-8 w-8 rounded-lg border border-white/10 object-cover"
          />
          <span className="text-sm font-extrabold tracking-tight text-white">FirstKnock</span>
          <Link to="/login" className="ml-auto text-[11px] font-bold text-white/50 transition-colors hover:text-white">
            Sign in
          </Link>
        </div>

        {phase === 'results' ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-[#2EEB57]/30 bg-[#2EEB57]/10 p-3 text-center">
              <p className="text-3xl font-black text-[#39FF4A]">{estimate}</p>
              <p className="mt-0.5 text-[12px] font-semibold text-white">
                estimated recent homeowners in this territory
              </p>
              <p className="mt-1 text-[10px] font-medium text-white/45">
                Last {LOOKBACK_OPTIONS.find((o) => o.days === lookbackDays)?.label || `${lookbackDays} days`}{searchedLabel ? ` · ${searchedLabel}` : ''}
              </p>
            </div>
            <Link
              to="/register?from=find"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2EEB57] text-sm font-extrabold text-black shadow-[0_8px_28px_rgba(46,235,87,0.35)] transition-all hover:bg-[#39FF4A]"
            >
              <Lock className="h-4 w-4" />
              Unlock homeowners &amp; generate route →
            </Link>
            <button
              onClick={onReset}
              className="w-full rounded-xl border border-white/10 py-2 text-[11px] font-bold text-white/60 transition-colors hover:text-white"
            >
              Draw another area
            </button>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-extrabold leading-tight text-white">
              Find new homeowners before your competition does.
            </h1>
            <p className="mt-1 text-[12px] leading-snug text-white/55">
              Draw an area to see recent move-in opportunities in your territory.
            </p>

            {/* Search */}
            <form onSubmit={submitSearch} className="mt-3 flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search a city or address"
                  className="h-11 w-full rounded-xl border border-white/15 bg-white/[0.05] pl-9 pr-3 text-sm text-white placeholder-white/35 outline-none transition-colors focus:border-[#2EEB57]/60"
                />
              </div>
              <button
                type="submit"
                disabled={searching || !query.trim()}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#2EEB57]/30 bg-[#2EEB57]/10 text-[#39FF4A] transition-colors hover:bg-[#2EEB57] hover:text-black disabled:opacity-40"
                aria-label="Search"
              >
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
              </button>
            </form>
            {searchError && <p className="mt-1.5 text-[11px] font-semibold text-red-400">{searchError}</p>}

            {/* Lookback */}
            <div className="mt-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">Lookback period</p>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {LOOKBACK_OPTIONS.map((option) => (
                  <button
                    key={option.days}
                    onClick={() => onLookbackChange(option.days)}
                    className={`h-9 rounded-xl border text-[11px] font-extrabold transition-all ${
                      lookbackDays === option.days
                        ? 'border-[#2EEB57]/60 bg-[#2EEB57]/15 text-[#39FF4A]'
                        : 'border-white/10 bg-white/[0.04] text-white/55 hover:text-white'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Draw controls */}
            {phase === 'drawing' ? (
              <div className="mt-3 space-y-2">
                <p className="rounded-lg border border-[#2EEB57]/25 bg-[#2EEB57]/5 px-3 py-2 text-center text-[11px] font-semibold text-[#86efac]">
                  Tap the map to outline your territory
                  {pointCount > 0 && <span className="text-white/45"> · {pointCount} point{pointCount === 1 ? '' : 's'}</span>}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={onFinishDraw}
                    disabled={pointCount < 3}
                    className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-[#2EEB57] text-[12px] font-extrabold text-black transition-all hover:bg-[#39FF4A] disabled:opacity-40"
                  >
                    <Check className="h-4 w-4" /> Finish area
                  </button>
                  <button
                    onClick={onCancelDraw}
                    className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-white/15 text-[12px] font-bold text-white/60 transition-colors hover:text-white"
                  >
                    <X className="h-4 w-4" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={onStartDraw}
                className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2EEB57] text-sm font-extrabold text-black shadow-[0_8px_28px_rgba(46,235,87,0.35)] transition-all hover:bg-[#39FF4A]"
              >
                <Pencil className="h-4 w-4" />
                Draw Territory
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}