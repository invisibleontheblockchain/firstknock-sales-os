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
        priceId: 'price_1SwDXY2MvSNi6E8hZb5nSRDw',
        description: 'For solo reps & small teams.',
        features: [
            'Max 5 Users',
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
        priceId: 'price_1SwDXY2MvSNi6E8hfhtK7rBc',
        description: 'For scaling sales organizations.',
        features: [
            'Max 20 Users',
            'Command Center Auto-Dispatch',
            'AI Route Optimization',
            'Team Leaderboard & Metrics',
            'Priority Support'
        ],
        color: '#FFD700',
        recommended: true
    },
    {
        id: 'enterprise',
        name: 'ENTERPRISE',
        price: '$299',
        priceId: 'price_1SwDXY2MvSNi6E8hbaKcsk0d',
        description: 'Maximum power for large fleets.',
        features: [
            'Best for 20+ Users',
            'Advanced Analytics',
            'Custom API Access',
            'Dedicated Success Manager',
            'White-Label Options',
            'SLA & 24/7 Support'
        ],
        color: '#3b82f6',
        recommended: false
    }
];

export default function Billing() {
    const [loadingPriceId, setLoadingPriceId] = useState(null);
    const [updatingSeats, setUpdatingSeats] = useState(false);
    const [seats, setSeats] = useState(1);

    const { data: user, refetch: refetchUser } = useQuery({
        queryKey: ['user'],
        queryFn: () => base44.auth.me()
    });

    const handleSubscribe = async (priceId) => {
        // Check if running in iframe (preview mode)
        if (window.self !== window.top) {
            alert("Stripe Checkout cannot run in this preview window due to security restrictions.\n\nPlease open your app in a new tab (click the 'Open App' button in the top right) to test payments.");
            return;
        }

        try {
            setLoadingPriceId(priceId);
            const res = await base44.functions.invoke('createCheckoutSession', {
                priceId,
                quantity: seats,
                successUrl: window.location.origin + '/Billing?success=true',
                cancelUrl: window.location.origin + '/Billing?canceled=true'
            });

            if (res.data.url) {
                window.location.href = res.data.url;
            } else {
                throw new Error(res.data.error || 'Failed to start checkout');
            }
        } catch (error) {
            console.error("Checkout failed:", error);
            toast.error("Checkout failed: " + error.message);
            setLoadingPriceId(null);
        }
    };

    const isSubscribed = user?.subscription_status === 'active';

    const handleManageSubscription = async () => {
        try {
            const res = await base44.functions.invoke('createPortalSession', {
                returnUrl: window.location.href
            });
            if (res.data.url) {
                window.location.href = res.data.url;
            } else {
                toast.error("Failed to load subscription portal");
            }
        } catch (error) {
            toast.error("Error opening portal: " + error.message);
        }
    };

    const handleUpdateSeats = async () => {
        if(!confirm(`Update subscription to ${seats} seats? You will be charged immediately for any added seats.`)) return;
        
        try {
            setUpdatingSeats(true);
            const res = await base44.functions.invoke('updateSubscriptionSeats', {
                quantity: seats
            });
            
            if (res.data.success) {
                toast.success(`Updated to ${seats} seats successfully!`);
            } else {
                throw new Error(res.data.error || "Update failed");
            }
        } catch (error) {
            console.error(error);
            toast.error("Failed to update seats: " + error.message);
        } finally {
            setUpdatingSeats(false);
        }
    };

    // Helper to determine if a plan is allowed for the current seat count
    const isPlanAllowed = (planId) => {
        if (planId === 'hustler' && seats > 5) return false;
        if (planId === 'growth' && seats > 20) return false;
        return true;
    };

    return (
        <div className="h-full overflow-y-auto bg-black text-white p-4 sm:p-6 lg:p-8">
            <div className="max-w-6xl mx-auto space-y-10">
                
                {/* Header */}
                <div className="text-center space-y-4">
                    <h1 className="text-4xl font-extrabold tracking-tight">Upgrade Your Arsenal</h1>
                    <p className="text-gray-400 max-w-lg mx-auto">
                        Unlock advanced logistics and auto-dispatch capabilities.
                    </p>

                    {/* Seat Selector - Compact */}
                    <div className="bg-[#111]/80 backdrop-blur border border-gray-800 rounded-full px-6 py-2 mx-auto flex items-center justify-between gap-6 max-w-fit shadow-xl">
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider whitespace-nowrap">TEAM SIZE:</span>
                        
                        <div className="flex items-center gap-3">
                            <button 
                                onClick={() => setSeats(Math.max(1, seats - 1))}
                                className="w-6 h-6 rounded-full bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center transition-colors font-bold"
                            >
                                -
                            </button>
                            <span className="text-xl font-extrabold text-yellow-500 w-8 text-center">{seats}</span>
                            <button 
                                onClick={() => setSeats(seats + 1)}
                                className="w-6 h-6 rounded-full bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center transition-colors font-bold"
                            >
                                +
                            </button>
                        </div>

                        <div className="h-6 w-px bg-gray-700 mx-2 hidden sm:block"></div>
                        
                        <div className="hidden sm:block">
                            {seats <= 5 && <span className="text-[10px] text-white font-bold">HUSTLER</span>}
                            {seats > 5 && seats <= 20 && <span className="text-[10px] text-yellow-500 font-bold">GROWTH</span>}
                            {seats > 20 && <span className="text-[10px] text-blue-400 font-bold">ENTERPRISE</span>}
                        </div>
                    </div>

                    {isSubscribed && (
                        <div className="flex flex-col items-center gap-4 mt-4">
                            <div className="inline-block bg-green-900/30 border border-green-500/50 rounded-full px-4 py-1">
                                <span className="text-green-400 text-sm font-bold flex items-center gap-2">
                                    <Check className="w-4 h-4" /> ACTIVE SUBSCRIPTION
                                </span>
                            </div>
                            
                            <div className="bg-[#111] border border-gray-800 rounded-xl p-4 flex flex-col items-center gap-3 w-full max-w-sm">
                                <p className="text-xs text-gray-400 font-bold uppercase">Manage Seats</p>
                                <div className="flex items-center gap-4">
                                     {/* Re-use seat selector state */}
                                     <span className="text-white text-sm">Target: <span className="text-yellow-500 font-bold">{seats} Seats</span></span>
                                     <Button 
                                        onClick={handleUpdateSeats} 
                                        disabled={updatingSeats}
                                        size="sm"
                                        className="bg-yellow-500 text-black hover:bg-yellow-400 font-bold"
                                    >
                                        {updatingSeats ? 'Updating...' : 'Update Quantity'}
                                    </Button>
                                </div>
                            </div>

                            <Button 
                                onClick={handleManageSubscription}
                                variant="outline" 
                                className="border-gray-700 hover:bg-gray-800 text-gray-300 text-xs h-8"
                            >
                                Billing Portal / Cancel
                            </Button>
                        </div>
                    )}
                </div>

                {/* Plans Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6 items-stretch">
                    {PLANS.map(plan => (
                        <div 
                            key={plan.id}
                            className={`relative rounded-2xl p-6 border transition-all duration-300 flex flex-col h-full ${
                                plan.recommended 
                                    ? 'bg-gray-900/80 backdrop-blur-sm border-yellow-500 shadow-[0_0_40px_rgba(255,215,0,0.15)] scale-105 z-10' 
                                    : 'bg-black/50 backdrop-blur-sm border-gray-800 hover:border-gray-600 hover:bg-gray-900/50'
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
                                <div className="text-xs text-gray-500 font-medium mt-1">
                                    Total: <span className="text-gray-300">${parseInt(plan.price.replace('$','')) * seats}</span> /mo
                                </div>
                                <p className="text-sm text-gray-400 min-h-[3rem]">{plan.description}</p>
                            </div>

                            <ul className="space-y-3 mb-8 flex-1">
                                {plan.features.map((feature, i) => (
                                    <li key={i} className="flex items-start gap-3 text-sm text-gray-300">
                                        <div className={`rounded-full p-1 ${plan.recommended ? 'bg-yellow-500/20 text-yellow-500' : 'bg-gray-800 text-gray-400'}`}>
                                            <Check className="w-3 h-3" />
                                        </div>
                                        {feature}
                                    </li>
                                ))}
                            </ul>

                            <Button
                                onClick={() => handleSubscribe(plan.priceId)}
                                disabled={loadingPriceId !== null || isSubscribed || !isPlanAllowed(plan.id)}
                                className={`w-full h-12 font-bold tracking-wide transition-all ${
                                    !isPlanAllowed(plan.id)
                                        ? 'bg-gray-800 text-gray-500 cursor-not-allowed opacity-50'
                                        : plan.recommended
                                            ? 'bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20'
                                            : 'bg-white text-black hover:bg-gray-200'
                                }`}
                            >
                                {loadingPriceId === plan.priceId ? 'PREPARING...' 
                                 : isSubscribed ? 'CURRENT PLAN' 
                                 : !isPlanAllowed(plan.id) ? `MAX ${plan.id === 'hustler' ? 5 : 20} USERS`
                                 : `CHOOSE ${plan.name}`}
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