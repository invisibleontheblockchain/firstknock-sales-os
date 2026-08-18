import React from 'react';

export default function VisitBadge({ count = 0 }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[9px] font-black uppercase tracking-wide text-yellow-300">
      Visits:
      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-yellow-300/60 bg-yellow-400 px-1 text-[10px] leading-none text-black shadow-[0_0_10px_rgba(250,204,21,0.22)]">
        {count}
      </span>
    </span>
  );
}