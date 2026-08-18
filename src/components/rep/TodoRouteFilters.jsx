import React from 'react';
import { DEFAULT_TODO_ROUTE_FILTERS, TODO_ROUTE_FILTER_OPTIONS } from '@/components/logic/todoRouteFilters';
import MobileTodoRouteMenu from '@/components/rep/MobileTodoRouteMenu';

export default function TodoRouteFilters({ selected, counts = {}, onChange }) {
  const selectedSet = new Set(selected);
  const allValues = TODO_ROUTE_FILTER_OPTIONS.map((option) => option.value);
  const allSelected = allValues.every((value) => selectedSet.has(value));
  const toggle = (value) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  };
  const toggleAll = () => onChange(allSelected ? [...DEFAULT_TODO_ROUTE_FILTERS] : allValues);

  return (
    <>
      <MobileTodoRouteMenu
        options={TODO_ROUTE_FILTER_OPTIONS}
        selectedSet={selectedSet}
        allSelected={allSelected}
        counts={counts}
        onToggle={toggle}
        onToggleAll={toggleAll}
      />
      <div className="hidden rounded-xl border border-white/10 bg-white/[0.035] p-2 sm:block" aria-label="Choose Todo types to show and route">
      <div className="mb-1.5 flex items-center justify-between gap-3 px-0.5">
        <span className="text-[9px] font-black uppercase tracking-[0.12em] text-white/45">Route Todo types</span>
        <span className="text-[9px] font-bold text-[#39FF4A]">Start uses selected</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={allSelected} onClick={toggleAll}
          className={`min-h-8 rounded-lg border px-2.5 text-[9px] font-black uppercase tracking-[0.04em] transition-colors ${allSelected ? 'border-[#2EEB57]/55 bg-[#2EEB57] text-black' : 'border-white/10 bg-white/[0.05] text-white/55 hover:text-white'}`}>
          All <span className="opacity-65">{allValues.reduce((sum, value) => sum + (counts[value] || 0), 0)}</span>
        </button>
        {TODO_ROUTE_FILTER_OPTIONS.map((option) => {
          const active = selectedSet.has(option.value);
          return (
            <button key={option.value} type="button" aria-pressed={active} onClick={() => toggle(option.value)}
              className={`min-h-8 rounded-lg border px-2.5 text-[9px] font-black uppercase tracking-[0.04em] transition-colors ${active ? 'border-[#2EEB57]/55 bg-[#2EEB57] text-black' : 'border-white/10 bg-white/[0.05] text-white/55 hover:text-white'}`}>
              {option.label} <span className="opacity-65">{counts[option.value] || 0}</span>
            </button>
          );
        })}
      </div>
      </div>
    </>
  );
}