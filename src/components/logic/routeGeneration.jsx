import { toast } from "sonner";
import { base44 } from '@/api/base44Client';
import { generateOptimizedRoutes } from './routeOptimizer';
import { isPointInPolygon } from './territoryLogic';
import { subMonths, subDays } from 'date-fns';
import L from 'leaflet';

export async function generateAndSaveRoutes({
    // state setters
    setRoutesGenerating, setFrozenWorkingSet, setCooldownInfo, setRoutes, setModeRaw, setFetchedProperties,
    // data
    zipCodeFilter, user, logs, assignedHashes, routeConfig, soldDateFilter, drawnPolygon, housesPerRoute, startLocation, streetCooldownDays, learnedWeights, availableProperties, effectiveProperties, lastPullMode,
    // utils
    queryClient, mapRef, handleSaveRoute,
}) {
    setRoutesGenerating(true);
    const toastId = toast.loading("Building routes...", { id: 'build-routes' });

    try {
        // 1. DYNAMIC DATA FETCHING (if zip code is set)
        let dynamicProps = [];
        if (zipCodeFilter && zipCodeFilter.trim()) {
            const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);

            const fetchPromises = targetZips.map(zip =>
                base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                    .then(res => Array.isArray(res) ? res : (res?.items || []))
                    .catch(err => {
                        console.warn(`Failed to fetch zip ${zip}`, err);
                        return [];
                    })
            );

            const results = await Promise.all(fetchPromises);
            let flattened = results.flat();

            const userGeneratedZips = user?.generated_zip_codes || [];
            const ungeneratedZips = targetZips.filter(z => !userGeneratedZips.includes(z));

            if (flattened.length === 0 || ungeneratedZips.length > 0) {
                const zipsToFetch = ungeneratedZips.length > 0 ? ungeneratedZips : targetZips;
                toast.loading("Pulling property data...", { id: 'fetch-zip' });

                for (const zip of zipsToFetch) {
                    try {
                        const res = await base44.functions.invoke('fetchZipProperties', { 
                            zip_code: zip, 
                            sold_months: 12
                        });
                        if (res.data?.error) {
                            toast.error(res.data.message || res.data.error, { id: 'fetch-zip' });
                            break;
                        }
                    } catch (err) {
                        const errData = err?.response?.data;
                        if (errData?.error) {
                            toast.error(errData.message || 'Failed to fetch zip data.', { id: 'fetch-zip' });
                        }
                    }
                }

                queryClient.invalidateQueries({ queryKey: ['user'] });
                toast.success("Data synced!", { id: 'fetch-zip' });

                const retryPromises = targetZips.map(zip =>
                    base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                        .then(res => Array.isArray(res) ? res : (res?.items || []))
                        .catch(() => [])
                );
                const retryResults = await Promise.all(retryPromises);
                flattened = retryResults.flat();
            }

            if (flattened.length > 0) {
                dynamicProps = flattened;
                setFetchedProperties(prev => {
                    const existingIds = new Set(prev.map(p => p.id));
                    const newUnique = flattened.filter(p => !existingIds.has(p.id));
                    return prev.concat(newUnique);
                });
            }
        }

        const assignedSet = assignedHashes;

        const logsByAddress = new Map();
        logs.forEach(l => {
            if (!l.address_hash) return;
            if (!logsByAddress.has(l.address_hash)) {
                logsByAddress.set(l.address_hash, []);
            }
            logsByAddress.get(l.address_hash).push(l);
        });
        
        const { determineEffectiveStatus } = await import('./territoryLogic');
        const processedDynamic = dynamicProps.map(p => {
            const hash = p.address_hash || p.id;
            const propLogs = [
                ...(logsByAddress.get(hash) || []),
                ...(p.legacy_hash && p.legacy_hash !== hash ? (logsByAddress.get(p.legacy_hash) || []) : [])
            ];
            return {
                ...p,
                address_hash: hash,
                lat: parseFloat(p.lat),
                lng: parseFloat(p.lng),
                effective_status: determineEffectiveStatus(p, propLogs)
            };
        }).filter(p =>
            (routeConfig.excludeAssigned === false || !assignedSet.has(p.address_hash)) &&
            p.lat && p.lng &&
            !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001)
        );

        const combinedMap = new Map();
        const baseProps = routeConfig.excludeAssigned === false ? effectiveProperties : availableProperties;
        baseProps.forEach(p => combinedMap.set(p.address_hash, p));
        processedDynamic.forEach(p => combinedMap.set(p.address_hash, p));

        let workingSet = Array.from(combinedMap.values());
        setFrozenWorkingSet(workingSet);

        const hasActivePolygon = drawnPolygon && drawnPolygon.length > 2;
        if (!hasActivePolygon) {
            let targetZips = [];
            if (zipCodeFilter && zipCodeFilter.trim()) targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
            else if (user?.territory_zip_codes?.length > 0) targetZips = user.territory_zip_codes;
            if (targetZips.length > 0) {
                workingSet = workingSet.filter(p => targetZips.includes(String(p.zip_code || '').trim().slice(0, 5)));
            }
        }

        if (hasActivePolygon) {
            workingSet = workingSet.filter(p => isPointInPolygon({ lat: p.lat, lng: p.lng }, drawnPolygon));
            if (workingSet.length === 0) {
                toast.error('No property data inside your drawn area. Pull data for this area first.', { id: 'build-routes', duration: 6000 });
                setRoutesGenerating(false); return;
            }
        }

        if (soldDateFilter !== null && soldDateFilter !== 'all') {
            let cutoff;
            const now = new Date();
            if (soldDateFilter === 0.25 || soldDateFilter === '0.25') {
                cutoff = subDays(now, 7);
            } else {
                cutoff = subMonths(now, Number(soldDateFilter));
            }
            cutoff.setHours(0, 0, 0, 0);
            workingSet = workingSet.filter(p => {
                if (p.original_status === 'PENDING') return true;
                if (p.original_status === 'RECENT_OFF_MARKET' && p.sale_confidence !== 'low') return true;
                const hasInteraction = ['CALLBACK', 'NO_ANSWER', 'QUALIFIED'].includes(p.effective_status);
                if (!p.sold_date) return hasInteraction;
                try {
                    const date = new Date(p.sold_date);
                    if (isNaN(date.getTime())) return hasInteraction;
                    return date >= cutoff;
                } catch (e) { return hasInteraction; }
            });
        }
        
        if (routeConfig.propertyTypes.length > 0) {
            workingSet = workingSet.filter(p => {
                if (!p.property_type) return true;
                const pt = p.property_type.toLowerCase();
                return routeConfig.propertyTypes.some(t => pt.includes(t.toLowerCase()));
            });
        }

        if (routeConfig.excludeCommercial) {
            const commKeywords = ['commercial', 'industrial', 'retail', 'office', 'warehouse', 'business', 'shopping'];
            workingSet = workingSet.filter(p => !p.property_type || !commKeywords.some(kw => p.property_type.toLowerCase().includes(kw)));
        }

        if (routeConfig.excludeCondos) {
            const condoKeywords = ['condo', 'apartment', 'co-op', 'coop', 'multifamily', 'multi family', 'multi-family'];
            workingSet = workingSet.filter(p => !p.property_type || !condoKeywords.some(kw => p.property_type.toLowerCase().includes(kw)));
        }

        if (routeConfig.excludeLand) {
            const landKeywords = ['land', 'lot', 'vacant', 'acreage', 'farm'];
            workingSet = workingSet.filter(p => !p.property_type || !landKeywords.some(kw => p.property_type.toLowerCase().includes(kw)));
        }
        
        workingSet = workingSet.filter(p => p.original_status !== 'REJECTED');

        if (!routeConfig.includeUnverifiedSales || lastPullMode === '40mi') {
            workingSet = workingSet.filter(p => p.sale_confidence !== 'low');
        }

        if (routeConfig.excludePreviouslyKnocked) {
            workingSet = workingSet.filter(p => {
                const hash = p.address_hash || p.id;
                const propLogs = logsByAddress.get(hash);
                if (p.effective_status === 'CALLBACK') return true;
                return !propLogs || propLogs.length === 0;
            });
        }
        
        if (routeConfig.minPrice) workingSet = workingSet.filter(p => !p.price || p.price >= routeConfig.minPrice);
        if (routeConfig.maxPrice) workingSet = workingSet.filter(p => !p.price || p.price <= routeConfig.maxPrice);
        if (routeConfig.minYearBuilt) workingSet = workingSet.filter(p => !p.year_built || p.year_built >= routeConfig.minYearBuilt);
        if (routeConfig.maxYearBuilt) workingSet = workingSet.filter(p => !p.year_built || p.year_built <= routeConfig.maxYearBuilt);
        if (!routeConfig.includeCallbacks) workingSet = workingSet.filter(p => p.effective_status !== 'CALLBACK');

        if (workingSet.length === 0) {
            let reason = "current filters or selected area";
            if (soldDateFilter !== null) reason = `"Sold in last ${soldDateFilter} months" filter`;
            if (drawnPolygon && drawnPolygon.length > 2) reason = "drawn area selection";
            if (zipCodeFilter) reason = `filter for ${zipCodeFilter}`;

            toast.error(`No properties found matching ${reason}. Check filters or clear area.`, { id: 'build-routes', duration: 5000 });
            setRoutesGenerating(false);
            return;
        }

        if (mapRef.current && workingSet.length > 0) {
            const bounds = L.latLngBounds(workingSet.map(p => [p.lat, p.lng]));
            if (bounds.isValid()) {
                try { if (mapRef.current._mapPane) mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 }); } catch (e) { }
            }
        }

        const currentCenter = mapRef.current ? mapRef.current.getCenter() : null;
        const start = startLocation || (currentCenter ? { lat: currentCenter.lat, lng: currentCenter.lng } : null);

        const generated = generateOptimizedRoutes(
            workingSet, housesPerRoute, start, logs,
            {
                streetCooldownDays,
                useStreetSweep: routeConfig.walkingPattern === 'street_sweep',
                minimizeTurns: routeConfig.minimizeTurns,
                use2Opt: routeConfig.use2Opt,
                walkingPattern: routeConfig.walkingPattern,
                returnToStart: routeConfig.returnToStart,
                excludeTerminal: routeConfig.excludeTerminal,
            },
            learnedWeights
        );

        if (generated['_cooldownInfo']) {
            setCooldownInfo(generated['_cooldownInfo']);
        }

        setRoutes(generated);
        
        if (generated.length > 0) {
            const bulkToastId = toast.loading(`Auto-saving ${generated.length} routes...`);
            try {
                await Promise.all(generated.map(route => handleSaveRoute(route, null, null, true)));
                toast.success(`Automatically saved ${generated.length} routes`, { id: bulkToastId, duration: 3000 });
                setRoutes([]);
                setModeRaw('analyze');
            } catch (error) {
                toast.error("Bulk auto-save failed.", { id: bulkToastId });
            }
        }
        
        let skippedDueToAssigned = 0;
        if (routeConfig.excludeAssigned) {
            skippedDueToAssigned = (effectiveProperties.length - availableProperties.length) + 
                (dynamicProps ? dynamicProps.filter(p => assignedHashes.has(p.address_hash || p.id)).length : 0);
        }
        const routeWord = generated.length === 1 ? 'route' : 'routes';
        const toastMsg = `Built ${generated.length} ${routeWord}` + (skippedDueToAssigned > 0 ? ` (${skippedDueToAssigned} skipped because they are already assigned)` : '');
        toast.success(toastMsg, { id: 'build-routes', duration: 5000 });

    } catch (e) {
        console.error("Route generation error:", e);
        alert("An error occurred while generating routes.");
    } finally {
        setRoutesGenerating(false);
    }
}