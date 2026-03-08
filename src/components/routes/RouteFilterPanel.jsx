import React, { useState, useMemo } from 'react';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Filter, DollarSign, Calendar, Home, X, ChevronDown, ChevronUp, UserX } from 'lucide-react';

const PROPERTY_TYPES = [
  'Single Family',
  'Condo',
  'Townhouse',
  'Multi-Family',
  'Mobile Home',
  'Residential',
];

const VALUE_PRESETS = [
  { label: 'Any', value: 0 },
  { label: '$200K+', value: 200000 },
  { label: '$300K+', value: 300000 },
  { label: '$400K+', value: 400000 },
  { label: '$500K+', value: 500000 },
  { label: '$750K+', value: 750000 },
  { label: '$1M+', value: 1000000 },
];

const RECENCY_PRESETS = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 60 days', value: 60 },
  { label: 'Last 90 days', value: 90 },
  { label: 'All time', value: null },
];

/**
 * Post-fetch filter panel for route properties.
 * All filtering is client-side — no new API calls needed.
 * 
 * Props:
 *   filters: { minValue, maxDaysAgo, types, absenteeOnly }
 *   onFiltersChange: (newFilters) => void
 *   totalCount: number (total unfiltered properties)
 *   filteredCount: number (after filters applied)
 */
export default function RouteFilterPanel({ 
  filters = {}, 
  onFiltersChange, 
  totalCount = 0, 
  filteredCount = 0 
}) {
  const [expanded, setExpanded] = useState(false);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.minValue > 0) count++;
    if (filters.maxDaysAgo) count++;
    if (filters.types?.length > 0) count++;
    if (filters.absenteeOnly) count++;
    return count;
  }, [filters]);

  const updateFilter = (key, value) => {
    onFiltersChange?.({ ...filters, [key]: value });
  };

  const clearAll = () => {
    onFiltersChange?.({ minValue: 0, maxDaysAgo: null, types: [], absenteeOnly: false });
  };

  const toggleType = (type) => {
    const current = filters.types || [];
    const next = current.includes(type) 
      ? current.filter(t => t !== type) 
      : [...current, type];
    updateFilter('types', next);
  };

  return (
    <div className="bg-[#12121A]/95 backdrop-blur-xl border border-white/10 rounded-xl overflow-hidden shadow-2xl">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-yellow-400" />
          <span className="text-xs font-bold text-white/90 tracking-wide">FILTERS</span>
          {activeFilterCount > 0 && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px] px-1.5 py-0">
              {activeFilterCount}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/50">
            {filteredCount.toLocaleString()} / {totalCount.toLocaleString()}
          </span>
          {expanded ? <ChevronUp size={14} className="text-white/40" /> : <ChevronDown size={14} className="text-white/40" />}
        </div>
      </button>

      {/* Filter body — collapsible */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-white/5 pt-3">
          
          {/* Property Value */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <DollarSign size={12} className="text-green-400" />
              <span className="text-[10px] font-bold text-white/70 tracking-wide">PROPERTY VALUE</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {VALUE_PRESETS.map(({ label, value }) => (
                <button
                  key={value}
                  onClick={() => updateFilter('minValue', value)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-all ${
                    (filters.minValue || 0) === value
                      ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                      : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Days Since Sale */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Calendar size={12} className="text-blue-400" />
              <span className="text-[10px] font-bold text-white/70 tracking-wide">SOLD WITHIN</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {RECENCY_PRESETS.map(({ label, value }) => (
                <button
                  key={label}
                  onClick={() => updateFilter('maxDaysAgo', value)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-all ${
                    filters.maxDaysAgo === value
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                      : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Property Type */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Home size={12} className="text-purple-400" />
              <span className="text-[10px] font-bold text-white/70 tracking-wide">PROPERTY TYPE</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PROPERTY_TYPES.map(type => (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-all ${
                    (filters.types || []).includes(type)
                      ? 'bg-purple-500/20 text-purple-400 border border-purple-500/40'
                      : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Absentee Owner */}
          <div>
            <button
              onClick={() => updateFilter('absenteeOnly', !filters.absenteeOnly)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-medium transition-all w-full ${
                filters.absenteeOnly
                  ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
                  : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10'
              }`}
            >
              <UserX size={13} />
              <span>Absentee Owners Only</span>
              <span className="text-[9px] opacity-60 ml-auto">(mailing ≠ property address)</span>
            </button>
          </div>

          {/* Clear All */}
          {activeFilterCount > 0 && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 text-[10px] text-red-400 hover:text-red-300 transition-colors"
            >
              <X size={12} />
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
