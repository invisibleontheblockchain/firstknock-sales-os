import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
    Navigation, Loader2, MapPin, RefreshCw, X, ChevronDown, ChevronUp,
    Zap, Route, Footprints, Clock, Shield, Flame, Target, Shuffle,
    ArrowUpDown, GitBranch, ScanLine, Compass, Pencil, Layers
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
    onForceSync, onClearArea,
    onDraw, // New prop for enabling drawing mode
    // Data
    user,
    hasDrawnArea
}) {
    const [expandedSection, setExpandedSection] = useState('presets');
    const [activePreset, setActivePreset] = useState(null);
    const [viewMode, setViewMode] = useState('simple'); // 'simple' or 'advanced'

    // Auto-build when panel opens based on saved Map Settings or a one-time flag
    React.useEffect(() => {
        try {
            const settingsRaw = localStorage.getItem('fk_mapSettings_v3');
            const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
            const autoOnClick = !!settings.autoBuildOnGenerateButton;
            const pendingOnce = localStorage.getItem('fk_autobuild_next_open') === 'true';
            if ((autoOnClick || pendingOnce) && !routesGenerating) {
                // slight delay to allow UI to render
                setTimeout(() => { onGenerate && onGenerate(); }, 50);
                if (pendingOnce) localStorage.removeItem('fk_autobuild_next_open');
            }
        } catch (e) { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleSection = (id) => {
        setExpandedSection(expandedSection === id ? null : id);
    };

    const STRATEGIES = [
        {
            id: 'best',
            name: 'FirstKnock Best',
            icon: <Zap className="w-4 h-4" />,
            desc: 'Ultra-optimized for newest homeowners. Starts at the most recently sold home and builds the route from there.',
            criteria: 'Recent Sales First, 50 doors, All Residential',
            apply: () => {
                setHousesPerRoute(50);
                setMaxRouteDistance(8); // Increased distance to allow connecting sparse recent sales without breaking
                setStreetCooldownDays(14);
                setMinScore(20);
                setSoldDateFilter(12); // Past 12 months
                setSortBy('recent_sale');
                setRouteConfig(prev => ({ ...prev, walkingPattern: 'recent_sale_first', minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, minPrice: null, maxPrice: null, propertyTypes: [] }));
                toast.success("FirstKnock Best applied!");
            }
        },
        {
            id: 'new_homeowners',
            name: 'Hot Market Sweep',
            icon: <Flame className="w-4 h-4" />,
            desc: 'Sweeps entire streets that have high recent sales activity. Great for hitting dense pockets.',
            criteria: 'Street Sweep, Past 36mo sales, 75 doors',
            apply: () => {
                setHousesPerRoute(75);
                setMaxRouteDistance(6);
                setStreetCooldownDays(14);
                setMinScore(0);
                setSoldDateFilter(36); // Past 3 years (all data we pull)
                setSortBy('score');
                setRouteConfig(prev => ({ ...prev, walkingPattern: 'street_sweep', minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, minPrice: null, maxPrice: null, propertyTypes: [] }));
                toast.success("Hot Market Sweep applied");
            }
        },
        {
            id: 'speed',
            name: 'Speed Blitz',
            icon: <Footprints className="w-4 h-4" />,
            desc: 'Max doors in minimum time. Shortest walking distance, no filters.',
            criteria: '60 doors, nearest door, no score filter',
            apply: () => {
                setHousesPerRoute(60);
                setMaxRouteDistance(3);
                setStreetCooldownDays(0);
                setMinScore(0);
                setSoldDateFilter(null);
                setSortBy('distance');
                setRouteConfig(prev => ({ ...prev, walkingPattern: 'nearest', minimizeTurns: false, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: false, minPrice: null, maxPrice: null, propertyTypes: [] }));
                toast.success("Speed Blitz applied");
            }
        }
    ];

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
                            {!hasDrawnArea ? (
                            <div className="space-y-3">
                                <div className="flex justify-between items-center">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">1. Target Area</label>
                                    <button
                                        onClick={onDraw}
                                        className="text-[10px] font-bold text-yellow-500 hover:text-yellow-400 flex items-center gap-1 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/30"
                                    >
                                        <Pencil className="w-3 h-3" /> Draw on Map
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    placeholder="Enter Zip Code(s) e.g. 90210"
                                    value={zipCodeFilter}
                                    onChange={(e) => setZipCodeFilter(e.target.value)}
                                    className="w-full px-4 py-3 rounded-xl text-base bg-[#1A1A1A] text-white border border-[#222] focus:border-yellow-500 focus:outline-none transition-colors"
                                />
                            </div>
                            ) : (
                            <div className="space-y-3">
                                <div className="flex justify-between items-center">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">1. Target Area</label>
                                </div>
                                <div className="w-full px-4 py-3 rounded-xl text-sm bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 flex items-center justify-between">
                                    <span>Custom Drawn Area Active</span>
                                    <button onClick={onDraw} className="text-[10px] font-bold underline hover:text-yellow-400">
                                        Redraw
                                    </button>
                                </div>
                            </div>
                            )}

                            {/* Recently Sold Filter */}
                            <div className="space-y-4 pt-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">2. Recently Sold</label>
                                    <span className="text-sm font-bold text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                                        {soldDateFilter ? `${soldDateFilter} Months` : '12 Months'}
                                    </span>
                                </div>
                                <Slider
                                    value={[soldDateFilter || 12]}
                                    onValueChange={([v]) => setSoldDateFilter(v)}
                                    min={3}
                                    max={12}
                                    step={3}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-gray-600 font-medium px-1">
                                    <span>3 Mo</span>
                                    <span>6 Mo</span>
                                    <span>9 Mo</span>
                                    <span>12 Mo</span>
                                </div>
                            </div>

                            {/* Simple House Count */}
                            <div className="space-y-4 pt-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">3. Houses per Route</label>
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
                                {/* Zip Code Filter */}
                                {!hasDrawnArea ? (
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Target Zip Codes</label>
                                        <button
                                            onClick={onDraw}
                                            className="text-[10px] font-bold text-yellow-500 hover:text-yellow-400 flex items-center gap-1 bg-yellow-500/10 px-2 py-0.5 rounded border border-yellow-500/30"
                                        >
                                            <Pencil className="w-3 h-3" /> Draw on Map
                                        </button>
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="e.g. 90210, 90001"
                                        value={zipCodeFilter}
                                        onChange={(e) => setZipCodeFilter(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg text-base bg-[#1F1F1F] text-white border border-[#333] focus:border-yellow-500 focus:outline-none"
                                    />
                                </div>
                                ) : (
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Target Area</label>
                                    </div>
                                    <div className="w-full px-3 py-2 rounded-lg text-xs bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 flex items-center justify-between">
                                        <span>Custom Drawn Area Active</span>
                                        <button onClick={onDraw} className="text-[9px] font-bold underline hover:text-yellow-400">
                                            Redraw
                                        </button>
                                    </div>
                                </div>
                                )}

                                {/* Houses Per Route */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Houses Per Route</label>
                                    <div className="grid grid-cols-6 gap-1.5">
                                        {ROUTE_SIZE_OPTIONS.map(size => (
                                            <button
                                                key={size}
                                                onClick={() => setHousesPerRoute(size)}
                                                className={`py-2.5 rounded-lg text-xs font-bold transition-all ${housesPerRoute === size
                                                    ? 'bg-yellow-500 text-black shadow-lg'
                                                    : 'bg-[#1F1F1F] text-gray-400 hover:bg-[#2a2a2a] border border-gray-800'
                                                    }`}
                                            >
                                                {size}
                                            </button>
                                        ))}
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
                                title="PROPERTY FILTERS"
                                icon={<Shield className="w-4 h-4" />}
                                expanded={expandedSection === 'filters'}
                                onToggle={() => toggleSection('filters')}
                            >
                                {/* Sold Date Filter */}
                                <div className="space-y-4 mb-4 pt-2">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Recently Sold</label>
                                        <span className="text-xs font-bold text-yellow-500">{soldDateFilter ? `${soldDateFilter} Months` : '12 Months'}</span>
                                    </div>
                                    <Slider
                                        value={[soldDateFilter || 12]}
                                        onValueChange={([v]) => setSoldDateFilter(v)}
                                        min={3}
                                        max={12}
                                        step={3}
                                        className="w-full"
                                    />
                                    <div className="flex justify-between text-[10px] text-gray-600 font-medium px-1">
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

                                {/* Min Score */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Minimum Property Score</label>
                                        <span className="text-xs font-bold text-yellow-500">{minScore}</span>
                                    </div>
                                    <Slider value={[minScore]} onValueChange={([v]) => setMinScore(v)} min={0} max={200} step={5} className="w-full" />
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

                                    {/* Exclude Saved Routes */}
                                    <ToggleOption
                                        label="Exclude Saved Routes"
                                        description="Don't build over properties already in a saved route"
                                        icon={<Layers className="w-4 h-4" />}
                                        checked={routeConfig.excludeAssigned !== false}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeAssigned: v }))}
                                    />

                                    {/* Include Callbacks */}
                                    <ToggleOption
                                        label="Include Callbacks"
                                        description="Add callback properties back into new routes"
                                        icon={<Clock className="w-4 h-4" />}
                                        checked={routeConfig.includeCallbacks}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, includeCallbacks: v }))}
                                    />
                                </div>
                            </SettingsSection>

                            {/* === ROUTING BEHAVIOR === */}
                            <SettingsSection
                                title="ROUTING BEHAVIOR"
                                icon={<Route className="w-4 h-4" />}
                                expanded={expandedSection === 'optimization'}
                                onToggle={() => toggleSection('optimization')}
                            >
                                {/* Walking Pattern */}
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Walking Pattern</label>
                                    <div className="grid grid-cols-2 gap-2">
                                        {[
                                            { id: 'street_sweep', label: 'Street Sweep', desc: 'Mailman style — one side, then the other', icon: Footprints },
                                            { id: 'recent_sale_first', label: 'Recent Sale First', desc: 'Start at the most recently sold home', icon: Flame },
                                            { id: 'nearest', label: 'Nearest Door', desc: 'Always go to the closest next house', icon: Target },
                                            { id: 'zigzag', label: 'Zig-Zag', desc: 'Cross street back & forth', icon: GitBranch },
                                            { id: 'cluster', label: 'Cluster Hop', desc: 'Hit dense pockets first, then expand', icon: Flame },
                                        ].map(pattern => {
                                            const Icon = pattern.icon;
                                            const isActive = routeConfig.walkingPattern === pattern.id;
                                            return (
                                                <button
                                                    key={pattern.id}
                                                    onClick={() => setRouteConfig(prev => ({ ...prev, walkingPattern: pattern.id }))}
                                                    className={`p-3 rounded-lg text-left transition-all border ${isActive
                                                        ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500'
                                                        : 'bg-[#1A1A1A] border-gray-800 text-gray-400 hover:border-gray-600'
                                                        }`}
                                                >
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <Icon className="w-3.5 h-3.5" />
                                                        <span className="text-xs font-bold">{pattern.label}</span>
                                                    </div>
                                                    <p className="text-[9px] text-gray-500 leading-tight">{pattern.desc}</p>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Max Route Distance */}
                                <div className="space-y-2 pt-2 border-t border-gray-800/50">
                                    <div className="flex justify-between items-center">
                                        <label className="text-[10px] font-bold text-gray-500 uppercase">Max Walking Distance</label>
                                        <span className="text-xs font-bold text-yellow-500">{maxRouteDistance} mi</span>
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
                                <div className="space-y-2 mb-4">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Sort Routes By</label>
                                    <div className="grid grid-cols-2 gap-2">
                                        {[
                                            { id: 'score', label: 'SCORE', desc: 'Best leads first' },
                                            { id: 'houses', label: 'SIZE', desc: 'Most houses' },
                                            { id: 'distance', label: 'DISTANCE', desc: 'Shortest walk' },
                                            { id: 'recent_sale', label: 'RECENT SALE', desc: 'Newest homeowners' },
                                        ].map(opt => (
                                            <button key={opt.id} onClick={() => setSortBy(opt.id)}
                                                className={`py-3 rounded-lg text-center transition-all ${sortBy === opt.id ? 'bg-yellow-500 text-black' : 'bg-[#1F1F1F] text-gray-400 border border-gray-800'
                                                    }`}
                                            >
                                                <span className="text-xs font-bold block">{opt.label}</span>
                                                <span className="text-[8px] block mt-0.5 opacity-60">{opt.desc}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

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
                <div className="p-4 bg-[#0A0A0A] border-t border-gray-800 shrink-0">
                    <div className="flex gap-2">
                        <Button
                            onClick={async () => {
                                const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
                                const isOwner = user?.is_owner === true || user?.email?.toLowerCase().includes('christian');
                                
                                if (!isPaid && !isOwner && user?.has_generated_routes) {
                                    window.location.href = '/Billing';
                                    return;
                                }
                                
                                onGenerate();
                                
                                if (!isPaid && !isOwner && !user?.has_generated_routes) {
                                    try { await base44.auth.updateMe({ has_generated_routes: true }); } catch(e) {}
                                }
                            }}
                            disabled={routesGenerating}
                            className="flex-1 h-12 font-bold tracking-wide bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg"
                        >
                            {routesGenerating ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> BUILDING...</>
                            ) : (
                                <><Zap className="w-4 h-4 mr-2" /> GENERATE ROUTES</>
                            )}
                        </Button>
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