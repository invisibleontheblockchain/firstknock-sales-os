import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Zap } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';

const BETA_LIMIT = 50;

export default function BetaUsageMeter({ className = '' }) {
    const { accent } = useTheme();

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
    });

    const used = user?.rentcast_api_calls_used || 0;
    const remaining = BETA_LIMIT - used;
    const pct = Math.min((used / BETA_LIMIT) * 100, 100);
    const isLow = remaining <= 10;
    const isDepleted = remaining <= 0;

    return (
        <div className={`p-3 rounded-xl border bg-[#0A0A0A] ${isDepleted ? 'border-red-800' : isLow ? 'border-yellow-800' : 'border-gray-800'} ${className}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5" style={{ color: isDepleted ? '#EF4444' : accent }} />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Beta API Usage</span>
                </div>
                <span className={`text-xs font-bold ${isDepleted ? 'text-red-400' : isLow ? 'text-yellow-400' : 'text-white'}`}>
                    {used}/{BETA_LIMIT}
                </span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                        width: `${pct}%`,
                        background: isDepleted ? '#EF4444' : isLow ? '#F59E0B' : accent
                    }}
                />
            </div>
            <p className="text-[10px] mt-1.5" style={{ color: isDepleted ? '#EF4444' : '#6B7280' }}>
                {isDepleted
                    ? 'Limit reached — upgrade to sync more zip codes.'
                    : `${remaining} API calls remaining. Each zip uses ~1-4 calls.`
                }
            </p>
        </div>
    );
}