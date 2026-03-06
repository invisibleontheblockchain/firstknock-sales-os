import React from 'react';
import { Database, Lock } from 'lucide-react';

export default function DataStatusIndicator({ user }) {
    const hasPulledData = !!user?.has_pulled_data;
    const propertyCount = user?.territory_property_count || 0;

    if (!user) return null;

    return (
        <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] font-bold tracking-wide border shadow-lg backdrop-blur-md ${
            hasPulledData 
                ? 'bg-green-500/10 border-green-500/30 text-green-400' 
                : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
            <div className={`w-2 h-2 rounded-full ${hasPulledData ? 'bg-green-500 animate-pulse' : 'bg-red-500 animate-pulse'}`} />
            {hasPulledData ? (
                <span className="drop-shadow-[0_0_6px_rgba(34,197,94,0.6)]">
                    DATA ACTIVE{propertyCount > 0 ? ` • ${propertyCount.toLocaleString()}` : ''}
                </span>
            ) : (
                <span className="drop-shadow-[0_0_6px_rgba(239,68,68,0.6)]">NO DATA</span>
            )}
        </div>
    );
}