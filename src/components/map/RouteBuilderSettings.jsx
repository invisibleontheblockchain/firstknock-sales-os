import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { 
    Navigation, Loader2, MapPin, RefreshCw, X, ChevronDown, ChevronUp,
    Zap, Route, Footprints, Clock, Shield, Flame, Target, Shuffle,
    ArrowUpDown, GitBranch, ScanLine, Compass, Pencil
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
    user
}) {
    const [expandedSection, setExpandedSection] = useState('presets');

    const toggleSection = (id) => {
        setExpandedSection(expandedSection === id ? null : id);
    };

    return (
        <div className="fixed inset-0 z-[2000]">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <div
                className="absolute top-0 right-0 bottom-0 w-full max-w-md overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl shadow-2xl animate-in slide-in-from-right duration-300"
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

                <div className="overflow-y-auto h-[calc(100%-130px)] pb-4">

                    {/* === CORE SETTINGS === */}
                    <SettingsSection 
                        title="CORE SETTINGS" 
                        icon={<Target className="w-4 h-4" />}
                        expanded={expandedSection === 'core'}
                        onToggle={() => toggleSection('core')}
                    >
                        {/* Starting Location */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Starting Location</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    placeholder="Enter start address..."
                                    value={startAddressInput}
                                    onChange={(e) => setStartAddressInput(e.target.value)}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333] focus:border-yellow-500 focus:outline-none"
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

                        {/* Zip Code Filter */}
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
                                className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333] focus:border-yellow-500 focus:outline-none"
                            />
                            {zipCodeFilter.trim().length >= 5 && (
                                <div className="flex gap-3">
                                    <button onClick={onForceSync} className="text-[10px] font-bold text-blue-400 hover:text-blue-300 flex items-center gap-1">
                                        <RefreshCw className="w-3 h-3" /> Force Sync
                                    </button>
                                    <button onClick={onClearArea} className="text-[10px] font-bold text-red-500 hover:text-red-400 flex items-center gap-1">
                                        <X className="w-3 h-3" /> Clear Area
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Houses Per Route */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Houses Per Route</label>
                            <div className="grid grid-cols-6 gap-1.5">
                                {ROUTE_SIZE_OPTIONS.map(size => (
                                    <button
                                        key={size}
                                        onClick={() => setHousesPerRoute(size)}
                                        className={`py-2.5 rounded-lg text-xs font-bold transition-all ${
                                            housesPerRoute === size
                                                ? 'bg-yellow-500 text-black shadow-lg'
                                                : 'bg-[#1F1F1F] text-gray-400 hover:bg-[#2a2a2a] border border-gray-800'
                                        }`}
                                    >
                                        {size}
                                    </button>
                                ))}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] text-gray-600">Custom:</span>
                                <input
                                    type="number"
                                    value={housesPerRoute}
                                    onChange={(e) => setHousesPerRoute(Math.max(5, Math.min(1000, parseInt(e.target.value) || 50)))}
                                    className="w-16 px-2 py-1 rounded text-xs bg-[#1F1F1F] text-white border border-[#333] text-center"
                                />
                            </div>
                        </div>
                    </SettingsSection>

                    {/* === ROUTE OPTIMIZATION === */}
                    <SettingsSection 
                        title="ROUTE OPTIMIZATION" 
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
                                            className={`p-3 rounded-lg text-left transition-all border ${
                                                isActive
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

                        {/* Max Route Distance */}
                        <div className="space-y-2">
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
                            <div className="flex justify-between text-[9px] text-gray-600">
                                <span>1 mi</span><span>10 mi</span><span>25 mi</span><span>50 mi</span>
                            </div>
                        </div>
                    </SettingsSection>

                    {/* === PROPERTY FILTERS === */}
                    <SettingsSection 
                        title="PROPERTY FILTERS" 
                        icon={<Shield className="w-4 h-4" />}
                        expanded={expandedSection === 'filters'}
                        onToggle={() => toggleSection('filters')}
                    >
                        {/* Min Score */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-[10px] font-bold text-gray-500 uppercase">Minimum Property Score</label>
                                <span className="text-xs font-bold text-yellow-500">{minScore}</span>
                            </div>
                            <Slider value={[minScore]} onValueChange={([v]) => setMinScore(v)} min={0} max={200} step={5} className="w-full" />
                            <p className="text-[9px] text-gray-600">Lower = more houses, higher = cherry-pick top leads</p>
                        </div>

                        {/* Street Cooldown */}
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <label className="text-[10px] font-bold text-gray-500 uppercase">Street Cooldown</label>
                                <span className="text-xs font-bold text-yellow-500">{streetCooldownDays} days</span>
                            </div>
                            <Slider value={[streetCooldownDays]} onValueChange={([v]) => setStreetCooldownDays(v)} min={0} max={120} step={1} className="w-full" />
                            <div className="flex gap-2">
                                {[0, 7, 14, 30, 60, 90].map(d => (
                                    <button key={d} onClick={() => setStreetCooldownDays(d)}
                                        className={`flex-1 py-1 rounded text-[9px] font-bold transition-all ${
                                            streetCooldownDays === d ? 'bg-yellow-500 text-black' : 'bg-[#1A1A1A] text-gray-500 hover:text-white'
                                        }`}
                                    >{d === 0 ? 'OFF' : `${d}d`}</button>
                                ))}
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
                                            className={`py-2 rounded-lg text-[9px] font-bold transition-all ${
                                                isActive ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50' : 'bg-[#1A1A1A] text-gray-500 border border-gray-800'
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
                                    className="flex-1 px-2 py-2 rounded-lg text-xs bg-[#1F1F1F] text-white border border-[#333] text-center"
                                />
                                <span className="text-gray-600 text-xs">to</span>
                                <input type="number" placeholder="Max" value={routeConfig.maxPrice || ''}
                                    onChange={(e) => setRouteConfig(prev => ({ ...prev, maxPrice: e.target.value ? parseInt(e.target.value) : null }))}
                                    className="flex-1 px-2 py-2 rounded-lg text-xs bg-[#1F1F1F] text-white border border-[#333] text-center"
                                />
                            </div>
                            <div className="flex gap-1.5">
                                {[
                                    { label: 'Any', min: null, max: null },
                                    { label: '<$200k', min: null, max: 200000 },
                                    { label: '$200-500k', min: 200000, max: 500000 },
                                    { label: '$500k+', min: 500000, max: null },
                                ].map(preset => (
                                    <button key={preset.label} onClick={() => setRouteConfig(prev => ({ ...prev, minPrice: preset.min, maxPrice: preset.max }))}
                                        className={`flex-1 py-1.5 rounded text-[9px] font-bold transition-all ${
                                            routeConfig.minPrice === preset.min && routeConfig.maxPrice === preset.max
                                                ? 'bg-yellow-500 text-black' : 'bg-[#1A1A1A] text-gray-500'
                                        }`}
                                    >{preset.label}</button>
                                ))}
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
                                    className="flex-1 px-2 py-2 rounded-lg text-xs bg-[#1F1F1F] text-white border border-[#333] text-center"
                                />
                                <span className="text-gray-600 text-xs">to</span>
                                <input type="number" placeholder="To" value={routeConfig.maxYearBuilt || ''}
                                    onChange={(e) => setRouteConfig(prev => ({ ...prev, maxYearBuilt: e.target.value ? parseInt(e.target.value) : null }))}
                                    className="flex-1 px-2 py-2 rounded-lg text-xs bg-[#1F1F1F] text-white border border-[#333] text-center"
                                />
                            </div>
                        </div>

                        {/* Sold Date Filter */}
                        <div className="space-y-2 mb-4">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Recently Sold (Months)</label>
                            <div className="flex gap-1.5">
                                {[
                                    { label: 'Any Time', val: null },
                                    { label: 'Past Month', val: 1 },
                                    { label: 'Past 3 Mo', val: 3 },
                                    { label: 'Past 6 Mo', val: 6 },
                                    { label: 'Past Year', val: 12 },
                                ].map(opt => (
                                    <button key={opt.label} onClick={() => setSoldDateFilter(opt.val)}
                                        className={`flex-1 py-1.5 rounded text-[9px] font-bold transition-all border border-gray-800 ${
                                            soldDateFilter === opt.val
                                                ? 'bg-yellow-500 text-black border-yellow-500' : 'bg-[#1A1A1A] text-gray-500 hover:text-white hover:border-gray-600'
                                        }`}
                                    >{opt.label}</button>
                                ))}
                            </div>
                        </div>

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
                    </SettingsSection>

                    {/* === DISPLAY & SORTING === */}
                    <SettingsSection 
                        title="DISPLAY & SORTING" 
                        icon={<ArrowUpDown className="w-4 h-4" />}
                        expanded={expandedSection === 'display'}
                        onToggle={() => toggleSection('display')}
                    >
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Sort Routes By</label>
                            <div className="grid grid-cols-2 gap-2">
                                {[
                                    { id: 'score', label: 'SCORE', desc: 'Best leads first' },
                                    { id: 'houses', label: 'SIZE', desc: 'Most houses' },
                                    { id: 'distance', label: 'DISTANCE', desc: 'Shortest walk' },
                                    { id: 'recent_sale', label: 'RECENT SALE', desc: 'Newest homeowners' },
                                ].map(opt => (
                                    <button key={opt.id} onClick={() => setSortBy(opt.id)}
                                        className={`py-3 rounded-lg text-center transition-all ${
                                            sortBy === opt.id ? 'bg-yellow-500 text-black' : 'bg-[#1F1F1F] text-gray-400 border border-gray-800'
                                        }`}
                                    >
                                        <span className="text-xs font-bold block">{opt.label}</span>
                                        <span className="text-[8px] block mt-0.5 opacity-60">{opt.desc}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </SettingsSection>

                    {/* === QUICK PRESETS === */}
                    <SettingsSection 
                        title="QUICK PRESETS" 
                        icon={<Zap className="w-4 h-4" />}
                        expanded={expandedSection === 'presets'}
                        onToggle={() => toggleSection('presets')}
                    >
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Optimized Builds</label>
                            <div className="space-y-2">
                                {[
                                    {
                                        name: '🏃 Speed Blitz',
                                        desc: 'Max doors in minimum time. Short routes, nearest-door pattern.',
                                        apply: () => {
                                            setHousesPerRoute(50);
                                            setMaxRouteDistance(3);
                                            setStreetCooldownDays(0);
                                            setMinScore(0);
                                            setSoldDateFilter(null);
                                            setRouteConfig(prev => ({ ...prev, walkingPattern: 'nearest', minimizeTurns: false, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: false, minPrice: null, maxPrice: null, propertyTypes: [] }));
                                            toast.success("Speed Blitz preset applied");
                                        }
                                    },
                                    {
                                        name: '🎯 High-Value Targets',
                                        desc: 'Cherry-pick expensive homes sold in last 6 months. Quality over quantity.',
                                        apply: () => {
                                            setHousesPerRoute(25);
                                            setMaxRouteDistance(10);
                                            setStreetCooldownDays(30);
                                            setMinScore(50);
                                            setSoldDateFilter(6);
                                            setRouteConfig(prev => ({ ...prev, walkingPattern: 'nearest', minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: false, minPrice: 300000, maxPrice: null, propertyTypes: ['Single Family'] }));
                                            toast.success("High-Value preset applied");
                                        }
                                    },
                                    {
                                        name: '🔥 New Homeowner Sweep',
                                        desc: 'Focus on recent sales (past 3 months). Best for solar, roofing, etc.',
                                        apply: () => {
                                            setHousesPerRoute(75);
                                            setMaxRouteDistance(8);
                                            setStreetCooldownDays(14);
                                            setMinScore(0);
                                            setSoldDateFilter(3);
                                            setSortBy('recent_sale');
                                            setRouteConfig(prev => ({ ...prev, walkingPattern: 'street_sweep', minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: true, minPrice: null, maxPrice: null, propertyTypes: [] }));
                                            toast.success("New Homeowner preset applied");
                                        }
                                    },
                                    {
                                        name: '📬 Full Street Sweep',
                                        desc: 'Mailman-style coverage. Hit every door on each street systematically.',
                                        apply: () => {
                                            setHousesPerRoute(100);
                                            setMaxRouteDistance(5);
                                            setStreetCooldownDays(60);
                                            setMinScore(0);
                                            setSoldDateFilter(null);
                                            setRouteConfig(prev => ({ ...prev, walkingPattern: 'street_sweep', minimizeTurns: true, use2Opt: true, returnToStart: true, excludeTerminal: true, includeCallbacks: true, minPrice: null, maxPrice: null, propertyTypes: [] }));
                                            toast.success("Full Street Sweep preset applied");
                                        }
                                    },
                                    {
                                        name: '💎 Premium Neighborhoods',
                                        desc: '$500k+ homes only. Low volume, high conversion potential.',
                                        apply: () => {
                                            setHousesPerRoute(20);
                                            setMaxRouteDistance(15);
                                            setStreetCooldownDays(30);
                                            setMinScore(30);
                                            setSoldDateFilter(12);
                                            setRouteConfig(prev => ({ ...prev, walkingPattern: 'cluster', minimizeTurns: true, use2Opt: true, returnToStart: false, excludeTerminal: true, includeCallbacks: false, minPrice: 500000, maxPrice: null, propertyTypes: ['Single Family'] }));
                                            toast.success("Premium preset applied");
                                        }
                                    },
                                ].map(preset => (
                                    <button
                                        key={preset.name}
                                        onClick={preset.apply}
                                        className="w-full p-3 rounded-lg bg-[#1A1A1A] border border-gray-800 hover:border-yellow-500/50 hover:bg-yellow-500/5 transition-all text-left group"
                                    >
                                        <span className="text-sm font-bold text-white group-hover:text-yellow-500 transition-colors">{preset.name}</span>
                                        <p className="text-[10px] text-gray-500 mt-1 leading-tight">{preset.desc}</p>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </SettingsSection>

                    {/* === SAVED TEMPLATES === */}
                    <SettingsSection 
                        title="MY TEMPLATES" 
                        icon={<Shuffle className="w-4 h-4" />}
                        expanded={expandedSection === 'templates'}
                        onToggle={() => toggleSection('templates')}
                    >
                        {routeTemplates.length > 0 && (
                            <div className="space-y-2">
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

                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-gray-500 uppercase">Save Current as Template</label>
                            <div className="flex gap-2">
                                <input 
                                    className="flex-1 bg-[#1F1F1F] border border-gray-700 rounded-lg px-3 py-2 text-xs text-white focus:border-yellow-500 focus:outline-none"
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
                                        style={{ background: BRAND.charcoal, borderLeft: `3px solid ${['#FFD700','#ec4899','#10b981','#f59e0b','#8b5cf6','#06b6d4','#f97316','#a855f7'][idx % 8]}` }}
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
                <div className="absolute bottom-0 left-0 right-0 p-4 bg-[#0A0A0A] border-t border-gray-800">
                    <div className="flex gap-2">
                        <Button
                            onClick={onGenerate}
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
                className={`w-10 h-6 rounded-full transition-all relative shrink-0 ml-3 ${
                    checked ? 'bg-yellow-500' : 'bg-gray-700'
                }`}
            >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow ${
                    checked ? 'left-5' : 'left-1'
                }`} />
            </button>
        </div>
    );
}