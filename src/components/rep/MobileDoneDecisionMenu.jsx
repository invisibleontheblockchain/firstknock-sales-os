import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function MobileDoneDecisionMenu({ options, value, onChange }) {
  const selectedLabel = value === 'all'
    ? 'All decisions'
    : options.find((option) => option.value === value)?.label || 'All decisions';
  return (
    <div className="order-4 col-span-2 flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-2 sm:hidden sm:order-none">
      <div className="min-w-0">
        <p className="text-[9px] font-black uppercase tracking-[0.12em] text-white/45">Done decisions</p>
        <p className="mt-0.5 truncate text-[10px] font-bold text-[#39FF4A]">{selectedLabel}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Choose completed decision" className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-2.5 text-[10px] font-black text-white">
            Select <MoreHorizontal className="h-4 w-4 text-[#39FF4A]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 border-white/10 bg-[#080808] text-white">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-white/45">Completed decisions</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            <DropdownMenuRadioItem value="all" className="h-10 focus:bg-white/10 focus:text-white">All decisions</DropdownMenuRadioItem>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} className="h-10 focus:bg-white/10 focus:text-white">{option.label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}