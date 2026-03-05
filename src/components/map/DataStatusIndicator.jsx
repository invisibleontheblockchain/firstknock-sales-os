import React from 'react';
import { Database, Lock } from 'lucide-react';

export default function DataStatusIndicator({ user }) {
    const hasPulledData = !!user?.has_pulled_data;
    const propertyCount = user?.territory_property_count || 0;

    if (!user) return null;

    return (
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide border ${
            hasPulledData 
                ? 'bg-green-500/10 border-green-500/30 text-green-400' 
                : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${hasPulledData ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            {hasPulledData ? (
                <span>DATA ACTIVE{propertyCount > 0 ? ` • ${propertyCount.toLocaleString()}` : ''}</span>
            ) : (
                <span>NO DATA</span>
            )}
        </div>
    );
}