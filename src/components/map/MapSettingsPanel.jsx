import React from 'react';
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { X, Sun, Moon, Palette, Globe, Mountain, Eye, EyeOff, Maximize2, Minimize2, GitBranch } from 'lucide-react';

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

export default function MapSettingsPanel({ 
    mapTheme, 
    setMapTheme, 
    teamMembers, 
    repColors, 
    onUpdateRepColor,
    onClose,
    quickFilter,
    setQuickFilter,
    showRouteDetails,
    setShowRouteDetails,
    navigationApp,
    setNavigationApp,
    // New display settings
    pinSize = 5, setPinSize,
    showRouteLines = false, setShowRouteLines,
    showStreetLabels = true, setShowStreetLabels,
    clusterPins = false, setClusterPins,
}) {
    const STATUS_FILTERS = [
        { id: 'all', label: 'ALL', color: '#E5E5E5' },
        { id: 'eligible', label: 'NOT VISITED', color: '#6b7280' },
        { id: 'sold', label: 'SOLD', color: '#22c55e' },
        { id: 'rejected', label: 'UNDECIDED', color: '#8B5CF6' },
    ];

    return (
        <div className="fixed inset-0 z-[2000]">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
            <div
                className="absolute top-0 right-0 bottom-0 w-full max-w-sm overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl shadow-2xl animate-in slide-in-from-right duration-300"
                style={{ background: 'rgba(10, 10, 10, 0.95)', borderLeft: '1px solid rgba(255, 255, 255, 0.1)' }}
            >
                <div className="p-5 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                    <h2 className="flex items-center gap-2 font-bold tracking-wide" style={{ color: BRAND.gold }}>
                        <Palette className="w-5 h-5" />
                        MAP SETTINGS
                    </h2>
                    <button onClick={onClose} className="p-2 hover:bg-[#333] rounded-full transition-colors">
                        <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                    </button>
                </div>

                <div className="p-5 space-y-6 overflow-y-auto h-[calc(100%-70px)]">
                    
                    {/* Status Visibility Filters (Moved from Map) */}
                    <div>
                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                            MAP DISPLAY
                        </label>
                        <div className="flex gap-2 mb-4">
                            <button
                                onClick={() => setShowRouteDetails(!showRouteDetails)}
                                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all border ${
                                    showRouteDetails
                                        ? 'bg-yellow-500 text-black border-yellow-500'
                                        : 'bg-[#1A1A1A] text-gray-400 border-gray-800'
                                }`}
                            >
                                {showRouteDetails ? 'SHOWING PINS' : 'SHOWING RANK'}
                            </button>
                        </div>

                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                            STATUS VISIBILITY
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {STATUS_FILTERS.map(f => (
                                <button
                                    key={f.id}
                                    onClick={() => setQuickFilter && setQuickFilter(f.id)}
                                    className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs font-bold transition-all border ${
                                        quickFilter === f.id 
                                            ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500' 
                                            : 'bg-[#1A1A1A] border-gray-800 text-gray-400 hover:border-gray-600'
                                    }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full" style={{ background: f.color }} />
                                        {f.label}
                                    </div>
                                    {quickFilter === f.id ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 opacity-50" />}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Navigation App Preference */}
                    <div>
                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                            NAVIGATION APP
                        </label>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setNavigationApp('apple')}
                                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-xs font-bold transition-all ${
                                    navigationApp === 'apple' 
                                        ? 'bg-yellow-500 text-black shadow-lg' 
                                        : 'bg-[#1F1F1F] text-gray-400 hover:text-white border border-gray-700'
                                }`}
                            >
                                 Apple Maps
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
                    </div>

                    {/* Map Theme Toggle */}
                    <div>
                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                            MAP STYLE
                        </label>
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
                    </div>

                    {/* Rep Color Assignments */}
                    <div>
                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                            TEAM PIN COLORS
                        </label>
                        <p className="text-[10px] text-gray-500 mb-4">
                            Assign colors to each rep. These colors appear on the map for their routes.
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
                    </div>

                    {/* Legend Preview */}
                    <div>
                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                            MAP LEGEND PREVIEW
                        </label>
                        <div className="bg-black/40 rounded-lg p-3 border border-gray-800 space-y-2">
                            {teamMembers.map(member => (
                                <div key={member.id} className="flex items-center gap-2 text-xs">
                                    <span 
                                        className="w-3 h-3 rounded-full"
                                        style={{ background: repColors[member.id] || '#FFD700' }}
                                    />
                                    <span className="text-white">{member.name}</span>
                                </div>
                            ))}
                            <div className="flex items-center gap-2 text-xs opacity-50 pt-1 border-t border-gray-800">
                                <span className="w-3 h-3 rounded-full bg-[#666]" />
                                <span className="text-white">Unassigned Routes</span>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
}