import { useRef, useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { withReadDeadline } from '@/lib/readRequest';
import { fetchMapTerritory, mapTerritoryBootstrapOptions, mapTerritoryQueryKey, mapTerritoryZipCodes, MAP_OVERVIEW_LIMIT } from './mapTerritoryLoading';

// Phase 4 — viewport-based property fetching + payload reduction.
// Stage 1: a lightweight bootstrap so pins can arrive on slow connections.
// Stage 2: restore the original 20K territory overview in the background.
// Stage 3: ONLY if the overview hit its cap, fetch detail as the manager pans.
// Small territories never trigger viewport fetches — everything is already loaded.
const VIEWPORT_LIMIT = 10000;
const MAX_VIEWPORT_SPAN_DEG = 2; // skip fetches when zoomed out to region/state level
// The merge set used to grow for the whole session, so a long panning session kept
// enlarging every downstream pass over the property list.
const MAX_MERGED_PROPERTIES = 30000;
const EMPTY_PROPERTIES = [];

const quantize = (v) => Math.round(v * 50) / 50; // 0.02° grid → stable, reusable fetch keys

export default function useViewportMapProperties(user) {
    const [viewportState, setViewportProperties] = useState({ scope: null, properties: [] });
    const [viewportFailure, setViewportFailure] = useState(null);
    const mergedRef = useRef(new Map());
    const fetchedKeysRef = useRef(new Set());
    const inFlightRef = useRef(null);
    const cappedRef = useRef(false);
    const latestBoundsRef = useRef(null);
    const scopeKey = JSON.stringify(mapTerritoryQueryKey(user));
    const scopeRef = useRef(scopeKey);
    scopeRef.current = scopeKey;

    useEffect(() => {
        mergedRef.current = new Map();
        fetchedKeysRef.current = new Set();
        inFlightRef.current = null;
        setViewportProperties({ scope: scopeKey, properties: [] });
        setViewportFailure(null);
    }, [scopeKey]);

    const bootstrap = useQuery({
        // Keeps the legacy 'masterProperties' key so existing invalidations
        // (post-pull refresh, force sync, wizard complete) still refresh this data.
        ...mapTerritoryBootstrapOptions(user, (...args) => base44.functions.invoke(...args), withReadDeadline),
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        enabled: !!user
    });
    // Small territories finish with one request. Larger ones show their first
    // homes promptly, then restore the same 20K overview in the background.
    const overview = useQuery({
        queryKey: mapTerritoryQueryKey(user, 'overview'),
        staleTime: 1000 * 60 * 15,
        gcTime: 1000 * 60 * 30,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        queryFn: () => withReadDeadline(() => fetchMapTerritory((...args) => base44.functions.invoke(...args), user, MAP_OVERVIEW_LIMIT), 30_000),
        enabled: !!user && bootstrap.data?.capped === true,
    });
    const baseResult = bootstrap.data?.capped ? (overview.data || bootstrap.data) : bootstrap.data;
    const isOverviewReady = bootstrap.isSuccess && (!bootstrap.data?.capped || overview.isSuccess);
    cappedRef.current = isOverviewReady && !!baseResult?.capped;

    // Called by MapController's debounced moveend with the map's LatLngBounds
    const onMapMoveEnd = useCallback(async (bounds) => {
        latestBoundsRef.current = bounds;
        if (!cappedRef.current || !bounds?.getNorth || inFlightRef.current) return;
        const north = bounds.getNorth(), south = bounds.getSouth(), east = bounds.getEast(), west = bounds.getWest();
        if (north - south > MAX_VIEWPORT_SPAN_DEG || east - west > MAX_VIEWPORT_SPAN_DEG) return;

        // Pad by ~20% and quantize so small pans reuse the previous fetched box
        const padLat = (north - south) * 0.2, padLng = (east - west) * 0.2;
        const box = {
            minLat: quantize(south - padLat), maxLat: quantize(north + padLat),
            minLng: quantize(west - padLng), maxLng: quantize(east + padLng)
        };
        const key = `${box.minLat},${box.maxLat},${box.minLng},${box.maxLng}`;
        if (fetchedKeysRef.current.has(key)) return;

        const request = { scope: scopeKey };
        inFlightRef.current = request;
        try {
            const res = await withReadDeadline(() => base44.functions.invoke('getRouteCandidatesFromNeon', {
                bounds: box,
                zip_codes: mapTerritoryZipCodes(user),
                sold_months: 'all',
                limit: VIEWPORT_LIMIT,
                fields: 'map'
            }));
            if (scopeRef.current !== request.scope) return;
            if (!Array.isArray(res.data?.properties)) throw new Error('Viewport homes could not be loaded.');
            setViewportFailure(null);
            fetchedKeysRef.current.add(key);
            const props = Array.isArray(res.data?.properties) ? res.data.properties : [];
            let added = 0;
            props.forEach(p => {
                const key = p.address_hash || p.id;
                if (!mergedRef.current.has(key)) added++;
                mergedRef.current.set(key, p);
            });
            // Re-publishing an array of everything merged this session on every pan
            // invalidated the entire property fan-out downstream (status derivation,
            // route hydration, pin layer) even when the fetch added nothing new.
            if (added > 0) {
                if (mergedRef.current.size > MAX_MERGED_PROPERTIES) {
                    mergedRef.current = new Map(Array.from(mergedRef.current.entries()).slice(-MAX_MERGED_PROPERTIES));
                    // Evicted boxes must be re-fetchable, or panning back would show no pins.
                    fetchedKeysRef.current = new Set([key]);
                }
                setViewportProperties({ scope: request.scope, properties: Array.from(mergedRef.current.values()) });
            }
            console.log(`[ViewportFetch] viewport key=${key} fetched=${props.length} mergedTotal=${mergedRef.current.size}`);
        } catch (e) {
            if (scopeRef.current === request.scope) setViewportFailure({ scope: request.scope, error: e });
            console.warn('[ViewportFetch] viewport fetch failed', e);
        } finally {
            if (inFlightRef.current === request) inFlightRef.current = null;
        }
    }, [scopeKey, user]);

    // The map now mounts before the territory request completes. Its initial
    // bounds must still be filled when the full overview reaches its cap.
    useEffect(() => {
        if (isOverviewReady) onMapMoveEnd(latestBoundsRef.current);
    }, [isOverviewReady, baseResult, onMapMoveEnd]);

    const retry = useCallback(async () => {
        const initial = await bootstrap.refetch();
        if (initial.data?.capped) await overview.refetch();
        fetchedKeysRef.current = new Set();
        await onMapMoveEnd(latestBoundsRef.current);
    }, [bootstrap.refetch, overview.refetch, onMapMoveEnd]);

    return {
        baseProperties: baseResult?.properties || EMPTY_PROPERTIES,
        viewportProperties: viewportState.scope === scopeKey ? viewportState.properties : EMPTY_PROPERTIES,
        isLoading: bootstrap.isLoading,
        isOverviewReady,
        isLoadingOverview: bootstrap.isLoading || (!!bootstrap.data?.capped && overview.isLoading),
        error: bootstrap.error || (bootstrap.data?.capped ? overview.error : null)
            || (viewportFailure?.scope === scopeKey ? viewportFailure.error : null),
        retry,
        onMapMoveEnd
    };
}
