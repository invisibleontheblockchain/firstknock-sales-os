import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Check, Shield, Zap, Star, Users, TrendingDown, ChevronDown, BarChart3 } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import BetaUsageMeter from '../components/beta/BetaUsageMeter';

const BRAND = {
    gold: '#FFD700',
    black: '#0A0A0A',
    gray: '#1F1F1F'
};

// Single plan - $49 base, $1 off per user, min $20/user
const BASE_PRICE = 49;
const DISCOUNT_PER_USER = 1;
const MIN_PRICE_PER_USER = 20;
const PRICE_ID = 'price_1SwDXY2MvSNi6E8hZb5nSRDw'; // Hustler $49 base

const getPricePerUser = (totalUsers) => {
    const discount = (totalUsers - 1) * DISCOUNT_PER_USER;
    return Math.max(MIN_PRICE_PER_USER, BASE_PRICE - discount);
};

const getMonthlyTotal = (totalUsers) => {
    return totalUsers * getPricePerUser(totalUsers);
};

const ALL_FEATURES = [
    'Up to 10 Zip Code Territories',
    'Unlimited Routes & Route Builder',
    'Live GPS Tracking & Proof of Visit',
    'AI Route Optimization',
    'Command Center Auto-Dispatch',
    'Team Leaderboard & Metrics',
    'Property Intel & History',
    'Priority Support'
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

    const pricePerUser = getPricePerUser(seats);
    const monthlyTotal = getMonthlyTotal(seats);
    const savings = seats > 1 ? (BASE_PRICE * seats) - monthlyTotal : 0;

    return (
        <div className="h-full overflow-y-auto bg-black text-white p-4 sm:p-6 lg:p-8">
            <div className="max-w-2xl mx-auto space-y-8">
                
                {/* Header */}
                <div className="text-center space-y-3">
                    <h1 className="text-4xl font-extrabold tracking-tight">FirstKnock Pro</h1>
                    <p className="text-gray-400 max-w-md mx-auto">
                        One plan. Every feature. The more you grow, the more you save.
                    </p>
                </div>

                {/* Current Usage */}
                <BetaUsageMeter showUpgrade={false} />

                {isSubscribed && (
                    <div className="flex flex-col items-center gap-4">
                        <div className="inline-block bg-green-900/30 border border-green-500/50 rounded-full px-4 py-1">
                            <span className="text-green-400 text-sm font-bold flex items-center gap-2">
                                <Check className="w-4 h-4" /> ACTIVE SUBSCRIPTION
                            </span>
                        </div>
                        
                        <div className="bg-[#111] border border-gray-800 rounded-xl p-4 flex flex-col items-center gap-3 w-full max-w-sm">
                            <p className="text-xs text-gray-400 font-bold uppercase">Manage Seats</p>
                            <div className="flex items-center gap-4">
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

                {/* Main Pricing Card */}
                <div className="relative rounded-2xl p-6 sm:p-8 border border-yellow-500 bg-gray-900/80 backdrop-blur-sm shadow-[0_0_60px_rgba(255,215,0,0.1)]">
                    
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-xs font-bold px-4 py-1 rounded-full flex items-center gap-1 shadow-lg">
                        <Star className="w-3 h-3 fill-black" />
                        ALL FEATURES INCLUDED
                    </div>

                    {/* Price Display */}
                    <div className="text-center mb-8 mt-2">
                        <div className="flex items-baseline justify-center gap-2">
                            <span className="text-5xl font-extrabold text-white">${pricePerUser}</span>
                            <span className="text-gray-400 text-lg">/user/mo</span>
                        </div>
                        {seats > 1 && pricePerUser < BASE_PRICE && (
                            <div className="flex items-center justify-center gap-2 mt-2">
                                <span className="text-gray-500 line-through text-sm">${BASE_PRICE}/user</span>
                                <Badge className="bg-green-900/50 text-green-400 border-green-500/30 text-xs">
                                    <TrendingDown className="w-3 h-3 mr-1" />
                                    SAVE ${BASE_PRICE - pricePerUser}/user
                                </Badge>
                            </div>
                        )}
                    </div>

                    {/* Team Size Selector */}
                    <div className="bg-black/40 rounded-xl p-5 border border-gray-800 mb-6">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <Users className="w-4 h-4 text-yellow-500" />
                                <span className="text-sm font-bold text-gray-300">TEAM SIZE</span>
                            </div>
                            <span className="text-sm text-gray-500">{seats} {seats === 1 ? 'user' : 'users'}</span>
                        </div>
                        
                        <div className="flex items-center gap-4">
                            <button 
                                onClick={() => setSeats(Math.max(1, seats - 1))}
                                className="w-10 h-10 rounded-xl bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center transition-colors font-bold text-lg"
                            >
                                -
                            </button>
                            <div className="flex-1 relative">
                                <input
                                    type="range"
                                    min="1"
                                    max="50"
                                    value={seats}
                                    onChange={(e) => setSeats(parseInt(e.target.value))}
                                    className="w-full accent-yellow-500 cursor-pointer"
                                />
                                <div className="flex justify-between text-[10px] text-gray-600 mt-1 px-1">
                                    <span>1</span>
                                    <span>10</span>
                                    <span>25</span>
                                    <span>50</span>
                                </div>
                            </div>
                            <button 
                                onClick={() => setSeats(Math.min(50, seats + 1))}
                                className="w-10 h-10 rounded-xl bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center transition-colors font-bold text-lg"
                            >
                                +
                            </button>
                        </div>

                        {/* Price Breakdown */}
                        <div className="mt-4 pt-4 border-t border-gray-800 flex items-center justify-between">
                            <span className="text-sm text-gray-400">Monthly Total</span>
                            <div className="text-right">
                                <span className="text-2xl font-extrabold text-yellow-500">${monthlyTotal}</span>
                                <span className="text-gray-500 text-sm">/mo</span>
                                {savings > 0 && (
                                    <p className="text-xs text-green-400 mt-0.5">Saving ${savings}/mo vs solo pricing</p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Features */}
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
                        {ALL_FEATURES.map((feature, i) => (
                            <li key={i} className="flex items-center gap-3 text-sm text-gray-300">
                                <div className="rounded-full p-1 bg-yellow-500/20 text-yellow-500 shrink-0">
                                    <Check className="w-3 h-3" />
                                </div>
                                {feature}
                            </li>
                        ))}
                    </ul>

                    {/* CTA */}
                    {!isSubscribed && (
                        <Button
                            onClick={() => handleSubscribe(PRICE_ID)}
                            disabled={loadingPriceId !== null}
                            className="w-full h-12 font-bold text-base tracking-wide bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20 transition-all"
                        >
                            {loadingPriceId ? 'PREPARING...' : `GET STARTED — $${monthlyTotal}/mo`}
                        </Button>
                    )}
                </div>

                {/* Volume Discount Table */}
                <div className="bg-[#111] border border-gray-800 rounded-xl p-5">
                    <h3 className="font-bold text-white text-sm mb-4 flex items-center gap-2">
                        <TrendingDown className="w-4 h-4 text-green-400" />
                        Volume Discounts
                    </h3>
                    <div className="grid grid-cols-4 gap-3 text-center">
                        {[1, 5, 15, 30].map(n => (
                            <div 
                                key={n} 
                                onClick={() => setSeats(n)}
                                className={`rounded-lg p-3 border cursor-pointer transition-all hover:border-yellow-500/50 ${seats === n ? 'border-yellow-500 bg-yellow-500/5' : 'border-gray-800 bg-black/30'}`}
                            >
                                <p className="text-xs text-gray-500 mb-1">{n} {n === 1 ? 'user' : 'users'}</p>
                                <p className="text-lg font-bold text-white">${getPricePerUser(n)}</p>
                                <p className="text-[10px] text-gray-600">/user/mo</p>
                            </div>
                        ))}
                    </div>
                    <p className="text-[11px] text-gray-600 mt-3 text-center">
                        Price drops $1/user for each team member added. Minimum $20/user/mo.
                    </p>
                </div>

                {/* Enterprise Callout */}
                <div className="bg-[#111] border border-gray-800 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-blue-900/20 flex items-center justify-center text-blue-500">
                            <Shield className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="font-bold text-white">50+ Users?</h3>
                            <p className="text-sm text-gray-400">Contact us for custom enterprise pricing and white-label options.</p>
                        </div>
                    </div>
                    <Button variant="outline" className="border-gray-700 text-white hover:bg-gray-800">
                        Contact Sales
                    </Button>
                </div>

                {/* Cost Projections Link */}
                <div className="text-center">
                    <Link to={createPageUrl('CostProjections')}>
                        <Button variant="outline" className="border-gray-700 text-gray-400 hover:text-white hover:bg-gray-800 gap-2">
                            <BarChart3 className="w-4 h-4" />
                            View Scaling Metrics (1 → 1M Users)
                        </Button>
                    </Link>
                </div>

                <div className="text-center text-xs text-gray-600">
                    <p>Secure payments processed by Stripe. Cancel anytime.</p>
                </div>

            </div>
        </div>
    );
}