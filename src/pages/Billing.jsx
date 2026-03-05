import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Check, Shield, Star, PlayCircle } from 'lucide-react';
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import BetaUsageMeter from '../components/beta/BetaUsageMeter';

const PLANS = [
  {
    id: 'pro',
    name: 'FirstKnock Pro',
    price: 49,
    priceId: 'price_1SwDXY2MvSNi6E8hZb5nSRDw',
    isPopular: true,
    features: [
      'Unlimited Zip Code Territories',
      '3 Custom Drawn Areas per Month (200 sq mi each)',
      'Unlimited Routes within your Areas',
      'Live GPS Tracking & Proof of Visit',
      'AI Route Optimization',
      'Command Center Auto-Dispatch',
      'Team Leaderboard & Metrics',
      'Property Intel & History',
      'Priority Support'
    ]
  }
];


export default function Billing() {
  const [loadingPriceId, setLoadingPriceId] = useState(null);

  const { data: user, refetch: refetchUser } = useQuery({
    queryKey: ['user'],
    queryFn: () => base44.auth.me()
  });

  const handleSubscribe = async (priceId, trialDays = 0) => {
    // Check if running in iframe (preview mode)
    if (window.self !== window.top) {
      toast.error("Stripe Checkout cannot run in this preview window. Please open your app in a new tab (click the 'Open App' button in the top right) to test payments.", { duration: 5000 });
      return;
    }

    try {
      setLoadingPriceId(priceId);
      const res = await base44.functions.invoke('createCheckoutSession', {
        priceId: priceId,
        quantity: 1,
        successUrl: window.location.origin + '/Billing?success=true',
        cancelUrl: window.location.origin + '/Billing?canceled=true',
        trialDays: trialDays
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

  const isSubscribed = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';

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

  return (
    <div className="h-full overflow-y-auto bg-black text-white p-4 sm:p-6 lg:p-8">
            <div className="max-w-6xl mx-auto space-y-8">
                
                {/* Header */}
                <div className="text-center space-y-3">
                    <h1 className="text-4xl font-extrabold tracking-tight">FirstKnock Plans</h1>
                    <p className="text-gray-400 max-w-md mx-auto">
                        Choose the perfect plan for your team. Start your 7-day free trial.
                    </p>
                </div>

                {/* Current Usage */}
                <BetaUsageMeter showUpgrade={false} />

                {isSubscribed &&
        <div className="flex flex-col items-center gap-4">
                        <div className="inline-block bg-green-900/30 border border-green-500/50 rounded-full px-4 py-1">
                            <span className="text-green-400 text-sm font-bold flex items-center gap-2">
                                <Check className="w-4 h-4" /> 
                                {user?.subscription_status === 'trialing' ? 'TRIAL ACTIVE' : 'ACTIVE SUBSCRIPTION'}
                            </span>
                        </div>
                        
                        <Button
            onClick={handleManageSubscription}
            variant="outline"
            className="border-gray-700 hover:bg-gray-800 text-gray-300 text-xs h-8">

                            Billing Portal / Cancel
                        </Button>
                    </div>
        }

                {/* Main Pricing Cards */}
                <div className="grid grid-cols-1 max-w-md mx-auto gap-6">
                    {PLANS.map((plan) => (
                        <div key={plan.id} className={`relative rounded-2xl p-6 border ${plan.isPopular ? 'border-yellow-500 bg-gray-900/80 shadow-[0_0_30px_rgba(255,215,0,0.1)]' : 'border-gray-800 bg-[#111]'} backdrop-blur-sm flex flex-col`}>
                            {plan.isPopular && (
                                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-xs font-bold px-4 py-1 rounded-full flex items-center gap-1 shadow-lg whitespace-nowrap">
                                    <Star className="w-3 h-3 fill-black" />
                                    MOST POPULAR
                                </div>
                            )}

                            <div className="text-center mb-6 mt-2">
                                <h3 className="text-xl font-bold text-white mb-2">{plan.name}</h3>
                                <div className="flex items-baseline justify-center gap-1">
                                    <span className="text-4xl font-extrabold text-white">${plan.price}</span>
                                    <span className="text-gray-400 text-sm">/mo</span>
                                </div>
                            </div>

                            <ul className="space-y-3 mb-8 flex-1">
                                {plan.features.map((feature, i) => (
                                    <li key={i} className="flex items-start gap-3 text-sm text-gray-300">
                                        <div className={`rounded-full p-1 shrink-0 mt-0.5 ${plan.isPopular ? 'bg-yellow-500/20 text-yellow-500' : 'bg-gray-800 text-gray-400'}`}>
                                            <Check className="w-3 h-3" />
                                        </div>
                                        <span>{feature}</span>
                                    </li>
                                ))}
                            </ul>

                            {!isSubscribed && (
                                <div className="flex flex-col gap-3">
                                    <Button
                                        onClick={() => handleSubscribe(plan.priceId, plan.isPopular ? 7 : 0)}
                                        disabled={loadingPriceId !== null}
                                        className={`w-full h-12 font-bold tracking-wide rounded-xl transition-all ${
                                            plan.isPopular 
                                                ? 'bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20' 
                                                : 'bg-white text-black hover:bg-gray-200'
                                        }`}
                                    >
                                        {loadingPriceId === plan.priceId ? 'PREPARING...' : (plan.isPopular ? 'START 7-DAY FREE TRIAL' : 'SUBSCRIBE')}
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {!isSubscribed && (
                    <p className="text-center text-xs text-gray-500 mt-4">
                        Secure payments via Stripe. Cancel anytime.
                    </p>
                )}

            </div>
        </div>);

}