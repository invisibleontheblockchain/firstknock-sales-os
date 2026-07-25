import React, { useState, useMemo, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Phone, Ban, Home, Navigation, Mic, MapPin, UserX, Clock, User, DollarSign, Ruler, Building2 } from 'lucide-react';
import { getPropertyResultSummary } from '../logic/territoryLogic';
import { buildFullAddress, getRouteNavigationPlan, openInMaps, openNavigationBatch } from '../logic/navigation';
import { getNavigationSessionProgress, selectRemainingTodoStops } from '../logic/routeNavigation';
import { parseOptionalSaleAmount } from '../analytics/salesManagement';
import { isBusinessOwnedProperty } from '../logic/ownerType';
import { resolvePropertySaleMetadata } from '../logic/propertySaleMetadata';
import { formatPropertyAge } from '@/utils';
import { base44 } from '@/api/base44Client';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STATUS_OPTIONS = [
    { id: 'SOLD', label: 'Sold', icon: Check, color: '#22c55e', textColor: '#fff' },
    { id: 'NO_ANSWER', label: 'No Answer', icon: Home, color: '#3b82f6', textColor: '#fff' },
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: '#eab308', textColor: '#000' },
    { id: 'HARD_NO', label: 'Not Interested', icon: Ban, color: '#8B5CF6', textColor: '#fff' },
    { id: 'NOT_MOVED_IN', label: 'Not Moved In', icon: Clock, color: '#f97316', textColor: '#fff' },
    { id: 'DM_NOT_HOME', label: 'DM Not Home', icon: UserX, color: '#06b6d4', textColor: '#fff' },
];

const STATUS_COLORS = {
    ELIGIBLE: '#22c55e',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6',
    RECENT_OFF_MARKET: '#FFD700',
    NOT_MOVED_IN: '#f97316',
    DM_NOT_HOME: '#06b6d4'
};

