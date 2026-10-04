import { toast } from 'sonner';
import { tryRoadMatrixOptimize } from '@/lib/roadMatrixOptimize';
import { importOptimizationMessage } from '@/components/import/optimizeImportedRoute';
import React, { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, History, FilePlus, AlertCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { geocodeAddress } from '@/lib/geocoding';
import { storage } from '@/lib/storage';
import { Button } from "@/components/ui/button";
import { createPageUrl } from '@/utils';
import PropertyImportSummary from '@/components/import/PropertyImportSummary';
import { parsePropertyImportFile } from '@/components/import/propertyImportFile';
import { preparePropertyImport, mergeImportedStops, geocodePropertyImportBatch } from '@/components/import/propertyImportData';
import { savePropertyImport, canAppendToRoute } from '@/components/import/savePropertyImport';
import { hydrateRouteForMap } from '@/components/logic/routeHydration';
import { fetchAllSavedRoutePages } from '@/components/rep/repRouteCollection';
import { optimizeRouteByDistance } from '@/components/logic/routeOptimizer';
import { createOutcomeIdempotencyKey } from '@/components/upgrade/knockGate';

export default function CsvUploader() {
    const navigate = useNavigate();
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState(null);
    const [importMode, setImportMode] = useState('create'); // 'create', 'history', or 'analyze'
    const [analysisReport, setAnalysisReport] = useState(null);
    const [pendingImport, setPendingImport] = useState(null);
    const [isSaving, setIsSaving] = useState(false);
    const [routeDestination, setRouteDestination] = useState('new');
    const [selectedRouteId, setSelectedRouteId] = useState('');
    const inputId = useId();
    const inputRef = useRef(null);
    const busy = isUploading || isSaving || !!pendingImport;
    const uploadDisabled = busy || (importMode === 'create' && routeDestination === 'existing' && !selectedRouteId);
    const queryClient = useQueryClient();
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });
    const routesQuery = useQuery({
        queryKey: ['savedRoutes', 'import-destinations', user?.id],
        enabled: !!user?.id && importMode === 'create' && routeDestination === 'existing',
        queryFn: async () => {
            // List only RLS-visible routes, with pagination so older routes remain selectable.
            const routes = await fetchAllSavedRoutePages((limit, skip) => base44.entities.SavedRoute.list('-updated_date', limit, skip));
            return routes.filter(route => canAppendToRoute(route, user));
        },
    });
    const routes = routesQuery.data || [];
    const selectedRoute = routes.find(route => route.id === selectedRouteId);
    const existingStopsQuery = useQuery({
        queryKey: ['importRoutePreview', pendingImport?.routeId, pendingImport?.fileName],
        enabled: !!pendingImport?.routeId,
        retry: 1,
        queryFn: async () => {
            const route = await base44.entities.SavedRoute.get(pendingImport.routeId);
            if (!canAppendToRoute(route, user)) throw new Error('This route is no longer available for imports.');
            const hydrated = await hydrateRouteForMap(route, user?.email);
            const properties = hydrated?.allProperties || hydrated?.properties || [];
            if (properties.length < (route.property_hashes || []).length) throw new Error('Some route stops could not be loaded. Cancel and retry the import.');
            return { route, preview: mergeImportedStops(route, properties, pendingImport.properties) };
        },
    });

    const handleFileUpload = async event => {
        const file = event.target.files?.[0];
        event.target.value = ''; // Allow retrying the same file after an error or cancellation.
        if (!file || busy) return;
        if (importMode === 'create' && routeDestination === 'existing' && !selectedRoute) {
            setUploadStatus({ success: false, message: 'Choose an existing route before uploading.' });
            return;
        }
        setIsUploading(true);
        setUploadStatus({ success: null, message: 'Reading file...' });
        try {
            const currentUser = await base44.auth.me();
            if (!currentUser?.id || !currentUser?.email) throw new Error('Sign in before importing properties.');
            const data = await parsePropertyImportFile(file);
            if (importMode !== 'create') {
                await processData(data);
                return;
            }
            const prepared = await preparePropertyImport(data, file.name, {
                onProgress: message => setUploadStatus({ success: null, message }),
                geocodeBatch: addresses => geocodePropertyImportBatch(addresses, {
                    geocodeBatch: async items => {
                        const response = await base44.functions.invoke('geocodeAddressBatch', { addresses: items });
                        return response.data?.results;
                    },
                    geocodeOne: geocodeAddress,
                }),
            });
            setPendingImport({ ...prepared, routeId: routeDestination === 'existing' ? selectedRouteId : null });
            setUploadStatus(null);
        } catch (error) {
            setUploadStatus({ success: false, message: error.response?.data?.error || error.message || 'Unable to import this file.' });
        } finally {
            setIsUploading(false);
        }
    };

    const handleSaveImport = async () => {
        if (!pendingImport || isSaving) return;
        setIsSaving(true);
        setUploadStatus(null);
        try {
            const currentUser = await base44.auth.me();
            const result = await savePropertyImport(pendingImport, {
                client: base44, user: currentUser, routeId: pendingImport.routeId,
                optimize: optimizeRouteByDistance,
                optimizeRoad: tryRoadMatrixOptimize,
                optimizeBeta: (await import('@/lib/roadAwareRoutingBeta')).prepareRoadAwareBetaComparison,
                completeGenerated: (await import('@/lib/roadAwareRoutingBeta')).completeBetaRouteRecords,
                bindGenerated: (await import('@/lib/roadAwareRoutingBeta')).bindBetaGeneratedRoutes,
                persistProperties: async (properties, routeId) => {
                    const response = await base44.functions.invoke('persistImportedProperties', { properties, route_id: routeId });
                    return response.data?.properties;
                },
                loadRouteProperties: async route => {
                    const hydrated = await hydrateRouteForMap(route, currentUser.email);
                    return hydrated?.allProperties || hydrated?.properties || [];
                },
                saveLocal: storage.saveProperties,
                onProgress: message => setUploadStatus({ success: null, message }),
            });
            queryClient.setQueryData(['routeMap', currentUser.email, result.route.id], result.route);
            await Promise.allSettled([
                queryClient.invalidateQueries({ queryKey: ['masterProperties'], refetchType: 'all' }),
                queryClient.invalidateQueries({ queryKey: ['savedRoutes'], refetchType: 'all' }),
                queryClient.invalidateQueries({ queryKey: ['localProperties'], refetchType: 'all' }),
                queryClient.invalidateQueries({ queryKey: ['importRoutePreview'] }),
            ]);
            setPendingImport(null);
            const message = `${result.added} properties ${pendingImport.routeId ? 'added to' : 'imported into'} ${result.route.name}. ${result.duplicatesRemoved} existing stops skipped. ${importOptimizationMessage(result.optimization)}`.trim();
            setUploadStatus({ success: true, message });
            toast.success(message, { duration: 8000 });
            navigate(`${createPageUrl('Home')}?savedRoute=${encodeURIComponent(result.route.id)}`);
        } catch (error) {
            setUploadStatus({ success: false, message: error.response?.data?.error || error.message || 'Import failed. Please retry.' });
        } finally {
            setIsSaving(false);
        }
    };

    const processData = async (data) => {
        // Get user email
        let userEmail = user?.email;
        if (!userEmail) {
            try {
                const currentUser = await base44.auth.me();
                userEmail = currentUser?.email;
            } catch (e) { console.log('Auth check failed', e); }
        }
        if (!userEmail) userEmail = 'unknown@user.local';

        if (importMode === 'analyze') {
            await processCoverageAnalysis(data);
        } else if (importMode === 'history') {
            await processHistoryImport(data, userEmail);
        }
    };

    const processCoverageAnalysis = async (data) => {
        setIsUploading(true);
        try {
            const stats = {
                totalRows: data.length,
                states: new Set(),
                counties: new Set(),
                years: {},
                salesByYear: {}
            };

            const stateCounts = {};

            data.forEach(row => {
                // Normalize keys
                const r = {};
                Object.keys(row).forEach(k => r[k.toLowerCase().trim().replace(/[\s_-]+/g, '')] = row[k]);

                // Extract State
                const state = r.state || r.stateorprovince || r.st;
                if (state) {
                    stats.states.add(state);
                    stateCounts[state] = (stateCounts[state] || 0) + 1;
                }

                // Extract County (if available) - Composite key state-county
                const county = r.county || r.countyname;
                if (county && state) {
                    stats.counties.add(`${state}-${county}`);
                } else if (r.zip || r.zipcode) {
                    // Fallback: Count unique zips as proxy for coverage spread
                    stats.counties.add(`zip-${r.zip || r.zipcode}`); 
                }

                // Sales Year
                const soldDate = r.solddate || r.datesold || r.lastsolddate;
                if (soldDate) {
                    const year = new Date(soldDate).getFullYear();
                    if (year && !isNaN(year)) {
                        stats.salesByYear[year] = (stats.salesByYear[year] || 0) + 1;
                    }
                }
            });

            const topStates = Object.entries(stateCounts)
                .sort((a,b) => b[1] - a[1])
                .slice(0, 5)
                .map(([s, c]) => `${s} (${c})`)
                .join(', ');

            const report = (
                <div className="space-y-2 text-xs">
                    <div className="p-3 bg-black/40 rounded border border-blue-900/50">
                        <h4 className="font-bold text-blue-400 mb-2">Coverage Report</h4>
                        <div className="grid grid-cols-2 gap-2">
                            <div>Total Rows: <span className="text-white font-bold">{stats.totalRows.toLocaleString()}</span></div>
                            <div>States Found: <span className="text-white font-bold">{stats.states.size}</span></div>
                            <div>Counties/Areas: <span className="text-white font-bold">{stats.counties.size}</span></div>
                        </div>
                        <div className="mt-2 text-gray-400">Top States: {topStates || 'None detected'}</div>
                    </div>
                    
                    {Object.keys(stats.salesByYear).length > 0 && (
                        <div className="p-3 bg-black/40 rounded border border-green-900/50">
                            <h4 className="font-bold text-green-400 mb-2">Sales by Year</h4>
                            <div className="grid grid-cols-3 gap-2">
                                {Object.entries(stats.salesByYear)
                                    .filter(([y]) => y >= new Date().getFullYear() - 5) // Last 5 years +
                                    .sort(([a], [b]) => b - a)
                                    .map(([year, count]) => (
                                        <div key={year}>{year}: <span className="text-white">{count.toLocaleString()}</span></div>
                                    ))}
                            </div>
                        </div>
                    )}

                    <div className="p-2 text-[10px] text-gray-500 italic">
                        * Note: There are ~3,143 counties in the US.
                        {stats.counties.size < 3000 ? " This file does not appear to cover every county." : " Coverage looks comprehensive."}
                    </div>
                </div>
            );

            setAnalysisReport(report);
            setUploadStatus({ success: true, message: "Analysis Complete" });

        } catch (e) {
            console.error(e);
            setUploadStatus({ success: false, message: "Analysis Failed: " + e.message });
        } finally {
            setIsUploading(false);
        }
    };

    const normalizeStatus = (rawStatus) => {
        if (!rawStatus) return 'ELIGIBLE';
        const s = String(rawStatus).toUpperCase().trim();
        
        if (['SOLD', 'BOUGHT', 'CLOSE'].some(x => s.includes(x))) return 'SOLD';
        if (['NO', 'NOT', 'REJECT', 'HARD', 'UNINTERESTED', 'STOP', 'DON'].some(x => s.includes(x))) return 'HARD_NO';
        if (['CALL', 'BACK', 'LATER', 'BUSY'].some(x => s.includes(x))) return 'CALLBACK';
        if (['ANSWER', 'HOME', 'DOOR'].some(x => s.includes(x))) return 'NO_ANSWER';
        if (['YES', 'INTERESTED', 'LEAD', 'QUALIFIED'].some(x => s.includes(x))) return 'QUALIFIED';
        
        return 'ELIGIBLE';
    };

    const processHistoryImport = async (data, userEmail) => {
        const logs = [];
        let errorCount = 0;
        const normalizeKey = (key) => key.toLowerCase().trim().replace(/[\s_-]+/g, '');

        data.forEach((row, idx) => {
            const normalizedRow = {};
            Object.keys(row).forEach(key => normalizedRow[normalizeKey(key)] = row[key]);

            // Try to construct address hash to link to property
            // We need enough info to recreate the hash: Street Name + House Number + Lat + Lng
            // OR if the CSV has the hash/ID directly
            
            let addressHash = normalizedRow.addresshash || normalizedRow.id || normalizedRow.hash || normalizedRow.propertyid || row["MLS#"];
            
            // If no hash, try to generate it using same logic as creation
            if (!addressHash) {
                const lat = parseFloat(normalizedRow.lat || normalizedRow.latitude || row.Lat || 0);
                const lng = parseFloat(normalizedRow.lng || normalizedRow.longitude || row.Lng || 0);
                
                let houseNumber = parseInt(normalizedRow.housenumber || normalizedRow.number || 0);
                let streetName = normalizedRow.streetname || normalizedRow.street || '';
                const fullAddress = normalizedRow.fulladdress || normalizedRow.address || `${houseNumber} ${streetName}`;

                // Parse address if needed
                if ((!houseNumber || !streetName) && fullAddress) {
                    const parts = fullAddress.trim().split(' ');
                    if (parts.length > 1 && !isNaN(parseInt(parts[0]))) {
                        houseNumber = parseInt(parts[0]);
                        streetName = parts.slice(1).join(' ');
                    }
                }
                
                if (houseNumber && streetName && !isNaN(lat) && !isNaN(lng)) {
                     addressHash = btoa(`${streetName}-${houseNumber}-${lat}-${lng}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
                }
            }

            if (!addressHash) {
                errorCount++;
                return;
            }

            const status = normalizeStatus(normalizedRow.status || normalizedRow.result || row.Status || 'ELIGIBLE');
            
            // Only create log if status is meaningful (not just eligible)
            if (status !== 'ELIGIBLE') {
                logs.push({
                    address_hash: String(addressHash),
                    raw_input_text: `Imported from CSV: ${row.Status || status}`,
                    parsed_status: status,
                    created_by: userEmail,
                    gps_proof_lat: parseFloat(normalizedRow.lat || 0),
                    gps_proof_lng: parseFloat(normalizedRow.lng || 0),
                    gps_accuracy: 0
                });
            }
        });

        if (logs.length === 0) {
            setUploadStatus({ success: false, message: `No valid status updates found. Check columns.` });
            setIsUploading(false);
            return;
        }

        try {
            const BATCH_SIZE = 500;
            let importedCount = 0;
            const totalBatches = Math.ceil(logs.length / BATCH_SIZE);

            for (let i = 0; i < logs.length; i += BATCH_SIZE) {
                const batch = logs.slice(i, i + BATCH_SIZE);
                setUploadStatus({ success: null, message: `Updating history batch ${Math.floor(i/BATCH_SIZE)+1}/${totalBatches}...` });
                const response = await base44.functions.invoke('recordKnockOutcome', {
                    action: 'import_history',
                    idempotency_key: createOutcomeIdempotencyKey('csv-history'),
                    interactions: batch
                });
                importedCount += Number(response.data?.imported || 0) + Number(response.data?.reused || 0);
            }

            await queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
            await queryClient.invalidateQueries({ queryKey: ['masterProperties'] }); // Update effective statuses

            setUploadStatus({ success: true, message: `✓ Updated history for ${importedCount} properties!` });
        } catch (error) {
            console.error("History import error", error);
            setUploadStatus({ success: false, message: `Update failed: ${error.message}` });
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="space-y-4">
            {/* Mode Switcher */}
            <div className="flex flex-wrap items-center gap-2 p-1 bg-[#1F1F1F] rounded-lg border border-gray-800 w-fit">
                <button
                    disabled={busy}
                    onClick={() => { setImportMode('create'); setUploadStatus(null); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all ${
                        importMode === 'create' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    <FilePlus className="w-4 h-4" />
                    PROPERTY LIST
                </button>
                <button
                    disabled={busy}
                    onClick={() => { setImportMode('history'); setUploadStatus(null); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all ${
                        importMode === 'history' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    <History className="w-4 h-4" />
                    UPDATE HISTORY
                </button>
                <button
                    disabled={busy}
                    onClick={() => { setImportMode('analyze'); setUploadStatus(null); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs font-bold transition-all ${
                        importMode === 'analyze' ? 'bg-purple-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                >
                    <AlertCircle className="w-4 h-4" />
                    VERIFY COVERAGE
                </button>
                </div>

                <div className="text-xs text-gray-400 px-1">
                {importMode === 'create' 
                    ? "Upload properties to create a route or add stops to an existing route."
                    : importMode === 'analyze' 
                    ? "Scan a file to verify state/county coverage and sales history without importing."
                    : "Upload a list with statuses (Sold, Not Interested, etc) to update history."}
                </div>

            {importMode === 'create' && (
                <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <p className="text-xs font-semibold text-gray-300">Where should these properties go?</p>
                    <div className="grid grid-cols-2 gap-2">
                        {[['new', 'Create New Route'], ['existing', 'Add to Existing Route']].map(([value, label]) => (
                            <button key={value} type="button" disabled={busy} aria-pressed={routeDestination === value}
                                onClick={() => { setRouteDestination(value); setUploadStatus(null); }}
                                className={`rounded-lg border px-3 py-3 text-xs font-bold disabled:opacity-50 ${routeDestination === value ? 'border-green-500/50 bg-green-500/10 text-green-400' : 'border-white/10 text-gray-400 hover:text-white'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    {routeDestination === 'existing' && (
                        <div className="space-y-2">
                            <label htmlFor={`${inputId}-route`} className="block text-xs text-gray-400">Choose a route</label>
                            <select id={`${inputId}-route`} value={selectedRouteId} onChange={event => setSelectedRouteId(event.target.value)} disabled={busy || routesQuery.isPending}
                                className="w-full rounded-lg border border-white/15 bg-[#1F1F1F] p-3 text-sm text-white">
                                <option value="">{routesQuery.isPending ? 'Loading routes...' : 'Select an existing route'}</option>
                                {routes.map(route => <option key={route.id} value={route.id}>{route.name} · {(route.property_hashes || []).length} {(route.property_hashes || []).length === 1 ? 'stop' : 'stops'}{route.assigned_to_name ? ` · ${route.assigned_to_name}` : ''}</option>)}
                            </select>
                            {routesQuery.isError && <p role="alert" className="text-xs text-red-400">Could not load routes. <button type="button" onClick={() => routesQuery.refetch()} className="underline">Retry</button></p>}
                            {!routesQuery.isPending && !routesQuery.isError && !routes.length && <p className="text-xs text-gray-400">No active routes available. Create a new route first.</p>}
                            {selectedRoute && <p className="text-xs text-gray-500">Duplicate addresses will be skipped. We will check all stops together and apply a better route order automatically.</p>}
                        </div>
                    )}
                    <p className="text-[11px] text-gray-500">Addresses without coordinates use Census and fallback address lookup. Review unmatched rows before saving.</p>
                </div>
            )}

            <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx,.xlsm,.json"
                onChange={handleFileUpload}
                className="hidden"
                id={inputId}
                disabled={uploadDisabled}
            />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={uploadDisabled} className="block w-full rounded-xl disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-green-400">
                <div className={`flex items-center justify-center gap-2 px-4 py-6 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${isUploading ? 'border-yellow-500 bg-yellow-500/10' : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/50'}`}>
                    <Upload className={`w-6 h-6 ${isUploading ? 'text-yellow-500 animate-bounce' : 'text-slate-400'}`} />
                    <div className="text-center">
                        <span className="block text-sm font-bold text-slate-300">
                            {isUploading || isSaving ? 'PROCESSING...' : `CLICK TO UPLOAD ${importMode === 'create' ? (routeDestination === 'existing' ? 'ADDITIONAL LIST' : 'NEW LIST') : importMode === 'analyze' ? 'COVERAGE FILE' : 'HISTORY'}`}
                        </span>
                        <span className="text-[10px] text-slate-500 mt-1 block">CSV, Excel (.xlsx) or JSON</span>
                    </div>
                </div>
            </button>

            <PropertyImportSummary
                importBatch={pendingImport}
                route={existingStopsQuery.data?.route || selectedRoute}
                preview={existingStopsQuery.data?.preview}
                isSaving={isSaving}
                progress={isSaving ? uploadStatus?.message : null}
                isLoading={!!pendingImport?.routeId && existingStopsQuery.isPending}
                error={existingStopsQuery.error?.message || (uploadStatus?.success === false ? uploadStatus.message : null)}
                onCancel={() => {
                    if (isSaving) return;
                    setPendingImport(null);
                    setUploadStatus(null);
                    queryClient.removeQueries({ queryKey: ['importRoutePreview'] });
                }}
                onNameChange={routeName => setPendingImport(batch => ({ ...batch, routeName }))}
                onSave={handleSaveImport}
            />

            {uploadStatus && (
                <div className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
                    uploadStatus.success === true ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                    uploadStatus.success === false ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                    'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                }`}>
                    {uploadStatus.success === false ? <AlertCircle className="w-4 h-4 shrink-0" /> : null}
                    {uploadStatus.message}
                    </div>
                    )}

                    {analysisReport && (
                    <div className="animate-in fade-in slide-in-from-top-2">
                    {analysisReport}
                    <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => setAnalysisReport(null)}
                        className="mt-2 text-xs text-gray-500 hover:text-white w-full"
                    >
                        Clear Report
                    </Button>
                    </div>
                    )}
                    </div>
                    );
                    }
