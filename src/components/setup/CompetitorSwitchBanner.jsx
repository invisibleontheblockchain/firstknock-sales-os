import React from 'react';
import { ArrowRight, Zap, Shield, TrendingUp, Star, Check } from 'lucide-react';

const COMPETITORS = [
    { name: 'SalesRabbit', pain: 'Expensive per-seat pricing' },
    { name: 'Spotio', pain: 'Clunky territory management' },
    { name: 'SPOTIO', pain: 'No smart routing' },
    { name: 'D2D CRM', pain: 'Outdated UI, slow maps' },
    { name: 'SalesRabbit', pain: '$50+/seat monthly' },
];

const ADVANTAGES = [
    { icon: Zap, text: 'AI-powered route optimization', detail: 'Walk 40% fewer miles per day' },
    { icon: Shield, text: 'Real-time sold property data', detail: 'Never knock a sold home again' },
    { icon: TrendingUp, text: 'Smart territory heatmaps', detail: 'See which streets convert best' },
    { icon: Star, text: 'One-click CSV import', detail: 'Bring your SalesRabbit/Spotio data in 30 seconds' },
];

export default function CompetitorSwitchBanner() {
    return (
        <div className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-[#111113] to-[#0a0a10] p-5 md:p-7 relative overflow-hidden">
            {/* Glow effects */}
            <div className="absolute -top-20 -left-20 w-60 h-60 bg-purple-500/10 blur-[80px] rounded-full pointer-events-none" />
            <div className="absolute -bottom-20 -right-20 w-60 h-60 bg-blue-500/10 blur-[80px] rounded-full pointer-events-none" />
            
            <div className="relative z-10">
                {/* Badge */}
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-gradient-to-r from-purple-500/20 to-blue-500/20 border border-purple-500/30 mb-4">
                    <ArrowRight className="w-3 h-3 text-purple-400" />
                    <span className="text-[11px] font-bold text-purple-300 uppercase tracking-wider">Switching from another tool?</span>
                </div>

                <h2 className="text-xl md:text-2xl font-black text-white mb-2">
                    Import your data. Keep your momentum.
                </h2>
                <p className="text-sm text-gray-400 mb-6 max-w-lg">
                    FirstKnock replaces SalesRabbit, Spotio, and D2D CRM with smarter routes, real-time sold data, and AI that helps you close more doors — at a fraction of the cost.
                </p>

                {/* Advantages grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                    {ADVANTAGES.map((a, i) => (
                        <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
                            <div className="w-8 h-8 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center shrink-0">
                                <a.icon className="w-4 h-4 text-green-400" />
                            </div>
                            <div>
                                <p className="text-xs font-bold text-white">{a.text}</p>
                                <p className="text-[10px] text-gray-500 mt-0.5">{a.detail}</p>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Social proof */}
                <div className="flex items-center gap-3 p-3 rounded-xl bg-yellow-500/[0.05] border border-yellow-500/10">
                    <div className="flex -space-x-2">
                        {[1,2,3,4].map(i => (
                            <div key={i} className="w-7 h-7 rounded-full bg-gradient-to-br from-gray-700 to-gray-800 border-2 border-[#09090b] flex items-center justify-center">
                                <span className="text-[9px] font-bold text-gray-400">⭐</span>
                            </div>
                        ))}
                    </div>
                    <div>
                        <p className="text-[11px] font-bold text-white">Hundreds of reps have switched</p>
                        <p className="text-[10px] text-gray-500">"Best move I made for my team" — D2D Manager</p>
                    </div>
                </div>
            </div>
        </div>
    );
}