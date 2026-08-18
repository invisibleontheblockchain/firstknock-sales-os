import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Map as MapIcon, Pencil } from 'lucide-react';
import { Button } from "@/components/ui/button";

export default function MarketOnboarding({ user, onComplete }) {
    const [isStarting, setIsStarting] = React.useState(false);

    if (!user || user.app_role !== 'manager') return null;
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const walkthroughKey = user.id ? `fk_firstAreaWalkthrough_${user.id}` : null;
    const walkthroughActive = walkthroughKey && localStorage.getItem(walkthroughKey) === 'active';
    if (params?.get('startDraw') === 'true' || params?.get('onboarding') === 'precision' || walkthroughActive) return null;

    const hasExistingTerritory = user.has_pulled_data || user.has_defined_market || user.territory_zip_codes?.length > 0 || user.area_pulls_count > 0;
    if (hasExistingTerritory) return null;

    const startDrawing = () => {
        if (isStarting) return;
        setIsStarting(true);
        if (walkthroughKey) localStorage.setItem(walkthroughKey, 'active');
        localStorage.setItem('fk_routeMode', 'precision');
        onComplete?.({ method: 'draw' });
    };

    return (
        <div className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-sm"
            >
                <div className="bg-[#050505] border border-[#2EEB57]/25 rounded-3xl overflow-hidden shadow-[0_0_60px_rgba(46,235,87,0.15)] p-6">
                    <div className="text-center space-y-5">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto bg-[#2EEB57]/15 border border-[#2EEB57]/30 shadow-[0_0_35px_rgba(46,235,87,0.25)]">
                            <MapIcon className="w-8 h-8 text-[#39FF4A]" />
                        </div>

                        <div>
                            <h2 className="text-2xl font-extrabold text-white mb-2 tracking-tight">
                                Build Your First Precision Route
                            </h2>
                            <p className="text-gray-400 text-sm leading-relaxed">
                                We’ll guide you through drawing an area, choosing recently sold homes, and building your first optimized route.
                            </p>
                        </div>

                        <button
                            onClick={startDrawing}
                            disabled={isStarting}
                            className="w-full rounded-2xl border border-[#2EEB57]/40 bg-[#2EEB57]/10 p-5 text-left transition-all hover:bg-[#2EEB57]/15 hover:border-[#39FF4A]/70 disabled:opacity-70"
                        >
                            <div className="flex items-start gap-4">
                                <div className="w-12 h-12 rounded-2xl bg-[#2EEB57] text-black flex items-center justify-center shrink-0 shadow-[0_0_20px_rgba(46,235,87,0.35)]">
                                    <Pencil className="w-6 h-6" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-white font-extrabold text-base">Precision Quick Start</h3>
                                    <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                                        Outline a neighborhood, select your target filters, and let FirstKnock create the route.
                                    </p>
                                </div>
                                <ArrowRight className="w-5 h-5 text-[#39FF4A] mt-1 shrink-0" />
                            </div>
                        </button>

                        <div className="bg-black/50 border border-white/10 rounded-2xl p-4 space-y-2 text-left">
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-[#39FF4A] shrink-0" />
                                <span className="text-xs text-gray-300">Draw the exact neighborhood you want to target</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-[#39FF4A] shrink-0" />
                                <span className="text-xs text-gray-300">Satellite view makes streets and rooftops easy to trace</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Check className="w-4 h-4 text-[#39FF4A] shrink-0" />
                                <span className="text-xs text-gray-300">Your first route builds automatically after the pull</span>
                            </div>
                        </div>

                        <Button
                            onClick={startDrawing}
                            disabled={isStarting}
                            className="bg-[#2EEB57] hover:bg-[#39FF4A] text-black font-bold h-14 text-base w-full rounded-xl border-none"
                        >
                            {isStarting ? 'Opening Map...' : 'Start Quick Setup'} <ArrowRight className="w-5 h-5 ml-2" />
                        </Button>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}