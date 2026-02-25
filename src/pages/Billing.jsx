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

const PRICE_ID = 'price_1SwDXY2MvSNi6E8hZb5nSRDw'; // Hustler $49 base
const FLAT_PRICE = 49;

const ALL_FEATURES = [
'Up to 10 Zip Code Territories',
'Unlimited Routes & Route Builder',
'Live GPS Tracking & Proof of Visit',
'AI Route Optimization',
'Command Center Auto-Dispatch',
'Team Leaderboard & Metrics',
'Property Intel & History',
'Priority Support'];


export default function Billing() {
  const [loadingPriceId, setLoadingPriceId] = useState(null);

  const { data: user, refetch: refetchUser } = useQuery({
    queryKey: ['user'],
    queryFn: () => base44.auth.me()
  });

  const handleSubscribe = async (trialDays = 0) => {
    // Check if running in iframe (preview mode)
    if (window.self !== window.top) {
      alert("Stripe Checkout cannot run in this preview window due to security restrictions.\n\nPlease open your app in a new tab (click the 'Open App' button in the top right) to test payments.");
      return;
    }

    try {
      setLoadingPriceId(trialDays > 0 ? 'trial' : 'now');
      const res = await base44.functions.invoke('createCheckoutSession', {
        priceId: PRICE_ID,
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
            <div className="max-w-2xl mx-auto space-y-8">
                
                {/* Header */}
                <div className="text-center space-y-3">
                    <h1 className="text-4xl font-extrabold tracking-tight">FirstKnock Pro</h1>
                    <p className="text-gray-400 max-w-md mx-auto">
                        One simple plan. Everything included. Start your 7-day free trial.
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

                {/* Main Pricing Card */}
                <div className="relative rounded-2xl p-6 sm:p-8 border border-yellow-500 bg-gray-900/80 backdrop-blur-sm shadow-[0_0_60px_rgba(255,215,0,0.1)]">
                    
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-yellow-500 text-black text-xs font-bold px-4 py-1 rounded-full flex items-center gap-1 shadow-lg">
                        <Star className="w-3 h-3 fill-black" />
                        7-DAY FREE TRIAL
                    </div>

                    {/* Price Display */}
                    <div className="text-center mb-8 mt-2">
                        <div className="flex items-baseline justify-center gap-2">
                            <span className="text-5xl font-extrabold text-white">${FLAT_PRICE}</span>
                            <span className="text-gray-400 text-lg">/mo</span>
                        </div>
                        <p className="text-sm text-gray-500 mt-2">Flat rate. Unlimited team members.</p>
                    </div>

                    {/* Zip Code Limits Info */}
                    <div className="bg-black/40 rounded-xl p-5 border border-gray-800 mb-6 text-center">
                         <div className="grid grid-cols-2 gap-4 divide-x divide-gray-800">
                            <div>
                                <p className="text-xs text-gray-500 uppercase font-bold mb-1">Free Plan</p>
                                <p className="text-xl font-bold text-white">3 Zip Codes</p>
                                <p className="text-sm font-medium text-gray-400">3 Area Pulls</p>
                            </div>
                            <div>
                                <p className="text-xs text-yellow-500 uppercase font-bold mb-1">Pro Plan</p>
                                <p className="text-xl font-bold text-white">10 Zip Codes <span className="text-xs font-normal text-gray-400">/seat</span></p>
                                <p className="text-sm font-medium text-gray-400">20 Area Pulls</p>
                            </div>
                         </div>
                    </div>

                    {/* Features */}
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
                        {ALL_FEATURES.map((feature, i) =>
            <li key={i} className="flex items-center gap-3 text-sm text-gray-300">
                                <div className="rounded-full p-1 bg-yellow-500/20 text-yellow-500 shrink-0">
                                    <Check className="w-3 h-3" />
                                </div>
                                {feature}
                            </li>
            )}
                    </ul>

                    {/* CTA */}
                    {!isSubscribed &&
          <div className="flex flex-col gap-3">
                            <Button
              onClick={() => handleSubscribe(7)}
              disabled={loadingPriceId !== null}
              className="w-full h-14 font-bold text-lg tracking-wide bg-yellow-500 text-black hover:bg-yellow-400 shadow-lg hover:shadow-yellow-500/20 transition-all rounded-xl">

                                <PlayCircle className="w-5 h-5 mr-2" />
                                {loadingPriceId === 'trial' ? 'PREPARING...' : `START 7-DAY FREE TRIAL`}
                            </Button>
                            
                            <div className="relative flex py-2 items-center">
                                <div className="flex-grow border-t border-gray-800"></div>
                                <span className="flex-shrink-0 mx-4 text-xs text-gray-500 font-bold uppercase">or</span>
                                <div className="flex-grow border-t border-gray-800"></div>
                            </div>

                            <Button
              onClick={() => handleSubscribe(0)}
              disabled={loadingPriceId !== null}
              variant="outline" className="bg-background text-gray-900 px-4 py-2 text-sm font-bold tracking-wide rounded-xl inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border shadow-sm hover:text-accent-foreground w-full h-12 border-gray-700 hover:bg-gray-800">


                                {loadingPriceId === 'now' ? 'PREPARING...' : `SKIP TRIAL & PAY $${FLAT_PRICE} NOW`}
                            </Button>
                        </div>
          }
                    
                    {!isSubscribed &&
          <p className="text-center text-xs text-gray-500 mt-4">
                            Secure payments via Stripe. Cancel anytime.
                        </p>
          }
                </div>

                {/* Enterprise Callout */}
                <div className="bg-[#111] border border-gray-800 rounded-xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-blue-900/20 flex items-center justify-center text-blue-500">
                            <Shield className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="font-bold text-white">Need more territories?</h3>
                            <p className="text-sm text-gray-400">Contact us for custom enterprise pricing with higher limits.</p>
                        </div>
                    </div>
                    <Button variant="outline" className="border-gray-700 text-white hover:bg-gray-800">
                        Contact Sales
                    </Button>
                </div>

                <div className="text-center text-xs text-gray-600">
                    <p>Secure payments processed by Stripe.</p>
                </div>

            </div>
        </div>);

}