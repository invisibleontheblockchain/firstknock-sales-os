import React from 'react';
import { SlidersHorizontal } from 'lucide-react';

// One control surface for the page. The old header stacked three always-on rows
// (time tabs + source row + status chips) that mostly restated each other, so
// source/status now live behind a single Filters toggle.
export const TIME_TABS = [
    { id: 'today', label: 'Today' },
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'this_week', label: 'Week' },
    { id: 'past', label: 'Past' },
    { id: 'all', label: 'All' },
];

const SOURCES = [
    { id: 'all', label: 'All types' },
    { id: 'callbacks', label: 'Callbacks' },
    { id: 'appointments', label: 'Appointments' },
];

const STATUSES = [
    { id: 'all', label: 'Any status' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'confirmed', label: 'Confirmed' },
    { id: 'completed', label: 'Completed' },
    { id: 'cancelled', label: 'Cancelled' },
    { id: 'no_show', label: 'No show' },
];

export default function AppointmentsFilterBar({
    timeFilter,
    onTimeFilterChange,
    sourceFilter,
    onSourceFilterChange,
    statusFilter,
    onStatusFilterChange,
    counts = {},
}) {
    const [showFilters, setShowFilters] = React.useState(false);
    const refinedCount = (sourceFilter !== 'all' ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0);

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <div className="flex-1 grid grid-cols-5 gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.05]">
                    {TIME_TABS.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => onTimeFilterChange(tab.id)}
                            className={`h-9 rounded-lg text-[10px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 ${
                                timeFilter === tab.id ? 'bg-white text-black shadow-sm' : 'text-gray-500 hover:text-white'
                            }`}
                        >
                            {tab.label}
                            {counts[tab.id] > 0 && (
                                <span className={`text-[9px] font-black ${timeFilter === tab.id ? 'text-black/50' : 'text-gray-600'}`}>
                                    {counts[tab.id]}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                <button
                    onClick={() => setShowFilters((open) => !open)}
                    className={`h-11 px-3 shrink-0 rounded-xl border text-[10px] font-bold flex items-center gap-1.5 transition-all ${
                        showFilters || refinedCount > 0
                            ? 'border-white/15 bg-white/[0.08] text-white'
                            : 'border-white/[0.05] bg-white/[0.03] text-gray-500 hover:text-white'
                    }`}
                >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    {refinedCount > 0 ? refinedCount : <span className="hidden sm:inline">Filters</span>}
                </button>
            </div>

            {showFilters && (
                <div className="flex flex-wrap gap-1.5 p-2 rounded-xl bg-white/[0.02] border border-white/[0.05] animate-in fade-in slide-in-from-top-1">
                    {SOURCES.map((source) => (
                        <button
                            key={source.id}
                            onClick={() => onSourceFilterChange(source.id)}
                            className={`h-8 px-3 rounded-full text-[10px] font-bold border transition-all ${
                                sourceFilter === source.id
                                    ? 'bg-[#39FF4A]/15 border-[#39FF4A]/30 text-[#39FF4A]'
                                    : 'border-white/[0.05] text-gray-500 hover:text-white'
                            }`}
                        >
                            {source.label}
                        </button>
                    ))}
                    <div className="w-px self-stretch bg-white/[0.06] mx-1 hidden sm:block" />
                    {STATUSES.map((status) => (
                        <button
                            key={status.id}
                            onClick={() => onStatusFilterChange(status.id)}
                            className={`h-8 px-3 rounded-full text-[10px] font-bold border transition-all ${
                                statusFilter === status.id
                                    ? 'bg-white/[0.08] border-white/15 text-white'
                                    : 'border-white/[0.05] text-gray-600 hover:text-gray-300'
                            }`}
                        >
                            {status.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}