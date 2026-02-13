import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { 
    MapPin, 
    Navigation, 
    CheckCircle2, 
    ArrowRight, 
    Sparkles, 
    Loader2,
    Save,
    Map as MapIcon,
    AlertCircle
} from 'lucide-react';
import { toast } from "sonner";
import { generateOptimizedRoutes } from '../logic/routeOptimizer';

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F'
};

export default function TerritorySetupWizard({ user, onComplete }) {
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [zipInput, setZipInput] = useState(user?.working_area || '');
    const [housesPerRoute, setHousesPerRoute] = useState(50);
    const [generatedRoutes, setGeneratedRoutes] = useState([]);
    const [fetchedProperties, setFetchedProperties] = useState([]);

    // Step 1: Define Territory
    const handleSyncTerritory = async () => {
        if (!zipInput || zipInput.length < 5) {
            toast.error("Please enter a valid zip code");
            return;
        }

        setLoading(true);
        try {
            const zips = zipInput.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z));
            
            // 1. Update User Profile
            await base44.auth.updateMe({ 
                working_area: zipInput,
                territory_zip_codes: zips
            });

            // 2. Fetch Data from RentCast via backend
            let allProps = [];
            for (const zip of zips) {
                try {
                    toast.loading(`Syncing ${zip}...`, { id: `sync-${zip}` });
                    const res = await base44.functions.invoke('fetchZipProperties', { zip_code: zip });
                    const result = res.data;
                    toast.success(`${zip}: ${result.count || result.message || 'Done'}`, { id: `sync-${zip}` });
                } catch (e) {
                    console.error(`Failed to fetch zip ${zip}:`, e);
                    toast.error(`Failed to sync ${zip}`, { id: `sync-${zip}` });
                }
            }
            
            // Now fetch the imported entities
            for (const zip of zips) {
                const res = await base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000);
                let props = [];
                if (res.items) props = res.items;
                else if (Array.isArray(res)) props = res;
                
                props = props.filter(p => p.lat && p.lng && !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001));
                allProps = [...allProps, ...props];
            }

            if (allProps.length === 0) {
                toast.error("No properties found for these zip codes. Try a different zip.");
            }

            setFetchedProperties(allProps);
            setStep(2); // Move to strategy
            toast.success(`Found ${allProps.length} properties in territory!`);

        } catch (e) {
            console.error(e);
            toast.error("Failed to sync territory: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    // Step 2 -> 3: Generate Routes
    const handleGenerate = async () => {
        setLoading(true);
        // Small timeout to allow UI to update
        setTimeout(() => {
            try {
                const routes = generateOptimizedRoutes(
                    fetchedProperties, 
                    housesPerRoute, 
                    null, // Start location default
                    [], // Logs (none yet)
                    { streetCooldownDays: 30, useStreetSweep: true }
                );
                setGeneratedRoutes(routes);
                setStep(3); // Move to review
            } catch (e) {
                console.error(e);
                toast.error("Failed to generate routes");
            } finally {
                setLoading(false);
            }
        }, 500);
    };

    // Step 3 -> Finish: Save Routes
    const handleSaveAndFinish = async () => {
        setLoading(true);
        try {
            // Bulk create routes? Or just create top 5?
            // Creating all might be slow if there are 100s. Let's save top 20 or all if < 20.
            const routesToSave = generatedRoutes.slice(0, 20); // Save top 20 for now
            
            const promises = routesToSave.map(route => 
                base44.entities.SavedRoute.create({
                    name: route.name,
                    property_hashes: route.properties.map(p => p.address_hash),
                    metrics: {
                        distance: route.totalDistance,
                        house_count: route.houseCount,
                        score: route.competitivenessScore
                    },
                    status: 'PENDING', // Ready for assignment
                    manager_id: user.id
                })
            );

            await Promise.all(promises);
            toast.success(`Saved ${routesToSave.length} routes to your campaign!`);
            onComplete(); // Close wizard

        } catch (e) {
            console.error(e);
            toast.error("Failed to save routes");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
            <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-[#111] border border-gray-800 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            >
                {/* Header */}
                <div className="p-6 border-b border-gray-800 bg-[#0F0F0F]">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                                <Sparkles className="w-6 h-6 text-yellow-500" />
                                Territory Setup
                            </h2>
                            <p className="text-gray-400 text-sm mt-1">
                                Step {step} of 3: {
                                    step === 1 ? 'Define Area' : 
                                    step === 2 ? 'Strategy' : 'Review'
                                }
                            </p>
                            {/* Skip Button */}
                            <button 
                                onClick={() => {
                                    if(confirm("Skip setup? You can always access this later in the Setup page.")) {
                                        onComplete();
                                    }
                                }}
                                className="text-xs text-gray-500 hover:text-white mr-4 underline"
                            >
                                Skip Setup
                            </button>
                        </div>
                        {/* Progress Dots */}
                        <div className="flex gap-2">
                            {[1, 2, 3].map(i => (
                                <div key={i} className={`w-3 h-3 rounded-full ${step >= i ? 'bg-yellow-500' : 'bg-gray-700'}`} />
                            ))}
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="p-8 flex-1 overflow-y-auto">
                    <AnimatePresence mode="wait">
                        
                        {/* STEP 1: ZIP CODES */}
                        {step === 1 && (
                            <motion.div
                                key="step1"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                className="space-y-6"
                            >
                                <div className="bg-yellow-500/10 border border-yellow-500/20 p-4 rounded-xl">
                                    <h3 className="font-bold text-yellow-500 mb-1">Where is your team working?</h3>
                                    <p className="text-sm text-gray-300">
                                        Enter the Zip Codes you want to target. We'll automatically pull property data for these areas.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Zip Codes (Comma Separated)</label>
                                    <Input
                                        value={zipInput}
                                        onChange={(e) => setZipInput(e.target.value)}
                                        placeholder="e.g. 90210, 90211"
                                        className="h-14 text-lg bg-black border-gray-700"
                                    />
                                    <p className="text-xs text-gray-500">
                                        We recommend starting with 1-3 zip codes for better performance.
                                    </p>
                                    <p className="text-[10px] text-yellow-500/80 italic flex items-center gap-1">
                                        <AlertCircle className="w-3 h-3" />
                                        Works with any US zip code. Property data pulled live from nationwide database.
                                    </p>
                                </div>

                                <Button 
                                    onClick={handleSyncTerritory}
                                    disabled={loading || !zipInput}
                                    className="w-full h-12 bg-white text-black font-bold hover:bg-gray-200 text-lg"
                                >
                                    {loading ? <><Loader2 className="animate-spin mr-2" /> Syncing Data...</> : 'Sync Territory Data'}
                                </Button>
                            </motion.div>
                        )}

                        {/* STEP 2: STRATEGY */}
                        {step === 2 && (
                            <motion.div
                                key="step2"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                className="space-y-8"
                            >
                                <div className="text-center">
                                    <h3 className="text-xl font-bold text-white mb-2">Configure Routing Strategy</h3>
                                    <p className="text-gray-400">
                                        Found {fetchedProperties.length} properties. How should we split them?
                                    </p>
                                </div>

                                <div className="space-y-4 bg-[#1A1A1A] p-6 rounded-xl border border-gray-800">
                                    <div className="flex justify-between items-center mb-2">
                                        <label className="text-sm font-bold text-white">Route Size</label>
                                        <span className="text-yellow-500 font-mono font-bold">{housesPerRoute} homes</span>
                                    </div>
                                    <Slider
                                        value={[housesPerRoute]}
                                        onValueChange={([v]) => setHousesPerRoute(v)}
                                        min={20}
                                        max={150}
                                        step={10}
                                        className="py-4"
                                    />
                                    <p className="text-xs text-gray-500">
                                        Smaller routes (30-50) are better for quick evening shifts. Larger routes (75+) are for full days.
                                    </p>
                                </div>

                                <Button 
                                    onClick={handleGenerate}
                                    disabled={loading}
                                    className="w-full h-14 bg-yellow-500 text-black font-bold hover:bg-yellow-400 text-lg shadow-[0_0_20px_rgba(255,215,0,0.3)]"
                                >
                                    {loading ? <><Loader2 className="animate-spin mr-2" /> Optimizing Routes...</> : 'Generate Optimized Routes'}
                                </Button>
                            </motion.div>
                        )}

                        {/* STEP 3: REVIEW */}
                        {step === 3 && (
                            <motion.div
                                key="step3"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                className="space-y-6"
                            >
                                <div className="text-center space-y-2">
                                    <div className="w-16 h-16 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <CheckCircle2 className="w-8 h-8" />
                                    </div>
                                    <h3 className="text-2xl font-bold text-white">Success!</h3>
                                    <p className="text-gray-400">
                                        We created <span className="text-white font-bold">{generatedRoutes.length} optimized routes</span> for your team.
                                    </p>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="bg-[#1A1A1A] p-4 rounded-xl border border-gray-800 text-center">
                                        <div className="text-2xl font-bold text-white">{generatedRoutes.reduce((acc, r) => acc + r.houseCount, 0)}</div>
                                        <div className="text-xs text-gray-500 uppercase font-bold">Total Doors</div>
                                    </div>
                                    <div className="bg-[#1A1A1A] p-4 rounded-xl border border-gray-800 text-center">
                                        <div className="text-2xl font-bold text-white">{(generatedRoutes.reduce((acc, r) => acc + r.totalDistance, 0)).toFixed(1)}</div>
                                        <div className="text-xs text-gray-500 uppercase font-bold">Total Miles</div>
                                    </div>
                                </div>

                                <Button 
                                    onClick={handleSaveAndFinish}
                                    disabled={loading}
                                    className="w-full h-14 bg-green-600 text-white font-bold hover:bg-green-500 text-lg shadow-lg"
                                >
                                    {loading ? <Loader2 className="animate-spin" /> : <span className="flex items-center gap-2"><Save className="w-5 h-5" /> Save Campaign & Launch Map</span>}
                                </Button>

                                <button 
                                    onClick={() => setStep(2)}
                                    className="w-full py-2 text-sm text-gray-500 hover:text-white"
                                >
                                    Back to Strategy
                                </button>
                            </motion.div>
                        )}

                    </AnimatePresence>
                </div>
            </motion.div>
        </div>
    );
}