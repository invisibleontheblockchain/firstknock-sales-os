import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { base44 } from '@/api/base44Client';
import { Map as MapIcon, Loader2, Zap, ArrowRight, RefreshCw, List } from 'lucide-react';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

const ROUTE_COUNT_OPTIONS = [1, 5, 10, 20, 30, 40, 50];

export default function MarketSetupPrompt({
    mode,
    activeRoute,
    routesGenerating,
    showCompare,
    showRoutePanel,
    drawingMode,
    user,
    setZipCodeFilter,
    setShowCompare,
    setShowRoutePanel,
    setMode,
    onSetupComplete, // callback: ({ zips, routeCount }) => void
}) {
    const queryClient = useQueryClient();
    const [step, setStep] = useState('zips'); // 'zips' | 'routes' | 'loading'
    const [zipInput, setZipInput] = useState('');
    const [routeCount, setRouteCount] = useState(10);
    const [pulling, setPulling] = useState(false);

    // Determine if user has already set up their market
    const hasMarket = user?.territory_zip_codes?.length > 0;

    // Determine credit info
    const lastPull = user?.last_market_pull ? new Date(user.last_market_pull) : null;
    const now = new Date();
    const daysSincePull = lastPull ? Math.floor((now - lastPull) / (1000 * 60 * 60 * 24)) : 999;
    const canRefresh = daysSincePull >= 7; // 1 credit per week

    // Don't show if not in generate mode, or if user is doing something else
    if (mode !== 'generate' || activeRoute || routesGenerating || showCompare || showRoutePanel || drawingMode) return null;

    // If user already has a market set up, show the "ready" state
    if (hasMarket) {
        return (
            <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-5 w-full px-6 max-w-sm">
                    <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                        <MapIcon className="w-8 h-8 text-yellow-500" />
                    </div>
                    <h2 className="text-2xl font-extrabold text-white text-center tracking-tight">
                        Your Market
                    </h2>
                    <p className="text-gray-400 text-sm text-center">
                        {user.territory_zip_codes.join(', ')}
                    </p>

                    <div className="flex flex-col gap-3 w-full">
                        <Button
                            onClick={() => setShowCompare(true)}
                            className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-14 text-base w-full rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none"
                        >
                            <Zap className="w-5 h-5 mr-2" />
                            Generate Routes
                        </Button>

                        <Button
                            onClick={() => {
                                setMode('analyze');
                                setShowRoutePanel(true);
                            }}
                            className="bg-white/10 hover:bg-white/20 text-white font-bold h-12 text-sm w-full rounded-xl border border-white/10"
                        >
                            <List className="w-4 h-4 mr-2" />
                            View Saved Routes
                        </Button>

                        <Button
                            onClick={() => {
                                if (!canRefresh) {
                                    toast.error(`You can refresh once per week. Next refresh available in ${7 - daysSincePull} days.`);
                                    return;
                                }
                                // Reset to setup flow to re-pull
                                setStep('zips');
                                setZipInput(user.territory_zip_codes.join(', '));
                            }}
                            variant="ghost"
                            className="text-gray-500 hover:text-white h-10 text-xs w-full"
                        >
                            <RefreshCw className="w-3 h-3 mr-2" />
                            {canRefresh ? 'Refresh Market Data (1 credit)' : `Next refresh in ${7 - daysSincePull}d`}
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    // STEP 1: Enter zip codes
    if (step === 'zips' && !pulling) {
        return (
            <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-5 w-full px-6 max-w-sm">
                    <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                        <MapIcon className="w-8 h-8 text-yellow-500" />
                    </div>
                    <h2 className="text-2xl font-extrabold text-white text-center tracking-tight">
                        Choose Your Market
                    </h2>
                    <p className="text-gray-400 text-sm text-center leading-relaxed">
                        Enter the zip codes for your entire service area. We'll pull all the property data you need.
                    </p>

                    <div className="w-full space-y-3">
                        <Input
                            value={zipInput}
                            onChange={(e) => setZipInput(e.target.value)}
                            placeholder="e.g. 29464, 29401, 29412"
                            className="bg-black/80 border-gray-700 text-white placeholder:text-gray-600 h-14 text-center text-lg font-mono tracking-wider rounded-xl"
                        />
                        <p className="text-[10px] text-gray-600 text-center">Separate multiple zip codes with commas</p>
                    </div>

                    <Button
                        onClick={() => {
                            const zips = zipInput.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));
                            if (zips.length === 0) {
                                toast.error("Please enter at least one valid 5-digit zip code");
                                return;
                            }
                            setStep('routes');
                        }}
                        disabled={!zipInput.trim()}
                        className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-14 text-base w-full rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none disabled:opacity-40"
                    >
                        Next <ArrowRight className="w-5 h-5 ml-2" />
                    </Button>
                </div>
            </div>
        );
    }

    // STEP 2: Choose route count
    if (step === 'routes' && !pulling) {
        const zips = zipInput.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));

        return (
            <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-5 w-full px-6 max-w-sm">
                    <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                        <Zap className="w-8 h-8 text-yellow-500" />
                    </div>
                    <h2 className="text-2xl font-extrabold text-white text-center tracking-tight">
                        How Many Routes?
                    </h2>
                    <p className="text-gray-400 text-sm text-center leading-relaxed">
                        We'll split your market into this many optimized routes.
                    </p>

                    <div className="grid grid-cols-4 gap-2 w-full">
                        {ROUTE_COUNT_OPTIONS.map(n => (
                            <button
                                key={n}
                                onClick={() => setRouteCount(n)}
                                className={`py-4 rounded-xl text-lg font-bold transition-all ${
                                    routeCount === n
                                        ? 'bg-yellow-500 text-black shadow-lg scale-105'
                                        : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-gray-800'
                                }`}
                            >
                                {n}
                            </button>
                        ))}
                    </div>

                    <div className="flex gap-3 w-full">
                        <Button
                            onClick={() => setStep('zips')}
                            variant="ghost"
                            className="text-gray-400 hover:text-white h-14 flex-1 rounded-xl"
                        >
                            Back
                        </Button>
                        <Button
                            onClick={async () => {
                                setPulling(true);
                                const toastId = toast.loading("Pulling property data for your market...");

                                try {
                                    // Set zip filter for the route builder
                                    setZipCodeFilter(zips.join(', '));

                                    // Fetch data for each zip
                                    for (const zip of zips) {
                                        toast.loading(`Fetching ${zip}...`, { id: toastId });
                                        try {
                                            const res = await base44.functions.invoke('fetchZipProperties', { zip_code: zip });
                                            if (res.data?.error) {
                                                toast.error(res.data.message || res.data.error, { id: toastId });
                                                setPulling(false);
                                                return;
                                            }
                                        } catch (err) {
                                            const errData = err?.response?.data;
                                            if (errData?.error?.includes('limit')) {
                                                toast.error(errData.message || 'Zip code limit reached.', { id: toastId });
                                                setPulling(false);
                                                return;
                                            }
                                        }
                                    }

                                    // Save market pull timestamp
                                    await base44.auth.updateMe({
                                        territory_zip_codes: zips,
                                        last_market_pull: new Date().toISOString()
                                    });

                                    // Refresh data
                                    await queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
                                    await queryClient.invalidateQueries({ queryKey: ['user'] });

                                    toast.success("Market data loaded!", { id: toastId });

                                    // Trigger the route generation with the chosen count
                                    if (onSetupComplete) {
                                        onSetupComplete({ zips, routeCount });
                                    }
                                } catch (e) {
                                    toast.error("Failed to pull data: " + (e.message || 'Unknown error'), { id: toastId });
                                } finally {
                                    setPulling(false);
                                }
                            }}
                            className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-14 flex-[2] text-base rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none"
                        >
                            <Zap className="w-5 h-5 mr-2" /> Build {routeCount} Route{routeCount > 1 ? 's' : ''}
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    // LOADING STATE
    if (pulling) {
        return (
            <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/70 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-5 w-full px-6 max-w-xs">
                    <Loader2 className="w-12 h-12 text-yellow-500 animate-spin" />
                    <h2 className="text-xl font-bold text-white text-center">
                        Building Your Market
                    </h2>
                    <p className="text-gray-400 text-sm text-center">
                        Pulling property data and generating routes. This may take 15-30 seconds...
                    </p>
                    <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-yellow-500 to-yellow-300 rounded-full animate-pulse" style={{ width: '60%' }} />
                    </div>
                </div>
            </div>
        );
    }

    return null;
}