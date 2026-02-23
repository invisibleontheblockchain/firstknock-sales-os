import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Check } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

export default function OnboardingWizard({ user, onComplete }) {
    const [isOpen, setIsOpen] = useState(true);
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);

    if (!user || user.has_seen_onboarding || !user.app_role || !isOpen) return null;

    const handleComplete = async () => {
        setIsOpen(false);
        try { await base44.auth.updateMe({ has_seen_onboarding: true }); } catch {}
        if (onComplete) onComplete();
    };

    const isManager = user.app_role === 'manager';

    return (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} className="bg-[#111] border border-gray-800 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl relative">
                <div className="p-8 text-center space-y-6">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}CC)`, boxShadow: `0 0 30px ${accent}40` }}>
                        <Sparkles className="w-8 h-8" style={{ color: accentTxt }} />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold text-white mb-2">Welcome to FirstKnock</h2>
                        <p className="text-gray-400 text-sm leading-relaxed">
                            {isManager 
                                ? "The smartest way to build territories, generate routes, and manage your sales team."
                                : "Your personal assistant for the doors. Get optimized routes and track your success."}
                        </p>
                    </div>

                    <div className="space-y-3 text-left bg-black/40 p-5 rounded-2xl border border-white/5">
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: `${accent}20`, color: accent }}><Check className="w-3 h-3 font-bold" /></div>
                            <div>
                                <p className="text-sm font-bold text-white">{isManager ? 'Pull Property Data' : 'Follow the Route'}</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: `${accent}20`, color: accent }}><Check className="w-3 h-3 font-bold" /></div>
                            <div>
                                <p className="text-sm font-bold text-white">{isManager ? 'Generate Smart Routes' : 'Log Every Knock'}</p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: `${accent}20`, color: accent }}><Check className="w-3 h-3 font-bold" /></div>
                            <div>
                                <p className="text-sm font-bold text-white">{isManager ? 'Track Team Analytics' : 'Close More Deals'}</p>
                            </div>
                        </div>
                    </div>

                    <Button onClick={handleComplete} className="w-full h-12 text-base font-bold rounded-xl transition-all shadow-lg hover:scale-[1.02]" style={{ background: accent, color: accentTxt }}>
                        Get Started <ArrowRight className="w-5 h-5 ml-2" />
                    </Button>
                </div>
            </motion.div>
        </div>
    );
}