import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function MobileTodoRouteMenu({ options, selectedSet, allSelected, counts, onToggle, onToggleAll }) {
  const total = options.reduce((sum, option) => sum + (counts[option.value] || 0), 0);
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-2 sm:hidden">
      <div className="min-w-0">
        <p className="text-[9px] font-black uppercase tracking-[0.12em] text-white/45">Route Todo types</p>
        <p className="mt-0.5 truncate text-[10px] font-bold text-[#39FF4A]">{allSelected ? 'All decisions' : `${selectedSet.size} selected`} · Start optimized</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Choose Todo route types" className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 text-[10px] font-black text-white">
            Select <MoreHorizontal className="h-4 w-4 text-[#39FF4A]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 border-white/10 bg-[#080808] text-white">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-white/45">Decisions to route</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={allSelected} onCheckedChange={onToggleAll} onSelect={(event) => event.preventDefault()} className="h-10 focus:bg-white/10 focus:text-white">
            <span className="flex w-full justify-between"><span>All decisions</span><span className="text-white/40">{total}</span></span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator className="bg-white/10" />
          {options.map((option) => (
            <DropdownMenuCheckboxItem key={option.value} checked={selectedSet.has(option.value)} onCheckedChange={() => onToggle(option.value)} onSelect={(event) => event.preventDefault()} className="h-10 focus:bg-white/10 focus:text-white">
              <span className="flex w-full justify-between"><span>{option.label}</span><span className="text-white/40">{counts[option.value] || 0}</span></span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}