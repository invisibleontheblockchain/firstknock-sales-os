import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Map as MapIcon, Pencil, Search, ArrowRight, ArrowLeft, Check, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';

export default function MarketOnboarding({ user, onComplete }) {
    const queryClient = useQueryClient();
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);
    const [method, setMethod] = useState(null); // null | 'draw' | 'zip'
    const [zipInput, setZipInput] = useState('');
    const [pulling, setPulling] = useState(false);

    // Don't show if user already has territory defined or isn't a manager
    if (!user || user.app_role !== 'manager') return null;
    if (user.territory_zip_codes?.length > 0 || user.has_defined_market) return null;

    const handleZipSubmit = async () => {
        const zips = zipInput.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));
        if (zips.length === 0) {
            toast.error("Enter at least one valid 5-digit zip code");
            return;
        }

        setPulling(true);
        const toastId = toast.loading("Pulling property data...");

        try {
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
                        toast.error(errData.message || 'Limit reached.', { id: toastId });
                        setPulling(false);
                        return;
                    }
                }
            }

            await base44.auth.updateMe({
                territory_zip_codes: zips,
                has_defined_market: true,
                last_market_pull: new Date().toISOString()
            });

            await queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
            await queryClient.invalidateQueries({ queryKey: ['user'] });

            toast.success("Market data loaded!", { id: toastId });
            onComplete({ method: 'zip', zips });
        } catch (e) {
            toast.error("Failed: " + (e.message || 'Unknown error'), { id: toastId });
        } finally {
            setPulling(false);
        }
    };

    const handleDrawChoice = async () => {
        // Mark that user chose draw method, then send them to the map with drawing mode
        await base44.auth.updateMe({ has_defined_market: true });
        await queryClient.invalidateQueries({ queryKey: ['user'] });
        onComplete({ method: 'draw' });
    };

    // Loading state
    if (pulling) {
        return (
            <div className="fixed inset-0 z-[6000] flex items-center justify-center bg-black/90 backdrop-blur-md">
                <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center gap-5 w-full px-6 max-w-xs"
                >
                    <Loader2 className="w-12 h-12 text-yellow-500 animate-spin" />
                    <h2 className="text-xl font-bold text-white text-center">Loading Your Market</h2>
                    <p className="text-gray-400 text-sm text-center">
                        Pulling property data. This may take 15-30 seconds...
                    </p>
                    <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-yellow-500 to-yellow-300 rounded-full animate-pulse" style={{ width: '60%' }} />
                    </div>
                </motion.div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <AnimatePresence mode="wait">
                {/* STEP 1: Choose method */}
                {!method && (
                    <motion.div
                        key="choose"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="w-full max-w-sm"
                    >
                        <div className="bg-[#111] border border-gray-800 rounded-3xl overflow-hidden shadow-2xl p-8">
                            <div className="text-center space-y-5">
                                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto shadow-[0_0_40px_rgba(255,215,0,0.3)]" style={{ background: 'linear-gradient(135deg, #FFD93D, #FFA500)' }}>
                                    <MapIcon className="w-8 h-8 text-black" />
                                </div>

                                <div>
                                    <h2 className="text-2xl font-extrabold text-white mb-2 tracking-tight">
                                        Define Your Market
                                    </h2>
                                    <p className="text-gray-400 text-sm leading-relaxed">
                                        First, tell us your full service area. This is where your team knocks doors.
                                    </p>
                                </div>

                                <div className="space-y-3 pt-2">
                                    <button
                                        onClick={() => setMethod('draw')}
                                        className="w-full relative overflow-hidden group rounded-xl border border-white/10 bg-white/5 p-5 transition-all hover:bg-white/10 hover:border-yellow-500/30 text-left flex items-center gap-4"
                                    >
                                        <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center shrink-0 group-hover:bg-yellow-500/20 transition-colors">
                                            <Pencil className="w-6 h-6 text-yellow-500" />
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="text-base font-bold text-white mb-0.5">Draw My Area</h3>
                                            <p className="text-xs text-gray-400 leading-relaxed">
                                                Drop a shape on the map to define your exact territory. Up to 200 sq miles.
                                            </p>
                                        </div>
                                        <ArrowRight className="w-5 h-5 text-gray-600 group-hover:text-yellow-500 transition-colors shrink-0" />
                                    </button>

                                    <button
                                        onClick={() => setMethod('zip')}
                                        className="w-full relative overflow-hidden group rounded-xl border border-white/10 bg-white/5 p-5 transition-all hover:bg-white/10 hover:border-blue-500/30 text-left flex items-center gap-4"
                                    >
                                        <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0 group-hover:bg-blue-500/20 transition-colors">
                                            <Search className="w-6 h-6 text-blue-400" />
                                        </div>
                                        <div className="flex-1">
                                            <h3 className="text-base font-bold text-white mb-0.5">Enter Zip Codes</h3>
                                            <p className="text-xs text-gray-400 leading-relaxed">
                                                Type in the zip codes you service. We'll pull all the data for you.
                                            </p>
                                        </div>
                                        <ArrowRight className="w-5 h-5 text-gray-600 group-hover:text-blue-400 transition-colors shrink-0" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* STEP 2A: Draw confirmation */}
                {method === 'draw' && (
                    <motion.div
                        key="draw"
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        className="w-full max-w-sm"
                    >
                        <div className="bg-[#111] border border-gray-800 rounded-3xl overflow-hidden shadow-2xl p-8">
                            <div className="text-center space-y-5">
                                <div className="w-16 h-16 rounded-2xl bg-yellow-500/20 flex items-center justify-center mx-auto">
                                    <Pencil className="w-8 h-8 text-yellow-500" />
                                </div>

                                <div>
                                    <h2 className="text-xl font-extrabold text-white mb-2 tracking-tight">
                                        Draw Your Territory
                                    </h2>
                                    <p className="text-gray-400 text-sm leading-relaxed">
                                        You'll be taken to the map where you can drop a shape over your full service area. Choose a size up to 200 sq miles.
                                    </p>
                                </div>

                                <div className="bg-black/40 border border-white/5 rounded-xl p-4 space-y-2 text-left">
                                    <div className="flex items-center gap-2">
                                        <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                        <span className="text-xs text-gray-300">Click anywhere on the map to place your area</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                        <span className="text-xs text-gray-300">Choose circle, square, or triangle shape</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Check className="w-4 h-4 text-yellow-500 shrink-0" />
                                        <span className="text-xs text-gray-300">We'll pull all property data inside the area</span>
                                    </div>
                                </div>

                                <div className="flex gap-3 w-full pt-2">
                                    <Button
                                        onClick={() => setMethod(null)}
                                        variant="ghost"
                                        className="text-gray-400 hover:text-white h-12 flex-1 rounded-xl"
                                    >
                                        <ArrowLeft className="w-4 h-4 mr-2" /> Back
                                    </Button>
                                    <Button
                                        onClick={handleDrawChoice}
                                        className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-12 flex-[2] text-base rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.4)] border-none"
                                    >
                                        Open Map <ArrowRight className="w-5 h-5 ml-2" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* STEP 2B: Enter Zip Codes */}
                {method === 'zip' && (
                    <motion.div
                        key="zip"
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        className="w-full max-w-sm"
                    >
                        <div className="bg-[#111] border border-gray-800 rounded-3xl overflow-hidden shadow-2xl p-8">
                            <div className="text-center space-y-5">
                                <div className="w-16 h-16 rounded-2xl bg-blue-500/20 flex items-center justify-center mx-auto">
                                    <Search className="w-8 h-8 text-blue-400" />
                                </div>

                                <div>
                                    <h2 className="text-xl font-extrabold text-white mb-2 tracking-tight">
                                        Enter Your Zip Codes
                                    </h2>
                                    <p className="text-gray-400 text-sm leading-relaxed">
                                        Enter all the zip codes your team services. We'll pull every property in those areas.
                                    </p>
                                </div>

                                <div className="w-full space-y-3">
                                    <Input
                                        value={zipInput}
                                        onChange={(e) => setZipInput(e.target.value)}
                                        placeholder="e.g. 29464, 29401, 29412"
                                        className="bg-black/80 border-gray-700 text-white placeholder:text-gray-600 h-14 text-center text-lg font-mono tracking-wider rounded-xl"
                                        autoFocus
                                    />
                                    <p className="text-[10px] text-gray-600 text-center">Separate multiple zip codes with commas</p>
                                </div>

                                <div className="flex gap-3 w-full pt-2">
                                    <Button
                                        onClick={() => setMethod(null)}
                                        variant="ghost"
                                        className="text-gray-400 hover:text-white h-12 flex-1 rounded-xl"
                                    >
                                        <ArrowLeft className="w-4 h-4 mr-2" /> Back
                                    </Button>
                                    <Button
                                        onClick={handleZipSubmit}
                                        disabled={!zipInput.trim()}
                                        className="bg-blue-600 hover:bg-blue-500 text-white font-bold h-12 flex-[2] text-base rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.4)] border-none disabled:opacity-40"
                                    >
                                        Pull Data <ArrowRight className="w-5 h-5 ml-2" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}