import React from 'react';
import { Shield, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';

const TIERS = {
    high:     { label: 'Deed Confirmed',  color: '#22c55e', bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.25)',  Icon: ShieldCheck },
    verified: { label: 'Verified',        color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)', Icon: ShieldCheck },
    medium:   { label: 'Likely Sold',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)', Icon: Shield },
    low:      { label: 'Unverified',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.25)',  Icon: ShieldAlert },
};

export default function ConfidenceBadge({ confidence }) {
    const tier = TIERS[confidence] || TIERS.high;
    const Icon = tier.Icon;

    return (
        <div
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold"
            style={{ background: tier.bg, border: `1px solid ${tier.border}`, color: tier.color }}
        >
            <Icon className="w-3 h-3" />
            {tier.label}
        </div>
    );
}