import React from 'react';
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, DollarSign, UserPlus } from 'lucide-react';
import { format } from 'date-fns';

const STATUS_CONFIG = {
    signed_up: { label: 'Signed Up', icon: UserPlus, color: 'bg-blue-900/30 text-blue-400 border-blue-800/50' },
    subscribed: { label: 'Subscribed', icon: CheckCircle2, color: 'bg-green-900/30 text-green-400 border-green-800/50' },
    paid_out: { label: 'Paid Out', icon: DollarSign, color: 'bg-yellow-900/30 text-yellow-400 border-yellow-800/50' },
    pending: { label: 'Pending', icon: Clock, color: 'bg-gray-800 text-gray-400 border-gray-700' },
};

export default function ReferralHistory({ referrals, accent }) {
    if (!referrals || referrals.length === 0) {
        return (
            <div className="bg-[#111] border border-gray-800 rounded-xl p-6 text-center">
                <UserPlus className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No referrals yet</p>
                <p className="text-xs text-gray-600 mt-1">Share your code to start earning!</p>
            </div>
        );
    }

    return (
        <div className="bg-[#111] border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
                <h3 className="text-xs font-bold text-gray-500 uppercase">Referral History</h3>
            </div>
            <div className="divide-y divide-gray-800/50">
                {referrals.map((ref) => {
                    const config = STATUS_CONFIG[ref.status] || STATUS_CONFIG.pending;
                    const Icon = config.icon;
                    return (
                        <div key={ref.id} className="flex items-center justify-between px-4 py-3 hover:bg-gray-900/30 transition-colors">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center shrink-0" style={{ color: accent }}>
                                    <Icon className="w-4 h-4" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-white truncate">{ref.referred_name || ref.referred_email}</p>
                                    <p className="text-[10px] text-gray-500">
                                        {ref.created_date ? format(new Date(ref.created_date), 'MMM d, yyyy') : ''}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {ref.commission_amount > 0 && (
                                    <span className="text-sm font-bold text-green-400">${ref.commission_amount}</span>
                                )}
                                <Badge className={`text-[9px] ${config.color}`}>
                                    {config.label}
                                </Badge>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}