import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Full-screen overlay shown while routes are being generated.
 * Provides immediate visual feedback so the user knows their click registered,
 * even while the main thread is busy building large data structures.
 */
export default function RouteGenerationOverlay({ visible, stage = 'Preparing data...' }) {
    if (!visible) return null;

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-auto animate-in fade-in duration-200"
            style={{ background: 'rgba(0, 0, 0, 0.72)', backdropFilter: 'blur(6px)' }}
        >
            <div
                className="flex flex-col items-center gap-5 px-10 py-8 rounded-2xl"
                style={{
                    background: 'rgba(17, 17, 17, 0.95)',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(212,175,55,0.1)',
                    minWidth: 280
                }}
            >
                <Loader2 className="w-12 h-12 animate-spin" style={{ color: '#D4AF37' }} />
                <div className="text-center">
                    <div
                        className="text-xs font-bold tracking-[0.25em] uppercase mb-2"
                        style={{ color: '#D4AF37' }}
                    >
                        Building Routes
                    </div>
                    <div className="text-sm text-white/90 font-medium max-w-xs">
                        {stage}
                    </div>
                    <div className="text-[10px] text-white/40 mt-3 tracking-wide">
                        This may take a few seconds...
                    </div>
                </div>
            </div>
        </div>
    );
}