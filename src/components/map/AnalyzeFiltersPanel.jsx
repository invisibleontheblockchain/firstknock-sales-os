import React from 'react';
import { BarChart3, Filter, X } from 'lucide-react';

const SORT_OPTIONS = [
  { id: 'score', label: 'SCORE' },
  { id: 'houses', label: 'HOUSES' },
  { id: 'distance', label: 'DISTANCE' },
  { id: 'recent_sale', label: 'RECENT SALE' },
];

export default function AnalyzeFiltersPanel({
  BRAND,
  repFilter,
  setRepFilter,
  uniqueReps,
  analyzeZipFilter,
  setAnalyzeZipFilter,
  uniqueZips,
  sortBy,
  setSortBy,
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
          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>FILTER BY REP</label>
              <select
                value={repFilter}
                onChange={(event) => setRepFilter(event.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
              >
                <option value="all">All Reps</option>
                {uniqueReps.map((rep) => <option key={rep} value={rep}>{rep}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>FILTER BY ZIP CODE</label>
              <select
                value={analyzeZipFilter}
                onChange={(event) => setAnalyzeZipFilter(event.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
              >
                <option value="all">All Zip Codes</option>
                {uniqueZips.map((zip) => <option key={zip} value={zip}>{zip}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                <Filter className="w-3 h-3 inline mr-1" /> SORT BY
              </label>
              <div className="flex gap-2 flex-wrap">
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setSortBy(option.id)}
                    className="px-3 py-2 rounded-lg text-xs font-bold tracking-wide transition-all"
                    style={{
                      background: sortBy === option.id ? BRAND.gold : BRAND.charcoal,
                      color: sortBy === option.id ? BRAND.voidBlack : BRAND.offWhite,
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}