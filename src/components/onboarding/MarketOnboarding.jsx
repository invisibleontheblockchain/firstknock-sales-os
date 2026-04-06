import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { Circle, Square, ArrowRight, Check, Lock, Map as MapIconLucide, Satellite } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Slider } from "@/components/ui/slider";

export default function MarketOnboarding({ user, onComplete }) {
    const queryClient = useQueryClient();
    const [shape, setShape] = useState('square');
    const [monthsBack, setMonthsBack] = useState(12);
    const [isDrawingSession, setIsDrawingSession] = React.useState(false);

    React.useEffect(() => {
        if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('startDraw') === 'true') {
            setIsDrawingSession(true);
        }
    }, []);

    // Show for managers who haven't pulled data yet
    if (!user || user.app_role !== 'manager') return null;
    
    // Wait until the install/welcome onboarding is done first
    if (!user.has_seen_onboarding) return null;
    
    // Hide if user already has territory data
    if (user.has_pulled_data || user.has_defined_market || user.territory_zip_codes?.length > 0 || user.area_pulls_count > 0) return null;
    
    if (isDrawingSession) return null;
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('startDraw') === 'true') return null;

    const handleGo = async () => {
        await base44.auth.updateMe({ has_defined_market: true, pull_months_back: monthsBack });
        await queryClient.invalidateQueries({ queryKey: ['user'] });
        onComplete({ method: 'draw', shape });
    };

    const sizeLabel = monthsBack <= 3 ? 'Fresh leads — most recent sales only' 
        : monthsBack <= 6 ? 'Good balance of volume & recency' 
        : monthsBack <= 9 ? 'High volume — covers seasonal cycles'
        : 'Maximum coverage — full year of sales data';

    return (
        <div className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-sm"
            >
                <div className="bg-[#111] border border-gray-800 rounded-3xl overflow-hidden shadow-2xl p-8">
                    <div className="text-center space-y-6">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto shadow-[0_0_40px_rgba(255,215,0,0.3)]" style={{ background: 'linear-gradient(135deg, #FFD93D, #FFA500)' }}>
                            <Satellite className="w-8 h-8 text-black" />
                        </div>

                        <div>
                            <h2 className="text-2xl font-extrabold text-white mb-2 tracking-tight">
                                Define Your Territory
                            </h2>
                            <p className="text-gray-400 text-sm leading-relaxed">
                                Draw your area on the <strong className="text-white">satellite map</strong>. We'll find every recently sold home inside it.
                            </p>
                        </div>

                        {/* Shape picker */}
                        <div className="flex justify-center gap-4">
                            <button
                                onClick={() => setShape('circle')}
                                className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                                    shape === 'circle' 
                                        ? 'border-yellow-500 bg-yellow-500/10 scale-105' 
                                        : 'border-gray-800 bg-white/5 hover:bg-white/10'
                                }`}
                            >
                                <div className="w-12 h-12 rounded-full border-2 border-current flex items-center justify-center text-yellow-500">
                                    <Circle className="w-8 h-8" />
                                </div>
                                <span className={`text-xs font-bold ${shape === 'circle' ? 'text-yellow-500' : 'text-gray-400'}`}>Circle</span>
                            </button>
                            <button
                                onClick={() => setShape('square')}
                                className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                                    shape === 'square' 
                                        ? 'border-yellow-500 bg-yellow-500/10 scale-105' 
                                        : 'border-gray-800 bg-white/5 hover:bg-white/10'
                                }`}
                            >
                                <div className="w-12 h-12 rounded border-2 border-current flex items-center justify-center text-yellow-500">
                                    <Square className="w-8 h-8" />
                                </div>
                                <span className={`text-xs font-bold ${shape === 'square' ? 'text-yellow-500' : 'text-gray-400'}`}>Square</span>
                            </button>
                        </div>

                        {/* Months back picker */}
                        <div className="bg-black/40 border border-white/5 rounded-xl p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-gray-300">Sold in the last</span>
                                <span className="text-sm font-extrabold text-yellow-500">{monthsBack} month{monthsBack !== 1 ? 's' : ''}</span>
                            </div>
                            <div className="flex gap-2">
                                {[1, 3, 6, 9, 12].map(m => (
                                    <button
                                        key={m}
                                        onClick={() => setMonthsBack(m)}
                                        className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                                            monthsBack === m
                                                ? 'bg-yellow-500 text-black shadow-[0_0_12px_rgba(255,215,0,0.4)]'
                                                : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-white/5'
                                        }`}
                                    >
                                        {m}mo
                                    </button>
                                ))}
                            </div>
                            <p className="text-[10px] text-gray-500 text-center">
                                {sizeLabel}
                            </p>
                        </div>

                        <div className="bg-black/40 border border-white/5 rounded-xl p-4 space-y-2 text-left">
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                <span className="text-xs text-gray-300">Up to 40 sq miles — covers most territories</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                <span className="text-xs text-gray-300">Satellite view — see real rooftops & streets</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                <span className="text-xs text-gray-300">Filter by price, property type & sold date after</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Lock className="w-4 h-4 text-gray-600 shrink-0" />
                                <span className="text-xs text-gray-500">Need 300mi² coverage? Upgrade for PRO pulls</span>
                            </div>
                        </div>

                        <Button
                            onClick={handleGo}
                            className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-14 text-base w-full rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none"
                        >
                            Open Satellite Map <ArrowRight className="w-5 h-5 ml-2" />
                        </Button>

                        <p className="text-[10px] text-gray-600">Tap the map to place your territory shape</p>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}