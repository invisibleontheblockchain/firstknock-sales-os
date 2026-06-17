import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Lock } from 'lucide-react';

// Persistent banner shown at the top of Knock Mode after the limit sheet is
// first dismissed. Stays for the rest of the session.
export default function KnockLimitBanner() {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2 bg-[#2EEB57]/10 border-b border-[#2EEB57]/25">
      <div className="flex items-center gap-2 min-w-0">
        <Lock className="w-3.5 h-3.5 text-[#39FF4A] shrink-0" />
        <span className="text-[11px] font-bold text-white/85 truncate">
          Upgrade to log more outcomes
        </span>
      </div>
      <Link
        to={createPageUrl('Billing')}
        className="shrink-0 text-[11px] font-black tracking-wide text-black bg-[#2EEB57] hover:bg-[#39FF4A] rounded-full px-3 py-1 active:scale-95 transition-all"
      >
        Upgrade
      </Link>
    </div>
  );
}