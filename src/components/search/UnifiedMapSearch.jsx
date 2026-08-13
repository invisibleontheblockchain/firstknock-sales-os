import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, Loader2, MapPin, Search, User, X, Landmark, Building2 } from 'lucide-react';
import useUnifiedMapSearch from './useUnifiedMapSearch';
import UnifiedSearchResultRow from './UnifiedSearchResultRow';
import { addRecentSearch, clearRecentSearches, loadRecentSearches } from './recentSearches';

const TYPE_ICONS = { record: User, address: MapPin, city: Building2, county: Landmark };

/**
 * Shared search field for the manager and rep Home screens.
 * Selection handling lives in the host page so each surface can use its own
 * canonical property card and map commands.
 */
export default function UnifiedMapSearch({
  onSelect,
  onClear,
  enableCounties = true,
  className = '',
  autoFocus = false,
  placeholder = 'Search customers, addresses, or counties…',
  showLeadingIcon = true,
  // The header field lives inside a low z-index bar, so its dropdown must be
  // portaled to the body or map overlays paint on top of it.
  portalResults = false,
}) {
  const { query, setQuery, results, groups, loading, error, geocoderError, reset, intent, minLength } =
    useUnifiedMapSearch({ enableCounties });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState(() => loadRecentSearches());
  const [showRecent, setShowRecent] = useState(true);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const panelRef = useRef(null);

  const flatResults = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      const inside = containerRef.current?.contains(event.target) || panelRef.current?.contains(event.target);
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open]);

  const clear = useCallback(() => {
    reset();
    setOpen(false);
    onClear?.();
    inputRef.current?.focus();
  }, [onClear, reset]);

  const choose = useCallback((result) => {
    if (!result) return;
    setOpen(false);
    setRecent(addRecentSearch(result));
    // Collapsing the field reveals the map and the selected property card,
    // which matters most on a phone with the keyboard open.
    inputRef.current?.blur();
    onSelect?.(result);
  }, [onSelect]);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (open) setOpen(false);
      else clear();
      return;
    }
    if (!flatResults.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index + 1) % flatResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index - 1 + flatResults.length) % flatResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(flatResults[activeIndex]);
    }
  };

  const showHistory = open && !intent.usable && !query.trim() && showRecent && recent.length > 0;
  const showPanel = (open && intent.usable) || showHistory;
  const [panelRect, setPanelRect] = useState(null);

  useEffect(() => {
    if (!portalResults || !showPanel) return undefined;
    const measure = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) setPanelRect({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [portalResults, showPanel]);

  const renderPanel = (node) => (portalResults ? createPortal(node, document.body) : node);

  const emptyMessage = !loading && results.length === 0 && intent.usable
    ? (error || `No customers or leads found for “${query.trim()}”. Search their address to locate or add them.`)
    : '';

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div className="relative">
        {showLeadingIcon && (
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#39FF4A]" />
        )}
        <input
          ref={inputRef}
          /* type="text" — the native search input adds its own clear button, which duplicated ours. */
          type="text"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="unified-map-search-results"
          aria-autocomplete="list"
          aria-label="Search customers, addresses, or counties"
          autoComplete="off"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={`h-11 w-full rounded-xl border border-white/12 bg-black/80 ${showLeadingIcon ? 'pl-9' : 'pl-3'} pr-16 text-sm text-white shadow-[0_10px_30px_rgba(0,0,0,0.45)] outline-none backdrop-blur-xl placeholder:text-white/35 focus:border-[#2EEB57]/60`}
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-[#39FF4A]" />}
          {!query && recent.length > 0 && (
            <button
              type="button"
              aria-label={showRecent ? 'Hide recent searches' : 'Show recent searches'}
              aria-pressed={showRecent}
              onClick={() => { setShowRecent((value) => !value); setOpen(true); inputRef.current?.focus(); }}
              className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-white/10 ${showRecent ? 'text-[#39FF4A]' : 'text-white/45 hover:text-white'}`}
            >
              <History className="h-4 w-4" />
            </button>
          )}
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={clear}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {showPanel && renderPanel(
        <div
          ref={panelRef}
          id="unified-map-search-results"
          role="listbox"
          style={portalResults && panelRect ? { left: panelRect.left, top: panelRect.top, width: panelRect.width } : undefined}
          className={`${portalResults ? 'fixed z-[3500]' : 'absolute left-0 right-0 top-[calc(100%+6px)] z-[1200]'} max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain rounded-xl border border-white/12 bg-[#050505]/97 shadow-[0_24px_70px_rgba(0,0,0,0.7)] backdrop-blur-2xl`}
        >
          {showHistory && (
            <section>
              <div className="sticky top-0 flex items-center justify-between bg-[#050505]/95 px-3 py-1.5">
                <p className="text-[9px] font-black uppercase tracking-[0.16em] text-white/40">Recently viewed</p>
                <button type="button" onClick={() => setRecent(clearRecentSearches())} className="text-[9px] font-bold uppercase tracking-[0.12em] text-white/35 hover:text-white">Clear</button>
              </div>
              {recent.map((result, index) => (
                <UnifiedSearchResultRow
                  key={`recent-${result.id || result.formatted_address || index}`}
                  result={result}
                  Icon={TYPE_ICONS[result.type] || MapPin}
                  active={false}
                  onSelect={() => choose(result)}
                  onHover={() => {}}
                />
              ))}
            </section>
          )}
          {emptyMessage && (
            <p className="px-3 py-4 text-[11px] leading-relaxed text-white/55" aria-live="polite">{emptyMessage}</p>
          )}
          {geocoderError && (
            <p className="border-b border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[10px] text-amber-200" aria-live="polite">
              {geocoderError}
            </p>
          )}
          {query.trim().length > 0 && query.trim().length < minLength && !loading && (
            <p className="px-3 py-4 text-[11px] text-white/45">Keep typing to search.</p>
          )}
          {groups.map((group) => (
            <section key={group.id}>
              <p className="sticky top-0 bg-[#050505]/95 px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.16em] text-white/40">
                {group.label}
              </p>
              {group.items.map((result) => {
                const index = flatResults.indexOf(result);
                return (
                  <UnifiedSearchResultRow
                    key={`${group.id}-${result.id || result.formatted_address}-${index}`}
                    result={result}
                    Icon={TYPE_ICONS[result.type] || MapPin}
                    active={index === activeIndex}
                    onSelect={() => choose(result)}
                    onHover={() => setActiveIndex(index)}
                  />
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}