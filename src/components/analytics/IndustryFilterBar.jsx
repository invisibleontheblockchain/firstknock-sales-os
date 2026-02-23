import React from 'react';
import { Button } from "@/components/ui/button";
import { getIndustryLabel } from '../appointments/EligibilityScorer';

export default function IndustryFilterBar({ industries, selected, onSelect, accent = '#FFD700' }) {
    return (
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar bg-black/60 backdrop-blur-md border border-white/10 rounded-xl p-1 shadow-inner">
            <Button
                variant="ghost"
                size="sm"
                onClick={() => onSelect('all')}
                className={`h-7 px-4 text-[10px] font-bold rounded-lg shrink-0 transition-all duration-300 ${
                    selected === 'all' ? 'text-black shadow-[0_0_10px_rgba(255,215,0,0.3)]' : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
                style={selected === 'all' ? { background: accent } : {}}
            >
                ALL
            </Button>
            {industries.map(ind => (
                <Button
                    key={ind}
                    variant="ghost"
                    size="sm"
                    onClick={() => onSelect(ind)}
                    className={`h-7 px-4 text-[10px] font-bold rounded-lg shrink-0 transition-all duration-300 ${
                        selected === ind ? 'text-black shadow-[0_0_10px_rgba(255,215,0,0.3)]' : 'text-gray-400 hover:text-white hover:bg-white/5'
                    }`}
                    style={selected === ind ? { background: accent } : {}}
                >
                    {getIndustryLabel(ind).toUpperCase()}
                </Button>
            ))}
        </div>
    );
}