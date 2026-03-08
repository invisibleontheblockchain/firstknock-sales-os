import React from 'react';
import { Calendar } from 'lucide-react';
import { Button } from "@/components/ui/button";

const PRESETS = [
    { label: '7D', days: 7 },
    { label: '14D', days: 14 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: 'ALL', days: null },
];

export default function DateRangeFilter({ selectedDays, onChangeDays, accent = '#FFD700' }) {
    return (
        <div className="flex items-center gap-1.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-inner shrink-0">
            <Calendar className="w-3.5 h-3.5 text-gray-400 ml-2 drop-shadow-md" />
            {PRESETS.map(p => (
                <Button
                    key={p.label}
                    variant="ghost"
                    size="sm"
                    onClick={() => onChangeDays(p.days)}
                    className={`h-7 px-3 text-[10px] font-bold rounded-lg transition-all duration-300 ${
                        selectedDays === p.days ? 'text-black shadow-[0_0_10px_rgba(255,215,0,0.3)]' : 'text-gray-400 hover:text-white hover:bg-white/5'
                    }`}
                    style={selectedDays === p.days ? { background: accent } : {}}
                >
                    {p.label}
                </Button>
            ))}
        </div>
    );
}