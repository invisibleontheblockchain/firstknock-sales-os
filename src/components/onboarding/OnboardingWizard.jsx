import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { 
    Map, 
    List, 
    Upload, 
    Users, 
    CheckCircle2, 
    ArrowRight, 
    X, 
    Sparkles, 
    Navigation,
    Target
} from 'lucide-react';

export default function OnboardingWizard({ user, onComplete }) {
    const [isOpen, setIsOpen] = useState(true);
    const [step, setStep] = useState(0);

    // Don't show if already seen or no role
    if (!user || user.has_seen_onboarding || !user.app_role || !isOpen) {
        return null;
    }

    const handleComplete = async () => {
        setIsOpen(false);
        try {
            await base44.auth.updateMe({ has_seen_onboarding: true });
            if (onComplete) onComplete();
        } catch (e) {
            console.error("Failed to update onboarding status", e);
        }
    };

    const isManager = user.app_role === 'manager';

    const steps = isManager ? [
        {
            title: "Welcome to FirstKnock",
            description: "Your complete territory management command center. Let's get you set up for success.",
            icon: Sparkles,
            color: "text-yellow-500"
        },
        {
            title: "Setup Territories",
            description: "Go to the 'Setup' tab to upload your property data (CSV/JSON) and define your team's territory zip codes.",
            icon: Upload,
            color: "text-blue-500"
        },
        {
            title: "Build Routes",
            description: "Use the 'Map' to visualize properties and generate optimized routes for your team automatically.",
            icon: Map,
            color: "text-green-500"
        },
        {
            title: "Manage Your Team",
            description: "Invite reps, assign routes, and track performance in real-time from the 'Team' dashboard.",
            icon: Users,
            color: "text-purple-500"
        }
    ] : [
        {
            title: "Welcome to FirstKnock",
            description: "Your personal sales companion. We're here to help you knock more doors and close more deals.",
            icon: Sparkles,
            color: "text-yellow-500"
        },
        {
            title: "Your Daily Route",
            description: "Check 'My Route' to see your assigned properties for the day, optimized for the fastest path.",
            icon: Navigation,
            color: "text-blue-500"
        },
        {
            title: "Log Interactions",
            description: "Tap on any property to log the result of your knock. We'll track your stats automatically.",
            icon: CheckCircle2,
            color: "text-green-500"
        },
        {
            title: "Hit Your Goals",
            description: "Track your personal performance and see how you rank against the team goals.",
            icon: Target,
            color: "text-red-500"
        }
    ];

    const currentStep = steps[step];

    return (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-[#111] border border-gray-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl relative"
            >
                {/* Progress Bar */}
                <div className="h-1 bg-gray-800 w-full">
                    <motion.div 
                        className="h-full bg-yellow-500"
                        initial={{ width: 0 }}
                        animate={{ width: `${((step + 1) / steps.length) * 100}%` }}
                        transition={{ duration: 0.3 }}
                    />
                </div>

                <div className="p-8">
                    {/* Close Button */}
                    <button 
                        onClick={handleComplete}
                        className="absolute top-4 right-4 text-gray-500 hover:text-white transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>

                    <AnimatePresence mode="wait">
                        <motion.div
                            key={step}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -20 }}
                            transition={{ duration: 0.2 }}
                            className="text-center space-y-6"
                        >
                            <div className="flex justify-center">
                                <div className={`w-20 h-20 rounded-full bg-gray-900 flex items-center justify-center border border-gray-800 ${currentStep.color}`}>
                                    <currentStep.icon className="w-10 h-10" />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <h2 className="text-2xl font-bold text-white">{currentStep.title}</h2>
                                <p className="text-gray-400 leading-relaxed text-sm">
                                    {currentStep.description}
                                </p>
                            </div>
                        </motion.div>
                    </AnimatePresence>

                    <div className="mt-8 pt-4 flex gap-3">
                        {step > 0 ? (
                            <Button
                                variant="outline"
                                onClick={() => setStep(step - 1)}
                                className="flex-1 border-gray-700 text-white hover:bg-gray-800 hover:text-white"
                            >
                                Back
                            </Button>
                        ) : (
                            <Button
                                variant="ghost"
                                onClick={handleComplete}
                                className="flex-1 text-gray-500 hover:text-white"
                            >
                                Skip
                            </Button>
                        )}

                        <Button
                            onClick={() => {
                                if (step < steps.length - 1) {
                                    setStep(step + 1);
                                } else {
                                    handleComplete();
                                }
                            }}
                            className="flex-1 bg-yellow-500 text-black font-bold hover:bg-yellow-400"
                        >
                            {step === steps.length - 1 ? "Let's Go!" : "Next"}
                            {step < steps.length - 1 && <ArrowRight className="w-4 h-4 ml-2" />}
                        </Button>
                    </div>
                    
                    <div className="mt-6 flex justify-center gap-1.5">
                        {steps.map((_, idx) => (
                            <div 
                                key={idx} 
                                className={`w-2 h-2 rounded-full transition-colors ${idx === step ? 'bg-yellow-500' : 'bg-gray-800'}`}
                            />
                        ))}
                    </div>
                </div>
            </motion.div>
        </div>
    );
}