import React, { useMemo } from 'react';

const LABELS = {
  SOLD: { label: 'Sold', color: '#22c55e' },
  QUALIFIED: { label: 'Qualified', color: '#3b82f6' },
  CALLBACK: { label: 'Callback', color: '#f59e0b' },
  NO_ANSWER: { label: 'No Answer', color: '#6b7280' },
  HARD_NO: { label: 'Hard No', color: '#ef4444' },
  NOT_QUALIFIED: { label: 'Not Qualified', color: '#a855f7' },
  DM_NOT_HOME: { label: 'Decision Maker Away', color: '#64748b' },
  NOT_MOVED_IN: { label: 'Not Moved In', color: '#78716c' },
  DNC: { label: 'Do Not Knock', color: '#991b1b' },
};

export default function TeamOutcomeBreakdown({ counts }) {
  const items = useMemo(() => {
    return Object.entries(LABELS)
      .map(([key, config]) => ({
        ...config,
        value: counts?.[key] || 0,
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [counts]);

  const max = items[0]?.value || 1;

  return (
    <div className="rounded-xl md:rounded-2xl border border-white/5 bg-gradient-to-b from-[#151515] to-[#0A0A0A] p-3 md:p-5 shadow-2xl">
      <div className="mb-3 md:mb-4">
        <h3 className="text-sm md:text-lg font-black text-white tracking-tight">Outcome Mix</h3>
        <p className="text-[10px] md:text-sm text-gray-500">All-time door decisions</p>
      </div>
      <div className="space-y-2 md:space-y-3">
        {items.map((item) => (
          <div key={item.label}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-bold text-white">{item.label}</span>
              <span className="text-sm text-gray-400">{item.value}</span>
            </div>
            <div className="h-2.5 rounded-full bg-white/5 overflow-hidden border border-white/5">
              <div className="h-full rounded-full" style={{ width: `${(item.value / max) * 100}%`, background: item.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
