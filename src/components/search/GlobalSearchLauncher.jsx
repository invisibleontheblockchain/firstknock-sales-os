import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import UnifiedMapSearch from './UnifiedMapSearch';
import useGlobalSearchSelect from './useGlobalSearchSelect';

/**
 * Header magnifying-glass button available on every screen.
 *
 * The panel only exists while open, and it renders inside a full-screen overlay
 * so no control behind it can be tapped until the search is dismissed.
 */
export default function GlobalSearchLauncher({ className = '' }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const handleSelect = useGlobalSearchSelect(useCallback(() => setOpen(false), []));

  return (
    <>
      <button
        type="button"
        aria-label="Search customers, addresses, or counties"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`flex items-center justify-center rounded-full transition-all ${className}`}
      >
        <Search className="h-5 w-5" />
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[4000]" role="dialog" aria-modal="true" aria-label="Search">
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div
            className="absolute left-1/2 top-[max(1rem,env(safe-area-inset-top))] w-[min(94vw,32rem)] -translate-x-1/2"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                aria-label="Close search"
                onClick={() => setOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/12 bg-black/70 text-white/70 backdrop-blur-xl transition-colors hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <UnifiedMapSearch autoFocus onSelect={handleSelect} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}