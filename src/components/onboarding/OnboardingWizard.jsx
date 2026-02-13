import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { ArrowRight, X, Sparkles, MapPin, Route, BarChart3 } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

export default function OnboardingWizard({ user, onComplete }) {
    const [isOpen, setIsOpen] = useState(true);
    const [step, setStep] = useState(0);
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);

    if (!user || user.has_seen_onboarding || !user.app_role || !isOpen) return null;

    const handleComplete = async () => {
        setIsOpen(false);
        try { await base44.auth.updateMe({ has_seen_onboarding: true }); } catch {}
        if (onComplete) onComplete();
    };

    const steps = [
        {
            title: "Find the Best Houses",
            description: "FirstKnock shows you exactly which homes to knock in your zip code — prioritized by recent sales, equity, and timing.",
            icon: Sparkles,
        },
        {
            title: "Enter Your Zip Code",
            description: "Tell us where you work. We pull every property in that area and score them so you know which doors are worth your time.",
            icon: MapPin,
        },
        {
            title: "Get Optimized Routes",
            description: "We build walking routes that hit the highest-value homes first. No wasted steps, no cold doors.",
            icon: Route,
        },
        {
            title: "Track & Improve",
            description: "Log every knock, see your stats, and watch your close rate climb. The data works for you.",
            icon: BarChart3,
        },
    ];

    const current = steps[step];

    return (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#111] border border-gray-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl relative">
                {/* Progress */}
                <div className="h-1 bg-gray-800 w-full">
                    <motion.div className="h-full" style={{ background: accent }} initial={{ width: 0 }} animate={{ width: `${((step + 1) / steps.length) * 100}%` }} transition={{ duration: 0.3 }} />
                </div>

                <div className="p-8">
                    <button onClick={handleComplete} className="absolute top-4 right-4 text-gray-500 hover:text-white"><X className="w-5 h-5" /></button>

                    <AnimatePresence mode="wait">
                        <motion.div key={step} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.2 }} className="text-center space-y-6">
                            <div className="flex justify-center">
                                <div className="w-20 h-20 rounded-full flex items-center justify-center border border-gray-800" style={{ background: `${accent}15`, color: accent }}>
                                    <current.icon className="w-10 h-10" />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-2xl font-bold text-white">{current.title}</h2>
                                <p className="text-gray-400 leading-relaxed text-sm">{current.description}</p>
                            </div>
                        </motion.div>
                    </AnimatePresence>

                    <div className="mt-8 pt-4 flex gap-3">
                        {step > 0 ? (
                            <Button variant="outline" onClick={() => setStep(step - 1)} className="flex-1 border-gray-700 text-white hover:bg-gray-800 hover:text-white">Back</Button>
                        ) : (
                            <Button variant="ghost" onClick={handleComplete} className="flex-1 text-gray-500 hover:text-white">Skip</Button>
                        )}
                        <Button onClick={() => step < steps.length - 1 ? setStep(step + 1) : handleComplete()} className="flex-1 font-bold" style={{ background: accent, color: accentTxt }}>
                            {step === steps.length - 1 ? "Let's Go!" : "Next"} {step < steps.length - 1 && <ArrowRight className="w-4 h-4 ml-2" />}
                        </Button>
                    </div>

                    <div className="mt-6 flex justify-center gap-1.5">
                        {steps.map((_, idx) => (
                            <div key={idx} className="w-2 h-2 rounded-full transition-colors" style={{ background: idx === step ? accent : '#1F2937' }} />
                        ))}
                    </div>
                </div>
            </motion.div>
        </div>
    );
}