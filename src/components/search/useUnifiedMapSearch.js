import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classifyQuery, groupResults, rankResults, MIN_SEARCH_LENGTH } from './searchQuery';
import { searchInternalRecords } from './internalSearchClient';
import { searchCities, searchCounties, searchExternalAddresses } from './geoSearchService';

const DEBOUNCE_MS = 300;
const CACHE_TTL_MS = 60_000;

/**
 * Unified search state used by both the manager and the rep Home screens.
 *
 * Guarantees:
 * - one debounced pass per query, stale responses discarded by request id
 * - the external geocoder is only called for location-like queries
 * - internal search failures and geocoder failures are reported independently
 */
export default function useUnifiedMapSearch({
  enableCounties = true,
  enableExternalAddresses = true,
  limit = 10,
  searchInternal = searchInternalRecords,
  searchAddresses = searchExternalAddresses,
  searchCountyAreas = searchCounties,
  searchCityAreas = searchCities,
  enableCities = true,
  debounceMs = DEBOUNCE_MS,
} = {}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [geocoderError, setGeocoderError] = useState('');
  const requestIdRef = useRef(0);
  const abortRef = useRef(null);
  const cacheRef = useRef(new Map());

  const intent = useMemo(() => classifyQuery(query), [query]);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setQuery('');
    setResults([]);
    setError('');
    setGeocoderError('');
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!intent.usable) {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      setResults([]);
      setError('');
      setGeocoderError('');
      setLoading(false);
      return undefined;
    }

    const cached = cacheRef.current.get(intent.query);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setResults(cached.results);
      setError('');
      setGeocoderError(cached.geocoderError || '');
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const timer = setTimeout(async () => {
      const collected = [];
      let internalError = '';
      let externalError = '';

      const tasks = [
        (async () => {
          try {
            collected.push(...await searchInternal(intent.query, { limit, signal: controller.signal }));
          } catch (searchError) {
            if (searchError?.name !== 'AbortError') {
              internalError = 'Customer and address search is temporarily unavailable. Please try again.';
            }
          }
        })(),
      ];

      if (enableExternalAddresses && intent.searchAddress) {
        tasks.push((async () => {
          try {
            collected.push(...await searchAddresses(intent.query, { signal: controller.signal }));
          } catch (geoError) {
            if (geoError?.name !== 'AbortError') externalError = 'Address lookup is unavailable right now.';
          }
        })());
      }

      if (enableCities && intent.searchCity) {
        tasks.push((async () => {
          try {
            collected.push(...await searchCityAreas(intent.query, { signal: controller.signal }));
          } catch (geoError) {
            if (geoError?.name !== 'AbortError') externalError = 'City lookup is unavailable right now.';
          }
        })());
      }

      if (enableCounties && intent.searchCounty) {
        tasks.push((async () => {
          try {
            collected.push(...await searchCountyAreas(intent.query, { signal: controller.signal }));
          } catch (geoError) {
            if (geoError?.name !== 'AbortError') externalError = 'County lookup is unavailable right now.';
          }
        })());
      }

      await Promise.all(tasks);
      // A response for an older query must never replace newer results.
      if (requestIdRef.current !== requestId) return;

      const ranked = rankResults(collected, intent.query, { limit });
      cacheRef.current.set(intent.query, { results: ranked, at: Date.now(), geocoderError: externalError });
      if (cacheRef.current.size > 30) cacheRef.current.delete(cacheRef.current.keys().next().value);
      setResults(ranked);
      setError(ranked.length === 0 ? internalError : '');
      setGeocoderError(externalError);
      setLoading(false);
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [debounceMs, enableCities, enableCounties, enableExternalAddresses, intent, limit, searchAddresses, searchCityAreas, searchCountyAreas, searchInternal]);

  return {
    query,
    setQuery,
    intent,
    results,
    groups: useMemo(() => groupResults(results), [results]),
    loading,
    error,
    geocoderError,
    reset,
    minLength: MIN_SEARCH_LENGTH,
  };
}