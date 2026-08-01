import React from 'react';
import UnifiedMapSearch from './UnifiedMapSearch';
import useGlobalSearchSelect from './useGlobalSearchSelect';

/**
 * Always-expanded header search field (desktop). No overlay or backdrop, so the
 * rest of the header and page stay fully visible while the dropdown is open.
 */
export default function GlobalSearchBar({ className = '' }) {
  const handleSelect = useGlobalSearchSelect();

  return (
    <UnifiedMapSearch
      className={className}
      onSelect={handleSelect}
      placeholder="Search customers, addresses, or counties…"
    />
  );
}