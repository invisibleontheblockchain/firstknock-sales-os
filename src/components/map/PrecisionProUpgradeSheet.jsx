import React from 'react';
import { Lock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function PrecisionProUpgradeSheet({ onClose, onUpgrade }) {
  return (
    <div className="fixed inset-0 z-[2600] sm:hidden bg-black/60 backdrop-blur-sm animate-in fade-in" onClick={onClose}>
      <div
        className="absolute left-0 right-0 bottom-0 rounded-t-3xl border-t border-[#2EEB57]/25 bg-[#070707] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl animate-in slide-in-from-bottom-6"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 h-8 w-8 rounded-full bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white flex items-center justify-center"
          aria-label="Close upgrade prompt"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#2EEB57]/15 border border-[#2EEB57]/30">
          <Lock className="h-6 w-6 text-[#39FF4A]" />
        </div>

        <h3 className="text-center text-xl font-extrabold text-white">Pro Feature</h3>
        <p className="mt-2 text-center text-sm leading-relaxed text-gray-400">
          Shorter date ranges (1 day, 2 days, 1 week, 2 weeks, 1 month) are available on the Pro plan. Upgrade to unlock faster lead targeting.
        </p>

        <Button
          onClick={onUpgrade}
          className="mt-5 h-12 w-full rounded-xl bg-[#2EEB57] text-black font-extrabold hover:bg-[#39FF4A]"
        >
          Upgrade to Pro
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full text-center text-xs font-bold text-gray-500 hover:text-white"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}