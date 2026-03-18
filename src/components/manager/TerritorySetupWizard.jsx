import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { MapPin, CheckCircle2, ArrowRight, Sparkles, Loader2, Save, AlertCircle, Lock } from 'lucide-react';
import { toast } from "sonner";
import { generateOptimizedRoutes } from '../logic/routeOptimizer';
import { useTheme, contrastText } from '@/components/theme/ThemeProvider';
import BetaUsageMeter from '../beta/BetaUsageMeter';
import { useQuery } from "@tanstack/react-query";

export default function TerritorySetupWizard({ user, onComplete }) {
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [zipInput, setZipInput] = useState(user?.working_area || '');
    const [housesPerRoute, setHousesPerRoute] = useState(50);
    const [generatedRoutes, setGeneratedRoutes] = useState([]);
    const [fetchedProperties, setFetchedProperties] = useState([]);
    const { accent } = useTheme();
    const accentTxt = contrastText(accent);
    const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';

    const { data: leadScoringWeightsRaw = [] } = useQuery({
        queryKey: ['leadScoringWeights'],
        queryFn: () => base44.entities.LeadScoringWeights.list(),
    });
    const learnedWeights = leadScoringWeightsRaw[0]?.weights || null;

    const handleSyncTerritory = async () => {
        if (!zipInput || zipInput.length < 5) { toast.error("Enter a valid zip code"); return; }
        
        // Front-end limit check (also enforced on backend)
        const zipLimit = isPaid ? 10 : 3;
        const zips = zipInput.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));
        
        // Filter out zips that are already generated so we don't count them against the limit in the check
        const generatedZips = user?.generated_zip_codes || [];
        const newZips = zips.filter(z => !generatedZips.includes(z));
        
        if (generatedZips.length + newZips.length > zipLimit) {
            toast.error(isPaid 
                ? `Limit reached (${zipLimit} zips). Add seats for more.` 
                : `Free limit is 3 zips. Upgrade for more.`);
            if (!isPaid) {
                setTimeout(() => { window.location.href = '/Billing'; }, 2000);
            }
            return;
        }

        setLoading(true);
        try {
            await base44.auth.updateMe({ working_area: zipInput, territory_zip_codes: zips });
            let allProps = [];
            let hitLimit = false;
            for (const zip of zips) {
                try {
                    toast.loading(`Syncing ${zip}...`, { id: `sync-${zip}` });
                    const res = await base44.functions.invoke('fetchZipProperties', { zip_code: zip });
                    if (res.data?.error) {
                        toast.error(res.data.message || res.data.error, { id: `sync-${zip}` });
                        hitLimit = true;
                        break;
                    }
                    toast.success(`${zip}: ${res.data?.count || 'Done'}`, { id: `sync-${zip}` });
                } catch (e) {
                    const errData = e?.response?.data;
                    if (errData?.error?.includes('limit')) {
                        toast.error(errData.message || 'Zip code limit reached. Upgrade your plan.', { id: `sync-${zip}` });
                        hitLimit = true;
                        break;
                    }
                    toast.error(`Failed to sync ${zip}`, { id: `sync-${zip}` });
                }
            }
            for (const zip of zips) {
                const res = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
                let props = res.items || (Array.isArray(res) ? res : []);
                props = props.filter(p => p.lat && p.lng && !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001));
                allProps = [...allProps, ...props];
            }
            if (allProps.length === 0) { 
                toast.error("No properties found. Try a different zip."); 
            } else {
                setFetchedProperties(allProps);
                setStep(2);
                toast.success(`Found ${allProps.length} properties!`);
            }

            if (hitLimit && !isPaid) {
                setTimeout(() => { window.location.href = '/Billing'; }, 2000);
            }
        } catch (e) { toast.error("Sync failed: " + e.message); }
        finally { setLoading(false); }
    };

    const handleGenerate = async () => {
        if (!isPaid && user?.has_generated_routes) {
            window.location.href = '/Billing';
            return;
        }

        setLoading(true);
        setTimeout(async () => {
            try {
                const finalHousesPerRoute = isPaid ? housesPerRoute : Math.min(housesPerRoute, 25);
                const routes = generateOptimizedRoutes(fetchedProperties, finalHousesPerRoute, null, [], { streetCooldownDays: 30, useStreetSweep: true }, learnedWeights);
                setGeneratedRoutes(routes);
                setStep(3);
                
                if (!isPaid && !user?.has_generated_routes) {
                    try { await base44.auth.updateMe({ has_generated_routes: true }); } catch(e) {}
                }
            } catch (e) { toast.error("Failed to generate routes"); }
            finally { setLoading(false); }
        }, 500);
    };

    const handleSaveAndFinish = async () => {
        setLoading(true);
        try {
            const routesToSave = generatedRoutes.slice(0, 20);
            await Promise.all(routesToSave.map(route =>
                base44.entities.SavedRoute.create({
                    name: route.name,
                    property_hashes: route.properties.map(p => p.address_hash),
                    metrics: { distance: route.totalDistance, house_count: route.houseCount, score: route.competitivenessScore },
                    status: 'PENDING',
                    manager_id: user.id
                })
            ));
            toast.success(`Saved ${routesToSave.length} routes!`);
            onComplete();
        } catch (e) { toast.error("Failed to save routes"); }
        finally { setLoading(false); }
    };

    return (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-[#111] border border-gray-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
                {/* Header */}
                <div className="p-5 border-b border-gray-800 bg-[#0F0F0F]">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                <Sparkles className="w-5 h-5" style={{ color: accent }} />
                                {step === 1 ? 'Where Are You Knocking?' : step === 2 ? 'Route Strategy' : 'Ready to Go!'}
                            </h2>
                            <p className="text-gray-500 text-xs mt-1">Step {step} of 3</p>
                        </div>
                        <div className="flex gap-1.5">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="w-2.5 h-2.5 rounded-full" style={{ background: step >= i ? accent : '#374151' }} />
                            ))}
                        </div>
                    </div>
                    <button onClick={() => { if(confirm("Skip? You can set up later in the Setup page.")) onComplete(); }} className="text-[10px] text-gray-600 hover:text-white underline mt-1">Skip Setup</button>
                </div>

                {/* Content */}
                <div className="p-6 flex-1 overflow-y-auto">
                    <AnimatePresence mode="wait">
                        {step === 1 && (
                            <motion.div key="s1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-5">
                                <div className="p-4 rounded-xl border" style={{ background: `${accent}10`, borderColor: `${accent}30` }}>
                                    <h3 className="font-bold text-sm mb-1" style={{ color: accent }}>Enter your target zip codes</h3>
                                    <p className="text-xs text-gray-400">We'll pull every property in these areas and score them by sale recency, value, and more.</p>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-bold text-gray-500 uppercase">Zip Codes (comma separated)</label>
                                    <Input value={zipInput} onChange={e => setZipInput(e.target.value)} placeholder="e.g. 90210, 90211" className="h-14 text-lg bg-black border-gray-700 text-white" />
                                    <p className="text-[10px] text-gray-600 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Works with any US zip code.</p>
                                </div>
                                <BetaUsageMeter />
                                <Button onClick={handleSyncTerritory} disabled={loading || !zipInput} className="w-full h-12 font-bold text-base" style={{ background: accent, color: accentTxt }}>
                                    {loading ? <><Loader2 className="animate-spin mr-2 w-5 h-5" /> Syncing...</> : <><MapPin className="w-5 h-5 mr-2" /> Find Properties</>}
                                </Button>
                            </motion.div>
                        )}

                        {step === 2 && (
                            <motion.div key="s2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
                                <div className="text-center">
                                    <p className="text-2xl font-bold text-white">{fetchedProperties.length.toLocaleString()}</p>
                                    <p className="text-xs text-gray-500">properties found in your territory</p>
                                </div>
                                <div className="bg-[#1A1A1A] p-5 rounded-xl border border-gray-800 space-y-3">
                                    <div className="flex justify-between items-center">
                                        <label className="text-sm font-bold text-white flex items-center gap-2">
                                            Homes per route
                                            {!isPaid && <Lock className="w-3 h-3 text-yellow-500" />}
                                        </label>
                                        <span className="font-mono font-bold" style={{ color: accent }}>{isPaid ? housesPerRoute : Math.min(housesPerRoute, 25)}</span>
                                    </div>
                                    <Slider 
                                        value={[isPaid ? housesPerRoute : Math.min(housesPerRoute, 25)]} 
                                        onValueChange={([v]) => setHousesPerRoute(isPaid ? v : Math.min(v, 25))} 
                                        min={20} 
                                        max={isPaid ? 150 : 25} 
                                        step={5} 
                                        className="py-4" 
                                    />
                                    <p className="text-[10px] text-gray-500">
                                        {isPaid ? '30-50 = evening shift | 75+ = full day' : 'Free plan limit: 25 houses. Upgrade for more.'}
                                    </p>
                                </div>
                                <Button onClick={handleGenerate} disabled={loading} className="w-full h-12 font-bold text-base" style={{ background: accent, color: accentTxt }}>
                                    {loading ? <><Loader2 className="animate-spin mr-2" /> Building Routes...</> : <><ArrowRight className="w-5 h-5 mr-2" /> Generate Routes</>}
                                </Button>
                            </motion.div>
                        )}

                        {step === 3 && (
                            <motion.div key="s3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
                                <div className="text-center space-y-2">
                                    <div className="w-14 h-14 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center mx-auto"><CheckCircle2 className="w-7 h-7" /></div>
                                    <h3 className="text-xl font-bold text-white">{generatedRoutes.length} routes ready</h3>
                                    <p className="text-gray-400 text-sm">{generatedRoutes.reduce((a, r) => a + r.houseCount, 0)} doors &bull; {generatedRoutes.reduce((a, r) => a + r.totalDistance, 0).toFixed(1)} mi</p>
                                </div>
                                <Button onClick={handleSaveAndFinish} disabled={loading} className="w-full h-12 font-bold text-base bg-green-600 hover:bg-green-500 text-white">
                                    {loading ? <Loader2 className="animate-spin" /> : <><Save className="w-5 h-5 mr-2" /> Save & Go to Map</>}
                                </Button>
                                <button onClick={() => setStep(2)} className="w-full py-2 text-xs text-gray-500 hover:text-white">← Back to Strategy</button>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </motion.div>
        </div>
    );
}