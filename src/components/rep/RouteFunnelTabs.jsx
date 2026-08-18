import React from 'react';

export default function RouteFunnelTabs({ activeTab, tabs, onChange }) {
  return (
    <div
      className="grid grid-cols-[1.2fr_1.05fr_0.9fr_0.75fr] items-stretch gap-0.5 rounded-xl border border-white/10 bg-white/[0.04] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
      role="tablist"
      aria-label="Route sales funnel"
    >
      {tabs.map((tab, index) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`flex h-10 min-w-0 items-center justify-center gap-1 px-2 text-[10px] font-black uppercase tracking-[0.07em] transition-colors sm:h-11 sm:text-xs ${
              active
                ? 'bg-[#2EEB57] text-black shadow-[0_0_18px_rgba(46,235,87,0.24)]'
                : 'bg-white/[0.055] text-white/55 hover:bg-white/10 hover:text-white'
            }`}
            style={{
              clipPath: index === 0
                ? 'polygon(0 0, 100% 8%, 94% 92%, 0 100%)'
                : index === tabs.length - 1
                  ? 'polygon(6% 8%, 100% 16%, 100% 84%, 0 92%)'
                  : 'polygon(6% 8%, 100% 12%, 94% 88%, 0 92%)',
            }}
          >
            <span className="truncate">{tab.label}</span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] tabular-nums ${active ? 'bg-black/15' : 'bg-white/10'}`}>
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}