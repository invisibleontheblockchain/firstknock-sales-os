import React, { useMemo } from 'react';
import { Shield, Lock, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

// Fix #3: Surface low-confidence lead count to users
// Fix #5: Confidence tier legend for the map
export const CONFIDENCE_TIERS = [
    { key: 'high', label: 'Deed Confirmed', color: '#22c55e', description: 'County recorded sale' },
    { key: 'verified', label: 'Verified', color: '#3b82f6', description: 'Third-party confirmed' },
    { key: 'medium', label: 'Likely Sold', color: '#f59e0b', description: 'Strong heuristic signals' },
    { key: 'low', label: 'Unverified', color: '#ef4444', description: 'Possible lead, unconfirmed' },
];

export default function ConfidenceLegend({ effectiveProperties, isPaid, isVisible }) {
    const counts = useMemo(() => {
        const result = { high: 0, verified: 0, medium: 0, low: 0, total: 0 };
        if (!effectiveProperties) return result;
        for (const p of effectiveProperties) {
            const conf = p.sale_confidence || 'high';
            if (result[conf] !== undefined) result[conf]++;
            result.total++;
        }
        return result;
    }, [effectiveProperties]);

    if (!isVisible || counts.total === 0) return null;

    return (
        <div className="absolute bottom-20 left-2 z-[1000] animate-in fade-in slide-in-from-bottom-2">
            <div className="bg-black/90 backdrop-blur-md border border-white/10 rounded-xl p-3 shadow-2xl min-w-[200px]">
                <div className="flex items-center gap-1.5 mb-2">
                    <Shield className="w-3 h-3 text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Data Confidence</span>
                </div>
                <div className="space-y-1.5">
                    {CONFIDENCE_TIERS.map(tier => {
                        const count = counts[tier.key];
                        if (count === 0) return null;
                        const pct = counts.total > 0 ? Math.round((count / counts.total) * 100) : 0;
                        return (
                            <div key={tier.key} className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: tier.color }} />
                                <span className="text-[10px] text-gray-300 flex-1">{tier.label}</span>
                                <span className="text-[10px] font-bold text-white">{count.toLocaleString()}</span>
                                <span className="text-[9px] text-gray-500 w-8 text-right">{pct}%</span>
                            </div>
                        );
                    })}
                </div>
                {/* Fix #3: Show upgrade prompt for free users with low-confidence leads */}
                {counts.low > 0 && !isPaid && (
                    <Link
                        to={createPageUrl('Billing')}
                        className="mt-2 flex items-center gap-1.5 p-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400 hover:bg-orange-500/20 transition-colors"
                    >
                        <Lock className="w-3 h-3 shrink-0" />
                        <span className="text-[9px] font-bold flex-1">
                            {counts.low} leads need verification
                        </span>
                        <ArrowRight className="w-3 h-3" />
                    </Link>
                )}
            </div>
        </div>
    );
}

// Export confidence colors for use by pin layers
export const CONFIDENCE_COLORS = {
    high: '#22c55e',
    verified: '#3b82f6',
    medium: '#f59e0b',
    low: '#ef4444',
};