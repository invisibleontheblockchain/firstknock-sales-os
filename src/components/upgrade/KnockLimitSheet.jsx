import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Lock } from 'lucide-react';

// Mobile bottom sheet shown when a free user hits the 50-outcome Knock Mode limit.
// Animates up from the bottom. Tapping outside == "Maybe later".
export default function KnockLimitSheet({ open, onClose }) {
  const navigate = useNavigate();
  if (!open) return null;

  const goToPlans = () => {
    onClose?.();
    navigate(createPageUrl('Billing'));
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex flex-col justify-end bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#050505]/97 backdrop-blur-2xl rounded-t-[2rem] border-t border-white/10 px-6 pt-7 pb-[calc(env(safe-area-inset-bottom)+1.75rem)] animate-in slide-in-from-bottom duration-300 shadow-[0_-24px_80px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-center mb-5">
          <div className="w-14 h-14 rounded-full bg-[#2EEB57]/12 border border-[#2EEB57]/30 flex items-center justify-center">
            <Lock className="w-7 h-7 text-[#39FF4A]" />
          </div>
        </div>

        <h2 className="text-xl font-extrabold text-white text-center mb-2">
          You've reached your free limit
        </h2>
        <p className="text-[#9CA3AF] text-sm text-center mb-6 leading-relaxed max-w-sm mx-auto">
          You've logged 50 stops — upgrade to keep knocking and unlock unlimited routes, CSV imports, and rep management.
        </p>

        <button
          onClick={goToPlans}
          className="w-full h-13 py-3.5 rounded-2xl bg-[#2EEB57] hover:bg-[#39FF4A] text-black font-black tracking-wide shadow-[0_12px_35px_rgba(46,235,87,0.28)] active:scale-95 transition-all"
        >
          Upgrade to Pro
        </button>

        <button
          onClick={onClose}
          className="w-full text-center text-xs text-white/45 hover:text-white/80 py-3 mt-1 transition-colors"
        >
          Maybe later
        </button>
      </div>
    </div>,
    document.body
  );
}