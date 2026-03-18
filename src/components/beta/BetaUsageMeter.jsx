import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Database, Lock, Crown } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';

export default function BetaUsageMeter({ className = '' }) {
    const { accent } = useTheme();

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
    });

    const hasPulledData = !!user?.has_pulled_data;
    const isSubscribed = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';

    return (
        <div className={`p-3 rounded-xl border bg-[#0A0A0A] border-gray-800 ${className}`}>
            <div className="space-y-3">
                {/* Data Pull Status */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Database className="w-3.5 h-3.5" style={{ color: hasPulledData ? '#00F5A0' : '#FF6B6B' }} />
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                            Territory Data
                        </span>
                    </div>
                    <span className={`text-xs font-bold ${hasPulledData ? 'text-green-400' : 'text-red-400'}`}>
                        {hasPulledData ? 'ACTIVE' : 'NOT SET UP'}
                    </span>
                </div>

                {hasPulledData && (
                    <div className="text-[10px] text-gray-500">
                        {user?.territory_property_count ? `${user.territory_property_count.toLocaleString()} properties loaded` : 'Data loaded'}
                        {user?.last_data_pull && ` • Pulled ${new Date(user.last_data_pull).toLocaleDateString()}`}
                    </div>
                )}

                {/* Beta mode — no limits */}
                {hasPulledData && (
                    <div className="flex items-center gap-2 p-2 rounded-lg bg-green-900/10 border border-green-800/30">
                        <Crown className="w-3 h-3 text-green-500 shrink-0" />
                        <span className="text-[10px] text-green-400/80">
                            Beta — Unlimited data pulls
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}