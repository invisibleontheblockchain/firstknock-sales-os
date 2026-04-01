import React, { useMemo } from 'react';

const STATUS_CONFIG = {
  ELIGIBLE: { color: '#8888A0', label: 'Eligible' },
  SOLD: { color: '#22c55e', label: 'Sold' },
  QUALIFIED: { color: '#06b6d4', label: 'Qualified' },
  HARD_NO: { color: '#ef4444', label: 'Not Interested' },
  CALLBACK: { color: '#f59e0b', label: 'Follow Up' },
  NO_ANSWER: { color: '#6b7280', label: 'Not Home' },
  OTHER: { color: '#8b5cf6', label: 'Other' },
};

export default function StatusBreakdown({ properties }) {
  const data = useMemo(() => {
    const counts = {};
    properties.forEach(p => {
      const s = p.effective_status || 'ELIGIBLE';
      counts[s] = (counts[s] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([status, count]) => ({
        name: STATUS_CONFIG[status]?.label || status,
        value: count,
        color: STATUS_CONFIG[status]?.color || '#666',
        pct: properties.length > 0 ? ((count / properties.length) * 100) : 0,
      }))
      .sort((a, b) => b.value - a.value);
  }, [properties]);

  const maxVal = data[0]?.value || 1;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-purple-500/5 blur-[60px] rounded-full pointer-events-none" />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs md:text-sm font-black text-white">Status Breakdown</h3>
          <span className="text-[9px] font-bold text-gray-500 bg-white/[0.04] px-2 py-0.5 rounded">{properties.length.toLocaleString()} doors</span>
        </div>
        <div className="space-y-2">
          {data.map(d => (
            <div key={d.name}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
                  <span className="text-[10px] md:text-xs font-semibold text-gray-400">{d.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] md:text-xs font-black text-white">{d.value.toLocaleString()}</span>
                  <span className="text-[9px] font-bold text-gray-600 w-10 text-right">{d.pct.toFixed(1)}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-white/[0.03] rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(d.value / maxVal) * 100}%`, background: `linear-gradient(90deg, ${d.color}80, ${d.color})` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}