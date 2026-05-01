import React from 'react';

export default function DataStatusIndicator({ user }) {
    const hasPulledData = !!user?.has_pulled_data;
    if (!user) return null;

    return (
        <div className={`flex items-center justify-center gap-0 sm:gap-1 h-8 w-8 sm:h-auto sm:w-auto sm:px-2 sm:py-1 rounded-lg sm:rounded-full text-[9px] font-bold tracking-wide border backdrop-blur-md shrink-0 ${
            hasPulledData 
                ? 'bg-green-500/10 border-green-500/30 text-green-400' 
                : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${hasPulledData ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            {hasPulledData ? (
                <span className="hidden sm:inline">DATA READY</span>
            ) : (
                <span className="hidden sm:inline">NO DATA</span>
            )}
        </div>
    );
}