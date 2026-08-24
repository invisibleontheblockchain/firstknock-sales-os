import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, X, Navigation } from 'lucide-react';
import FindSearchField from '@/components/find/FindSearchField';

const LOOKBACK_OPTIONS = [
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
];

function BrandRow() {
  return (
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
  );
}

export default function FindOverlay({
  phase,
  lookbackDays,
  onLookbackChange,
  onSelectPlace,
  searchedLabel,
  pointCount,
  estimate,
  onStartDraw,
  onCancelDraw,
  onReset,
}) {
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);

  // While drawing the panel collapses to a slim bar so the map stays visible.
  if (phase === 'drawing') {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full border border-[#2EEB57]/30 bg-black/85 px-4 py-2.5 shadow-[0_16px_50px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          <Pencil className="h-4 w-4 shrink-0 text-[#39FF4A]" />
          <span className="flex-1 text-[11px] font-semibold leading-tight text-white">
            {pointCount > 0 ? 'Release to close your territory' : 'Press and drag on the map to trace your territory'}
          </span>
          <button
            onClick={onCancelDraw}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/60 transition-colors hover:text-white"
            aria-label="Cancel drawing"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-white/10 bg-black/85 p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl">
        <BrandRow />

        {phase === 'results' ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-[#2EEB57]/30 bg-[#2EEB57]/10 p-3 text-center">
              <p className="text-3xl font-black text-[#39FF4A]">{estimate}</p>
              <p className="mt-0.5 text-[12px] font-semibold text-white">
                estimated recent homeowners in this territory
              </p>
              <p className="mt-1 text-[10px] font-medium text-white/45">
                Last {LOOKBACK_OPTIONS.find((o) => o.days === lookbackDays)?.label || `${lookbackDays} days`}
                {searchedLabel ? ` · ${searchedLabel}` : ''}
              </p>
            </div>

            {showLoginPrompt ? (
              <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                <p className="text-[12px] font-semibold leading-snug text-white">
                  Create your free account to generate this route and unlock homeowner details.
                </p>
                <Link
                  to="/register?from=find"
                  className="flex h-11 w-full items-center justify-center rounded-xl bg-[#2EEB57] text-[13px] font-extrabold text-black transition-all hover:bg-[#39FF4A]"
                >
                  Create free account
                </Link>
                <Link
                  to="/login"
                  className="flex h-10 w-full items-center justify-center rounded-xl border border-white/15 text-[12px] font-bold text-white/70 transition-colors hover:text-white"
                >
                  I already have an account
                </Link>
              </div>
            ) : (
              <button
                onClick={() => setShowLoginPrompt(true)}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2EEB57] text-sm font-extrabold text-black shadow-[0_8px_28px_rgba(46,235,87,0.35)] transition-all hover:bg-[#39FF4A]"
              >
                <Navigation className="h-4 w-4" />
                Generate Route
              </button>
            )}

            <button
              onClick={() => { setShowLoginPrompt(false); onReset(); }}
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

            <FindSearchField onSelect={onSelectPlace} />

            <div className="mt-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">Lookback period</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
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

            <button
              onClick={onStartDraw}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#2EEB57] text-sm font-extrabold text-black shadow-[0_8px_28px_rgba(46,235,87,0.35)] transition-all hover:bg-[#39FF4A]"
            >
              <Pencil className="h-4 w-4" />
              Draw Territory
            </button>
          </>
        )}
      </div>
    </div>
  );
}