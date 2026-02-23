import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
    X, Sun, Moon, Palette, Globe, Mountain, Eye, EyeOff, 
    GitBranch, Circle, Square, Diamond, Layers, Type, 
    Droplets, Zap, RotateCcw, ChevronDown, ChevronRight, Save
} from 'lucide-react';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const REP_COLOR_OPTIONS = [
    '#FFD700', '#ef4444', '#22c55e', '#3b82f6', '#ec4899',
    '#f97316', '#8b5cf6', '#06b6d4', '#eab308', '#14b8a6',
];

const COLOR_SCHEMES = [
    { id: 'default', label: 'Default', colors: { ELIGIBLE: '#6b7280', SOLD: '#22c55e', HARD_NO: '#8B5CF6', CALLBACK: '#eab308', NO_ANSWER: '#6b7280' } },
    { id: 'neon', label: 'Neon', colors: { ELIGIBLE: '#00fff7', SOLD: '#39ff14', HARD_NO: '#ff073a', CALLBACK: '#ffed00', NO_ANSWER: '#00fff7' } },
    { id: 'pastel', label: 'Pastel', colors: { ELIGIBLE: '#a8b8c8', SOLD: '#77dd77', HARD_NO: '#b39ddb', CALLBACK: '#fff176', NO_ANSWER: '#a8b8c8' } },
    { id: 'heatmap', label: 'Heat', colors: { ELIGIBLE: '#1e3a5f', SOLD: '#ff4500', HARD_NO: '#8b0000', CALLBACK: '#ff8c00', NO_ANSWER: '#1e3a5f' } },
    { id: 'monochrome', label: 'Mono', colors: { ELIGIBLE: '#555', SOLD: '#fff', HARD_NO: '#888', CALLBACK: '#bbb', NO_ANSWER: '#555' } },
];

const LINE_STYLES = [
    { id: 'solid', label: 'Solid', dashArray: null },
    { id: 'dashed', label: 'Dashed', dashArray: '8,6' },
    { id: 'dotted', label: 'Dotted', dashArray: '2,4' },
    { id: 'dashdot', label: 'Dash-Dot', dashArray: '10,4,2,4' },
];

const PIN_SHAPES = [
    { id: 'circle', label: 'Circle', icon: Circle },
    { id: 'square', label: 'Square', icon: Square },
    { id: 'diamond', label: 'Diamond', icon: Diamond },
];

function CollapsibleSection({ title, icon: Icon, children, defaultOpen = true }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="border border-gray-800 rounded-xl overflow-hidden">
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors"
            >
                <div className="flex items-center gap-2">
                    {Icon && <Icon className="w-4 h-4 text-yellow-500" />}
                    <span className="text-xs font-bold tracking-wide text-white uppercase">{title}</span>
                </div>
                {open ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
            </button>
            {open && <div className="px-4 pb-4 space-y-4">{children}</div>}
        </div>
    );
}

