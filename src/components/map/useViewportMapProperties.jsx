import { useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// Phase 4 — viewport-based property fetching + payload reduction.
// Stage 1: one slim ('map' fields) territory fetch, capped, for initial centering/overview pins.
// Stage 2: ONLY if stage 1 hit its cap, slim viewport fetches fill in detail as the manager pans.
// Small territories never trigger viewport fetches — everything is already loaded.
const BASE_LIMIT = 20000;
const VIEWPORT_LIMIT = 10000;
const MAX_VIEWPORT_SPAN_DEG = 2; // skip fetches when zoomed out to region/state level
// The merge set used to grow for the whole session, so a long panning session kept
// enlarging every downstream pass over the property list.
const MAX_MERGED_PROPERTIES = 30000;

const quantize = (v) => Math.round(v * 50) / 50; // 0.02° grid → stable, reusable fetch keys

export default function useViewportMapProperties(user) {
    const [viewportProperties, setViewportProperties] = useState([]);
    const mergedRef = useRef(new Map());
    const fetchedKeysRef = useRef(new Set());
    const inFlightRef = useRef(false);
    const cappedRef = useRef(false);

    const { data: baseResult, isLoading } = useQuery({
        // Keeps the legacy 'masterProperties' key so existing invalidations
        // (post-pull refresh, force sync, wizard complete) still refresh this data.
        queryKey: ['masterProperties', user?.email, user?.territory_zip_codes, user?.generated_zip_codes],
        staleTime: 1000 * 60 * 15,
        gcTime: 1000 * 60 * 30,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        queryFn: async () => {
            if (!user) return { properties: [], capped: false };
            const t0 = performance.now();
            const allZips = Array.from(new Set([...(user.territory_zip_codes || []), ...(user.generated_zip_codes || [])]));
            const res = await base44.functions.invoke('getRouteCandidatesFromNeon', {
                zip_codes: allZips,
                sold_months: 'all',
                limit: BASE_LIMIT,
                fields: 'map'
            });
            const properties = Array.isArray(res.data?.properties) ? res.data.properties : [];
            console.log(`[ViewportFetch] base count=${properties.length} capped=${!!res.data?.capped} elapsed_ms=${Math.round(performance.now() - t0)}`);
            return { properties, capped: !!res.data?.capped };
        },
        enabled: !!user
    });
    cappedRef.current = !!baseResult?.capped;

    // Called by MapController's debounced moveend with the map's LatLngBounds
    const onMapMoveEnd = useCallback(async (bounds) => {
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

        inFlightRef.current = true;
        try {
            const res = await base44.functions.invoke('getRouteCandidatesFromNeon', {
                bounds: box,
                sold_months: 'all',
                limit: VIEWPORT_LIMIT,
                fields: 'map'
            });
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
                setViewportProperties(Array.from(mergedRef.current.values()));
            }
            console.log(`[ViewportFetch] viewport key=${key} fetched=${props.length} mergedTotal=${mergedRef.current.size}`);
        } catch (e) {
            console.warn('[ViewportFetch] viewport fetch failed', e);
        } finally {
            inFlightRef.current = false;
        }
    }, []);

    return {
        baseProperties: baseResult?.properties || [],
        viewportProperties,
        isLoading,
        onMapMoveEnd
    };
}