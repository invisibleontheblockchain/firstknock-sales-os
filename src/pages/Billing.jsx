import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AlertCircle, Check, Star } from 'lucide-react';
import { toast } from "sonner";
import BetaUsageMeter from '../components/beta/BetaUsageMeter';
import { getBillingState, shouldShowTrialActivation } from '@/lib/billingState';
import { usePrecisionUsage } from '@/hooks/usePrecisionUsage';

const PLANS = [
  {
    id: 'precision',
    name: 'Precision Mode',
    price: 99,
    unit: '/user/mo',
    isPopular: true,
    subtitle: 'For targeted property acquisition before routing.',
    includedFeatures: [
      'Up to 1,000 Precision homes per monthly billing period after payment clears',
      'Free accounts remain limited to 50 total single-family Precision homes',
      'A card or free trial alone does not unlock the 1,000-home allowance',
      'Freehand area preview before using Precision homes'
    ],
    features: [
      'Precision Mode at $99 per user per month',
      'Targeted property acquisition',
      'Recently-sold and new-homeowner filters',
      'Advanced Filters & Property Intel',
      'Priority Support'
    ]
  }
];


export default function Billing() {
  const [loadingPriceId, setLoadingPriceId] = useState(null);

  const {
    data: user,
    refetch: refetchUser,
    isError: isUserError,
    isSuccess: isUserLoaded
  } = useQuery({
    queryKey: ['user'],
    queryFn: () => base44.auth.me()
  });

  const {
    data: precisionUsage,
    isLoading: isPrecisionUsageLoading,
    isFetching: isPrecisionUsageFetching,
    isError: isPrecisionUsageError,
    refetch: refetchPrecisionUsage
  } = usePrecisionUsage(user);

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

  const handleActivateTrial = async (planId) => {
    if (window.self !== window.top) {
      toast.error("Stripe billing cannot run in this preview window. Please open your app in a new tab.", { duration: 5000 });
      return;
    }

    try {
      const selectedPlan = PLANS.find((plan) => plan.id === planId);
      if (!selectedPlan) throw new Error('That billing plan is not available.');
      setLoadingPriceId(planId + '_activate');
      const res = await base44.functions.invoke('createCheckoutSession', {
        action: 'activate_trial',
        planId,
        quantity: 1,
        returnUrl: window.location.origin + '/Billing?billing_return=true'
      });
      const result = res?.data || res;

      if (result?.url) {
        window.location.href = result.url;
        return;
      }
      if (!result?.success) {
        throw new Error(result?.error || 'Stripe did not confirm the trial upgrade.');
      }

      toast.success(
        result.already_active
          ? "Your paid subscription is already active."
          : "Payment confirmed! Your paid plan is being activated.",
        { duration: 6000 }
      );
      await refetchUser();
      await refetchPrecisionUsage();
      setTimeout(() => refetchUser(), 2000);
    } catch (error) {
      console.error("[Billing] Trial activation failed:", error);
      const errorData = error?.response?.data;
      const msg = errorData?.error || error?.message || 'Unknown error';
      if (errorData?.billing_reconciled) {
        toast.info("Your billing status was refreshed. Please choose the paid plan again.", { duration: 6000 });
      } else {
        toast.error("Upgrade failed: " + msg, { duration: 6000 });
      }
      await refetchUser();
      await refetchPrecisionUsage();
    } finally {
      setLoadingPriceId(null);
    }
  };

  // Handle return from Stripe checkout
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let refreshTimer;
    if (params.get('success') === 'true') {
      toast.success("Checkout is complete. The 1,000-home Precision allowance unlocks after Stripe confirms the $99 payment.", { duration: 7000 });
      window.history.replaceState({}, '', window.location.pathname);
      refetchUser();
      refetchPrecisionUsage();
      refreshTimer = setTimeout(() => {
        refetchUser();
        refetchPrecisionUsage();
      }, 2000);
    } else if (params.get('billing_return') === 'true') {
      toast.info("Returned from Stripe. Checking your payment status now.");
      window.history.replaceState({}, '', window.location.pathname);
      refetchUser();
      refetchPrecisionUsage();
      refreshTimer = setTimeout(() => {
        refetchUser();
        refetchPrecisionUsage();
      }, 2000);
    } else if (params.get('canceled') === 'true') {
      toast.info("Checkout canceled. You can try again anytime.");
      window.history.replaceState({}, '', window.location.pathname);
    }

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [refetchPrecisionUsage, refetchUser]);

  const { isTrialing, isActive, needsPaymentRecovery, hasSubscription: isSubscribed } = getBillingState(user);
  const billingReadyForPlan = () => isUserLoaded;

  const handleManageSubscription = async () => {
    try {
      const res = await base44.functions.invoke('createPortalSession', {
        returnUrl: window.location.href
      });
      const portalUrl = res?.data?.url || res?.url;
      if (portalUrl) {
        window.location.href = portalUrl;
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
                        Precision is $99 per user each month for targeted property discovery.
                    </p>
                </div>

                <div className="mx-auto grid w-full max-w-3xl gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                        <p className="text-xs font-extrabold uppercase tracking-wider text-white">Knock decisions</p>
                        <p className="mt-2 text-sm leading-relaxed text-gray-400">
                            Free accounts must add a valid card after 25 logged decisions to keep logging. Adding a card does not purchase Precision.
                        </p>
                    </div>
                    <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/[0.07] p-4">
                        <p className="text-xs font-extrabold uppercase tracking-wider text-yellow-400">Precision unlock</p>
                        <p className="mt-2 text-sm leading-relaxed text-gray-300">
                            The $99 payment must successfully clear before up to 1,000 Precision homes unlock for the monthly billing period. A trial or card on file alone remains at the free 50-home total limit.
                        </p>
                    </div>
                </div>

                {/* Current Usage — hidden on mobile to save space */}
                <div className="hidden sm:block">
                    <BetaUsageMeter showUpgrade={false} />
                </div>

                {isUserError && (
                    <div className="mx-auto max-w-xl rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-center text-sm text-amber-100">
                        <p>We could not load your billing account, so checkout is paused.</p>
                        <button
                            type="button"
                            onClick={() => refetchUser()}
                            className="mt-2 font-semibold text-yellow-400 hover:text-yellow-300"
                        >
                            Retry account check
                        </button>
                    </div>
                )}


                {isSubscribed &&
        <div className="flex flex-col items-center gap-4">
                        <div className={`inline-block rounded-full px-4 py-1 border ${needsPaymentRecovery ? 'bg-amber-900/30 border-amber-500/50' : 'bg-green-900/30 border-green-500/50'}`}>
                            <span className={`${needsPaymentRecovery ? 'text-amber-300' : 'text-green-400'} text-sm font-bold flex items-center gap-2`}>
                                {needsPaymentRecovery ? <AlertCircle className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                                {isTrialing ? 'TRIAL ACTIVE' : isActive ? 'ACTIVE SUBSCRIPTION' : 'PAYMENT ACTION NEEDED'}
                            </span>
                        </div>
                        
                        <Button
            onClick={handleManageSubscription}
            variant="outline"
            className="border-gray-700 hover:bg-gray-800 text-gray-300 text-xs h-8">

                            {needsPaymentRecovery ? 'Fix Payment in Stripe' : 'Billing Portal / Cancel'}
                        </Button>
                    </div>
        }

                {/* Combined Pricing Cards */}
                <div className="mx-auto grid max-w-3xl grid-cols-1 gap-4 sm:gap-6">
                    {PLANS.map((plan) => (
                        <div key={plan.id} className={`relative rounded-2xl p-5 sm:p-6 border ${plan.isPopular ? 'border-yellow-500 bg-gray-900/80 shadow-[0_0_30px_rgba(255,215,0,0.1)]' : 'border-gray-800 bg-[#111]'} backdrop-blur-sm flex flex-col`}>
                            {plan.isPopular && (
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-xs sm:text-xs font-bold px-3 py-0.5 rounded-full flex items-center gap-1 shadow-lg whitespace-nowrap">
                                    <Star className="w-2.5 h-2.5 fill-black" />
                                    MOST POPULAR
                                </div>
                            )}

                            <div className="mb-5 mt-2">
                                <h2 className="text-2xl font-extrabold text-white">{plan.name}</h2>
                                <p className="text-sm text-gray-400 mt-2 leading-relaxed">{plan.subtitle}</p>
                            </div>

                            <ul className="space-y-2.5 mb-5 pb-5 border-b border-white/10">
                                {plan.includedFeatures.map((feature, i) => (
                                    <li key={i} className="flex items-start gap-3 text-sm text-gray-300">
                                        <div className={`rounded-full p-1 shrink-0 mt-0.5 ${plan.isPopular ? 'bg-yellow-500/20 text-yellow-500' : 'bg-purple-500/20 text-purple-300'}`}>
                                            <Check className="w-3 h-3" />
                                        </div>
                                        <span className="leading-snug">{feature}</span>
                                    </li>
                                ))}
                            </ul>

                            <div className="text-center mb-4">
                                <div className="flex items-baseline justify-center gap-1">
                                    <span className="text-4xl sm:text-4xl font-extrabold text-white">${plan.price}</span>
                                    <span className="text-gray-400 text-sm sm:text-sm">{plan.unit}</span>
                                </div>
                                {plan.id === 'precision' && (
                                    <div className="mt-3 rounded-xl bg-black/30 border border-white/10 p-3 text-left">
                                        {precisionUsage && !isPrecisionUsageError && !isPrecisionUsageFetching ? (
                                            <>
                                                <div className="flex justify-between text-xs text-gray-300 mb-2">
                                                    <span>Precision properties used</span>
                                                    <span>{precisionUsage.meterUsed.toLocaleString()} / {precisionUsage.limit.toLocaleString()}</span>
                                                </div>
                                                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                                                    <div className="h-full bg-yellow-500 rounded-full" style={{ width: `${precisionUsage.percent}%` }} />
                                                </div>
                                                {precisionUsage.reserved > 0 && (
                                                    <p className="mt-2 text-[10px] text-gray-400">
                                                        {precisionUsage.reserved.toLocaleString()} properties are reserved by an import in progress.
                                                    </p>
                                                )}
                                            </>
                                        ) : isPrecisionUsageLoading || isPrecisionUsageFetching ? (
                                            <p className="text-xs text-gray-400">Checking authoritative usage…</p>
                                        ) : isPrecisionUsageError ? (
                                            <div className="flex items-center justify-between gap-3 text-xs text-amber-200">
                                                <span>Usage unavailable</span>
                                                <button type="button" className="font-bold text-yellow-400" onClick={() => refetchPrecisionUsage()}>
                                                    Retry
                                                </button>
                                            </div>
                                        ) : (
                                            <p className="text-xs text-gray-400">Sign in to view usage.</p>
                                        )}
                                    </div>
                                )}
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

                            {billingReadyForPlan(plan.id) && !isSubscribed && (
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
                            {billingReadyForPlan(plan.id) && shouldShowTrialActivation(user, plan.id) && (
                                <div className="flex flex-col gap-2">
                                    <Button
                                        onClick={() => handleActivateTrial(plan.id)}
                                        disabled={loadingPriceId !== null}
                                        className="w-full h-12 font-bold tracking-wide rounded-xl transition-all bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20 text-sm sm:text-base"
                                    >
                                        {loadingPriceId === plan.id + '_activate'
                                            ? 'PROCESSING PAYMENT...'
                                            : `UPGRADE NOW — $${plan.price}${plan.unit.toUpperCase()}`}
                                    </Button>
                                    <p className="text-center text-xs text-gray-400">
                                        Ends your free trial and charges the plan total today. No cancellation needed.
                                    </p>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {isUserLoaded && (
                    <p className="text-center text-xs sm:text-xs text-gray-500 mt-3 sm:mt-4">
                        Secure payments via Stripe. Cancel anytime.
                        {isSubscribed && (
                            <>
                                {' '}
                                <button
                                    type="button"
                                    onClick={handleManageSubscription}
                                    className="text-yellow-500 hover:text-yellow-400 underline font-semibold"
                                >
                                    Cancel subscription
                                </button>
                            </>
                        )}
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