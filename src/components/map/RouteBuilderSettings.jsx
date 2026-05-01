import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
    Navigation, Loader2, MapPin, RefreshCw, X, ChevronDown, ChevronUp,
    Zap, Route, Footprints, Clock, Shield, Target,
    Shuffle, Compass, Pencil, Lock, ScanLine
} from 'lucide-react';
import { toast } from "sonner";

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100, 150, 200];

export default function RouteBuilderSettings({
    // State values
    housesPerRoute, setHousesPerRoute,
    streetCooldownDays, setStreetCooldownDays,
    minScore, setMinScore,
    zipCodeFilter, setZipCodeFilter,
    startLocation, setStartLocation,
    startAddressInput, setStartAddressInput,
    sortBy, setSortBy,
    soldDateFilter, setSoldDateFilter,
    lastPullMode,
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
    onDraw,
    // Reorder
    onReorder, hasFrozenData,
    // Data
    user,
    hasDrawnArea,
    maxDataMonths,
    hasMlsData
}) {
    const [expandedSection, setExpandedSection] = useState(null);

    // Auto-apply good defaults on initial load
    React.useEffect(() => {
        try { localStorage.removeItem('fk_autobuild_next_open'); } catch (e) { /* ignore */ }
    }, []);

    React.useEffect(() => {
        if (soldDateFilter === null) {
            setSoldDateFilter(12);
        }
    }, []);

    const toggleSection = (id) => {
        setExpandedSection(expandedSection === id ? null : id);
    };

    const resetFilters = () => {
        setHousesPerRoute(10000);
        setRouteConfig({
            walkingPattern: 'street_sweep',
            minimizeTurns: true,
            use2Opt: true,
            returnToStart: false,
            excludeTerminal: true,
            includeCallbacks: true,
            excludeAssigned: false,
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
        setSoldDateFilter(12);
        setSortBy('score');
        toast.success("Filters reset to defaults.");
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
                    <div className="flex items-center gap-2">
                        <button
                            onClick={resetFilters}
                            className="text-[10px] font-bold text-gray-500 hover:text-white flex items-center gap-1 bg-white/5 px-2 py-1 rounded-lg border border-gray-800 transition-colors"
                        >
                            <RefreshCw className="w-3 h-3" /> Reset
                        </button>
                        <button onClick={onClose} className="p-2 hover:bg-[#333] rounded-full transition-colors">
                            <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                        </button>
                    </div>
                </div>

                <div className="overflow-y-auto h-[calc(100%-180px)] pb-24">
                    <div className="p-4 space-y-6">

                        {/* ═══ 1. TARGET AREA ═══ */}
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

                        {/* ═══ 2. RECENTLY SOLD ═══ */}
                        <div className="space-y-3">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">2. Recently Sold</label>
                            {lastPullMode === '300mi' ? (
                                <>
                                    <div className="flex gap-1.5">
                                        <div className="flex-1 py-3 rounded-lg text-xs font-bold bg-yellow-500 text-black shadow-lg text-center">
                                            1 Mo
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[9px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-2 py-1.5">
                                        <Lock className="w-3 h-3 shrink-0" />
                                        <span>Locked to 1 month — 300mi² pull only contains 1 month of data</span>
                                    </div>
                                </>
                            ) : (
                                <div className="flex gap-1.5">
                                    {[{ label: '1', val: 1 }, { label: '3', val: 3 }, { label: '6', val: 6 }, { label: '9', val: 9 }, { label: '12', val: 12 }].map(opt => {
                                        const isDisabled = maxDataMonths && opt.val > maxDataMonths;
                                        return (
                                            <button
                                                key={opt.val}
                                                onClick={() => !isDisabled && setSoldDateFilter(opt.val)}
                                                disabled={isDisabled}
                                                className={`flex-1 py-3 rounded-lg text-xs font-bold transition-all ${
                                                    isDisabled
                                                        ? 'bg-[#111] text-gray-700 border border-gray-800/50 cursor-not-allowed opacity-40'
                                                        : (soldDateFilter || 12) === opt.val
                                                            ? 'bg-yellow-500 text-black shadow-lg'
                                                            : 'bg-[#1A1A1A] text-gray-500 border border-gray-800 active:bg-[#252525]'
                                                }`}
                                            >
                                                {opt.label}mo{isDisabled && ' 🔒'}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* ═══ 3. ROUTE SIZE ═══ */}
                        <div className="space-y-3">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">3. Route Size</label>
                            <div className="flex p-1 bg-[#1A1A1A] rounded-xl border border-gray-800">
                                <button
                                    onClick={() => setHousesPerRoute(10000)}
                                    className={`flex-1 py-2 text-[10px] font-bold rounded-lg transition-all ${housesPerRoute >= 10000 ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-500 hover:text-white'}`}
                                >
                                    ALL IN ONE ROUTE
                                </button>
                                <button
                                    onClick={() => setHousesPerRoute(50)}
                                    className={`flex-1 py-2 text-[10px] font-bold rounded-lg transition-all ${housesPerRoute < 10000 ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-500 hover:text-white'}`}
                                >
                                    HOUSES PER ROUTE
                                </button>
                            </div>
                            {housesPerRoute < 10000 && (
                                <div className="space-y-3 pt-2">
                                    <div className="flex justify-between items-center">
                                        <span className="text-[10px] font-bold text-gray-500 uppercase">Houses per Route</span>
                                        <span className="text-sm font-bold text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">{housesPerRoute}</span>
                                    </div>
                                    <div className="grid grid-cols-6 gap-1.5">
                                        {ROUTE_SIZE_OPTIONS.map(size => (
                                            <button
                                                key={size}
                                                onClick={() => setHousesPerRoute(size)}
                                                className={`py-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center ${housesPerRoute === size ? 'bg-yellow-500 text-black shadow-lg' : 'bg-[#1F1F1F] text-gray-400 hover:bg-[#2a2a2a] border border-gray-800'}`}
                                            >
                                                {size}
                                            </button>
                                        ))}
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

                        {/* ═══ COLLAPSIBLE: FILTERS ═══ */}
                        <CollapsibleSection
                            title="Filters"
                            icon={<Shield className="w-4 h-4" />}
                            expanded={expandedSection === 'filters'}
                            onToggle={() => toggleSection('filters')}
                            badge={routeConfig.propertyTypes?.length > 0 || routeConfig.minPrice || routeConfig.maxPrice ? 'Active' : null}
                        >
                            {/* Property Type — pick what to include */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-bold text-gray-500 uppercase">Include Property Types</label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {[
                                        { label: 'All', key: 'all' },
                                        { label: 'Single Family', key: 'Single Family' },
                                        { label: 'Townhouse', key: 'Townhouse' },
                                        { label: 'Condo', key: 'Condo' },
                                        { label: 'Multi-Family', key: 'Multi-Family' },
                                        { label: 'Other', key: 'Other' },
                                    ].map(type => {
                                        const isAll = type.key === 'all';
                                        const isActive = isAll
                                            ? routeConfig.propertyTypes.length === 0
                                            : routeConfig.propertyTypes.includes(type.key);
                                        return (
                                            <button key={type.key} onClick={() => {
                                                if (isAll) {
                                                    setRouteConfig(prev => ({ ...prev, propertyTypes: [], excludeCommercial: false, excludeCondos: false, excludeLand: false }));
                                                } else {
                                                    setRouteConfig(prev => {
                                                        const current = prev.propertyTypes;
                                                        const updated = current.includes(type.key) ? current.filter(t => t !== type.key) : [...current, type.key];
                                                        return { ...prev, propertyTypes: updated };
                                                    });
                                                }
                                            }}
                                                className={`py-2.5 rounded-lg text-[9px] font-bold transition-all ${isActive ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50' : 'bg-[#1A1A1A] text-gray-500 border border-gray-800'
                                                    }`}
                                            >{type.label}</button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Price Range */}
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Price Range</label>
                                    {(routeConfig.minPrice || routeConfig.maxPrice) && (
                                        <button onClick={() => setRouteConfig(prev => ({ ...prev, minPrice: null, maxPrice: null }))}
                                            className="text-[9px] font-bold text-gray-500 hover:text-white"
                                        >Clear</button>
                                    )}
                                </div>
                                <div className="flex gap-2 items-center">
                                    <div className="flex-1 relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                                        <input
                                            type="text" inputMode="numeric" placeholder="Min"
                                            value={routeConfig.minPrice ? routeConfig.minPrice.toLocaleString() : ''}
                                            onChange={(e) => {
                                                const raw = e.target.value.replace(/[^0-9]/g, '');
                                                setRouteConfig(prev => ({ ...prev, minPrice: raw ? parseInt(raw) : null }));
                                            }}
                                            className="w-full pl-7 pr-2 py-3 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333] focus:border-yellow-500 focus:outline-none"
                                        />
                                    </div>
                                    <span className="text-gray-600 text-xs">to</span>
                                    <div className="flex-1 relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                                        <input
                                            type="text" inputMode="numeric" placeholder="Max"
                                            value={routeConfig.maxPrice ? routeConfig.maxPrice.toLocaleString() : ''}
                                            onChange={(e) => {
                                                const raw = e.target.value.replace(/[^0-9]/g, '');
                                                setRouteConfig(prev => ({ ...prev, maxPrice: raw ? parseInt(raw) : null }));
                                            }}
                                            className="w-full pl-7 pr-2 py-3 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333] focus:border-yellow-500 focus:outline-none"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Skip rules */}
                            <div className="pt-2 border-t border-gray-800/50 space-y-2">
                                <label className="text-[10px] font-bold text-gray-500 uppercase">Skip Rules</label>
                                <ToggleOption
                                    label="Exclude Sold & Hard No"
                                    description="Skip properties already marked sold or hard no"
                                    icon={<Shield className="w-4 h-4" />}
                                    checked={routeConfig.excludeTerminal}
                                    onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeTerminal: v }))}
                                />
                                <ToggleOption
                                    label="Include Callbacks"
                                    description="Add callback properties back into new routes"
                                    icon={<Clock className="w-4 h-4" />}
                                    checked={routeConfig.includeCallbacks}
                                    onChange={(v) => setRouteConfig(prev => ({ ...prev, includeCallbacks: v }))}
                                />
                                <ToggleOption
                                    label="Hide Already Routed"
                                    description="Only turn this on when you want brand-new routes and do not want to reuse doors from saved routes"
                                    icon={<Route className="w-4 h-4 text-blue-400" />}
                                    checked={routeConfig.excludeAssigned}
                                    onChange={(v) => setRouteConfig(prev => ({ ...prev, excludeAssigned: v }))}
                                />
                                <ToggleOption
                                    label="Hide Knocked Doors"
                                    description="Never route a house you've already visited"
                                    icon={<Footprints className="w-4 h-4 text-green-400" />}
                                    checked={routeConfig.excludePreviouslyKnocked}
                                    onChange={(v) => setRouteConfig(prev => ({ ...prev, excludePreviouslyKnocked: v }))}
                                />
                                {hasMlsData && (
                                    <ToggleOption
                                        label="Include Early Signal (MLS)"
                                        description="Include off-market MLS homes that haven't been deed-confirmed yet. May still have For Sale signs."
                                        icon={<Target className="w-4 h-4 text-orange-400" />}
                                        checked={routeConfig.includeUnverifiedSales}
                                        onChange={(v) => setRouteConfig(prev => ({ ...prev, includeUnverifiedSales: v }))}
                                    />
                                )}
                            </div>
                        </CollapsibleSection>

                        {/* ═══ COLLAPSIBLE: ROUTING BEHAVIOR ═══ */}
                        <CollapsibleSection
                            title="Routing Behavior"
                            icon={<Route className="w-4 h-4" />}
                            expanded={expandedSection === 'routing'}
                            onToggle={() => toggleSection('routing')}
                        >
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
                                            className={`flex-1 py-1 rounded text-[9px] font-bold transition-all ${streetCooldownDays === d ? 'bg-yellow-500 text-black' : 'bg-[#1A1A1A] text-gray-500 hover:text-white'
                                                }`}
                                        >{d === 0 ? 'OFF' : `${d}d`}</button>
                                    ))}
                                </div>
                            </div>

                            {/* Toggle Options */}
                            <ToggleOption
                                label="Minimize Turns"
                                description="Prefer straighter paths, fewer direction changes"
                                icon={<Compass className="w-4 h-4" />}
                                checked={routeConfig.minimizeTurns}
                                onChange={(v) => setRouteConfig(prev => ({ ...prev, minimizeTurns: v }))}
                            />
                            <ToggleOption
                                label="Path Smoothing (2-Opt)"
                                description="Uncross overlapping paths for shorter total distance"
                                icon={<ScanLine className="w-4 h-4" />}
                                checked={routeConfig.use2Opt}
                                onChange={(v) => setRouteConfig(prev => ({ ...prev, use2Opt: v }))}
                            />
                            <ToggleOption
                                label="Loop Back to Start"
                                description="End the route near where it began"
                                icon={<RefreshCw className="w-4 h-4" />}
                                checked={routeConfig.returnToStart}
                                onChange={(v) => setRouteConfig(prev => ({ ...prev, returnToStart: v }))}
                            />
                        </CollapsibleSection>

                        {/* ═══ COLLAPSIBLE: TEMPLATES ═══ */}
                        <CollapsibleSection
                            title="Templates"
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
                        </CollapsibleSection>

                    </div>

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
                            className="flex-1 h-12 font-bold tracking-wide bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg"
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

function CollapsibleSection({ title, icon, expanded, onToggle, badge, children }) {
    return (
        <div className="rounded-xl border border-gray-800/60 overflow-hidden">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors bg-[#111]"
            >
                <div className="flex items-center gap-2">
                    <span className="text-yellow-500">{icon}</span>
                    <span className="text-xs font-bold text-gray-300 tracking-wider uppercase">{title}</span>
                    {badge && (
                        <Badge className="bg-yellow-500/20 text-yellow-500 text-[9px] border-none h-4 px-1.5">{badge}</Badge>
                    )}
                </div>
                {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
            </button>
            {expanded && (
                <div className="px-4 pb-4 pt-2 space-y-4 animate-in slide-in-from-top-2 duration-200 bg-[#0D0D0D]">
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

function ChipFilter({ label, options, currentMin, currentMax, onChange }) {
    const isMatch = (opt) => {
        return (opt.min === (currentMin || null)) && (opt.max === (currentMax || null));
    };

    return (
        <div className="space-y-2">
            <label className="text-[10px] font-bold text-gray-500 uppercase">{label}</label>
            <div className="flex flex-wrap gap-1.5">
                {options.map(opt => {
                    const active = isMatch(opt);
                    return (
                        <button
                            key={opt.label}
                            onClick={() => onChange(opt.min, opt.max)}
                            className={`px-3 py-2 rounded-lg text-[10px] font-bold transition-all ${active
                                ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50'
                                : 'bg-[#1A1A1A] text-gray-500 border border-gray-800 active:bg-[#252525]'
                                }`}
                        >
                            {opt.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}