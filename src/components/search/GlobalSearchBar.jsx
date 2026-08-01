import React from 'react';
import { Search } from 'lucide-react';
import UnifiedMapSearch from './UnifiedMapSearch';
import useGlobalSearchSelect from './useGlobalSearchSelect';

/**
 * Always-expanded header search field (desktop). No overlay or backdrop, so the
 * rest of the header and page stay fully visible while the dropdown is open.
 */
export default function GlobalSearchBar({ className = '' }) {
  const handleSelect = useGlobalSearchSelect();

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Search className="h-5 w-5 shrink-0 text-white" aria-hidden="true" />
      <UnifiedMapSearch
        className="flex-1"
        onSelect={handleSelect}
        showLeadingIcon={false}
        portalResults
        placeholder="Search customers, addresses, or counties…"
      />
    </div>
  );
}