import React from 'react';

export default function DataStatusIndicator({ user }) {
    const hasPulledData = !!user?.has_pulled_data;
    const propertyCount = user?.territory_property_count || 0;

    if (!user) return null;

    return (
        <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold tracking-wide border backdrop-blur-md ${
            hasPulledData 
                ? 'bg-green-500/10 border-green-500/30 text-green-400' 
                : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${hasPulledData ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            {hasPulledData ? (
                <span>{propertyCount > 0 ? propertyCount.toLocaleString() : 'LIVE'}</span>
            ) : (
                <span>NO DATA</span>
            )}
        </div>
    );
}