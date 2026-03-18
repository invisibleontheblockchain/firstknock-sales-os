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
      '200 sq mi Service Area (Free: 2 pulls)',
      'Unlimited Fresh Data Pulls',
      'Unlimited Route Generation',
      'Filter by Price, Date, Property Type',
      'Live GPS Tracking & Proof of Visit',
      'AI Route Optimization',
      'Team Management & Dispatch',
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
    <div className="h-full overflow-y-auto bg-black text-white p-2 sm:p-6 lg:p-8 flex flex-col items-center">
            <div className="max-w-6xl w-full mx-auto space-y-3 sm:space-y-8 py-4 sm:py-8">
                
                {/* Header */}
                <div className="text-center space-y-1 sm:space-y-3">
                    <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight">FirstKnock Plans</h1>
                    <p className="text-xs sm:text-base text-gray-400 max-w-md mx-auto">
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
                <div className="grid grid-cols-1 max-w-md mx-auto gap-3 sm:gap-6">
                    {PLANS.map((plan) => (
                        <div key={plan.id} className={`relative rounded-2xl p-3.5 sm:p-6 border ${plan.isPopular ? 'border-yellow-500 bg-gray-900/80 shadow-[0_0_30px_rgba(255,215,0,0.1)]' : 'border-gray-800 bg-[#111]'} backdrop-blur-sm flex flex-col`}>
                            {plan.isPopular && (
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-[9px] sm:text-xs font-bold px-3 py-0.5 rounded-full flex items-center gap-1 shadow-lg whitespace-nowrap">
                                    <Star className="w-2.5 h-2.5 fill-black" />
                                    MOST POPULAR
                                </div>
                            )}

                            <div className="text-center mb-2 sm:mb-6 mt-1 sm:mt-2">
                                <h3 className="text-base sm:text-xl font-bold text-white mb-0.5 sm:mb-2">{plan.name}</h3>
                                <div className="flex items-baseline justify-center gap-1">
                                    <span className="text-3xl sm:text-4xl font-extrabold text-white">${plan.price}</span>
                                    <span className="text-gray-400 text-xs sm:text-sm">/mo</span>
                                </div>
                            </div>

                            <ul className="space-y-1.5 sm:space-y-3 mb-3 sm:mb-8 flex-1">
                                {plan.features.map((feature, i) => (
                                    <li key={i} className="flex items-start gap-2.5 sm:gap-3 text-xs sm:text-sm text-gray-300">
                                        <div className={`rounded-full p-0.5 sm:p-1 shrink-0 mt-0.5 ${plan.isPopular ? 'bg-yellow-500/20 text-yellow-500' : 'bg-gray-800 text-gray-400'}`}>
                                            <Check className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                                        </div>
                                        <span className="leading-tight">{feature}</span>
                                    </li>
                                ))}
                            </ul>

                            {!isSubscribed && (
                                <div className="flex flex-col gap-2 sm:gap-3">
                                    <Button
                                        onClick={() => handleSubscribe(plan.priceId, 7)}
                                        disabled={loadingPriceId !== null}
                                        className="w-full h-10 sm:h-12 font-bold tracking-wide rounded-xl transition-all bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20 text-xs sm:text-base"
                                    >
                                        {loadingPriceId === plan.priceId + '_trial' ? 'PREPARING...' : 'START 7-DAY FREE TRIAL'}
                                    </Button>
                                    <Button
                                        onClick={() => handleSubscribe(plan.priceId, 0)}
                                        disabled={loadingPriceId !== null}
                                        className="w-full h-9 sm:h-10 font-bold tracking-wide rounded-xl transition-all bg-white/10 text-white hover:bg-white/20 border border-white/10 text-[10px] sm:text-sm"
                                    >
                                        {loadingPriceId === plan.priceId + '_pay' ? 'PREPARING...' : 'PAY $49/MO — NO TRIAL'}
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {!isSubscribed && (
                    <p className="text-center text-[10px] sm:text-xs text-gray-500 mt-2 sm:mt-4">
                        Secure payments via Stripe. Cancel anytime.
                    </p>
                )}

                <div className="text-center mt-4 sm:mt-6 pb-4">
                    <p className="text-[10px] sm:text-xs text-gray-500">
                        Need help? Contact support at{' '}
                        <a href="mailto:firstknockhelp@gmail.com" className="text-yellow-500 hover:text-yellow-400 underline">
                            firstknockhelp@gmail.com
                        </a>
                    </p>
                </div>

            </div>
        </div>);

}