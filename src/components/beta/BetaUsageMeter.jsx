import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { MapPin, Lock, Crown, Map } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';
import { createPageUrl } from '@/utils';

const FREE_ZIP_LIMIT = 3;
const ZIPS_PER_SEAT = 10;
const FREE_PULL_LIMIT = 3;
const PAID_PULL_LIMIT = 20;

export default function BetaUsageMeter({ className = '', showUpgrade = true }) {
    const { accent } = useTheme();

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
    });

    const isPaid = user?.subscription_status === 'active';
    const totalSeats = user?.total_seats || 1;
    
    // Zip Codes
    const zipLimit = isPaid ? totalSeats * ZIPS_PER_SEAT : FREE_ZIP_LIMIT;
    const tierLabel = isPaid ? `Pro (${totalSeats} seat${totalSeats !== 1 ? 's' : ''})` : 'Free Beta';
    const generatedZips = user?.generated_zip_codes || [];
    const zipsUsed = generatedZips.length;
    const zipsRemaining = Math.max(0, zipLimit - zipsUsed);
    const zipsPct = Math.min((zipsUsed / zipLimit) * 100, 100);
    const zipsDepleted = zipsRemaining <= 0;

    // Area Pulls
    const pullLimit = isPaid ? PAID_PULL_LIMIT : FREE_PULL_LIMIT;
    const pullsUsed = user?.area_pulls_count || 0;
    const pullsRemaining = Math.max(0, pullLimit - pullsUsed);
    const pullsPct = Math.min((pullsUsed / pullLimit) * 100, 100);
    const pullsDepleted = pullsRemaining <= 0;

    return (
        <div className={`p-3 rounded-xl border bg-[#0A0A0A] ${(zipsDepleted || pullsDepleted) && !isPaid ? 'border-red-800' : 'border-gray-800'} ${className}`}>
            
            <div className="space-y-4">
                {/* Zip Codes Meter */}
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <MapPin className="w-3.5 h-3.5" style={{ color: zipsDepleted && !isPaid ? '#EF4444' : accent }} />
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                {tierLabel} — Zip Codes
                            </span>
                        </div>
                        <span className={`text-xs font-bold ${zipsDepleted && !isPaid ? 'text-red-400' : 'text-white'}`}>
                            {zipsUsed}/{zipLimit === 999 ? '∞' : zipLimit}
                        </span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                                width: `${zipLimit === 999 ? 10 : zipsPct}%`,
                                background: zipsDepleted && !isPaid ? '#EF4444' : accent
                            }}
                        />
                    </div>
                    {generatedZips.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                            {generatedZips.slice(0, 5).map(z => (
                                <span key={z} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{z}</span>
                            ))}
                            {generatedZips.length > 5 && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                                    +{generatedZips.length - 5} more
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Area Pulls Meter */}
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <Map className="w-3.5 h-3.5" style={{ color: pullsDepleted && !isPaid ? '#EF4444' : accent }} />
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                {tierLabel} — Map Area Pulls
                            </span>
                        </div>
                        <span className={`text-xs font-bold ${pullsDepleted && !isPaid ? 'text-red-400' : 'text-white'}`}>
                            {pullsUsed}/{pullLimit === 999 ? '∞' : pullLimit}
                        </span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                                width: `${pullLimit === 999 ? 10 : pullsPct}%`,
                                background: pullsDepleted && !isPaid ? '#EF4444' : accent
                            }}
                        />
                    </div>
                </div>
            </div>

            {(zipsDepleted || pullsDepleted) && !isPaid && showUpgrade ? (
                <div className="mt-4 p-2 rounded-lg bg-red-900/20 border border-red-800/50">
                    <div className="flex items-center gap-2 mb-1.5">
                        <Lock className="w-3 h-3 text-red-400" />
                        <span className="text-[10px] font-bold text-red-400">Free limit used — upgrade to add more</span>
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
                <p className="text-[10px] mt-3 text-gray-600">
                    {zipsRemaining > 0 || pullsRemaining > 0
                        ? `${zipsRemaining} zip(s) & ${pullsRemaining} map pull(s) remaining on your plan.`
                        : isPaid ? 'Need more limits? Add seats or contact support.' : ''
                    }
                </p>
            )}
        </div>
    );
}