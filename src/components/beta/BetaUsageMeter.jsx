import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { MapPin, Lock, Crown, Map } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';
import { createPageUrl } from '@/utils';

const AREA_LIMIT = 3; // 3 drawn areas per month for all users

export default function BetaUsageMeter({ className = '', showUpgrade = true }) {
    const { accent } = useTheme();

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
    });

    const isOwner = user?.is_owner === true || user?.email?.toLowerCase() === 'christian@nativapest.com' || user?.email?.toLowerCase() === 'christian@nativapes.com';

    // Zip Codes — unlimited for all users
    const generatedZips = user?.generated_zip_codes || [];
    const zipsUsed = generatedZips.length;

    // Area Allowances — 3 per month for everyone
    const areaLimit = isOwner ? 999 : AREA_LIMIT;
    const areasUsed = user?.area_pulls_count || 0;
    const areasRemaining = Math.max(0, areaLimit - areasUsed);
    const areasPct = Math.min((areasUsed / areaLimit) * 100, 100);
    const areasDepleted = areasRemaining <= 0;

    return (
        <div className={`p-3 rounded-xl border bg-[#0A0A0A] ${areasDepleted ? 'border-red-800' : 'border-gray-800'} ${className}`}>

            <div className="space-y-4">
                {/* Zip Codes — Unlimited */}
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <MapPin className="w-3.5 h-3.5" style={{ color: accent }} />
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                Zip Codes — Unlimited
                            </span>
                        </div>
                        <span className="text-xs font-bold text-white">
                            {zipsUsed} used
                        </span>
                    </div>
                    {generatedZips.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                            {generatedZips.slice(0, 8).map(z => (
                                <span key={z} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{z}</span>
                            ))}
                            {generatedZips.length > 8 && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                                    +{generatedZips.length - 8} more
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Drawn Areas — 3 per month */}
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <Map className="w-3.5 h-3.5" style={{ color: areasDepleted ? '#EF4444' : accent }} />
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                Drawn Areas — Monthly
                            </span>
                        </div>
                        <span className={`text-xs font-bold ${areasDepleted ? 'text-red-400' : 'text-white'}`}>
                            {areasUsed}/{areaLimit === 999 ? '∞' : areaLimit}
                        </span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                                width: `${areaLimit === 999 ? 10 : areasPct}%`,
                                background: areasDepleted ? '#EF4444' : accent
                            }}
                        />
                    </div>
                    <p className="text-[9px] text-gray-600 mt-1">200 sq miles per draw</p>
                </div>
            </div>

            {areasDepleted && showUpgrade ? (
                <div className="mt-4 p-2 rounded-lg bg-red-900/20 border border-red-800/50">
                    <div className="flex items-center gap-2">
                        <Lock className="w-3 h-3 text-red-400" />
                        <span className="text-[10px] font-bold text-red-400">Monthly draw limit reached — resets next month</span>
                    </div>
                </div>
            ) : (
                <p className="text-[10px] mt-3 text-gray-600">
                    {areasRemaining > 0
                        ? `${areasRemaining} drawn area(s) remaining this month.`
                        : ''
                    }
                </p>
            )}
        </div>
    );
}