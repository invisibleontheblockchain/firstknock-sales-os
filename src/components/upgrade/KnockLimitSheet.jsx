import React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Lock } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Mobile bottom sheet shown when a free user needs a card or plan upgrade to keep logging.
export default function KnockLimitSheet({ open, onClose, mode = 'limit' }) {
  const navigate = useNavigate();
  const [isStartingCardSetup, setIsStartingCardSetup] = React.useState(false);
  const [cardSetupError, setCardSetupError] = React.useState('');
  if (!open) return null;

  const isCardGate = mode === 'card';
  const goToPlans = async () => {
    if (isCardGate) {
      if (isStartingCardSetup) return;
      setIsStartingCardSetup(true);
      setCardSetupError('');
      try {
        const currentPath = `${window.location.pathname}${window.location.search}`;
        const response = await base44.functions.invoke('createCardSetupSession', {
          successUrl: `${window.location.origin}${currentPath}${currentPath.includes('?') ? '&' : '?'}card_setup=success`,
          cancelUrl: `${window.location.origin}${currentPath}${currentPath.includes('?') ? '&' : '?'}card_setup=canceled`
        });
        if (!response.data?.url) throw new Error('Stripe did not return a card setup link.');
        window.location.assign(response.data.url);
      } catch (error) {
        setCardSetupError(
          error?.response?.data?.error
          || error?.message
          || 'Could not start secure card setup. Please try again.'
        );
        setIsStartingCardSetup(false);
      }
      return;
    }
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
          {isCardGate ? 'Add a card to keep knocking' : "You've reached your free limit"}
        </h2>
        <p className="text-[#9CA3AF] text-sm text-center mb-6 leading-relaxed max-w-sm mx-auto">
          {isCardGate
            ? "Add a card on file with Stripe to continue logging field outcomes. You will not be charged unless you choose a paid plan."
            : "Upgrade to keep knocking and unlock unlimited routes, CSV imports, and rep management."}
        </p>

        <button
          onClick={goToPlans}
          disabled={isStartingCardSetup}
          className="w-full h-13 py-3.5 rounded-2xl bg-[#2EEB57] hover:bg-[#39FF4A] text-black font-black tracking-wide shadow-[0_12px_35px_rgba(46,235,87,0.28)] active:scale-95 transition-all"
        >
          {isCardGate
            ? (isStartingCardSetup ? 'Opening secure card setup…' : 'Add Card on File')
            : 'Upgrade to Pro'}
        </button>

        {cardSetupError && (
          <p className="mt-3 text-center text-xs text-red-300">{cardSetupError}</p>
        )}

        <button
          onClick={onClose}
          className="w-full text-center text-xs text-white/45 hover:text-white/80 py-3 mt-1 transition-colors"
        >
          {isCardGate ? 'Not now' : 'Maybe later'}
        </button>
      </div>
    </div>,
    document.body
  );
}
