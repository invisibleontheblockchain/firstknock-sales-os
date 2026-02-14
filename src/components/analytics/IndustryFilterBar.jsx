import React from 'react';
import { Button } from "@/components/ui/button";
import { getIndustryLabel } from '../appointments/EligibilityScorer';

export default function IndustryFilterBar({ industries, selected, onSelect, accent = '#FFD700' }) {
    return (
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
            <Button
                variant="ghost"
                size="sm"
                onClick={() => onSelect('all')}
                className={`h-7 px-3 text-[10px] font-bold rounded-lg shrink-0 ${
                    selected === 'all' ? 'text-black' : 'text-gray-500 hover:text-white'
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
                    className={`h-7 px-3 text-[10px] font-bold rounded-lg shrink-0 ${
                        selected === ind ? 'text-black' : 'text-gray-500 hover:text-white'
                    }`}
                    style={selected === ind ? { background: accent } : {}}
                >
                    {getIndustryLabel(ind).toUpperCase()}
                </Button>
            ))}
        </div>
    );
}