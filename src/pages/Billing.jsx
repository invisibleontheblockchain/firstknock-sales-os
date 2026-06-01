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
import PricingModeCard from '../components/billing/PricingModeCard.jsx';

const PLANS = [
  {
    id: 'canvas',
    name: 'Canvas Mode',
    price: 19,
    unit: '/rep/mo',
    isPopular: false,
    features: [
      'Canvas Mode at $19 per rep per month',
      'AI-Optimized Walking Routes',
      'Live GPS Tracking & Proof of Visit',
      'Team Management & Dispatch',
      'No paid BatchData pull required'
    ]
  },
  {
    id: 'precision',
    name: 'Precision Mode',
    price: 99,
    unit: '/user/mo',
    isPopular: true,
    features: [
      'Precision Mode at $99 per user per month',
      'BatchData-backed property acquisition',
      'Freehand area pulls and property imports',
      'Advanced Filters & Property Intel',
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

  const handleSubscribe = async (planId, trialDays = 0) => {
    // Check if running in iframe (preview mode)
    if (window.self !== window.top) {
      toast.error("Stripe Checkout cannot run in this preview window. Please open your app in a new tab (click the 'Open App' button in the top right) to test payments.", { duration: 5000 });
      return;
    }

    const suffix = trialDays > 0 ? '_trial' : '_pay';
    try {
      setLoadingPriceId(planId + suffix);
      console.log('[Billing] Starting checkout', { planId, trialDays, suffix });
      
      const res = await base44.functions.invoke('createCheckoutSession', {
        planId,
        quantity: 1,
        successUrl: window.location.origin + '/Billing?success=true',
        cancelUrl: window.location.origin + '/Billing?canceled=true',
        trialDays: trialDays
      });

      console.log('[Billing] Checkout response:', JSON.stringify(res));

      // Handle different response shapes — SDK may wrap in .data or return directly
      const checkoutUrl = res?.data?.url || res?.url;
      const errorMsg = res?.data?.error || res?.error;

      if (checkoutUrl) {
        console.log('[Billing] Redirecting to:', checkoutUrl);
        window.location.href = checkoutUrl;
      } else {
        console.error('[Billing] No checkout URL in response:', res);
        throw new Error(errorMsg || 'No checkout URL returned from Stripe. Check console for details.');
      }
    } catch (error) {
      console.error("[Billing] Checkout failed:", error);
      const msg = error?.response?.data?.error || error?.message || 'Unknown error';
      toast.error("Checkout failed: " + msg, { duration: 6000 });
      setLoadingPriceId(null);
    }
  };

  // Handle return from Stripe checkout
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === 'true') {
      toast.success("Payment successful! Your subscription is being activated. It may take a moment to reflect.", { duration: 6000 });
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
      // Refetch user to get updated subscription_status
      setTimeout(() => refetchUser(), 2000);
    } else if (params.get('canceled') === 'true') {
      toast.info("Checkout canceled. You can try again anytime.");
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const isSubscribed = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
  const precisionLimit = user?.precision_property_limit || user?.monthly_property_limit || 1000;
  const precisionUsed = Math.min(user?.precision_properties_used || user?.territory_property_count || 0, precisionLimit);
  const precisionUsage = {
    limit: precisionLimit,
    used: precisionUsed,
    remaining: Math.max(precisionLimit - precisionUsed, 0),
    percent: precisionLimit > 0 ? Math.min(100, Math.round((precisionUsed / precisionLimit) * 100)) : 0
  };

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
    <div className="h-full overflow-y-auto bg-black text-white px-4 py-4 sm:p-6 lg:p-8 flex flex-col items-center">
            <div className="max-w-6xl w-full mx-auto space-y-4 sm:space-y-8 py-4 sm:py-8">
                
                {/* Header */}
                <div className="text-center space-y-2 sm:space-y-3">
                    <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">FirstKnock Plans</h1>
                    <p className="text-sm sm:text-base text-gray-400 max-w-2xl mx-auto">
                        Canvas is $19 per rep/month for high-volume teams. Precision is $99 per user/month for paid BatchData-backed targeting.
                    </p>
                </div>

                {/* Current Usage — hidden on mobile to save space */}
                <div className="hidden sm:block">
                    <BetaUsageMeter showUpgrade={false} />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                    <PricingModeCard
                        mode="canvas"
                        title="Canvas Mode"
                        price="$19 / rep / mo"
                        subtitle="For massive door-knocking teams working assigned routes."
                        features={[
                            'Per-rep pricing scales with your field team',
                            'Route builder, dispatch, Knock tab, and Checklist sync',
                            'GPS proof, outcomes, team progress, and route switching',
                            'No paid BatchData pull required for route execution'
                        ]}
                    />
                    <PricingModeCard
                        mode="precision"
                        title="Precision Mode"
                        price="$99 / user / mo"
                        subtitle="For BatchData-backed property acquisition before routing."
                        usage={precisionUsage}
                        features={[
                            'Freehand area preview before using paid credits',
                            'Properties counter shows how many records remain',
                            'Paid pulls import real property records into territory',
                            'Best for targeted recently-sold/new-homeowner campaigns'
                        ]}
                    />
                </div>

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

                {/* Main Pricing Card */}
                <div className="grid grid-cols-1 max-w-md mx-auto gap-4 sm:gap-6">
                    {PLANS.map((plan) => (
                        <div key={plan.id} className={`relative rounded-2xl p-5 sm:p-6 border ${plan.isPopular ? 'border-yellow-500 bg-gray-900/80 shadow-[0_0_30px_rgba(255,215,0,0.1)]' : 'border-gray-800 bg-[#111]'} backdrop-blur-sm flex flex-col`}>
                            {plan.isPopular && (
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-xs sm:text-xs font-bold px-3 py-0.5 rounded-full flex items-center gap-1 shadow-lg whitespace-nowrap">
                                    <Star className="w-2.5 h-2.5 fill-black" />
                                    MOST POPULAR
                                </div>
                            )}

                            <div className="text-center mb-3 sm:mb-6 mt-2 sm:mt-2">
                                <div className="flex items-baseline justify-center gap-1">
                                    <span className="text-4xl sm:text-4xl font-extrabold text-white">${plan.price}</span>
                                    <span className="text-gray-400 text-sm sm:text-sm">{plan.unit}</span>
                                </div>
                            </div>

                            <ul className="space-y-2.5 sm:space-y-3 mb-5 sm:mb-8 flex-1">
                                {plan.features.map((feature, i) => (
                                    <li key={i} className="flex items-center gap-3 sm:gap-3 text-sm sm:text-sm text-gray-300">
                                        <div className={`rounded-full p-1 sm:p-1 shrink-0 ${plan.isPopular ? 'bg-yellow-500/20 text-yellow-500' : 'bg-gray-800 text-gray-400'}`}>
                                            <Check className="w-3 h-3 sm:w-3 sm:h-3" />
                                        </div>
                                        <span className="leading-snug">{feature}</span>
                                    </li>
                                ))}
                            </ul>

                            {!isSubscribed && (
                                <div className="flex flex-col gap-3 sm:gap-3">
                                    <Button
                                        onClick={() => handleSubscribe(plan.id, 7)}
                                        disabled={loadingPriceId !== null}
                                        className="w-full h-12 sm:h-12 font-bold tracking-wide rounded-xl transition-all bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20 text-base sm:text-base"
                                    >
                                        {loadingPriceId === plan.id + '_trial' ? 'PREPARING...' : 'START 7-DAY FREE TRIAL'}
                                    </Button>
                                    <Button
                                        onClick={() => handleSubscribe(plan.id, 0)}
                                        disabled={loadingPriceId !== null}
                                        className="w-full h-10 sm:h-10 font-bold tracking-wide rounded-xl transition-all bg-white/10 text-white hover:bg-white/20 border border-white/10 text-sm sm:text-sm"
                                    >
                                        {loadingPriceId === plan.id + '_pay' ? 'PREPARING...' : `PAY $${plan.price}${plan.unit.toUpperCase()} — NO TRIAL`}
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {!isSubscribed && (
                    <p className="text-center text-xs sm:text-xs text-gray-500 mt-3 sm:mt-4">
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