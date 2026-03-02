import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Check, Smartphone, Share, PlusSquare, Menu, MonitorSmartphone, Apple } from 'lucide-react';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";

function InstallStep({ num, text, icon }) {
    return (
        <Card className="bg-[#1A1A1A] border-gray-800">
            <CardContent className="flex items-center gap-3 p-3">
                <div className="w-6 h-6 rounded-full bg-yellow-500/10 text-yellow-500 flex items-center justify-center font-bold text-xs shrink-0">
                    {num}
                </div>
                <p className="text-xs text-gray-200 flex-1 text-left">{text}</p>
                <div className="w-8 h-8 rounded-lg bg-black border border-gray-800 flex items-center justify-center shrink-0">
                    {icon}
                </div>
            </CardContent>
        </Card>
    );
}

export default function OnboardingWizard({ user, onComplete }) {
    const [isOpen, setIsOpen] = useState(true);
    const [step, setStep] = useState(1);
    const [platform, setPlatform] = useState('ios');
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);

    useEffect(() => {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('android')) setPlatform('android');
    }, []);

    if (!user || user.has_seen_onboarding || !user.app_role || !isOpen) return null;

    const handleNext = () => {
        setStep(2);
    };

    const handleComplete = async () => {
        setIsOpen(false);
        try { await base44.auth.updateMe({ has_seen_onboarding: true }); } catch {}
        if (onComplete) onComplete();
    };

    const isManager = user.app_role === 'manager';

    return (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <AnimatePresence mode="wait">
                {step === 1 && (
                    <motion.div key="install" initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: -20 }} className="bg-[#111] border border-gray-800 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl relative">
                        <div className="p-6 text-center space-y-5">
                            <div className="w-14 h-14 bg-yellow-500 rounded-2xl mx-auto flex items-center justify-center shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                                <Smartphone className="w-7 h-7 text-black" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-white mb-2">Install the App</h2>
                                <p className="text-gray-400 text-xs leading-relaxed">
                                    For the best experience, install FirstKnock to your home screen. It works offline in bad service areas!
                                </p>
                            </div>

                            <Tabs defaultValue="ios" value={platform} onValueChange={setPlatform} className="w-full mt-4">
                                <TabsList className="grid w-full grid-cols-2 bg-[#1F1F1F]">
                                    <TabsTrigger value="ios" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">
                                        <Apple className="w-3 h-3 mr-1.5" /> iOS
                                    </TabsTrigger>
                                    <TabsTrigger value="android" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">
                                        <MonitorSmartphone className="w-3 h-3 mr-1.5" /> Android
                                    </TabsTrigger>
                                </TabsList>
                                
                                <TabsContent value="ios" className="mt-4 space-y-2">
                                    <InstallStep num={1} text="Tap the Share button in Safari" icon={<Share className="w-4 h-4 text-blue-400" />} />
                                    <InstallStep num={2} text="Scroll down, tap 'Add to Home Screen'" icon={<PlusSquare className="w-4 h-4 text-gray-200" />} />
                                    <InstallStep num={3} text="Tap 'Add' in top right" icon={<span className="font-bold text-xs text-blue-400">Add</span>} />
                                </TabsContent>

                                <TabsContent value="android" className="mt-4 space-y-2">
                                    <InstallStep num={1} text="Tap the three dots menu" icon={<Menu className="w-4 h-4 text-gray-200" />} />
                                    <InstallStep num={2} text="Tap 'Install App'" icon={<MonitorSmartphone className="w-4 h-4 text-gray-200" />} />
                                    <InstallStep num={3} text="Confirm by tapping 'Install'" icon={<Check className="w-4 h-4 text-green-500" />} />
                                </TabsContent>
                            </Tabs>

                            <Button onClick={handleNext} className="w-full h-12 text-base font-bold rounded-xl transition-all shadow-lg hover:scale-[1.02] bg-white text-black hover:bg-gray-200 mt-2">
                                Next <ArrowRight className="w-5 h-5 ml-2" />
                            </Button>
                        </div>
                    </motion.div>
                )}

                {step === 2 && (
                    <motion.div key="welcome" initial={{ opacity: 0, scale: 0.95, x: 20 }} animate={{ opacity: 1, scale: 1, x: 0 }} className="bg-[#111] border border-gray-800 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl relative">
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