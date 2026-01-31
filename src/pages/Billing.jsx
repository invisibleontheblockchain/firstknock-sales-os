import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Check, Shield, Zap, Star } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

const BRAND = {
    gold: '#FFD700',
    black: '#0A0A0A',
    gray: '#1F1F1F'
};

const PLANS = [
    {
        id: 'hustler',
        name: 'HUSTLER',
        price: '$49',
        priceId: 'price_1SvkEWEuXj1jcxU8SnED0qrs',
        description: 'For solo reps & small teams.',
        features: [
            'Up to 5 Users',
            'Live GPS Tracking',
            'Basic Territory Management',
            'Manual Route Building',
            'Lead Status Tracking'
        ],
        color: 'white',
        recommended: false
    },
    {
        id: 'growth',
        name: 'GROWTH',
        price: '$99',
        priceId: 'price_1SvkEWEuXj1jcxU8RGN3pB3i',
        description: 'For scaling sales organizations.',
        features: [
            'Up to 20 Users',
            'Command Center Auto-Dispatch',
            'Dark Room Intelligence (2k/mo)',
            'AI Route Optimization',
            'Team Leaderboard & Metrics',
            'Priority Support'
        ],
        color: '#FFD700',
        recommended: true
    }
];

export default function Billing() {
    const [loadingPriceId, setLoadingPriceId] = useState(null);

    const { data: user } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me()
    });

    const handleSubscribe = async (priceId) => {
        try {
            setLoadingPriceId(priceId);
            const res = await base44.functions.invoke('createCheckoutSession', {
                priceId,
                successUrl: window.location.origin + '/Billing?success=true',
                cancelUrl: window.location.origin + '/Billing?canceled=true'
            });

            if (res.data.url) {
                window.location.href = res.data.url;
            } else {
                throw new Error(res.data.error || 'Failed to start checkout');
            }
        } catch (error) {
            toast.error("Checkout failed: " + error.message);
            setLoadingPriceId(null);
        }
    };

    const isSubscribed = user?.subscription_status === 'active';

    return (
        <div className="min-h-screen bg-black text-white p-6">
            <div className="max-w-4xl mx-auto space-y-12">
                
                {/* Header */}
                <div className="text-center space-y-4">
                    <h1 className="text-4xl font-extrabold tracking-tight">Upgrade Your Arsenal</h1>
                    <p className="text-gray-400 max-w-lg mx-auto">
                        Unlock advanced logistics, dark room intelligence, and auto-dispatch capabilities.
                    </p>
                    {isSubscribed && (
                        <div className="inline-block bg-green-900/30 border border-green-500/50 rounded-full px-4 py-1">
                            <span className="text-green-400 text-sm font-bold flex items-center gap-2">
                                <Check className="w-4 h-4" /> ACTIVE SUBSCRIPTION
                            </span>
                        </div>
                    )}
                </div>

                {/* Plans Grid */}
                <div className="grid md:grid-cols-2 gap-8 items-start">
                    {PLANS.map(plan => (
                        <div 
                            key={plan.id}
                            className={`relative rounded-2xl p-8 border transition-all duration-300 ${
                                plan.recommended 
                                    ? 'bg-[#111] border-yellow-500 shadow-[0_0_30px_rgba(255,215,0,0.1)] scale-105 z-10' 
                                    : 'bg-black border-gray-800 hover:border-gray-700'
                            }`}
                        >
                            {plan.recommended && (
                                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1 shadow-lg">
                                    <Star className="w-3 h-3 fill-black" />
                                    MOST POPULAR
                                </div>
                            )}

                            <div className="space-y-4 mb-8">
                                <h3 className="text-xl font-bold tracking-wide" style={{ color: plan.color }}>
                                    {plan.name}
                                </h3>
                                <div className="flex items-baseline gap-1">
                                    <span className="text-4xl font-extrabold text-white">{plan.price}</span>
                                    <span className="text-gray-500 text-sm">/user/mo</span>
                                </div>
                                <p className="text-sm text-gray-400 h-10">{plan.description}</p>
                            </div>

                            <ul className="space-y-4 mb-8">
                                {plan.features.map((feature, i) => (
                                    <li key={i} className="flex items-center gap-3 text-sm text-gray-300">
                                        <div className={`rounded-full p-1 ${plan.recommended ? 'bg-yellow-500/20 text-yellow-500' : 'bg-gray-800 text-gray-400'}`}>
                                            <Check className="w-3 h-3" />
                                        </div>
                                        {feature}
                                    </li>
                                ))}
                            </ul>

                            <Button
                                onClick={() => handleSubscribe(plan.priceId)}
                                disabled={loadingPriceId !== null || isSubscribed}
                                className={`w-full h-12 font-bold tracking-wide transition-all ${
                                    plan.recommended
                                        ? 'bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20'
                                        : 'bg-white text-black hover:bg-gray-200'
                                }`}
                            >
                                {loadingPriceId === plan.priceId ? 'PREPARING...' : isSubscribed ? 'CURRENT PLAN' : `CHOOSE ${plan.name}`}
                            </Button>
                        </div>
                    ))}
                </div>

                {/* Enterprise Callout */}
                <div className="bg-[#111] border border-gray-800 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-blue-900/20 flex items-center justify-center text-blue-500">
                            <Shield className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="font-bold text-white">Need Enterprise Power?</h3>
                            <p className="text-sm text-gray-400">Custom integrations, white-labeling, and unlimited scale.</p>
                        </div>
                    </div>
                    <Button variant="outline" className="border-gray-700 text-white hover:bg-gray-800">
                        Contact Sales
                    </Button>
                </div>

                <div className="text-center text-xs text-gray-600">
                    <p>Secure payments processed by Stripe. Cancel anytime.</p>
                </div>

            </div>
        </div>
    );
}