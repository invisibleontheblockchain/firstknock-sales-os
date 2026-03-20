import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
    Navigation, Loader2, MapPin, RefreshCw, X, ChevronDown, ChevronUp,
    Zap, Route, Footprints, Clock, Shield, Flame, Target, Shuffle,
    ArrowUpDown, GitBranch, ScanLine, Compass, Pencil, Layers, Lock
} from 'lucide-react';
import { toast } from "sonner";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const ROUTE_SIZE_OPTIONS = [20, 50, 100, 200, 500, 1000];

export default function RouteBuilderSettings({
    // State values
    housesPerRoute, setHousesPerRoute,
    maxRouteDistance, setMaxRouteDistance,
    streetCooldownDays, setStreetCooldownDays,
    minScore, setMinScore,
    zipCodeFilter, setZipCodeFilter,
    startLocation, setStartLocation,
    startAddressInput, setStartAddressInput,
    sortBy, setSortBy,
    soldDateFilter, setSoldDateFilter,
    // New advanced options
    routeConfig, setRouteConfig,
    // Callbacks
    onGenerate, routesGenerating,
    onReset,
    mapRef,
    // Templates
    routeTemplates = [],
    templateName, setTemplateName,
    onSaveTemplate, onLoadTemplate,
    // Route list
    filteredRoutes = [],
    onSelectRoute,
    onClose,
    // Sync functions
    onForceSync, onClearPolygon,
    onDraw, // New prop for enabling drawing mode
    // Reorder
    onReorder, hasFrozenData,
    // Data
    user,
    hasDrawnArea
}) {
    const [expandedSection, setExpandedSection] = useState('presets');
    const [activePreset, setActivePreset] = useState(null);
    const [viewMode, setViewMode] = useState('simple'); // 'simple' or 'advanced'

    // Clear any stale auto-build flag — we no longer auto-generate on open
    React.useEffect(() => {
        try { localStorage.removeItem('fk_autobuild_next_open'); } catch (e) { /* ignore */ }
    }, []);

    // Auto-apply FirstKnock Best on initial load
    React.useEffect(() => {
        if (!activePreset) {
            const bestStrategy = STRATEGIES.find(s => s.id === 'best');
            if (bestStrategy) {
                bestStrategy.apply(true);
                setActivePreset('best');
            }
        }
    }, [activePreset]);

    // Ensure simple mode has a default soldDateFilter set
    React.useEffect(() => {
        if (viewMode === 'simple' && soldDateFilter === null) {
            setSoldDateFilter(12);
        }
    }, [viewMode]);

    const toggleSection = (id) => {
        setExpandedSection(expandedSection === id ? null : id);
    };

    const STRATEGIES = [
        {
            id: '12mo',
            name: '12 Month Sweep',
            icon: <Zap className="w-4 h-4" />,
            desc: 'The standard Mail Carrier route. All homes sold in the last 12 months, grouped into one clean sweep.',
            criteria: '12mo, Street Sweep, Mail Carrier Style',
            apply: (isInitial = false) => {
                setHousesPerRoute(10000); 
                setMaxRouteDistance(50);  
                setStreetCooldownDays(14);
                setMinScore(0);           
                setSoldDateFilter(12);    
                setSortBy('score');
                setRouteConfig(prev => ({ ...prev, minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, excludeAssigned: true, excludeCommercial: true, excludeCondos: true, excludePreviouslyKnocked: true, excludeLand: true, minPrice: null, maxPrice: null, propertyTypes: [] }));
                if (!isInitial) toast.success("12 Month Sweep applied!");
            }
        },
        {
            id: '6mo',
            name: '6 Month Sweep',
            icon: <Flame className="w-4 h-4" />,
            desc: 'Hotter market. Focused on homes sold in the last 6 months.',
            criteria: '6mo, Street Sweep, Mail Carrier Style',
            apply: () => {
                setHousesPerRoute(10000);
                setMaxRouteDistance(50);
                setStreetCooldownDays(14);
                setMinScore(0);
                setSoldDateFilter(6);
                setSortBy('score');
                setRouteConfig(prev => ({ ...prev, minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, excludeAssigned: true, excludeCommercial: true, excludeCondos: true, excludePreviouslyKnocked: true, excludeLand: true }));
                toast.success("6 Month Sweep applied");
            }
        },
        {
            id: '1mo',
            name: '1 Month Sweep',
            icon: <Zap className="w-4 h-4" />,
            desc: 'Ultra fresh leads. Just the homes sold in the last 30 days.',
            criteria: '1mo, Street Sweep, Mail Carrier Style',
            apply: () => {
                setHousesPerRoute(10000);
                setMaxRouteDistance(50);
                setStreetCooldownDays(7);
                setMinScore(0);
                setSoldDateFilter(1);
                setSortBy('score');
                setRouteConfig(prev => ({ ...prev, minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, excludeAssigned: true, excludeCommercial: true, excludeCondos: true, excludePreviouslyKnocked: true, excludeLand: true }));
                toast.success("1 Month Sweep applied");
            }
        },
        {
            id: 'newest_first',
            name: 'Newest Homes First',
            icon: <Footprints className="w-4 h-4" />,
            desc: 'Starts the Mail Carrier sweep at the most recently sold home in your area.',
            criteria: '12mo, Start at Newest, Street Sweep',
            apply: () => {
                setHousesPerRoute(10000);
                setMaxRouteDistance(50);
                setStreetCooldownDays(14);
                setMinScore(0);
                setSoldDateFilter(12);
                setSortBy('recent_sale'); // Hits logic to start at newest
                setRouteConfig(prev => ({ ...prev, minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, excludeAssigned: true, excludeCommercial: true, excludeCondos: true, excludePreviouslyKnocked: true, excludeLand: true }));
                toast.success("Newest Homes First applied");
            }
        }
    ];

    const resetFilters = () => {
        setHousesPerRoute(10000);
        setRouteConfig({
            walkingPattern: 'street_sweep',
            minimizeTurns: true,
            use2Opt: true,
            returnToStart: false,
            excludeTerminal: true,
            includeCallbacks: true,
            excludeAssigned: true,
            excludeCommercial: true,
            excludeCondos: true,
            excludePreviouslyKnocked: true,
            excludeLand: true,
            propertyTypes: [],
            minPrice: null,
            maxPrice: null,
            minYearBuilt: null,
            maxYearBuilt: null,
            minLotSize: null,
            maxLotSize: null,
            minBeds: null,
            minBaths: null,
            minSqft: null,
            maxSqft: null
        });
        setMinScore(0);
        setMaxRouteDistance(50);
        setSoldDateFilter(12);
        toast.success("Filters reset to default routing settings.");
    };

    return (
        <div className="fixed inset-0 z-[2000]">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <div
                className="absolute top-0 right-0 bottom-0 w-full max-w-md overflow-hidden pt-[env(safe-area-inset-top)] backdrop-blur-xl shadow-2xl animate-in slide-in-from-right duration-300"
                style={{ background: 'rgba(10, 10, 10, 0.97)', borderLeft: '1px solid rgba(255, 255, 255, 0.1)' }}
            >
                {/* Header */}
                <div className="p-4 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                    <h2 className="flex items-center gap-2 font-bold tracking-wide" style={{ color: BRAND.gold }}>
                        <Navigation className="w-5 h-5" />
                        ROUTE BUILDER
                    </h2>
                    <button onClick={onClose} className="p-2 hover:bg-[#333] rounded-full transition-colors">
                        <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                    </button>
                </div>

                <div className="p-4 pb-0">
                    <div className="flex p-1 bg-[#1A1A1A] rounded-xl border border-gray-800">
                        <button
                            onClick={() => setViewMode('simple')}
                            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${viewMode === 'simple' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-500 hover:text-white'}`}
                        >
                            SIMPLE
                        </button>
                        <button
                            onClick={() => setViewMode('advanced')}
                            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${viewMode === 'advanced' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-500 hover:text-white'}`}
                        >
                            ADVANCED
                        </button>
                    </div>
                </div>

                <div className="overflow-y-auto h-[calc(100%-180px)] pb-24">
                    {viewMode === 'simple' ? (
                        <div className="p-4 space-y-6">
                            {/* Target Area */}
                            <div className="space-y-3">
                                <div className="flex justify-between items-center">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">1. Target Area</label>
                                    <button
                                        onClick={onDraw}
                                        className="text-[10px] font-bold text-yellow-500 hover:text-yellow-400 flex items-center gap-1 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/30"
                                    >
                                        <Pencil className="w-3 h-3" /> {hasDrawnArea ? 'Redraw' : 'Draw on Map'}
                                    </button>
                                </div>
                                {hasDrawnArea ? (
                                    <div className="w-full px-4 py-3 rounded-xl text-sm bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 flex items-center justify-between">
                                        <span>Custom Drawn Area Active</span>
                                    </div>
                                ) : (
                                    <div className="w-full px-4 py-3 rounded-xl text-sm bg-[#1A1A1A] text-gray-400 border border-[#222] text-center">
                                        Draw an area on the map to target
                                    </div>
                                )}
                            </div>

                            {/* Recently Sold Filter */}
                            <div className="space-y-4 pt-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">2. Recently Sold</label>
                                    <span className="text-sm font-bold text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                                        {soldDateFilter ? `${soldDateFilter} Months` : '6 Months'}
                                    </span>
                                </div>
                                <Slider
                                    value={[soldDateFilter === null ? 100 : (soldDateFilter <= 1 ? 0 : soldDateFilter <= 3 ? 25 : soldDateFilter <= 6 ? 50 : soldDateFilter <= 9 ? 75 : 100)]}
                                    onValueChange={([v]) => {
                                        let val = 6;
                                        if (v === 0) val = 1;
                                        else if (v === 25) val = 3;
                                        else if (v === 50) val = 6;
                                        else if (v === 75) val = 9;
                                        else if (v === 100) val = 12;
                                        setSoldDateFilter(val);
                                    }}
                                    min={0}
                                    max={100}
                                    step={25}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-gray-600 font-medium px-1">
                                    <span>1 Mo</span>
                                    <span>3 Mo</span>
                                    <span>6 Mo</span>
                                    <span>9 Mo</span>
                                    <span>12 Mo</span>
                                </div>
                            </div>

                            {/* Route Size */}
                            <div className="space-y-3 pt-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">3. Route Size</label>
                                <div className="flex p-1 bg-[#1A1A1A] rounded-xl border border-gray-800">
                                    <button
                                        onClick={() => setHousesPerRoute(10000)}
                                        className={`flex-1 py-2 text-[10px] font-bold rounded-lg transition-all ${housesPerRoute === 10000 ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-500 hover:text-white'}`}
                                    >
                                        ALL IN ONE ROUTE
                                    </button>
                                    <button
                                        onClick={() => setHousesPerRoute(50)}
                                        className={`flex-1 py-2 text-[10px] font-bold rounded-lg transition-all ${housesPerRoute !== 10000 ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-500 hover:text-white'}`}
                                    >
                                        HOUSES PER ROUTE
                                    </button>
                                </div>
                                
                                {housesPerRoute !== 10000 && (
                                    <div className="space-y-4 pt-4">
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Houses per Route</span>
                                            <span className="text-sm font-bold text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">{housesPerRoute}</span>
                                        </div>
                                        <Slider
                                            value={[housesPerRoute]}
                                            onValueChange={([v]) => setHousesPerRoute(v)}
                                            min={10}
                                            max={200}
                                            step={10}
                                            className="w-full"
                                        />
                                        <div className="flex justify-between text-[10px] text-gray-600 font-medium px-1">
                                            <span>Small (10)</span>
                                            <span>Standard (60)</span>
                                            <span>Large (200)</span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Strategy Selection */}
                            <div className="space-y-3 pt-2">
                                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">4. Build Strategy</label>
                                <div className="space-y-3">
                                    {STRATEGIES.map(strategy => (
                                        <button
                                            key={strategy.id}
                                            onClick={() => { strategy.apply(); setActivePreset(strategy.id); }}
                                            className={`w-full p-4 rounded-xl border transition-all text-left relative overflow-hidden group ${activePreset === strategy.id ? 'bg-yellow-500/10 border-yellow-500' : 'bg-[#1A1A1A] border-gray-800 hover:border-gray-600'}`}
                                        >
                                            <div className="flex items-center gap-3 mb-1">
                                                <div className={`p-2 rounded-lg ${activePreset === strategy.id ? 'bg-yellow-500 text-black' : 'bg-gray-800 text-gray-400'}`}>
                                                    {strategy.icon}
                                                </div>
                                                <span className={`text-sm font-bold ${activePreset === strategy.id ? 'text-yellow-500' : 'text-white'}`}>{strategy.name}</span>
                                            </div>
                                            <p className="text-xs text-gray-500 leading-snug pr-8">{strategy.desc}</p>
                                            <div className="mt-2 flex items-center gap-1.5">
                                                <Badge className="bg-white/5 text-[9px] text-gray-400 border-none font-medium px-2 py-0.5">
                                                    {strategy.criteria}
                                                </Badge>
                                            </div>
                                            {activePreset === strategy.id && (
                                                <div className="absolute top-4 right-4 text-yellow-500">
                                                    <Zap className="w-4 h-4 fill-current" />
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            {/* === TERRITORY & SIZE === */}
                            <SettingsSection
                                title="TERRITORY & SIZE"
                                icon={<Target className="w-4 h-4" />}
                                expanded={expandedSection === 'core' || expandedSection === 'presets'} // default open
                                onToggle={() => toggleSection('core')}
                            >
                                {/* Target Area */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Target Area</label>
                                        <button
                                            onClick={onDraw}
                                            className="text-[10px] font-bold text-yellow-500 hover:text-yellow-400 flex items-center gap-1 bg-yellow-500/10 px-2 py-0.5 rounded border border-yellow-500/30"
                                        >
                                            <Pencil className="w-3 h-3" /> {hasDrawnArea ? 'Redraw' : 'Draw on Map'}
                                        </button>
                                    </div>
                                    {hasDrawnArea ? (
                                        <div className="w-full px-3 py-2 rounded-lg text-xs bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 flex items-center justify-between">
                                            <span>Custom Drawn Area Active</span>
                                        </div>
                                    ) : (
                                        <div className="w-full px-3 py-2 rounded-lg text-xs bg-[#1F1F1F] text-gray-500 border border-[#333] text-center">
                                            Draw an area on the map to target
                                        </div>
                                    )}
                                </div>

                                {/* Houses Per Route */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Houses Per Route</label>
                                    <div className="grid grid-cols-6 gap-1.5">
                                        <button
                                            onClick={() => {
                                                setHousesPerRoute(10000);
                                            }}
                                            className={`py-2.5 rounded-lg text-xs font-bold transition-all col-span-6 mb-1 flex items-center justify-center gap-2 ${housesPerRoute === 10000
                                                ? 'bg-yellow-500 text-black shadow-lg'
                                                : 'bg-[#1F1F1F] text-gray-400 hover:bg-[#2a2a2a] border border-gray-800'
                                                }`}
                                        >
                                            {!(user?.subscription_status === 'active' || user?.subscription_status === 'trialing' || user?.is_owner) && <Lock className="w-3 h-3" />}
                                            ALL IN ONE ROUTE
                                        </button>
                                        {ROUTE_SIZE_OPTIONS.map(size => {
                                            const isLocked = false; // Unlocked for testing
                                            return (
                                                <button
                                                    key={size}
                                                    onClick={() => {
                                                        if (isLocked) {
                                                            toast.error("Free plan limit: 25 houses per route. Upgrade for more.");
                                                            setTimeout(() => { if (onClose) onClose(); window.location.href = '/Billing'; }, 1500);
                                                        } else {
                                                            setHousesPerRoute(size);
                                                        }
                                                    }}
                                                    className={`py-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1 ${housesPerRoute === size
                                                        ? 'bg-yellow-500 text-black shadow-lg'
                                                        : isLocked ? 'bg-[#1F1F1F]/50 text-gray-600 border border-gray-800 overflow-hidden relative' : 'bg-[#1F1F1F] text-gray-400 hover:bg-[#2a2a2a] border border-gray-800'
                                                        }`}
                                                >
                                                    {isLocked && <Lock className="w-2.5 h-2.5" />}
                                                    {size}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Starting Location */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Starting Location</label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            placeholder="Enter start address..."
                                            value={startAddressInput}
                                            onChange={(e) => setStartAddressInput(e.target.value)}
                                            className="flex-1 px-3 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] focus:border-yellow-500 focus:outline-none"
                                        />
                                        <Button
                                            onClick={() => {
                                                if (mapRef?.current) {
                                                    const c = mapRef.current.getCenter();
                                                    setStartLocation({ lat: c.lat, lng: c.lng, address: startAddressInput || "Map Center" });
                                                    toast.success("Start location set");
                                                }
                                            }}
                                            size="icon"
                                            className="bg-[#1F1F1F] hover:bg-[#333] shrink-0"
                                        >
                                            <MapPin className="w-4 h-4" />
                                        </Button>
                                    </div>
                                    {startLocation ? (
                                        <div className="flex justify-between items-center">
                                            <p className="text-[10px] text-green-500">✓ {startLocation.address}</p>
                                            <button onClick={() => { setStartLocation(null); setStartAddressInput(""); }} className="text-[10px] text-red-400">Clear</button>
                                        </div>
                                    ) : (
                                        <p className="text-[10px] text-gray-600 italic">Defaults to map center</p>
                                    )}
                                </div>
                            </SettingsSection>

                            {/* === PROPERTY FILTERS === */}
                            <SettingsSection
                                title="ADVANCED PROPERTY FILTERS"
                                icon={<Shield className="w-4 h-4" />}
                                expanded={expandedSection === 'filters'}
                                onToggle={() => toggleSection('filters')}
                            >
                                <div className="mb-4 pt-1 flex justify-end">
                                    <button 
                                        onClick={resetFilters} 
                                        className="text-[10px] uppercase font-bold text-red-400 hover:text-red-300 transition-colors bg-red-400/10 px-3 py-1.5 rounded-lg border border-red-400/20"
                                    >
                                        Reset to Defaults
                                    </button>
                                </div>

                                {/* Sold Date Filter */}
                                <div className="space-y-4 mb-4">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Recently Sold</label>
                                        <span className="text-xs font-bold text-yellow-500">{soldDateFilter ? `${soldDateFilter} Months` : '6 Months'}</span>
                                    </div>
                                    <Slider
                                        value={[soldDateFilter === null ? 100 : (soldDateFilter <= 1 ? 0 : soldDateFilter <= 3 ? 25 : soldDateFilter <= 6 ? 50 : soldDateFilter <= 9 ? 75 : 100)]}
                                        onValueChange={([v]) => {
                                            let val = 6;
                                            if (v === 0) val = 1;
                                            else if (v === 25) val = 3;
                                            else if (v === 50) val = 6;
                                            else if (v === 75) val = 9;
                                            else if (v === 100) val = 12;
                                            setSoldDateFilter(val);
                                        }}
                                        min={0}
                                        max={100}
                                        step={25}
                                        className="w-full"
                                    />
                                    <div className="flex justify-between text-[10px] text-gray-600 font-medium px-1">
                                        <span>1 Mo</span>
                                        <span>3 Mo</span>
                                        <span>6 Mo</span>
                                        <span>9 Mo</span>
                                        <span>12 Mo</span>
                                    </div>
                                </div>

                                {/* Property Type Filter */}
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Property Types</label>
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {['All', 'Single Family', 'Condo', 'Townhouse', 'Multi-Family', 'Other'].map(type => {
                                            const isActive = routeConfig.propertyTypes.includes(type) || (type === 'All' && routeConfig.propertyTypes.length === 0);
                                            return (
                                                <button key={type} onClick={() => {
                                                    if (type === 'All') {
                                                        setRouteConfig(prev => ({ ...prev, propertyTypes: [] }));
                                                    } else {
                                                        setRouteConfig(prev => {
                                                            const current = prev.propertyTypes;
                                                            const updated = current.includes(type) ? current.filter(t => t !== type) : [...current, type];
                                                            return { ...prev, propertyTypes: updated };
                                                        });
                                                    }
                                                }}
                                                    className={`py-2 rounded-lg text-[9px] font-bold transition-all ${isActive ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50' : 'bg-[#1A1A1A] text-gray-500 border border-gray-800'
                                                        }`}
                                                >{type}</button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Price Range */}
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Price Range</label>
                                    <div className="flex gap-2 items-center">
                                        <input type="number" placeholder="Min" value={routeConfig.minPrice || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, minPrice: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                        <span className="text-gray-600 text-xs">to</span>
                                        <input type="number" placeholder="Max" value={routeConfig.maxPrice || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, maxPrice: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                    </div>
                                </div>

                                {/* Year Built Range */}
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Year Built</label>
                                        <span className="text-[10px] text-gray-600">
                                            {routeConfig.minYearBuilt || 'Any'} – {routeConfig.maxYearBuilt || 'Any'}
                                        </span>
                                    </div>
                                    <div className="flex gap-2 items-center">
                                        <input type="number" placeholder="From" value={routeConfig.minYearBuilt || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, minYearBuilt: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                        <span className="text-gray-600 text-xs">to</span>
                                        <input type="number" placeholder="To" value={routeConfig.maxYearBuilt || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, maxYearBuilt: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                    </div>
                                </div>

                                {/* RentCast Filters: Beds, Baths, Sqft, Lot Size */}
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Beds & Baths (Min)</label>
                                    <div className="flex gap-2 items-center">
                                        <input type="number" placeholder="Beds" value={routeConfig.minBeds || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, minBeds: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                        <input type="number" placeholder="Baths" value={routeConfig.minBaths || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, minBaths: e.target.value ? parseFloat(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Square Footage</label>
                                    <div className="flex gap-2 items-center">
                                        <input type="number" placeholder="Min Sqft" value={routeConfig.minSqft || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, minSqft: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                        <span className="text-gray-600 text-xs">to</span>
                                        <input type="number" placeholder="Max Sqft" value={routeConfig.maxSqft || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, maxSqft: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Lot Size (Sqft)</label>
                                    <div className="flex gap-2 items-center">
                                        <input type="number" placeholder="Min Lot" value={routeConfig.minLotSize || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, minLotSize: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                        <span className="text-gray-600 text-xs">to</span>
                                        <input type="number" placeholder="Max Lot" value={routeConfig.maxLotSize || ''}
                                            onChange={(e) => setRouteConfig(prev => ({ ...prev, maxLotSize: e.target.value ? parseInt(e.target.value) : null }))}
                                            className="flex-1 px-2 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] text-center"
                                        />
                                    </div>
                                </div>



                                <div className="pt-2 space-y-2 border-t border-gray-800/50">
                                    {/* Exclude Terminal Statuses */}
                                    <ToggleOption
                                        label="Exclude Sold & Hard No"
                                        description="Skip properties already marked sold or hard no"
                                        icon={<Shield className="w-4 h-4" />}
                                        checked={routeConfig.excludeTerminal}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeTerminal: v }))}
                                    />

                                    {/* Include Callbacks */}
                                    <ToggleOption
                                        label="Include Callbacks"
                                        description="Add callback properties back into new routes"
                                        icon={<Clock className="w-4 h-4" />}
                                        checked={routeConfig.includeCallbacks}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, includeCallbacks: v }))}
                                    />

                                    <div className="pt-2 mt-2 border-t border-gray-800/30 space-y-2">
                                        <ToggleOption
                                            label="Exclude Commercial"
                                            description="Filter out businesses, offices, and retail"
                                            icon={<Shield className="w-4 h-4 text-orange-400" />}
                                            checked={routeConfig.excludeCommercial}
                                            onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeCommercial: v }))}
                                        />
                                        <ToggleOption
                                            label="Exclude Condos"
                                            description="Filter out apartments and condo units"
                                            icon={<Layers className="w-4 h-4 text-blue-400" />}
                                            checked={routeConfig.excludeCondos}
                                            onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeCondos: v }))}
                                        />
                                        <ToggleOption
                                            label="Exclude Vacant Land"
                                            description="Filter out lots, vacant land, and acreage"
                                            icon={<Layers className="w-4 h-4 text-emerald-400" />}
                                            checked={routeConfig.excludeLand}
                                            onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeLand: v }))}
                                        />
                                        <ToggleOption
                                            label="Hide Knocked Doors"
                                            description="Never route a house you've already visited"
                                            icon={<Footprints className="w-4 h-4 text-green-400" />}
                                            checked={routeConfig.excludePreviouslyKnocked}
                                            onChange={(v) => setRouteConfig(prev => ({ ...prev, excludePreviouslyKnocked: v }))}
                                        />
                                    </div>
                                </div>
                            </SettingsSection>

                            {/* === ROUTING BEHAVIOR === */}
                            <SettingsSection
                                title="ROUTING BEHAVIOR"
                                icon={<Route className="w-4 h-4" />}
                                expanded={expandedSection === 'optimization'}
                                onToggle={() => toggleSection('optimization')}
                            >


                                {/* Max Route Distance */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Max Walking Distance</label>
                                        <span className="text-xs font-bold text-yellow-500">{maxRouteDistance >= 50 ? 'Unlimited' : `${maxRouteDistance} mi`}</span>
                                    </div>
                                    <Slider
                                        value={[maxRouteDistance]}
                                        onValueChange={([v]) => setMaxRouteDistance(v)}
                                        min={1}
                                        max={50}
                                        step={1}
                                        className="w-full"
                                    />
                                </div>

                                {/* Street Cooldown */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Street Cooldown</label>
                                        <span className="text-xs font-bold text-yellow-500">{streetCooldownDays} days</span>
                                    </div>
                                    <Slider value={[streetCooldownDays]} onValueChange={([v]) => setStreetCooldownDays(v)} min={0} max={120} step={1} className="w-full" />
                                    <div className="flex gap-2">
                                        {[0, 7, 14, 30, 60, 90].map(d => (
                                            <button key={d} onClick={() => setStreetCooldownDays(d)}
                                                className={`flex-1 py-1 rounded text-[9px] font-bold transition-all ${streetCooldownDays === d ? 'bg-yellow-500 text-black' : 'bg-[#1A1A1A] text-gray-500 hover:text-white'
                                                    }`}
                                            >{d === 0 ? 'OFF' : `${d}d`}</button>
                                        ))}
                                    </div>
                                </div>

                                <div className="pt-2 space-y-2 border-t border-gray-800/50">
                                    {/* Minimize Turns */}
                                    <ToggleOption
                                        label="Minimize Turns"
                                        description="Prefer straighter paths, fewer direction changes"
                                        icon={<Compass className="w-4 h-4" />}
                                        checked={routeConfig.minimizeTurns}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, minimizeTurns: v }))}
                                    />

                                    {/* Use 2-Opt */}
                                    <ToggleOption
                                        label="Path Smoothing (2-Opt)"
                                        description="Uncross overlapping paths for shorter total distance"
                                        icon={<ScanLine className="w-4 h-4" />}
                                        checked={routeConfig.use2Opt}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, use2Opt: v }))}
                                    />

                                    {/* Return to Start */}
                                    <ToggleOption
                                        label="Loop Back to Start"
                                        description="End the route near where it began"
                                        icon={<RefreshCw className="w-4 h-4" />}
                                        checked={routeConfig.returnToStart}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, returnToStart: v }))}
                                    />
                                </div>
                            </SettingsSection>

                            {/* === TEMPLATES & DISPLAY === */}
                            <SettingsSection
                                title="TEMPLATES & DISPLAY"
                                icon={<Shuffle className="w-4 h-4" />}
                                expanded={expandedSection === 'templates' || expandedSection === 'display'}
                                onToggle={() => toggleSection('templates')}
                            >


                                {routeTemplates.length > 0 && (
                                    <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Load Saved Template</label>
                                        <div className="space-y-1.5">
                                            {routeTemplates.map(t => (
                                                <button key={t.id} onClick={() => onLoadTemplate(t)}
                                                    className="w-full flex items-center justify-between p-3 rounded-lg bg-[#1A1A1A] border border-gray-800 hover:border-gray-600 transition-all text-left"
                                                >
                                                    <span className="text-xs font-bold text-white">{t.name}</span>
                                                    <span className="text-[9px] text-gray-500">{t.config?.houses_per_route || '?'} houses</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Save Current as Template</label>
                                    <div className="flex gap-2">
                                        <input
                                            className="flex-1 bg-[#1F1F1F] border border-gray-700 rounded-lg px-3 py-2 text-base text-white focus:border-yellow-500 focus:outline-none"
                                            placeholder="Template Name"
                                            value={templateName}
                                            onChange={(e) => setTemplateName(e.target.value)}
                                        />
                                        <Button onClick={onSaveTemplate} size="sm" className="bg-yellow-500 text-black hover:bg-yellow-400 font-bold text-xs shrink-0">
                                            SAVE
                                        </Button>
                                    </div>
                                </div>
                            </SettingsSection>
                        </>
                    )}


                    {/* Generated Routes List (if any) */}
                    {filteredRoutes.length > 0 && (
                        <div className="px-4 pt-4">
                            <h3 className="text-xs font-bold tracking-wide mb-3" style={{ color: BRAND.gold }}>
                                TOP ROUTES ({filteredRoutes.length})
                            </h3>
                            <div className="space-y-2">
                                {filteredRoutes.slice(0, 20).map((route, idx) => (
                                    <div
                                        key={route.id}
                                        className="p-3 rounded-lg flex items-center justify-between cursor-pointer transition-all hover:opacity-80"
                                        style={{ background: BRAND.charcoal, borderLeft: `3px solid ${['#FFD700', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'][idx % 8]}` }}
                                        onClick={() => onSelectRoute(route)}
                                    >
                                        <div>
                                            <p className="font-bold text-sm text-white">{route.name}</p>
                                            <p className="text-xs text-gray-500">{route.houseCount} houses • {route.totalDistance}mi</p>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-bold text-lg" style={{ color: BRAND.gold }}>{route.competitivenessScore}</p>
                                            <p className="text-[9px] text-gray-500">score</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Sticky Bottom Actions */}
                <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#0A0A0A] border-t border-gray-800 z-10 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                    <div className="flex gap-2">
                        <Button
                            onClick={() => {
                                if (!hasDrawnArea) {
                                    onDraw();
                                    return;
                                }
                                
                                onGenerate();
                            }}
                            disabled={routesGenerating}
                            className={`${hasFrozenData ? 'flex-1' : 'flex-1'} h-12 font-bold tracking-wide bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg`}
                        >
                            {routesGenerating ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> BUILDING...</>
                            ) : !hasDrawnArea ? (
                                <><Pencil className="w-4 h-4 mr-2" /> DRAW ON MAP</>
                            ) : (
                                <><Zap className="w-4 h-4 mr-2" /> GENERATE ROUTES</>
                            )}
                        </Button>

                        {hasFrozenData && hasDrawnArea && !routesGenerating && (
                            <Button
                                onClick={onReorder}
                                className="h-12 px-4 font-bold tracking-wide bg-blue-600 text-white hover:bg-blue-500 shadow-lg"
                            >
                                <RefreshCw className="w-4 h-4 mr-2" /> REORDER
                            </Button>
                        )}

                        {hasDrawnArea && !routesGenerating && (
                            <Button
                                onClick={onClearPolygon}
                                className="h-12 px-4 bg-gray-600/20 text-gray-400 border border-gray-700 hover:bg-gray-600/40"
                            >
                                <X className="w-5 h-5" />
                                <span className="ml-2 text-xs font-bold">CLEAR AREA</span>
                            </Button>
                        )}

                        <Button
                            onClick={onReset}
                            size="icon"
                            className="h-12 w-12 bg-red-900/20 text-red-500 border border-red-900/50 hover:bg-red-900/40 shrink-0"
                        >
                            <RefreshCw className="w-5 h-5" />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SettingsSection({ title, icon, expanded, onToggle, children }) {
    return (
        <div className="border-b border-gray-800/50">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <span className="text-yellow-500">{icon}</span>
                    <span className="text-xs font-bold text-gray-300 tracking-wider">{title}</span>
                </div>
                {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
            </button>
            {expanded && (
                <div className="px-4 pb-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                    {children}
                </div>
            )}
        </div>
    );
}

function ToggleOption({ label, description, icon, checked, onChange }) {
    return (
        <div className="flex items-center justify-between p-3 rounded-lg bg-[#1A1A1A] border border-gray-800">
            <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="text-gray-400 shrink-0">{icon}</span>
                <div className="min-w-0">
                    <p className="text-xs font-bold text-gray-300">{label}</p>
                    <p className="text-[9px] text-gray-600 leading-tight">{description}</p>
                </div>
            </div>
            <button
                onClick={() => onChange(!checked)}
                className={`w-10 h-6 rounded-full transition-all relative shrink-0 ml-3 ${checked ? 'bg-yellow-500' : 'bg-gray-700'
                    }`}
            >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow ${checked ? 'left-5' : 'left-1'
                    }`} />
            </button>
        </div>
    );
}