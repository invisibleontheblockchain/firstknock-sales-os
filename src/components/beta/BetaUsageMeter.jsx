import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { MapPin, Lock, Crown } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';
import { createPageUrl } from '@/utils';

const FREE_ZIP_LIMIT = 1;
const ZIPS_PER_SEAT = 10;

export default function BetaUsageMeter({ className = '', showUpgrade = true }) {
    const { accent } = useTheme();

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
    });

    const isPaid = user?.subscription_status === 'active';
    const totalSeats = user?.total_seats || 1;
    const zipLimit = isPaid ? totalSeats * ZIPS_PER_SEAT : FREE_ZIP_LIMIT;
    const tierLabel = isPaid ? `Pro (${totalSeats} seat${totalSeats !== 1 ? 's' : ''})` : 'Free Beta';
    const generatedZips = user?.generated_zip_codes || [];
    const zipsUsed = generatedZips.length;
    const remaining = Math.max(0, zipLimit - zipsUsed);
    const pct = Math.min((zipsUsed / zipLimit) * 100, 100);
    const isDepleted = remaining <= 0;

    return (
        <div className={`p-3 rounded-xl border bg-[#0A0A0A] ${isDepleted && !isPaid ? 'border-red-800' : 'border-gray-800'} ${className}`}>
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5" style={{ color: isDepleted && !isPaid ? '#EF4444' : accent }} />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                        {tierLabel} — Zip Codes
                    </span>
                </div>
                <span className={`text-xs font-bold ${isDepleted && !isPaid ? 'text-red-400' : 'text-white'}`}>
                    {zipsUsed}/{zipLimit === 999 ? '∞' : zipLimit}
                </span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                        width: `${zipLimit === 999 ? 10 : pct}%`,
                        background: isDepleted && !isPaid ? '#EF4444' : accent
                    }}
                />
            </div>

            {generatedZips.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                    {generatedZips.map(z => (
                        <span key={z} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{z}</span>
                    ))}
                </div>
            )}

            {isDepleted && !isPaid && showUpgrade ? (
                <div className="mt-2 p-2 rounded-lg bg-red-900/20 border border-red-800/50">
                    <div className="flex items-center gap-2 mb-1.5">
                        <Lock className="w-3 h-3 text-red-400" />
                        <span className="text-[10px] font-bold text-red-400">Free zip used — upgrade to add more</span>
                    </div>
                    <Link
                        to={createPageUrl('Billing')}
                        className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg text-[10px] font-bold transition-colors"
                        style={{ background: accent, color: '#000' }}
                    >
                        <Crown className="w-3 h-3" /> UPGRADE PLAN
                    </Link>
                </div>
            ) : (
                <p className="text-[10px] mt-1.5 text-gray-600">
                    {remaining > 0
                        ? `${remaining} zip code${remaining !== 1 ? 's' : ''} remaining on your plan.`
                        : isPaid ? 'Need more? Add seats for more zips.' : ''
                    }
                </p>
            )}
        </div>
    );
}