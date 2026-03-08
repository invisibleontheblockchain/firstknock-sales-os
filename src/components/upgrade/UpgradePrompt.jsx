import React from 'react';
import { Button } from '@/components/ui/button';
import { Crown, MapPin, RefreshCw, Home, X, Sparkles } from 'lucide-react';

/**
 * UpgradePrompt — shown when free tier users hit limits
 * 
 * Three triggers:
 *   1. "marked_100" — Knocked 100 doors
 *   2. "refresh_leads" — Wants fresh monthly data
 *   3. "territory_limit" — Trying to draw > 200 sq mi
 * 
 * Props:
 *   trigger: string — which limit was hit
 *   onUpgrade: () => void — opens Stripe checkout / billing page
 *   onDismiss: () => void — closes prompt
 */
export default function UpgradePrompt({ trigger, onUpgrade, onDismiss }) {
  const config = {
    marked_100: {
      icon: Home,
      color: 'green',
      title: "You've knocked 100 doors!",
      subtitle: "Upgrade to keep marking homes and tracking your progress.",
      cta: "Unlock Unlimited Knocks",
    },
    refresh_leads: {
      icon: RefreshCw,
      color: 'blue',
      title: "Want this month's newest sales?",
      subtitle: "Your current leads are from last month. Upgrade to refresh with the latest data anytime.",
      cta: "Get Fresh Leads",
    },
    territory_limit: {
      icon: MapPin,
      color: 'yellow',
      title: "Need a bigger territory?",
      subtitle: "The free plan covers 200 sq mi. Upgrade to draw unlimited service areas.",
      cta: "Expand My Territory",
    },
  };

  const c = config[trigger] || config.marked_100;
  const Icon = c.icon;

  const colorMap = {
    green: { bg: 'bg-green-500/10', border: 'border-green-500/30', text: 'text-green-400', glow: 'shadow-green-500/20' },
    blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400', glow: 'shadow-blue-500/20' },
    yellow: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-400', glow: 'shadow-yellow-500/20' },
  };
  const colors = colorMap[c.color];

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className={`bg-[#12121A] border ${colors.border} rounded-2xl p-8 max-w-sm mx-4 shadow-2xl ${colors.glow} relative`}>
        {/* Close */}
        <button
          onClick={onDismiss}
          className="absolute top-3 right-3 text-white/30 hover:text-white/60 transition-colors"
        >
          <X size={18} />
        </button>

        {/* Icon */}
        <div className={`w-16 h-16 rounded-2xl ${colors.bg} border ${colors.border} flex items-center justify-center mx-auto mb-5`}>
          <Icon size={32} className={colors.text} />
        </div>

        {/* Title */}
        <h3 className="text-lg font-bold text-white text-center mb-2">{c.title}</h3>
        <p className="text-sm text-white/50 text-center mb-6">{c.subtitle}</p>

        {/* Price tag */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6 text-center">
          <div className="flex items-center justify-center gap-1">
            <Crown size={16} className="text-yellow-400" />
            <span className="text-2xl font-black text-white">$49</span>
            <span className="text-sm text-white/40">/month</span>
          </div>
          <p className="text-[10px] text-white/30 mt-1">Unlimited territory • Fresh leads • Unlimited marks</p>
        </div>

        {/* CTA */}
        <Button
          onClick={onUpgrade}
          className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-sm py-3"
        >
          <Sparkles size={16} className="mr-2" />
          {c.cta}
        </Button>

        {/* Dismiss */}
        <button
          onClick={onDismiss}
          className="w-full text-center text-[11px] text-white/30 hover:text-white/50 mt-3 transition-colors"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
