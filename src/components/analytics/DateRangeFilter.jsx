import React from 'react';
import { Calendar } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { format } from 'date-fns';

const PRESETS = [
    { label: '7D', days: 7 },
    { label: '14D', days: 14 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
    { label: 'ALL', days: null },
];

export default function DateRangeFilter({ selectedDays, onChangeDays, accent = '#FFD700' }) {
    return (
        <div className="flex items-center gap-1.5 bg-black/50 border border-gray-800 rounded-xl p-1">
            <Calendar className="w-3.5 h-3.5 text-gray-500 ml-2" />
            {PRESETS.map(p => (
                <Button
                    key={p.label}
                    variant="ghost"
                    size="sm"
                    onClick={() => onChangeDays(p.days)}
                    className={`h-7 px-2.5 text-[10px] font-bold rounded-lg transition-all ${
                        selectedDays === p.days ? 'text-black shadow' : 'text-gray-500 hover:text-white'
                    }`}
                    style={selectedDays === p.days ? { background: accent } : {}}
                >
                    {p.label}
                </Button>
            ))}
        </div>
    );
}