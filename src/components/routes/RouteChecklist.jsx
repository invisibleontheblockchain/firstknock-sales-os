import React, { useState, useMemo, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Navigation, Mic, MapPin, User, DollarSign, Ruler, Building2, ChevronUp, History, Loader2, RotateCcw } from 'lucide-react';
import { getPropertyResultSummary } from '../logic/territoryLogic';
import PropertyHistory from '@/components/rep/PropertyHistory';
import HouseNoteField from '@/components/routes/HouseNoteField';
import {
    OUTCOME_OPTIONS as STATUS_OPTIONS,
    OUTCOME_COLORS as STATUS_COLORS,
    outcomeBorder,
    outcomeShortLabel,
    outcomeTint,
    latestOutcomeNote
} from '../logic/outcomeStatus';
import {
    CHECKLIST_STAGES,
    STAGE_DECISION_OPTIONS,
    checklistStageFor,
    summarizeChecklistStages
} from '../logic/checklistStages';
import { getWorkflowBucketFromLogs } from '../logic/routeBulkActions';
import { buildFullAddress, getRouteNavigationPlan, openInMaps, openNavigationBatch } from '../logic/navigation';
import { getNavigationSessionProgress, selectRemainingTodoStops } from '../logic/routeNavigation';
import { parseOptionalSaleAmount } from '../analytics/salesManagement';
import { isBusinessOwnedProperty } from '../logic/ownerType';
import { formatPropertyAge } from '@/utils';
import { isNewConstruction } from '@/lib/newConstruction';
import NewBuildBadge from '@/components/rep/NewBuildBadge';
import { base44 } from '@/api/base44Client';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

// Native selects fall back to the OS light palette for the dropdown list, which
// rendered white text on a white sheet. Colours are set explicitly on the
// control and on every option so the choices stay readable on dark.
const FILTER_SELECT_CLASS = 'min-h-9 min-w-0 cursor-pointer appearance-none rounded-xl border border-white/15 px-2 text-[10px] font-bold outline-none focus:border-[#2EEB57]/50';
const FILTER_SELECT_STYLE = { background: '#141414', color: '#E5E5E5', colorScheme: 'dark' };
const FILTER_OPTION_STYLE = { background: '#141414', color: '#E5E5E5' };

