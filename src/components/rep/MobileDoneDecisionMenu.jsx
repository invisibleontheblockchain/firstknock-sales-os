import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import RouteScopeToggles from '@/components/rep/RouteScopeToggles';

export default function MobileDoneDecisionMenu({ options, value, onChange, menuLabel = 'Completed decisions', businessOwnedCount = 0, hideBusinessOwned, onToggleBusinessOwned, newBuildCount = 0, newBuildsOnly, onToggleNewBuilds }) {
  return (
    <div className="order-4 col-span-2 flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.035] px-2 py-2 sm:hidden sm:order-none">
      <RouteScopeToggles
        className="flex flex-1"
        businessOwnedCount={businessOwnedCount}
        hideBusinessOwned={hideBusinessOwned}
        onToggleBusinessOwned={onToggleBusinessOwned}
        newBuildCount={newBuildCount}
        newBuildsOnly={newBuildsOnly}
        onToggleNewBuilds={onToggleNewBuilds}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Choose completed decision" className="ml-auto flex h-9 shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.06] px-2 text-[10px] font-black text-white">
            Decisions <MoreHorizontal className="h-4 w-4 text-[#39FF4A]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 border-white/10 bg-[#080808] text-white">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-white/45">{menuLabel}</DropdownMenuLabel>
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
