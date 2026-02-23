import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, DollarSign, Users, Gift, Link as LinkIcon, Share2, TrendingUp, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import ReferralStats from '../components/referral/ReferralStats';
import ReferralShareCard from '../components/referral/ReferralShareCard';
import ReferralHistory from '../components/referral/ReferralHistory';

export default function Referrals() {
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState(null);

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me(),
    });

    useEffect(() => {
        if (!user) return;
        const fetchStats = async () => {
            setLoading(true);
            try {
                const res = await base44.functions.invoke('processReferral', {
                    action: 'get_stats',
                    origin: window.location.origin,
                });
                setStats(res.data);
            } catch (e) {
                console.error('Failed to load referral stats:', e);
                toast.error('Failed to load referral data');
            } finally {
                setLoading(false);
            }
        };
        fetchStats();
    }, [user]);

    if (loading) {
        return (
            <div className="h-full flex items-center justify-center bg-black">
                <Loader2 className="w-8 h-8 animate-spin" style={{ color: accent }} />
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto bg-black text-white p-4 sm:p-6 lg:p-8">
            <div className="max-w-2xl mx-auto space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3" style={{ background: `${accent}20` }}>
                        <Gift className="w-7 h-7" style={{ color: accent }} />
                    </div>
                    <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-[#A29BFE]">Refer & Earn</h1>
                    <p className="text-[#8888A0] max-w-sm mx-auto text-sm font-medium">
                        Share FirstKnock with your network. Build your own organization and earn passive income for life.
                    </p>
                </div>

                {/* Commission Info */}
                <div className="bg-[#111] border border-gray-800 rounded-xl p-5 text-center">
                    <h3 className="text-xs font-bold text-gray-500 uppercase mb-3 flex items-center justify-center gap-2">
                        <DollarSign className="w-3 h-3" /> Recurring Commission
                    </h3>
                    <p className="text-4xl font-extrabold" style={{ color: accent }}>20%</p>
                    <p className="text-sm text-gray-400 mt-1">LIFETIME recurring commission</p>
                    <p className="text-[10px] text-gray-600 mt-2">
                        Earn 20% of the subscription revenue for as long as your referral remains a paying customer.
                        Build an army and create passive income!
                    </p>
                </div>

                {/* Stats */}
                {stats && <ReferralStats stats={stats} accent={accent} />}

                {/* Share Card */}
                {stats && <ReferralShareCard stats={stats} accent={accent} accentTxt={accentTxt} />}

                {/* Referral History */}
                {stats && <ReferralHistory referrals={stats.referrals || []} accent={accent} />}
            </div>
        </div>
    );
}