const formatMoney = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`;
};

const formatNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n.toLocaleString() : null;
};

export default function RouteChecklist({ route, logs, onLogResult, onClose, navigationApp = 'apple', activeRouteSoldFilter, setActiveRouteSoldFilter }) {
    const [latestRoute, setLatestRoute] = useState(route);
    const [expandedId, setExpandedId] = useState(null);
    const [filter, setFilter] = useState('all');
    const [decisionFilter, setDecisionFilter] = useState('all');
    const [callbackPhone, setCallbackPhone] = useState('');
    const [selectedAction, setSelectedAction] = useState(null);
    const [isListening, setIsListening] = useState(false);
    const [saleAmount, setSaleAmount] = useState('');
    const [saleAmountError, setSaleAmountError] = useState('');
    const [navigationSession, setNavigationSession] = useState(null);
    const [navigationError, setNavigationError] = useState('');
    const [hideBusinessOwned, setHideBusinessOwned] = useState(false);

    useEffect(() => {
        setLatestRoute(route);
    }, [route]);

    useEffect(() => {
        setNavigationSession(null);
        setNavigationError('');
    }, [route?.id]);

    useEffect(() => {
        if (!route?.id) return;

        const applySavedRouteOrder = (savedRoute) => {
            if (!savedRoute?.property_hashes?.length) return;
            const propsByHash = new Map((route.properties || []).map(p => [p.address_hash || p.id, p]));
            const orderedProperties = savedRoute.property_hashes
                .map(hash => propsByHash.get(hash))
                .filter(Boolean);

            if (orderedProperties.length === 0) return;
            setLatestRoute(prev => ({
                ...(prev || route),
                ...savedRoute,
                properties: orderedProperties,
                houseCount: orderedProperties.length,
                totalDistance: savedRoute.metrics?.distance ?? prev?.totalDistance ?? route.totalDistance,
                competitivenessScore: savedRoute.metrics?.score ?? prev?.competitivenessScore ?? route.competitivenessScore
            }));
        };

        base44.entities.SavedRoute.filter({ id: route.id }, '-updated_date', 1).then(res => {
            const savedRoute = Array.isArray(res) ? res[0] : res?.items?.[0];
            applySavedRouteOrder(savedRoute);
        });

        const unsubscribe = base44.entities.SavedRoute.subscribe((event) => {
            if (event?.id === route.id && event.data) applySavedRouteOrder(event.data);
        });
        return unsubscribe;
    }, [route]);

    const displayRoute = latestRoute || route;
    const businessOwnedCount = useMemo(
        () => displayRoute.properties.filter(isBusinessOwnedProperty).length,
        [displayRoute.properties]
    );
    const visibleRouteProperties = useMemo(
        () => hideBusinessOwned
            ? displayRoute.properties.filter(p => !isBusinessOwnedProperty(p))
            : displayRoute.properties,
        [displayRoute.properties, hideBusinessOwned]
    );

    const propertyData = useMemo(() => {
        const dataMap = {};
        displayRoute.properties.forEach(p => {
            const propLogs = logs.filter(l => l.address_hash === p.address_hash);
            dataMap[p.address_hash] = getPropertyResultSummary(propLogs);
        });
        return dataMap;
    }, [displayRoute.properties, logs]);

    const propertyStatuses = useMemo(() => {
        const statusMap = {};
        Object.entries(propertyData).forEach(([hash, data]) => {
            if (data.hasResult) statusMap[hash] = data.status;
        });
        return statusMap;
    }, [propertyData]);

    const filteredProperties = useMemo(() => {
        return visibleRouteProperties.filter(p => {
            const status = propertyStatuses[p.address_hash];
            if (filter === 'pending') return !status || status === 'ELIGIBLE';
            if (filter === 'done') {
                if (!status || status === 'ELIGIBLE') return false;
                return decisionFilter === 'all' || status === decisionFilter;
            }
            return true;
        });
    }, [visibleRouteProperties, propertyStatuses, filter, decisionFilter]);

    const stats = useMemo(() => {
        let pending = 0, done = 0;
        visibleRouteProperties.forEach(p => {
            const status = propertyStatuses[p.address_hash];
            if (!status || status === 'ELIGIBLE') pending++;
            else done++;
        });
        return { pending, done, total: visibleRouteProperties.length };
    }, [visibleRouteProperties, propertyStatuses]);

    const remainingProperties = useMemo(
        () => selectRemainingTodoStops(visibleRouteProperties, propertyStatuses),
        [visibleRouteProperties, propertyStatuses]
    );

    const navigationProgress = getNavigationSessionProgress(
        navigationSession?.routeId === displayRoute.id ? navigationSession : null,
        remainingProperties
    );
    const hasNextNavigationBatch = navigationProgress.canAdvance;
    const canResumeNavigationBatch = navigationProgress.canResume;

    const handleNavigate = (prop) => {
        openInMaps(prop.lat, prop.lng, buildFullAddress(prop), navigationApp);
    };

    const handleRouteNavigation = () => {
        if (remainingProperties.length === 0 && !hasNextNavigationBatch) return;
        setNavigationError('');

        try {
            if (canResumeNavigationBatch) {
                const resumePlan = getRouteNavigationPlan(navigationProgress.remainingStops, navigationApp, {
                    startDelaySeconds: 0
                });
                openNavigationBatch(resumePlan, 0);
                return;
            }

            if (hasNextNavigationBatch) {
                const continuationPlan = getRouteNavigationPlan(navigationProgress.continuationStops, navigationApp, {
                    startDelaySeconds: 0
                });
                if (!continuationPlan.batches.length) return;
                const nextSession = { routeId: displayRoute.id, plan: continuationPlan, batchIndex: 0 };
                setNavigationSession(nextSession);
                openNavigationBatch(continuationPlan, 0);
                return;
            }

            const plan = getRouteNavigationPlan(remainingProperties, navigationApp, { startDelaySeconds: 0 });
            if (plan.batches.length === 0) return;
            const nextSession = { routeId: displayRoute.id, plan, batchIndex: 0 };
            setNavigationSession(nextSession);
            openNavigationBatch(plan, 0);
        } catch (error) {
            setNavigationError(error?.message || 'This route could not be opened in maps.');
        }
    };

    const resetSalePrompt = () => {
        setSaleAmount('');
        setSaleAmountError('');
        setSelectedAction(null);
    };

    const saveSold = async (property, rawAmount = saleAmount) => {
        const parsedAmount = parseOptionalSaleAmount(rawAmount);
        if (parsedAmount.error) {
            setSaleAmountError(parsedAmount.error);
            return;
        }
        const numericAmount = parsedAmount.value;

        const logData = {
            parsed_status: 'SOLD',
            raw_input_text: numericAmount === null ? 'SOLD' : `SOLD | Sale: $${numericAmount.toFixed(2)}`
        };
        if (numericAmount !== null) logData.sale_amount = numericAmount;

        const saved = await onLogResult(property, logData);
        if (saved === false) return;
        resetSalePrompt();
        setExpandedId(null);
    };

    const handleSelectStatus = (property, statusId) => {
        if (statusId === 'SOLD') {
            setSaleAmount('');
            setSaleAmountError('');
            setCallbackPhone('');
            setSelectedAction({ propertyId: property.address_hash, statusId });
            return;
        }
        if (statusId === 'CALLBACK') {
            setSaleAmount('');
            setSaleAmountError('');
            setSelectedAction({ propertyId: property.address_hash, statusId });
            return;
        }
        onLogResult(property, statusId);
        setExpandedId(null);
    };

    const confirmCallback = (property) => {
        const note = callbackPhone ? `Callback Phone: ${callbackPhone}` : 'Callback';
        onLogResult(property, 'CALLBACK', note);
        setCallbackPhone('');
        setSelectedAction(null);
        setExpandedId(null);
    };

    const handleVoiceInput = (property) => {
        if (!('webkitSpeechRecognition' in window)) {
            alert("Voice input not supported in this browser.");
            return;
        }
        const recognition = new window.webkitSpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        setIsListening(true);

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            setIsListening(false);
            let status = 'ELIGIBLE';
            const lower = text.toLowerCase();
            if (lower.includes('sold') || lower.includes('bought')) status = 'SOLD';
            else if (lower.includes('not interested') || lower.includes('no') || lower.includes('go away')) status = 'HARD_NO';
            else if (lower.includes('call') || lower.includes('back') || lower.includes('busy')) status = 'CALLBACK';
            else if (lower.includes('no answer') || lower.includes('nobody')) status = 'NO_ANSWER';
            else if (lower.includes('not moved in') || lower.includes('haven\'t moved')) status = 'NOT_MOVED_IN';
            else if (lower.includes('decision maker') || lower.includes('dm not home') || lower.includes('husband') || lower.includes('wife')) status = 'DM_NOT_HOME';
            else if (lower.includes('yes') || lower.includes('interested')) status = 'QUALIFIED';
            if (confirm(`Heard: "${text}"\nStatus: ${status}\n\nSave?`)) {
                if (status === 'SOLD') {
                    setSaleAmount('');
                    setSaleAmountError('');
                    setSelectedAction({ propertyId: property.address_hash, statusId: 'SOLD' });
                } else {
                    onLogResult(property, status, text);
                    setExpandedId(null);
                }
            }
        };
        recognition.onerror = () => setIsListening(false);
        recognition.onend = () => setIsListening(false);
        recognition.start();
    };

    const progressPct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;

    return (
        <div className="h-full flex flex-col pt-[calc(env(safe-area-inset-top)+0.5rem)]" style={{ background: BRAND.voidBlack }}>
            {/* Compact Header */}
            <div className="px-4 pt-2 pb-3 space-y-3">
                {/* Title Row */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: BRAND.gold }}>
                            <Navigation className="w-4 h-4" style={{ color: BRAND.voidBlack }} />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-base font-bold leading-tight truncate" style={{ color: BRAND.offWhite }}>{displayRoute.name}</h2>
                            <p className="text-[11px] leading-tight" style={{ color: '#666' }}>
                                {displayRoute.assigned_to_name && <span className="text-blue-400 mr-1">{displayRoute.assigned_to_name} •</span>}
                                {stats.total} stops
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10">
                        <X className="w-4 h-4 text-gray-500" />
                    </button>
                </div>

                {/* Progress Bar */}
                <div className="flex items-center gap-3">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: '#222' }}>
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progressPct}%`, background: BRAND.gold }} />
                    </div>
                    <span className="text-[11px] font-bold tabular-nums shrink-0" style={{ color: BRAND.gold }}>
                        {stats.done}/{stats.total}
                    </span>
                </div>

                {/* Filters + Start Route */}
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex min-w-[190px] flex-1 gap-1">
                        {[
                            { id: 'all', label: 'All' },
                            { id: 'pending', label: `Todo ${stats.pending}` },
                            { id: 'done', label: `Done ${stats.done}` }
                        ].map(f => (
                            <button
                                key={f.id}
                                onClick={() => setFilter(f.id)}
                                className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold tracking-wide transition-colors"
                                style={{
                                    background: filter === f.id ? BRAND.gold : '#1a1a1a',
                                    color: filter === f.id ? BRAND.voidBlack : '#888'
                                }}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    {setActiveRouteSoldFilter && (
                        <select
                            value={activeRouteSoldFilter}
                            onChange={(e) => setActiveRouteSoldFilter(e.target.value)}
                            className="bg-[#1a1a1a] text-[#888] text-[10px] font-bold px-2 py-1.5 rounded-lg border-none outline-none cursor-pointer min-w-0"
                        >
                            <option value="all">All Time</option>
                            <option value="0.25">1 Week</option>
                            <option value="0.5">2 Weeks</option>
                            <option value="1">1 Month</option>
                            <option value="3">3 Months</option>
                            <option value="6">6 Months</option>
                            <option value="9">9 Months</option>
                            <option value="12">1 Year</option>
                        </select>
                    )}
                    {filter === 'done' && (
                        <select
                            value={decisionFilter}
                            onChange={(e) => setDecisionFilter(e.target.value)}
                            className="bg-[#1a1a1a] text-[#888] text-[10px] font-bold px-2 py-1.5 rounded-lg border-none outline-none cursor-pointer min-w-0"
                        >
                            <option value="all">All Decisions</option>
                            <option value="SOLD">Sold</option>
                            <option value="NO_ANSWER">No Answer</option>
                            <option value="CALLBACK">Callback</option>
                            <option value="HARD_NO">Not Interested</option>
                            <option value="NOT_MOVED_IN">Not Moved In</option>
                            <option value="DM_NOT_HOME">DM Not Home</option>
                        </select>
                    )}
                    <button
                        onClick={handleRouteNavigation}
                        disabled={remainingProperties.length === 0 && !hasNextNavigationBatch}
                        className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[10px] font-bold tracking-wide disabled:cursor-not-allowed disabled:opacity-40"
                        style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                    >
                        <Navigation className="w-3 h-3" />
                        {hasNextNavigationBatch ? 'NEXT BATCH' : canResumeNavigationBatch ? 'RESUME' : 'START'}
                        {hasNextNavigationBatch && (
                            <span className="opacity-60">
                                {navigationProgress.continuationStops.length} left
                            </span>
                        )}
                        {canResumeNavigationBatch && (
                            <span className="opacity-60">{navigationProgress.remainingStops.length}</span>
                        )}
                    </button>
                </div>
                {navigationError && (
                    <p className="text-[10px] font-semibold text-red-400" role="alert">{navigationError}</p>
                )}
                {businessOwnedCount > 0 && (
                    <button
                        type="button"
                        aria-pressed={hideBusinessOwned}
                        onClick={() => setHideBusinessOwned(current => !current)}
                        className="w-full flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[10px] font-bold tracking-wide transition-colors"
                        style={{
                            background: hideBusinessOwned ? 'rgba(6,182,212,0.12)' : '#151515',
                            borderColor: hideBusinessOwned ? 'rgba(6,182,212,0.45)' : '#262626',
                            color: hideBusinessOwned ? '#67e8f9' : '#888'
                        }}
                    >
                        <Building2 className="w-3 h-3" />
                        {hideBusinessOwned
                            ? `${businessOwnedCount} LLC / business-owned stops hidden`
                            : `Hide LLC / business-owned (${businessOwnedCount})`}
                    </button>
                )}
            </div>

            {/* Divider */}
            <div className="h-px" style={{ background: '#1a1a1a' }} />

            {/* Property List */}
            <ScrollArea className="flex-1">
                <div className="px-3 py-2 space-y-1.5">
                    {filteredProperties.map((prop, idx) => {
                        const propData = propertyData[prop.address_hash] || {};
                        const currentStatus = propertyStatuses[prop.address_hash];
                        const isExpanded = expandedId === prop.address_hash;
                        const isDone = currentStatus && currentStatus !== 'ELIGIBLE';
                        const ownerName = prop.owner_full_name || prop.owner_name || prop.ownerFullName;
                        const saleMetadata = resolvePropertySaleMetadata(prop);
                        const valueLabel = formatMoney(saleMetadata.amount);
                        const sqftLabel = formatNumber(prop.sqft || prop.squareFootage);
                        const yearBuilt = Number(prop.year_built || prop.yearBuilt) || null;
                        const soldDate = saleMetadata.soldDate;
                        const ageLabel = formatPropertyAge(soldDate);

                        return (
                            <div
                                key={prop.address_hash}
                                className={`group rounded-xl overflow-hidden transition-all duration-300 border ${
                                    isExpanded 
                                        ? 'bg-[#181818] border-yellow-500/40 shadow-[0_0_15px_rgba(255,215,0,0.1)]' 
                                        : 'bg-[#111] border-[#1a1a1a] hover:border-white/20 hover:shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                                }`}
                            >
                                {/* Property Row */}
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : prop.address_hash)}
                                    className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left"
                                >
                                    <div
                                        className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                                        style={{
                                            background: isDone ? (STATUS_COLORS[currentStatus] || '#333') : BRAND.gold,
                                            color: isDone ? '#fff' : BRAND.voidBlack,
                                            opacity: isDone ? 0.7 : 1
                                        }}
                                    >
                                        {isDone ? <Check className="w-3.5 h-3.5" /> : idx + 1}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className={`text-[13px] font-semibold truncate leading-tight transition-all duration-300 ${isDone ? 'line-through opacity-40' : 'group-hover:drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]'}`} style={{ color: BRAND.offWhite }}>
                                                {prop.house_number} {prop.street_name}
                                            </p>
                                            {ageLabel && (
                                                <span className="text-[9px] font-bold text-yellow-500/80 shrink-0">
                                                    {ageLabel}
                                                </span>
                                            )}
                                        </div>
                                        {prop.city && (
                                            <p className="text-[10px] truncate leading-tight mt-0.5" style={{ color: '#555' }}>
                                                {prop.city}, {prop.state} {prop.zip_code}
                                            </p>
                                        )}
                                        {(ownerName || valueLabel || sqftLabel || yearBuilt) && (
                                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] font-bold text-white/45">
                                                {ownerName && (
                                                    <span className="inline-flex max-w-[140px] items-center gap-1 truncate rounded-full bg-white/5 px-1.5 py-0.5">
                                                        <User className="h-2.5 w-2.5 shrink-0 text-[#39FF4A]" />
                                                        <span className="truncate">{ownerName}</span>
                                                    </span>
                                                )}
                                                {valueLabel && (
                                                    <span className="inline-flex items-center gap-1 rounded-full bg-[#2EEB57]/10 px-1.5 py-0.5 text-[#39FF4A]">
                                                        <DollarSign className="h-2.5 w-2.5" />{valueLabel}
                                                    </span>
                                                )}
                                                {sqftLabel && (
                                                    <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-1.5 py-0.5">
                                                        <Ruler className="h-2.5 w-2.5" />{sqftLabel} sqft
                                                    </span>
                                                )}
                                                {yearBuilt && <span className="rounded-full bg-white/5 px-1.5 py-0.5">Built {yearBuilt}</span>}
                                            </div>
                                        )}
                                    </div>

                                    {currentStatus && !isExpanded && (
                                        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0"
                                            style={{ background: STATUS_COLORS[currentStatus] + '20', color: STATUS_COLORS[currentStatus] }}>
                                            {currentStatus === 'NO_ANSWER' ? 'N/A' : currentStatus === 'HARD_NO' ? 'NO' : currentStatus === 'NOT_MOVED_IN' ? 'NMI' : currentStatus === 'DM_NOT_HOME' ? 'DM' : currentStatus}
                                        </span>
                                    )}
                                </button>

                                {/* Expanded Actions */}
                                {isExpanded && (
                                    <div className="px-3 pb-3 space-y-2">
                                        {/* Previous notes */}
                                        {propData.hasResult && propData.resultText && (
                                            <div className="px-2.5 py-1.5 rounded-lg text-[11px] border-l-2"
                                                style={{ background: '#0f0f0f', borderColor: STATUS_COLORS[propData.status], color: '#aaa' }}>
                                                "{propData.resultText}"
                                            </div>
                                        )}

                                        {/* Voice + Label */}
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-bold uppercase" style={{ color: '#555' }}>Log outcome</span>
                                            <button
                                                onClick={() => handleVoiceInput(prop)}
                                                className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg ${isListening ? 'text-red-400 bg-red-900/20 animate-pulse' : 'text-yellow-500 bg-yellow-500/10'}`}
                                            >
                                                <Mic className="w-3 h-3" />
                                                {isListening ? 'Listening...' : 'Voice'}
                                            </button>
                                        </div>

                                        {/* Status Buttons */}
                                        {selectedAction?.propertyId === prop.address_hash && selectedAction?.statusId === 'SOLD' ? (
                                            <div className="space-y-2 rounded-xl border border-green-500/25 bg-green-500/5 p-2.5">
                                                <label className="block text-[10px] font-bold uppercase tracking-wide text-green-400" htmlFor={`sale-amount-${prop.address_hash}`}>
                                                    Sale amount (optional)
                                                </label>
                                                <div className="relative">
                                                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-gray-500">$</span>
                                                    <input
                                                        id={`sale-amount-${prop.address_hash}`}
                                                        type="text"
                                                        inputMode="decimal"
                                                        autoComplete="off"
                                                        placeholder="0.00"
                                                        value={saleAmount}
                                                        onChange={(e) => { setSaleAmount(e.target.value); setSaleAmountError(''); }}
                                                        className="w-full rounded-lg border border-gray-700 bg-black py-2 pl-7 pr-3 text-sm text-white outline-none focus:border-green-500"
                                                        autoFocus
                                                    />
                                                </div>
                                                {saleAmountError && <p className="text-[10px] font-semibold text-red-400" role="alert">{saleAmountError}</p>}
                                                <div className="grid grid-cols-2 gap-2">
                                                    <Button onClick={() => saveSold(prop)} className="h-9 text-xs font-bold bg-green-600 text-white hover:bg-green-500">
                                                        Save Sale
                                                    </Button>
                                                    <Button onClick={() => saveSold(prop, '')} variant="outline" className="h-9 border-gray-700 text-xs text-gray-300">
                                                        Skip Amount
                                                    </Button>
                                                </div>
                                                <Button onClick={resetSalePrompt} variant="ghost" className="h-8 w-full text-xs text-gray-500">
                                                    Cancel
                                                </Button>
                                            </div>
                                        ) : selectedAction?.propertyId === prop.address_hash && selectedAction?.statusId === 'CALLBACK' ? (
                                            <div className="space-y-2">
                                                <input
                                                    type="tel"
                                                    placeholder="Phone number (optional)"
                                                    value={callbackPhone}
                                                    onChange={(e) => setCallbackPhone(e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg text-sm bg-black border border-gray-700 text-white"
                                                    autoFocus
                                                />
                                                <div className="flex gap-2">
                                                    <Button onClick={() => confirmCallback(prop)} className="flex-1 h-9 text-xs font-bold bg-yellow-500 text-black hover:bg-yellow-400">
                                                        Save Callback
                                                    </Button>
                                                    <Button onClick={() => { setSelectedAction(null); setCallbackPhone(''); }} variant="ghost" className="h-9 text-xs text-gray-400">
                                                        Cancel
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-3 gap-1.5">
                                                {STATUS_OPTIONS.map(opt => (
                                                    <button
                                                        key={opt.id}
                                                        onClick={() => handleSelectStatus(prop, opt.id)}
                                                        className="flex flex-col items-center gap-1 py-2.5 rounded-xl text-center transition-all active:scale-95"
                                                        style={{ background: opt.color + '18', border: `1px solid ${opt.color}30` }}
                                                    >
                                                        <opt.icon className="w-4 h-4" style={{ color: opt.color }} />
                                                        <span className="text-[9px] font-bold leading-tight" style={{ color: opt.color }}>{opt.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {/* Navigate */}
                                        <button
                                            onClick={() => handleNavigate(prop)}
                                            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-bold"
                                            style={{ background: '#1a1a1a', color: '#666' }}
                                        >
                                            <MapPin className="w-3 h-3" />
                                            Open in {navigationApp === 'google' ? 'Google' : 'Apple'} Maps
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </ScrollArea>
        </div>
    );
}
