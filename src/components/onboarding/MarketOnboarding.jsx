import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { Circle, Square, ArrowRight, Check, Loader2, Map as MapIcon } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export default function MarketOnboarding({ user, onComplete }) {
    const queryClient = useQueryClient();
    const [shape, setShape] = useState('circle');

    // Only show for managers who haven't pulled data yet
    if (!user || user.app_role !== 'manager') return null;
    if (user.has_pulled_data) return null;
    // Don't show if user is already in draw mode (they clicked "Open Map & Draw")
    if (user.has_defined_market && !user.has_pulled_data) return null;

    const handleGo = async () => {
        // Mark that user has started onboarding so this doesn't show again
        await base44.auth.updateMe({ has_defined_market: true });
        await queryClient.invalidateQueries({ queryKey: ['user'] });
        onComplete({ method: 'draw', shape });
    };

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
                            <MapIcon className="w-8 h-8 text-black" />
                        </div>

                        <div>
                            <h2 className="text-2xl font-extrabold text-white mb-2 tracking-tight">
                                Draw Your Service Area
                            </h2>
                            <p className="text-gray-400 text-sm leading-relaxed">
                                Drop a shape on the map that covers your <strong className="text-white">entire territory</strong>. We'll pull all the leads inside it.
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

                        <div className="bg-black/40 border border-white/5 rounded-xl p-4 space-y-2 text-left">
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                <span className="text-xs text-gray-300">200 sq miles — covers most service areas</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                <span className="text-xs text-gray-300">One-time data pull — all leads loaded instantly</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                <span className="text-xs text-gray-300">Filter by price, date, property type after</span>
                            </div>
                        </div>

                        <Button
                            onClick={handleGo}
                            className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-14 text-base w-full rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none"
                        >
                            Open Map & Draw <ArrowRight className="w-5 h-5 ml-2" />
                        </Button>

                        <p className="text-[10px] text-gray-600">Click anywhere on the map to place your area</p>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}