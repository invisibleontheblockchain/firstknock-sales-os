import React, { useEffect, useRef, useState } from 'react';
import { Search, Loader2, MapPin } from 'lucide-react';
import { suggestCities } from '@/components/find/findPlaceSuggest';

// City search with live suggestions. Selecting a suggestion is the only way to
// move the map, so the visitor never lands on an unresolved query.
export default function FindSearchField({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const activeQueryRef = useRef('');

  useEffect(() => {
    const trimmed = query.trim();
    activeQueryRef.current = trimmed;
    if (trimmed.length < 3) {
      setResults([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const found = await suggestCities(trimmed, { signal: controller.signal });
        if (activeQueryRef.current !== trimmed) return;
        setResults(found);
        setOpen(true);
      } catch {
        if (activeQueryRef.current === trimmed) setResults([]);
      } finally {
        if (activeQueryRef.current === trimmed) setLoading(false);
      }
    }, 300);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const pick = (item) => {
    setQuery(item.label);
    setOpen(false);
    setResults([]);
    onSelect(item);
  };

  return (
    <div className="relative mt-3">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        placeholder="Search a city"
        autoComplete="off"
        className="h-11 w-full rounded-xl border border-white/15 bg-white/[0.05] pl-9 pr-10 text-sm text-white placeholder-white/35 outline-none transition-colors focus:border-[#2EEB57]/60"
      />
      {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-white/40" />}

      {open && results.length > 0 && (
        <div className="absolute inset-x-0 top-[calc(100%+0.35rem)] z-20 overflow-hidden rounded-xl border border-white/10 bg-[#0A0A0A] shadow-[0_20px_60px_rgba(0,0,0,0.7)]">
          {results.map((item) => (
            <button
              key={item.id}
              onClick={() => pick(item)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
            >
              <MapPin className="h-4 w-4 shrink-0 text-[#39FF4A]" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-bold text-white">{item.label}</span>
                {item.sublabel && (
                  <span className="block truncate text-[11px] text-white/45">{item.sublabel}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {open && !loading && query.trim().length >= 3 && results.length === 0 && (
        <p className="mt-1.5 text-[11px] font-semibold text-white/45">No cities matched that search.</p>
      )}
    </div>
  );
}