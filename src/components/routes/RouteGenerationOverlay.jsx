import React from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';

/**
 * Full-screen overlay shown while routes are being generated.
 * Provides immediate visual feedback so the user knows their click registered,
 * even while the main thread is busy building large data structures.
 *
 * If `error` is provided, shows an error state instead of the spinner.
 */
export default function RouteGenerationOverlay({ visible, stage = 'Preparing data...', error = null, onDismiss }) {
    if (!visible) return null;
    const isError = !!error;

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-auto animate-in fade-in duration-200"
            style={{ background: 'rgba(0, 0, 0, 0.72)', backdropFilter: 'blur(6px)' }}
            onClick={isError && onDismiss ? onDismiss : undefined}
        >
            <div
                className="flex flex-col items-center gap-5 px-10 py-8 rounded-2xl max-w-md mx-4"
                style={{
                    background: 'rgba(17, 17, 17, 0.95)',
                    border: isError ? '1px solid rgba(255, 107, 107, 0.4)' : '1px solid rgba(212, 175, 55, 0.3)',
                    boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(212,175,55,0.1)',
                    minWidth: 280
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {isError ? (
                    <AlertTriangle className="w-12 h-12" style={{ color: '#FF6B6B' }} />
                ) : (
                    <Loader2 className="w-12 h-12 animate-spin" style={{ color: '#D4AF37' }} />
                )}
                <div className="text-center">
                    <div
                        className="text-xs font-bold tracking-[0.25em] uppercase mb-2"
                        style={{ color: isError ? '#FF6B6B' : '#D4AF37' }}
                    >
                        {isError ? 'Generation Failed' : 'Building Routes'}
                    </div>
                    <div className="text-sm text-white/90 font-medium">
                        {error || stage}
                    </div>
                    {!isError && (
                        <div className="text-[10px] text-white/40 mt-3 tracking-wide">
                            This may take a few seconds...
                        </div>
                    )}
                    {isError && onDismiss && (
                        <button
                            onClick={onDismiss}
                            className="mt-5 px-6 py-2 rounded-lg text-xs font-bold tracking-wider uppercase transition-colors"
                            style={{ background: '#D4AF37', color: '#000' }}
                        >
                            Got It
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}