export default function MapSettingsPanel({ 
    mapTheme, setMapTheme, 
    teamMembers, repColors, onUpdateRepColor,
    onClose,
    quickFilter, setQuickFilter,
    showRouteDetails, setShowRouteDetails,
    showAllProperties, setShowAllProperties,
    navigationApp, setNavigationApp,
    pinSize = 5, setPinSize,
    showRouteLines = false, setShowRouteLines,
    // New deep settings
    mapSettings, setMapSettings,
}) {
    // Local buffering state for settings
    const [localMapSettings, setLocalMapSettings] = useState(mapSettings || {});
    const [localPinSize, setLocalPinSize] = useState(pinSize);
    const [localShowRouteLines, setLocalShowRouteLines] = useState(showRouteLines);
    const [localShowRouteDetails, setLocalShowRouteDetails] = useState(showRouteDetails);
    const [localShowAllProperties, setLocalShowAllProperties] = useState(showAllProperties);
    const [localMapTheme, setLocalMapTheme] = useState(mapTheme);
    const [localNavigationApp, setLocalNavigationApp] = useState(navigationApp);
    const [localQuickFilter, setLocalQuickFilter] = useState(quickFilter);

    const update = (key, value) => {
        setLocalMapSettings(prev => ({ ...prev, [key]: value }));
    };

    const handleSave = () => {
        if (setMapSettings) setMapSettings(localMapSettings);
        if (setPinSize) setPinSize(localPinSize);
        if (setShowRouteLines) setShowRouteLines(localShowRouteLines);
        if (setShowRouteDetails) setShowRouteDetails(localShowRouteDetails);
        if (setShowAllProperties) setShowAllProperties(localShowAllProperties);
        if (setMapTheme) setMapTheme(localMapTheme);
        if (setNavigationApp) setNavigationApp(localNavigationApp);
        if (setQuickFilter) setQuickFilter(localQuickFilter);
        onClose();
    };

    const handleReset = () => {
        setLocalMapSettings({
            pinShape: 'circle',
            colorScheme: 'default',
            lineStyle: 'dashed',
            lineWidth: 2,
            lineOpacity: 0.5,
            pinOpacity: 0.85,
            pinBorderWidth: 1,
            pinBorderColor: '#000',
            showLabels: false,
            labelType: 'number',
            glowEffect: false,
            fillStyle: 'solid',
        });
        setLocalPinSize(5);
        setLocalShowRouteLines(false);
        setLocalShowRouteDetails(true);
        setLocalShowAllProperties(false);
        setLocalMapTheme('dark');
        setLocalNavigationApp('apple');
        setLocalQuickFilter('all');
    };

    const settings = localMapSettings;
    const pinShape = settings.pinShape || 'circle';
    const colorScheme = settings.colorScheme || 'default';
    const lineStyle = settings.lineStyle || 'dashed';
    const lineWidth = settings.lineWidth || 2;
    const lineOpacity = settings.lineOpacity || 0.5;
    const pinOpacity = settings.pinOpacity || 0.85;
    const pinBorderWidth = settings.pinBorderWidth || 1;
    const pinBorderColor = settings.pinBorderColor || '#000';
    const showLabels = settings.showLabels || false;
    const labelType = settings.labelType || 'number'; // number, address, status
    const routeLineColor = settings.routeLineColor || 'rep'; // 'rep' or custom hex
    const glowEffect = settings.glowEffect || false;
    const fillStyle = settings.fillStyle || 'solid'; // solid, gradient, outline

    const STATUS_FILTERS = [
        { id: 'all', label: 'ALL', color: '#E5E5E5' },
        { id: 'eligible', label: 'NOT VISITED', color: '#6b7280' },
        { id: 'sold', label: 'SOLD', color: '#22c55e' },
        { id: 'rejected', label: 'UNDECIDED', color: '#8B5CF6' },
    ];

    const activeScheme = COLOR_SCHEMES.find(s => s.id === colorScheme) || COLOR_SCHEMES[0];

    return (
        <div className="fixed inset-0 z-[2000]">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div
                className="absolute top-0 right-0 bottom-0 w-full max-w-sm overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl shadow-2xl animate-in slide-in-from-right duration-300"
                style={{ background: 'rgba(10, 10, 10, 0.97)', borderLeft: '1px solid rgba(255, 255, 255, 0.1)' }}
            >
                {/* Header */}
                <div className="px-5 py-4 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                    <h2 className="flex items-center gap-2 font-bold tracking-wide" style={{ color: BRAND.gold }}>
                        <Palette className="w-5 h-5" />
                        MAP SETTINGS
                    </h2>
                    <div className="flex items-center gap-2">
                        <button 
                            onClick={handleReset}
                            className="text-[9px] font-bold text-gray-500 hover:text-yellow-500 flex items-center gap-1 px-2 py-1 rounded bg-gray-900 hover:bg-gray-800 transition-colors"
                        >
                            <RotateCcw className="w-3 h-3" /> RESET
                        </button>
                        <button onClick={onClose} className="p-2 hover:bg-[#333] rounded-full transition-colors">
                            <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                        </button>
                    </div>
                </div>

                <ScrollArea className="h-[calc(100%-70px)]">
                    <div className="p-4 space-y-3">

                        {/* ═══ PIN APPEARANCE ═══ */}
                        <CollapsibleSection title="Pin Appearance" icon={Circle} defaultOpen={true}>
                            {/* Pin Size */}
                            {setPinSize && (
                                <div>
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-[10px] font-bold text-gray-500 uppercase">Pin Size</span>
                                        <span className="text-[10px] text-yellow-500 font-bold">{pinSize}px</span>
                                    </div>
                                    <Slider value={[pinSize]} onValueChange={([v]) => setPinSize(v)} min={2} max={14} step={1} className="w-full" />
                                    <div className="flex justify-between text-[8px] text-gray-600 mt-1">
                                        <span>Tiny</span><span>Default</span><span>Large</span>
                                    </div>
                                </div>
                            )}

                            {/* Pin Opacity */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-bold text-gray-500 uppercase">Pin Opacity</span>
                                    <span className="text-[10px] text-yellow-500 font-bold">{Math.round(pinOpacity * 100)}%</span>
                                </div>
                                <Slider value={[pinOpacity * 100]} onValueChange={([v]) => update('pinOpacity', v / 100)} min={20} max={100} step={5} className="w-full" />
                            </div>

                            {/* Fill Style */}
                            <div>
                                <span className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">Fill Style</span>
                                <div className="grid grid-cols-3 gap-2">
                                    {['solid', 'outline', 'glow'].map(style => (
                                        <button
                                            key={style}
                                            onClick={() => update('fillStyle', style)}
                                            className={`py-2 rounded-lg text-[10px] font-bold transition-all border ${
                                                fillStyle === style ? 'bg-yellow-500/15 border-yellow-500 text-yellow-500' : 'bg-[#1A1A1A] border-gray-800 text-gray-400 hover:border-gray-600'
                                            }`}
                                        >
                                            {style.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Pin Border */}
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-bold text-gray-500 uppercase">Border Width</span>
                                    <span className="text-[10px] text-yellow-500 font-bold">{pinBorderWidth}px</span>
                                </div>
                                <Slider value={[pinBorderWidth]} onValueChange={([v]) => update('pinBorderWidth', v)} min={0} max={4} step={0.5} className="w-full" />
                            </div>

                            {/* Pins On/Off */}
                            <div className="flex items-center justify-between py-1">
                                <span className="text-xs font-bold text-gray-300">Show Pins</span>
                                <Switch checked={showRouteDetails} onCheckedChange={setShowRouteDetails} />
                            </div>
                        </CollapsibleSection>

                        {/* ═══ ROUTE LINES ═══ */}
                        <CollapsibleSection title="Route Lines" icon={GitBranch} defaultOpen={true}>
                            {/* Lines On/Off */}
                            <div className="flex items-center justify-between py-1">
                                <span className="text-xs font-bold text-gray-300">Show Route Lines</span>
                                <Switch checked={showRouteLines} onCheckedChange={v => setShowRouteLines && setShowRouteLines(v)} />
                            </div>

                            {showRouteLines && (
                                <>
                                    {/* Line Style */}
                                    <div>
                                        <span className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">Line Pattern</span>
                                        <div className="space-y-2">
                                            {LINE_STYLES.map(ls => (
                                                <button
                                                    key={ls.id}
                                                    onClick={() => update('lineStyle', ls.id)}
                                                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all border ${
                                                        lineStyle === ls.id ? 'bg-yellow-500/15 border-yellow-500' : 'bg-[#1A1A1A] border-gray-800 hover:border-gray-600'
                                                    }`}
                                                >
                                                    <svg width="60" height="4" className="shrink-0">
                                                        <line x1="0" y1="2" x2="60" y2="2" 
                                                            stroke={lineStyle === ls.id ? '#FFD700' : '#666'} 
                                                            strokeWidth="2"
                                                            strokeDasharray={ls.dashArray || 'none'}
                                                        />
                                                    </svg>
                                                    <span className={`text-[10px] font-bold ${lineStyle === ls.id ? 'text-yellow-500' : 'text-gray-400'}`}>
                                                        {ls.label}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Line Width */}
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase">Line Thickness</span>
                                            <span className="text-[10px] text-yellow-500 font-bold">{lineWidth}px</span>
                                        </div>
                                        <Slider value={[lineWidth]} onValueChange={([v]) => update('lineWidth', v)} min={1} max={6} step={0.5} className="w-full" />
                                    </div>

                                    {/* Line Opacity */}
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase">Line Opacity</span>
                                            <span className="text-[10px] text-yellow-500 font-bold">{Math.round(lineOpacity * 100)}%</span>
                                        </div>
                                        <Slider value={[lineOpacity * 100]} onValueChange={([v]) => update('lineOpacity', v / 100)} min={10} max={100} step={5} className="w-full" />
                                    </div>
                                </>
                            )}
                        </CollapsibleSection>

                        {/* ═══ COLOR SCHEME ═══ */}
                        <CollapsibleSection title="Color Scheme" icon={Droplets} defaultOpen={false}>
                            <div className="space-y-2">
                                {COLOR_SCHEMES.map(scheme => (
                                    <button
                                        key={scheme.id}
                                        onClick={() => update('colorScheme', scheme.id)}
                                        className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg transition-all border ${
                                            colorScheme === scheme.id ? 'bg-yellow-500/10 border-yellow-500' : 'bg-[#1A1A1A] border-gray-800 hover:border-gray-600'
                                        }`}
                                    >
                                        <div className="flex gap-1">
                                            {Object.values(scheme.colors).slice(0, 4).map((c, i) => (
                                                <div key={i} className="w-4 h-4 rounded-full" style={{ background: c }} />
                                            ))}
                                        </div>
                                        <span className={`text-xs font-bold ${colorScheme === scheme.id ? 'text-yellow-500' : 'text-gray-400'}`}>
                                            {scheme.label}
                                        </span>
                                    </button>
                                ))}
                            </div>

                            {/* Preview Legend */}
                            <div className="bg-black/40 rounded-lg p-3 border border-gray-800 space-y-1.5 mt-2">
                                <span className="text-[9px] text-gray-600 uppercase font-bold">Preview</span>
                                {Object.entries(activeScheme.colors).map(([status, color]) => (
                                    <div key={status} className="flex items-center gap-2 text-[10px]">
                                        <div className="w-3 h-3 rounded-full" style={{ background: color }} />
                                        <span className="text-gray-400">{status.replace('_', ' ')}</span>
                                    </div>
                                ))}
                            </div>
                        </CollapsibleSection>

                        {/* ═══ LABELS & OVERLAYS ═══ */}
                        <CollapsibleSection title="Labels & Overlays" icon={Type} defaultOpen={false}>
                            <div className="flex items-center justify-between py-1">
                                <span className="text-xs font-bold text-gray-300">Show Pin Labels</span>
                                <Switch checked={showLabels} onCheckedChange={v => update('showLabels', v)} />
                            </div>

                            {showLabels && (
                                <div>
                                    <span className="text-[10px] font-bold text-gray-500 uppercase mb-2 block">Label Content</span>
                                    <div className="grid grid-cols-3 gap-2">
                                        {[
                                            { id: 'number', label: 'House #' },
                                            { id: 'address', label: 'Street' },
                                            { id: 'status', label: 'Status' },
                                        ].map(opt => (
                                            <button
                                                key={opt.id}
                                                onClick={() => update('labelType', opt.id)}
                                                className={`py-2 rounded-lg text-[10px] font-bold transition-all border ${
                                                    labelType === opt.id ? 'bg-yellow-500/15 border-yellow-500 text-yellow-500' : 'bg-[#1A1A1A] border-gray-800 text-gray-400 hover:border-gray-600'
                                                }`}
                                            >
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                        </CollapsibleSection>

                        {/* ═══ STATUS VISIBILITY ═══ */}
                        <CollapsibleSection title="Status Filter" icon={Eye} defaultOpen={false}>
                            {setShowAllProperties && (
                                <div className="flex items-center justify-between py-2 border-b border-gray-800 mb-3">
                                    <div>
                                        <span className="text-xs font-bold text-gray-300">Show All Properties</span>
                                        <p className="text-[9px] text-gray-500">Show pins not in any route</p>
                                    </div>
                                    <Switch checked={showAllProperties} onCheckedChange={setShowAllProperties} />
                                </div>
                            )}
                            <div className="grid grid-cols-2 gap-2">
                                {STATUS_FILTERS.map(f => (
                                    <button
                                        key={f.id}
                                        onClick={() => setQuickFilter && setQuickFilter(f.id)}
                                        className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                                            quickFilter === f.id 
                                                ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500' 
                                                : 'bg-[#1A1A1A] border-gray-800 text-gray-400 hover:border-gray-600'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <div className="w-2.5 h-2.5 rounded-full" style={{ background: f.color }} />
                                            {f.label}
                                        </div>
                                        {quickFilter === f.id ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 opacity-50" />}
                                    </button>
                                ))}
                            </div>
                        </CollapsibleSection>

                        {/* ═══ NAVIGATION APP ═══ */}
                        <CollapsibleSection title="Navigation App" icon={Zap} defaultOpen={false}>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setNavigationApp('apple')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-xs font-bold transition-all ${
                                        navigationApp === 'apple' 
                                            ? 'bg-yellow-500 text-black shadow-lg' 
                                            : 'bg-[#1F1F1F] text-gray-400 hover:text-white border border-gray-700'
                                    }`}
                                >
                                     Apple Maps
                                </button>
                                <button
                                    onClick={() => setNavigationApp('google')}
                                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-xs font-bold transition-all ${
                                        navigationApp === 'google' 
                                            ? 'bg-yellow-500 text-black shadow-lg' 
                                            : 'bg-[#1F1F1F] text-gray-400 hover:text-white border border-gray-700'
                                    }`}
                                >
                                    G Google Maps
                                </button>
                            </div>
                        </CollapsibleSection>

                        {/* ═══ MAP STYLE ═══ */}
                        <CollapsibleSection title="Map Style" icon={Layers} defaultOpen={false}>
                            <div className="grid grid-cols-2 gap-2">
                                {[
                                    { id: 'dark', label: 'DARK', icon: Moon },
                                    { id: 'light', label: 'LIGHT', icon: Sun },
                                    { id: 'satellite', label: 'SATELLITE', icon: Globe },
                                    { id: 'hybrid', label: 'HYBRID', icon: Mountain },
                                ].map(opt => {
                                    const Icon = opt.icon;
                                    const isActive = mapTheme === opt.id;
                                    return (
                                        <button
                                            key={opt.id}
                                            onClick={() => setMapTheme(opt.id)}
                                            className={`flex items-center justify-center gap-2 py-3 rounded-lg text-xs font-bold transition-all ${
                                                isActive
                                                    ? 'bg-yellow-500 text-black shadow-lg'
                                                    : 'bg-[#1F1F1F] text-gray-400 hover:text-white border border-gray-700'
                                            }`}
                                        >
                                            <Icon className="w-4 h-4" />
                                            {opt.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </CollapsibleSection>

                        {/* ═══ TEAM PIN COLORS ═══ */}
                        <CollapsibleSection title="Team Pin Colors" icon={Palette} defaultOpen={false}>
                            <p className="text-[10px] text-gray-500 mb-3">
                                Assign colors to each rep for their routes on the map.
                            </p>
                            
                            <div className="space-y-3">
                                {teamMembers.map(member => {
                                    const currentColor = repColors[member.id] || '#FFD700';
                                    return (
                                        <div key={member.id} className="bg-[#1A1A1A] rounded-lg p-3 border border-gray-800">
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-2">
                                                    <div 
                                                        className="w-4 h-4 rounded-full border-2 border-white/20"
                                                        style={{ background: currentColor }}
                                                    />
                                                    <span className="text-sm font-bold text-white">{member.name}</span>
                                                </div>
                                                <span className="text-[10px] text-gray-500 uppercase">{member.role}</span>
                                            </div>
                                            
                                            <div className="flex flex-wrap gap-1.5">
                                                {REP_COLOR_OPTIONS.map(color => (
                                                    <button
                                                        key={color}
                                                        onClick={() => onUpdateRepColor(member.id, color)}
                                                        className={`w-7 h-7 rounded-full transition-all ${
                                                            currentColor === color 
                                                                ? 'ring-2 ring-white ring-offset-2 ring-offset-black scale-110' 
                                                                : 'hover:scale-110'
                                                        }`}
                                                        style={{ background: color }}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}

                                {teamMembers.length === 0 && (
                                    <p className="text-sm text-gray-500 italic text-center py-4">
                                        No team members yet. Add reps in the Team page.
                                    </p>
                                )}
                            </div>

                            {/* Legend Preview */}
                            {teamMembers.length > 0 && (
                                <div className="bg-black/40 rounded-lg p-3 border border-gray-800 space-y-2 mt-3">
                                    <span className="text-[9px] text-gray-600 uppercase font-bold">Map Legend</span>
                                    {teamMembers.map(member => (
                                        <div key={member.id} className="flex items-center gap-2 text-xs">
                                            <span className="w-3 h-3 rounded-full" style={{ background: repColors[member.id] || '#FFD700' }} />
                                            <span className="text-white">{member.name}</span>
                                        </div>
                                    ))}
                                    <div className="flex items-center gap-2 text-xs opacity-50 pt-1 border-t border-gray-800">
                                        <span className="w-3 h-3 rounded-full bg-[#666]" />
                                        <span className="text-white">Unassigned Routes</span>
                                    </div>
                                </div>
                            )}
                        </CollapsibleSection>

                    </div>
                </ScrollArea>
            </div>
        </div>
    );
}