import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
    MapPin, Navigation, Settings, Save, 
    ArrowRight, CheckCircle2, AlertCircle, 
    Loader2, Layers, Filter, RefreshCw
} from 'lucide-react';
import { toast } from "sonner";

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STEPS = [
    { id: 'territory', label: 'Territory', icon: MapPin },
    { id: 'strategy', label: 'Strategy', icon: Settings },
    { id: 'review', label: 'Review', icon: CheckCircle2 }
];

export default function RouteGenerationWizard({
    isOpen,
    onClose,
    onGenerate, // (config) => Promise<routes>
    onSave,     // (config, routes) => Promise<void>
    initialConfig,
    isGenerating,
    generatedRoutes = [],
    genStats = null
}) {
    const [step, setStep] = useState('territory');
    const [config, setConfig] = useState({
        zipCodes: '',
        housesPerRoute: 50,
        minScore: 0,
        streetCooldownDays: 30,
        minimizeTurns: true,
        useStreetSweep: true,
        ...initialConfig
    });

    // Reset step when opened
    useEffect(() => {
        if (isOpen) {
            setStep('territory');
            if (initialConfig) {
                setConfig(prev => ({ ...prev, ...initialConfig }));
            }
        }
    }, [isOpen, initialConfig]);

    const handleNext = () => {
        if (step === 'territory') setStep('strategy');
        else if (step === 'strategy') {
            handleGenerate();
        }
    };

    const handleGenerate = async () => {
        setStep('review');
        await onGenerate(config);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 sm:p-6">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            
            <Card className="relative w-full max-w-2xl bg-[#0A0A0A] border border-gray-800 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
                
                {/* Header */}
                <div className="p-6 border-b border-gray-800 bg-[#111]">
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <h2 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2">
                                <Navigation className="w-6 h-6 text-yellow-500" />
                                Route Builder
                            </h2>
                            <p className="text-gray-400 text-sm mt-1">
                                Design your team's attack plan in 3 steps.
                            </p>
                        </div>
                        <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors">
                            <Settings className="w-5 h-5 text-gray-500" />
                        </button>
                    </div>

                    {/* Progress Steps */}
                    <div className="flex items-center justify-between relative px-2">
                        <div className="absolute left-0 right-0 top-1/2 h-0.5 bg-gray-800 -z-10" />
                        {STEPS.map((s, idx) => {
                            const isActive = s.id === step;
                            const isCompleted = STEPS.findIndex(st => st.id === step) > idx;
                            
                            return (
                                <div key={s.id} className="flex flex-col items-center gap-2 bg-[#111] px-2">
                                    <div 
                                        className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${
                                            isActive ? 'border-yellow-500 bg-yellow-500 text-black' :
                                            isCompleted ? 'border-green-500 bg-green-500 text-black' :
                                            'border-gray-700 bg-gray-900 text-gray-500'
                                        }`}
                                    >
                                        <s.icon className="w-4 h-4" />
                                    </div>
                                    <span className={`text-[10px] font-bold uppercase ${isActive ? 'text-yellow-500' : 'text-gray-500'}`}>
                                        {s.label}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Content Body */}
                <div className="flex-1 overflow-y-auto p-6 bg-[#0A0A0A]">
                    
                    {/* STEP 1: TERRITORY */}
                    {step === 'territory' && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                            <div className="bg-[#111] p-5 rounded-xl border border-gray-800">
                                <label className="text-sm font-bold text-gray-300 mb-2 block flex items-center gap-2">
                                    <MapPin className="w-4 h-4 text-yellow-500" />
                                    Target Zip Codes
                                </label>
                                <Input
                                    value={config.zipCodes}
                                    onChange={(e) => setConfig({ ...config, zipCodes: e.target.value })}
                                    placeholder="e.g. 90210, 90001"
                                    className="bg-black border-gray-700 text-lg h-12"
                                />
                                <p className="text-xs text-gray-500 mt-2 flex items-center gap-2">
                                    <AlertCircle className="w-3 h-3" />
                                    We'll fetch property data for these areas automatically.
                                </p>
                            </div>

                            <div className="bg-blue-900/10 p-4 rounded-xl border border-blue-900/30">
                                <h4 className="text-blue-400 font-bold text-sm mb-1">Tip: Define Your Workspace</h4>
                                <p className="text-gray-400 text-xs">
                                    Entering specific zip codes helps the optimizer focus only on relevant properties and prevents routes from drifting too far.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* STEP 2: STRATEGY */}
                    {step === 'strategy' && (
                        <div className="space-y-8 animate-in slide-in-from-right-4 duration-300">
                            
                            <div>
                                <div className="flex justify-between items-center mb-4">
                                    <label className="text-sm font-bold text-gray-300 flex items-center gap-2">
                                        <Layers className="w-4 h-4 text-yellow-500" />
                                        Route Size
                                    </label>
                                    <Badge variant="outline" className="text-yellow-500 border-yellow-500/30 bg-yellow-500/10">
                                        {config.housesPerRoute} Homes
                                    </Badge>
                                </div>
                                <div className="bg-[#111] p-6 rounded-xl border border-gray-800">
                                    <Slider
                                        value={[config.housesPerRoute]}
                                        onValueChange={([v]) => setConfig({ ...config, housesPerRoute: v })}
                                        min={20}
                                        max={150}
                                        step={5}
                                        className="py-2"
                                    />
                                    <div className="flex justify-between text-[10px] text-gray-500 mt-4 uppercase font-bold">
                                        <span>Quick Hustle (20)</span>
                                        <span>Full Day (100+)</span>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="bg-[#111] p-4 rounded-xl border border-gray-800 space-y-3">
                                    <label className="text-xs font-bold text-gray-400 uppercase">Filters</label>
                                    
                                    <div className="space-y-4">
                                        <div>
                                            <div className="flex justify-between text-xs mb-2">
                                                <span className="text-gray-300">Min Score</span>
                                                <span className="text-yellow-500 font-bold">{config.minScore}</span>
                                            </div>
                                            <Slider
                                                value={[config.minScore]}
                                                onValueChange={([v]) => setConfig({ ...config, minScore: v })}
                                                min={0}
                                                max={100}
                                                step={10}
                                            />
                                        </div>
                                        <div>
                                            <div className="flex justify-between text-xs mb-2">
                                                <span className="text-gray-300">Cooldown (Days)</span>
                                                <span className="text-blue-400 font-bold">{config.streetCooldownDays}d</span>
                                            </div>
                                            <Slider
                                                value={[config.streetCooldownDays]}
                                                onValueChange={([v]) => setConfig({ ...config, streetCooldownDays: v })}
                                                min={0}
                                                max={90}
                                                step={5}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-[#111] p-4 rounded-xl border border-gray-800 space-y-3">
                                    <label className="text-xs font-bold text-gray-400 uppercase">Optimization</label>
                                    
                                    <div className="flex items-center justify-between py-2 border-b border-gray-800">
                                        <span className="text-sm text-gray-300">Minimize Turns</span>
                                        <input 
                                            type="checkbox" 
                                            checked={config.minimizeTurns}
                                            onChange={(e) => setConfig({ ...config, minimizeTurns: e.target.checked })}
                                            className="accent-yellow-500 w-4 h-4" 
                                        />
                                    </div>
                                    <div className="flex items-center justify-between py-2">
                                        <span className="text-sm text-gray-300">Street Sweep Mode</span>
                                        <input 
                                            type="checkbox" 
                                            checked={config.useStreetSweep}
                                            onChange={(e) => setConfig({ ...config, useStreetSweep: e.target.checked })}
                                            className="accent-yellow-500 w-4 h-4" 
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* STEP 3: REVIEW & GENERATE */}
                    {step === 'review' && (
                        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300 h-full flex flex-col">
                            {isGenerating ? (
                                <div className="flex-1 flex flex-col items-center justify-center text-center py-10">
                                    <div className="relative w-20 h-20 mb-6">
                                        <div className="absolute inset-0 border-4 border-gray-800 rounded-full"></div>
                                        <div className="absolute inset-0 border-4 border-yellow-500 rounded-full border-t-transparent animate-spin"></div>
                                        <Navigation className="absolute inset-0 m-auto w-8 h-8 text-white animate-pulse" />
                                    </div>
                                    <h3 className="text-xl font-bold text-white mb-2">Optimizing Routes...</h3>
                                    <p className="text-gray-400 text-sm max-w-xs">
                                        Analyzing street topology and clustering homes for maximum efficiency.
                                    </p>
                                </div>
                            ) : generatedRoutes.length > 0 ? (
                                <div className="space-y-6">
                                    <div className="bg-green-900/20 border border-green-500/30 p-6 rounded-xl text-center">
                                        <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
                                            <CheckCircle2 className="w-6 h-6 text-green-500" />
                                        </div>
                                        <h3 className="text-lg font-bold text-white mb-1">Routes Ready!</h3>
                                        <p className="text-green-400 text-sm">
                                            Successfully generated {generatedRoutes.length} optimized routes.
                                        </p>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="bg-[#111] p-4 rounded-xl border border-gray-800 text-center">
                                            <div className="text-2xl font-extrabold text-white">{genStats?.totalHouses}</div>
                                            <div className="text-xs text-gray-500 uppercase font-bold">Total Doors</div>
                                        </div>
                                        <div className="bg-[#111] p-4 rounded-xl border border-gray-800 text-center">
                                            <div className="text-2xl font-extrabold text-yellow-500">{genStats?.avgScore}</div>
                                            <div className="text-xs text-gray-500 uppercase font-bold">Avg Quality Score</div>
                                        </div>
                                    </div>

                                    <div className="bg-[#111] p-4 rounded-xl border border-gray-800 max-h-[200px] overflow-y-auto">
                                        <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 sticky top-0 bg-[#111] py-1">Preview Routes</h4>
                                        <div className="space-y-2">
                                            {generatedRoutes.slice(0, 10).map((r, i) => (
                                                <div key={i} className="flex justify-between items-center text-sm p-2 hover:bg-white/5 rounded">
                                                    <span className="text-white font-medium">{r.name}</span>
                                                    <span className="text-gray-500 text-xs">{r.houseCount} homes</span>
                                                </div>
                                            ))}
                                            {generatedRoutes.length > 10 && (
                                                <div className="text-center text-xs text-gray-500 pt-2">
                                                    + {generatedRoutes.length - 10} more...
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="text-center py-10">
                                    <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                                    <h3 className="text-lg font-bold text-white">Generation Failed</h3>
                                    <p className="text-gray-400 text-sm mb-6">
                                        No routes could be generated with these settings. Try adjusting your filters or zip codes.
                                    </p>
                                    <Button onClick={() => setStep('territory')} variant="outline" className="border-gray-700">
                                        Back to Settings
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer / Actions */}
                <div className="p-6 border-t border-gray-800 bg-[#111] flex justify-between items-center">
                    {step !== 'territory' && step !== 'review' ? (
                        <Button 
                            onClick={() => setStep(step === 'strategy' ? 'territory' : 'strategy')}
                            variant="ghost" 
                            className="text-gray-400 hover:text-white"
                        >
                            Back
                        </Button>
                    ) : (
                        <div></div>
                    )}

                    {step === 'review' ? (
                        <div className="flex gap-3 w-full sm:w-auto">
                            <Button 
                                onClick={handleGenerate} 
                                variant="outline" 
                                disabled={isGenerating}
                                className="border-gray-700 hover:bg-gray-800"
                            >
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Regenerate
                            </Button>
                            <Button 
                                onClick={() => onSave(config, generatedRoutes)} 
                                disabled={isGenerating || generatedRoutes.length === 0}
                                className="bg-green-600 hover:bg-green-500 text-white font-bold px-8 flex-1 sm:flex-none"
                            >
                                <Save className="w-4 h-4 mr-2" />
                                Save Campaign
                            </Button>
                        </div>
                    ) : (
                        <Button 
                            onClick={handleNext}
                            className="bg-yellow-500 text-black font-bold px-8 hover:bg-yellow-400"
                        >
                            Next Step
                            <ArrowRight className="w-4 h-4 ml-2" />
                        </Button>
                    )}
                </div>
            </Card>
        </div>
    );
}