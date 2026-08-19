import React from 'react';
import { Check, Plus, Zap } from 'lucide-react';
import {
  MAX_CREDIT_PACK_PROPERTIES,
  MIN_CREDIT_PACK_PROPERTIES,
  CREDIT_BLOCK_PROPERTIES,
  describeCreditPack
} from '@/lib/precisionCreditPacks';

/**
 * Buy Precision credits as a one-off pack.
 *
 * Collapsed by default so the plan above it stays the page's single call to
 * action — a rep choosing the $99 plan should not have to scroll past a price
 * ladder that has nothing to do with it. Opening the panel is what commits the
 * rep to reading about extra credits, and only then does the slider appear.
 */
export default function PrecisionCreditPackCard({
  value,
  onChange,
  onPurchase,
  loading = false,
  disabled = false,
  eligible = true,
  ineligibleReason = '',
  currentLimit = 0,
  creditsRemaining = 0
}) {
  const [open, setOpen] = React.useState(false);
  const pack = describeCreditPack(value, currentLimit);

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border border-white/10 bg-[#0d0d0d] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 shrink-0 text-yellow-400" />
            <h2 className="text-lg font-extrabold text-white">Add Precision credits</h2>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-gray-400">
            A one-time purchase, separate from your plan. Credits are added to your account and roll
            over month to month — they are not a recurring charge and never change your $99 renewal.
          </p>
          {creditsRemaining > 0 && (
            <p className="mt-2 text-xs font-semibold text-yellow-300">
              {creditsRemaining.toLocaleString()} credits currently available.
            </p>
          )}
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 text-sm font-bold text-yellow-300 transition hover:bg-yellow-500/20"
          >
            <Plus className="h-4 w-4" />
            ADD CREDITS
          </button>
        )}
      </div>

      {open && (
        <div className="mt-5 rounded-xl border border-yellow-500/25 bg-yellow-500/[0.06] p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-bold text-white">Choose your pack</p>
              <p className="mt-1 text-xs text-gray-400">{pack.perThousandLabel}, charged once.</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-lg font-extrabold text-yellow-400">{pack.propertiesLabel}</p>
              <p className="text-[10px] uppercase tracking-wider text-gray-500">credits</p>
            </div>
          </div>

          <input
            type="range"
            min={MIN_CREDIT_PACK_PROPERTIES}
            max={MAX_CREDIT_PACK_PROPERTIES}
            step={CREDIT_BLOCK_PROPERTIES}
            value={pack.properties}
            onChange={(event) => onChange(Number(event.target.value))}
            disabled={disabled || loading || !eligible}
            className="mt-4 w-full accent-yellow-500 disabled:opacity-40"
            aria-label="Precision credits to buy"
          />
          <div className="mt-2 flex justify-between text-[10px] text-gray-500">
            <span>{MIN_CREDIT_PACK_PROPERTIES.toLocaleString()}</span>
            <span>{MAX_CREDIT_PACK_PROPERTIES.toLocaleString()}</span>
          </div>

          <ul className="mt-4 space-y-2 border-t border-white/10 pt-4">
            {[
              `${pack.propertiesLabel} extra Precision properties added to your account`,
              'Unused credits roll over for as long as your $99 plan stays paid',
              'Charged once today — your monthly bill stays $99',
              `Raises your ceiling to ${pack.newLimit.toLocaleString()} properties`
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-xs text-gray-300">
                <div className="mt-0.5 shrink-0 rounded-full bg-yellow-500/20 p-0.5 text-yellow-500">
                  <Check className="h-2.5 w-2.5" />
                </div>
                <span className="leading-snug">{line}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
            <span className="text-xs text-gray-400">One-time total</span>
            <span className="text-xl font-extrabold text-white">{pack.priceLabel}</span>
          </div>

          {eligible ? (
            <button
              type="button"
              onClick={() => onPurchase(pack.blocks)}
              disabled={disabled || loading}
              className="mt-3 h-11 w-full rounded-lg bg-yellow-500 font-bold text-black transition hover:bg-yellow-400 disabled:opacity-50"
            >
              {loading ? 'PREPARING…' : `BUY ${pack.propertiesLabel} CREDITS — ${pack.priceLabel}`}
            </button>
          ) : (
            <p className="mt-3 rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-center text-xs text-gray-400">
              {ineligibleReason}
            </p>
          )}
          <p className="mt-2 text-center text-[10px] text-gray-500">
            Credits appear on your account once Stripe confirms the payment.
          </p>
        </div>
      )}
    </div>
  );
}
