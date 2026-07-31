import React from 'react';
import { BarChart3, X, Users, Filter } from 'lucide-react';
import { DECISION_FILTERS } from './routeDecisionFilters';

export default function AnalyzeFiltersPanel({
  BRAND,
  repFilter,
  setRepFilter,
  uniqueReps,
  decisionFilter,
  setDecisionFilter,
  onClose,
}) {
  return (
    <div className="fixed inset-0 z-[2000]">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="absolute top-0 right-0 bottom-0 w-full max-w-md overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl shadow-2xl animate-in slide-in-from-right duration-300"
        style={{ background: 'rgba(10, 10, 10, 0.95)', borderLeft: '1px solid rgba(255, 255, 255, 0.1)' }}
      >
        <div className="p-5 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
          <h2 className="flex items-center gap-2 font-bold tracking-wide" style={{ color: BRAND.gold }}>
            <BarChart3 className="w-5 h-5" />
            ROUTE FILTERS
          </h2>
          <button onClick={onClose} className="p-4 -mr-2 hover:bg-[#333] rounded-full transition-colors">
            <X className="w-6 h-6" style={{ color: BRAND.offWhite }} />
          </button>
        </div>

        <div className="p-5 space-y-6 overflow-y-auto h-[calc(100%-70px)]">
          <div>
            <label className="text-xs font-bold tracking-wide mb-1 flex items-center gap-1.5" style={{ color: BRAND.offWhite }}>
              <Filter className="w-3.5 h-3.5" /> KNOCK DECISION
            </label>
            <p className="text-[11px] text-white/40 mb-3">Show only the doors with this outcome — route lines and other pins are hidden.</p>
            <div className="grid grid-cols-2 gap-2">
              {DECISION_FILTERS.map((option) => {
                const active = (decisionFilter || 'all') === option.id;
                return (
                  <button
                    key={option.id}
                    onClick={() => setDecisionFilter(option.id)}
                    className={`px-3 py-3 rounded-xl text-xs font-extrabold tracking-wide text-left transition-all border ${
                      active
                        ? 'bg-[#2EEB57]/15 border-[#2EEB57]/40 text-white'
                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:bg-white/[0.08]'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold tracking-wide mb-3 flex items-center gap-1.5" style={{ color: BRAND.offWhite }}>
              <Users className="w-3.5 h-3.5" /> FILTER BY REP
            </label>
            <select
              value={repFilter}
              onChange={(event) => setRepFilter(event.target.value)}
              className="w-full px-3 py-2.5 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
            >
              <option value="all">All Reps</option>
              {uniqueReps.map((rep) => <option key={rep} value={rep}>{rep}</option>)}
            </select>
          </div>

          {(decisionFilter && decisionFilter !== 'all') && (
            <button
              onClick={() => setDecisionFilter('all')}
              className="w-full px-3 py-3 rounded-xl text-xs font-bold tracking-wide bg-white/[0.04] border border-white/10 text-white/70 hover:bg-white/[0.08]"
            >
              CLEAR DECISION FILTER
            </button>
          )}
        </div>
      </div>
    </div>
  );
}