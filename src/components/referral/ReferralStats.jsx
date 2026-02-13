import React from 'react';
import { DollarSign, Users, TrendingUp, Clock } from 'lucide-react';

export default function ReferralStats({ stats, accent }) {
    const items = [
        { label: 'Balance', value: `$${(stats.balance || 0).toFixed(0)}`, icon: DollarSign, color: '#22c55e' },
        { label: 'Total Earned', value: `$${(stats.total_earned || 0).toFixed(0)}`, icon: TrendingUp, color: accent },
        { label: 'Referrals', value: stats.total_referrals || 0, icon: Users, color: '#3b82f6' },
        { label: 'Subscribed', value: stats.subscribed || 0, icon: Clock, color: '#f59e0b' },
    ];

    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {items.map(item => (
                <div key={item.label} className="bg-[#111] border border-gray-800 rounded-xl p-4 text-center">
                    <item.icon className="w-4 h-4 mx-auto mb-2" style={{ color: item.color }} />
                    <p className="text-xl font-bold text-white">{item.value}</p>
                    <p className="text-[10px] text-gray-500 uppercase font-bold">{item.label}</p>
                </div>
            ))}
        </div>
    );
}