const formatMoney = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`;
};

const formatNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n.toLocaleString() : null;
};

export default function RouteChecklist({ route, logs, onLogResult, onNoteSaved, onClose, navigationApp = 'apple', activeRouteSoldFilter, setActiveRouteSoldFilter }) {
    const [latestRoute, setLatestRoute] = useState(route);
    const [expandedId, setExpandedId] = useState(null);
    const [filter, setFilter] = useState(CHECKLIST_STAGES.TODO);
    const [decisionFilter, setDecisionFilter] = useState('all');
    const [callbackPhone, setCallbackPhone] = useState('');
    const [selectedAction, setSelectedAction] = useState(null);
    const [isListening, setIsListening] = useState(false);
    // Note drafts are keyed by address_hash, the canonical property id, so a
    // draft can never be read back onto a different house.
    const [houseNotes, setHouseNotes] = useState({});
    const [savingHash, setSavingHash] = useState(null);
    const [historyOpenHash, setHistoryOpenHash] = useState(null);
    const [detailsOpenHash, setDetailsOpenHash] = useState(null);
    // 'saving' | 'saved' | 'error', keyed by address_hash. The rep is told the
    // real state; a note is never shown as saved before the server took it.
    const [noteStatus, setNoteStatus] = useState({});
    const [noteError, setNoteError] = useState({});
    const noteTimersRef = React.useRef({});
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

    // Every house-level lookup goes through address_hash, never list position.
    const logsByProperty = useMemo(() => {
        const byHash = new Map();
        logs.forEach((log) => {
            if (!log?.address_hash) return;
            if (!byHash.has(log.address_hash)) byHash.set(log.address_hash, []);
            byHash.get(log.address_hash).push(log);
        });
        return byHash;
    }, [logs]);

    const logsForProperty = (property) => logsByProperty.get(property?.address_hash) || [];

    const propertyData = useMemo(() => {
        const dataMap = {};
        displayRoute.properties.forEach(p => {
            dataMap[p.address_hash] = getPropertyResultSummary(logsByProperty.get(p.address_hash) || []);
        });
        return dataMap;
    }, [displayRoute.properties, logsByProperty]);

    const propertyStatuses = useMemo(() => {
        const statusMap = {};
        Object.entries(propertyData).forEach(([hash, data]) => {
            if (data.hasResult) statusMap[hash] = data.status;
        });
        return statusMap;
    }, [propertyData]);

    // A stop's stage comes from its outcome and, when a manager has explicitly
    // moved it, from the workflow bucket on its newest log.
    const propertyStages = useMemo(() => {
        const stageMap = {};
        visibleRouteProperties.forEach(p => {
            stageMap[p.address_hash] = checklistStageFor(
                propertyStatuses[p.address_hash],
                getWorkflowBucketFromLogs(logsByProperty.get(p.address_hash) || [])
            );
        });
        return stageMap;
    }, [visibleRouteProperties, propertyStatuses, logsByProperty]);

    const stageDecisionOptions = STAGE_DECISION_OPTIONS[filter] || null;

    // Switching stages clears a decision filter that the new stage cannot show,
    // otherwise the list would look empty for no visible reason.
    useEffect(() => {
        setDecisionFilter('all');
    }, [filter]);

    const filteredProperties = useMemo(() => {
        return visibleRouteProperties.filter(p => {
            if (filter === 'all') return true;
            if (propertyStages[p.address_hash] !== filter) return false;
            if (decisionFilter === 'all') return true;
            return propertyStatuses[p.address_hash] === decisionFilter;
        });
    }, [visibleRouteProperties, propertyStages, propertyStatuses, filter, decisionFilter]);

    const stats = useMemo(
        () => summarizeChecklistStages(
            visibleRouteProperties,
            (property) => propertyStages[property.address_hash]
        ),
        [visibleRouteProperties, propertyStages]
    );

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

    // House notes save on their own, so an outcome never carries one.
    const houseNotePayload = () => ({});

    const persistHouseNote = async (property, value) => {
        const addressHash = property.address_hash;
        setNoteStatus((current) => ({ ...current, [addressHash]: 'saving' }));
        try {
            await base44.functions.invoke('recordKnockOutcome', {
                action: 'save_house_note',
                address_hash: addressHash,
                note: value,
                route_id: displayRoute?.id || null
            });
            setNoteStatus((current) => ({ ...current, [addressHash]: 'saved' }));
            setNoteError((current) => {
                if (current[addressHash] === undefined) return current;
                const next = { ...current };
                delete next[addressHash];
                return next;
            });
            onNoteSaved?.();
        } catch (error) {
            // Never let the interface imply a note was stored when it was not,
            // and show what the server actually said. Blaming the network sends
            // the rep chasing the wrong thing when the write was rejected.
            const reason = error?.response?.data?.error
                || error?.response?.data?.code
                || error?.message
                || 'Unknown error';
            console.error('[RouteChecklist] House note save failed', error);
            setNoteStatus((current) => ({ ...current, [addressHash]: 'error' }));
            setNoteError((current) => ({ ...current, [addressHash]: String(reason) }));
        }
    };

    // Autosave: the rep types and walks away, so the note commits on a pause
    // rather than waiting for a button they might never press.
    const handleNoteChange = (property, value) => {
        const addressHash = property.address_hash;
        setHouseNotes((current) => ({ ...current, [addressHash]: value }));
        setNoteStatus((current) => ({ ...current, [addressHash]: 'saving' }));
        clearTimeout(noteTimersRef.current[addressHash]);
        noteTimersRef.current[addressHash] = setTimeout(() => {
            persistHouseNote(property, value);
        }, 800);
    };

    // A pending keystroke must still commit when the field closes or unmounts.
    const flushHouseNote = (property) => {
        const addressHash = property.address_hash;
        if (!noteTimersRef.current[addressHash]) return;
        clearTimeout(noteTimersRef.current[addressHash]);
        delete noteTimersRef.current[addressHash];
        const draft = houseNotes[addressHash];
        if (draft !== undefined) persistHouseNote(property, draft);
    };

    useEffect(() => {
        const timers = noteTimersRef.current;
        return () => Object.values(timers).forEach(clearTimeout);
    }, []);

    const clearHouseNote = (addressHash) => {
        setHouseNotes((current) => {
            if (current[addressHash] === undefined) return current;
            const next = { ...current };
            delete next[addressHash];
            return next;
        });
    };

    // Outcomes are append-only, so the interface must not claim a save that the
    // server rejected; the draft is only released once the write is accepted.
    const logOutcome = async (property, logData) => {
        setSavingHash(property.address_hash);
        let saved = false;
        try {
            saved = await onLogResult(property, logData);
        } finally {
            setSavingHash(null);
        }
        if (saved === false) return false;
        clearHouseNote(property.address_hash);
        return saved;
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
            raw_input_text: numericAmount === null ? 'SOLD' : `SOLD | Sale: $${numericAmount.toFixed(2)}`,
            ...houseNotePayload(property)
        };
        if (numericAmount !== null) logData.sale_amount = numericAmount;

        const saved = await logOutcome(property, logData);
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
        logOutcome(property, {
            parsed_status: statusId,
            raw_input_text: statusId,
            ...houseNotePayload(property)
        });
        setExpandedId(null);
    };

    const confirmCallback = (property) => {
        const note = callbackPhone ? `Callback Phone: ${callbackPhone}` : 'Callback';
        logOutcome(property, {
            parsed_status: 'CALLBACK',
            raw_input_text: note,
            ...houseNotePayload(property)
        });
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

    const completedPct = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0;
    const followUpPct = stats.total > 0 ? (stats.followup / stats.total) * 100 : 0;

    return (
        <div className="h-full flex flex-col pt-[calc(env(safe-area-inset-top)+0.5rem)]" style={{ background: BRAND.voidBlack }}>
            {/* Compact Header */}
            <div className="px-4 pt-2 pb-3 space-y-3">
                {/* Title Row */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#2EEB57]/30 bg-[#2EEB57]/10">
                            <Navigation className="h-4 w-4 text-[#39FF4A]" />
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

                {/* Progress Bar — completed is solid, follow-ups are shown as
                    started-but-open so the bar never overstates the day */}
                <div className="flex items-center gap-3">
                    <div className="flex flex-1 h-1.5 rounded-full overflow-hidden border border-white/10 bg-black/60">
                        <div className="h-full transition-all duration-500 shadow-[0_0_14px_rgba(46,235,87,0.55)]" style={{ width: `${completedPct}%`, background: 'linear-gradient(90deg, #2EEB57, #39FF4A)' }} />
                        <div className="h-full transition-all duration-500" style={{ width: `${followUpPct}%`, background: 'rgba(255,215,0,0.55)' }} />
                    </div>
                    <span className="shrink-0 font-mono text-[11px] font-black tabular-nums text-white">
                        {stats.completed}<span className="text-white/35">/{stats.total}</span>
                    </span>
                </div>

                {/* Filters + Start Route */}
                <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
                    <div className="col-span-2 grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1 sm:flex sm:flex-1">
                        {[
                            { id: 'all', label: 'All' },
                            { id: CHECKLIST_STAGES.TODO, label: `Todo ${stats.todo}` },
                            { id: CHECKLIST_STAGES.FOLLOW_UP, label: `Return ${stats.followup}` },
                            { id: CHECKLIST_STAGES.COMPLETED, label: `Done ${stats.completed}` }
                        ].map(f => (
                            <button
                                key={f.id}
                                onClick={() => setFilter(f.id)}
                                className={`min-h-8 rounded-lg px-2.5 text-[10px] font-black uppercase tracking-[0.08em] transition-colors sm:flex-1 ${
                                    filter === f.id
                                        ? 'border border-[#2EEB57]/30 bg-[#2EEB57]/12 text-[#86efac]'
                                        : 'border border-transparent text-white/50 hover:text-white'
                                }`}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    {setActiveRouteSoldFilter && (
                        <select
                            value={activeRouteSoldFilter}
                            onChange={(e) => setActiveRouteSoldFilter(e.target.value)}
                            className={FILTER_SELECT_CLASS}
                            style={FILTER_SELECT_STYLE}
                        >
                            <option value="all" style={FILTER_OPTION_STYLE}>All Time</option>
                            <option value="0.25" style={FILTER_OPTION_STYLE}>1 Week</option>
                            <option value="0.5" style={FILTER_OPTION_STYLE}>2 Weeks</option>
                            <option value="1" style={FILTER_OPTION_STYLE}>1 Month</option>
                            <option value="3" style={FILTER_OPTION_STYLE}>3 Months</option>
                            <option value="6" style={FILTER_OPTION_STYLE}>6 Months</option>
                            <option value="9" style={FILTER_OPTION_STYLE}>9 Months</option>
                            <option value="12" style={FILTER_OPTION_STYLE}>1 Year</option>
                        </select>
                    )}
                    {stageDecisionOptions && (
                        <select
                            value={decisionFilter}
                            onChange={(e) => setDecisionFilter(e.target.value)}
                            className={FILTER_SELECT_CLASS}
                            style={FILTER_SELECT_STYLE}
                        >
                            <option value="all" style={FILTER_OPTION_STYLE}>All Decisions</option>
                            {stageDecisionOptions.map(option => (
                                <option key={option.value} value={option.value} style={FILTER_OPTION_STYLE}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    )}
                    <button
                        onClick={handleRouteNavigation}
                        disabled={remainingProperties.length === 0 && !hasNextNavigationBatch}
                        className="flex min-h-9 items-center justify-center gap-1.5 rounded-xl border border-[#2EEB57]/25 bg-[#2EEB57]/10 px-3 text-[10px] font-black uppercase tracking-[0.08em] text-[#86efac] transition hover:border-[#2EEB57]/45 hover:bg-[#2EEB57]/15 active:scale-95 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/30 sm:ml-auto"
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
                    {filteredProperties.length === 0 && (
                        <p className="px-2 py-8 text-center text-[11px] font-semibold text-white/40">
                            {filter === CHECKLIST_STAGES.TODO
                                ? 'Every stop on this route has been knocked.'
                                : filter === CHECKLIST_STAGES.FOLLOW_UP
                                    ? 'No stops need another visit right now.'
                                    : filter === CHECKLIST_STAGES.COMPLETED
                                        ? 'No stops are fully completed yet.'
                                        : 'No stops match this filter.'}
                        </p>
                    )}
                    {filteredProperties.map((prop, idx) => {
                        const propData = propertyData[prop.address_hash] || {};
                        const currentStatus = propertyStatuses[prop.address_hash];
                        const isExpanded = expandedId === prop.address_hash;
                        const stage = propertyStages[prop.address_hash];
                        // Only a terminal outcome is retired visually. A stop
                        // awaiting another visit keeps its number and full
                        // contrast so it still reads as work.
                        const isDone = stage === CHECKLIST_STAGES.COMPLETED;
                        const needsReturn = stage === CHECKLIST_STAGES.FOLLOW_UP;
                        const ownerName = prop.owner_full_name || prop.owner_name || prop.ownerFullName;
                        const valueLabel = formatMoney(
                            prop.price ??
                            prop.estimated_value ??
                            prop.estimatedValue ??
                            prop.sale_price ??
                            prop.last_sale_price ??
                            prop.lastSoldPrice ??
                            prop.last_sold_price ??
                            prop.sale_amount ??
                            prop.saleAmount ??
                            prop.assessed_value ??
                            prop.assessedValue ??
                            prop.market_value ??
                            prop.marketValue
                        );
                        const sqftLabel = formatNumber(prop.sqft || prop.squareFootage);
                        const yearBuilt = Number(prop.year_built || prop.yearBuilt) || null;
                        const isNewBuild = isNewConstruction(prop);
                        const soldDate = prop.sold_date || prop.soldDate || prop.lastSoldDate || prop.last_sold_date || prop.saleDate || prop.sale_date;
                        const ageLabel = formatPropertyAge(soldDate);
                        const houseLogs = logsForProperty(prop);
                        const savedNote = latestOutcomeNote(houseLogs);
                        const noteDraft = houseNotes[prop.address_hash];
                        const noteDirty = noteDraft !== undefined && noteDraft.trim() !== savedNote;
                        const isSaving = savingHash === prop.address_hash;
                        const historyOpen = historyOpenHash === prop.address_hash;
                        const detailsOpen = detailsOpenHash === prop.address_hash;
                        const noteState = noteStatus[prop.address_hash] || null;
                        const noteBadge = noteState === 'error'
                            ? 'Not saved'
                            : noteState === 'saving'
                                ? 'Saving'
                                : (savedNote ? 'Saved' : null);

                        return (
                            <div
                                key={prop.address_hash}
                                className={`group rounded-xl overflow-hidden transition-all duration-300 border ${
                                    isExpanded 
                                        ? 'bg-[#0E1510] border-[#2EEB57]/35 shadow-[0_0_18px_rgba(46,235,87,0.12)]'
                                        : 'bg-white/[0.03] border-white/10 hover:border-white/20'
                                }`}
                            >
                                {/* Property Row */}
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : prop.address_hash)}
                                    className="w-full px-3 py-2.5 flex items-start gap-2.5 text-left"
                                >
                                    <div
                                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-black"
                                        style={isDone
                                            ? { background: (STATUS_COLORS[currentStatus] || '#333') + '22', color: STATUS_COLORS[currentStatus] || '#888', border: `1px solid ${(STATUS_COLORS[currentStatus] || '#333')}55` }
                                            : needsReturn
                                                ? { background: 'rgba(255,215,0,0.12)', color: BRAND.gold, border: '1px solid rgba(255,215,0,0.35)' }
                                                : { background: 'rgba(46,235,87,0.12)', color: '#86efac', border: '1px solid rgba(46,235,87,0.3)' }}
                                    >
                                        {isDone ? <Check className="w-3.5 h-3.5" /> : needsReturn ? <RotateCcw className="w-3.5 h-3.5" /> : idx + 1}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className={`truncate text-[13px] font-bold leading-tight tracking-tight text-white transition-all duration-300 ${isDone ? 'line-through opacity-40' : ''}`}>
                                                {prop.house_number} {prop.street_name}
                                            </p>
                                            {ageLabel && (
                                                <span className="shrink-0 rounded-full bg-[#2EEB57]/10 px-1.5 py-0.5 text-[9px] font-bold text-[#86efac]">
                                                    {ageLabel}
                                                </span>
                                            )}
                                        </div>
                                        {prop.city && (
                                            <p className="mt-0.5 truncate text-[10px] leading-tight text-white/40">
                                                {prop.city}, {prop.state} {prop.zip_code}
                                            </p>
                                        )}
                                        {(ownerName || valueLabel || sqftLabel || yearBuilt || isNewBuild) && (
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
                                                {isNewBuild && <NewBuildBadge />}
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
                                        <div className="mt-1 flex shrink-0 flex-col items-end gap-1">
                                            <span className="rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wide"
                                                style={{ background: STATUS_COLORS[currentStatus] + '20', color: STATUS_COLORS[currentStatus] }}>
                                                {outcomeShortLabel(currentStatus)}
                                            </span>
                                            {needsReturn && (
                                                <span className="rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wide"
                                                    style={{ background: 'rgba(255,215,0,0.14)', color: BRAND.gold }}>
                                                    Return
                                                </span>
                                            )}
                                        </div>
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
                                                        disabled={isSaving}
                                                        aria-busy={isSaving}
                                                        className={`flex flex-col items-center gap-1 py-2.5 rounded-xl text-center transition-all ${isSaving ? 'opacity-50' : 'active:scale-95'}`}
                                                        style={{
                                                            background: outcomeTint(opt.color, '18'),
                                                            border: `1px solid ${outcomeBorder(opt.color, '30')}`
                                                        }}
                                                    >
                                                        {isSaving
                                                            ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: opt.color }} />
                                                            : <opt.icon className="w-4 h-4" style={{ color: opt.color }} />}
                                                        <span className="text-[9px] font-bold leading-tight" style={{ color: opt.color }}>{opt.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {/* Add Details — sits under Log outcome so the decision grid
                                            stays the first thing in reach */}
                                        <HouseNoteField
                                            property={prop}
                                            open={detailsOpen}
                                            onToggle={() => {
                                                if (detailsOpen) flushHouseNote(prop);
                                                setDetailsOpenHash(detailsOpen ? null : prop.address_hash);
                                            }}
                                            value={houseNotes[prop.address_hash] ?? savedNote}
                                            savedNote={savedNote}
                                            noteState={noteState}
                                            noteBadge={noteBadge}
                                            noteError={noteError[prop.address_hash]}
                                            onChange={handleNoteChange}
                                            onFlush={flushHouseNote}
                                        />

                                        {/* History — collapsed so a long log never buries the outcome grid */}
                                        {houseLogs.length > 0 && (
                                            <div className="space-y-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setHistoryOpenHash(historyOpen ? null : prop.address_hash)}
                                                    aria-expanded={historyOpen}
                                                    aria-controls={`checklist-history-${prop.address_hash}`}
                                                    className="w-full flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left active:scale-[0.99] transition-all"
                                                >
                                                    <span className="flex items-center gap-2">
                                                        <History className="w-3 h-3 text-white/45" />
                                                        <span className="text-[10px] font-bold uppercase tracking-wide text-white/75">History</span>
                                                        <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-white/70">
                                                            {houseLogs.length}
                                                        </span>
                                                    </span>
                                                    <ChevronUp className={`w-3.5 h-3.5 text-white/60 transition-transform ${historyOpen ? '' : 'rotate-180'}`} />
                                                </button>
                                                {historyOpen && (
                                                    <div
                                                        id={`checklist-history-${prop.address_hash}`}
                                                        className="max-h-[40vh] overflow-y-auto pr-0.5"
                                                    >
                                                        <PropertyHistory logs={houseLogs} />
                                                    </div>
                                                )}
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