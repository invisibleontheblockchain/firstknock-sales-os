import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from '@/api/base44Client';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Settings2, Database, Map as MapIcon, Save } from 'lucide-react';
import { generateOptimizedRoutes } from '../logic/routeOptimizer';

// Constants
const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STATUS_OPTIONS = ['ELIGIBLE', 'SOLD', 'HARD_NO', 'DO_NOT_KNOCK'];

export default function CampaignWizard({ open, onOpenChange, existingPlan = null }) {
    const queryClient = useQueryClient();
    const [step, setStep] = useState(1);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationProgress, setGenerationProgress] = useState("");

    // Form State
    const [config, setConfig] = useState({
        name: `Campaign ${new Date().getFullYear()}`,
        min_price: 0,
        max_price: 0, // 0 = no max
        sold_years_min: 0,
        sold_years_max: 30,
        included_statuses: ['ELIGIBLE'],
        houses_per_route: 50,
        street_cooldown_days: 30
    });

    // Sync state with props when modal opens or plan changes
    useEffect(() => {
        if (open) {
            setConfig(existingPlan?.strategy_config || {
                name: `Campaign ${new Date().getFullYear()}`,
                min_price: 0,
                max_price: 0,
                sold_years_min: 0,
                sold_years_max: 30,
                included_statuses: ['ELIGIBLE'],
                houses_per_route: 50,
                street_cooldown_days: 30
            });
        }
    }, [open, existingPlan]);

    // Fetch Master Properties for generation
    const { data: allPropertiesRaw = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000),
        enabled: open
    });
    const allProperties = Array.isArray(allPropertiesRaw) ? allPropertiesRaw : (allPropertiesRaw?.items || []);

    const createPlanMutation = useMutation({
        mutationFn: (data) => base44.entities.TerritoryPlan.create(data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['territoryPlans'] })
    });

    const updatePlanMutation = useMutation({
        mutationFn: ({ id, data }) => base44.entities.TerritoryPlan.update(id, data),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['territoryPlans'] })
    });

    const bulkCreateRoutesMutation = useMutation({
        mutationFn: (routes) => base44.entities.SavedRoute.bulkCreate(routes),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['savedRoutes'] })
    });

    const handleGenerate = async () => {
        setIsGenerating(true);
        setGenerationProgress("Filtering properties...");

        try {
            // 1. Filter Properties
            const filteredProps = allProperties.filter(p => {
                // Status Filter
                if (!config.included_statuses.includes(p.original_status)) return false;

                // Price Filter
                if (config.min_price > 0 && p.price < config.min_price) return false;
                if (config.max_price > 0 && p.price > config.max_price) return false;

                // Sold Date Filter
                if (p.sold_date) {
                    const yearsAgo = (new Date() - new Date(p.sold_date)) / (1000 * 60 * 60 * 24 * 365);
                    if (yearsAgo < config.sold_years_min || yearsAgo > config.sold_years_max) return false;
                }

                return true;
            });

            setGenerationProgress(`Generating routes from ${filteredProps.length} properties...`);

            // 2. Generate Routes (Client-side optimization)
            // We use a small delay to let UI render the progress message
            await new Promise(r => setTimeout(r, 100));

            const generatedRoutes = generateOptimizedRoutes(
                filteredProps,
                config.houses_per_route,
                null, // No specific start location, use clustering
                [], // No logs for initial generation
                { streetCooldownDays: config.street_cooldown_days }
            );

            setGenerationProgress(`Saving plan and ${generatedRoutes.length} routes...`);

            // 3. Create Plan
            const planData = {
                name: config.name,
                goal_houses: filteredProps.length,
                status: 'ACTIVE',
                start_date: new Date().toISOString().split('T')[0],
                strategy_config: config
            };

            let planId = existingPlan?.id;

            if (existingPlan) {
                await updatePlanMutation.mutateAsync({ id: planId, data: planData });
            } else {
                const newPlan = await createPlanMutation.mutateAsync(planData);
                planId = newPlan.id;
            }

            // 4. Bulk Create Routes
            if (generatedRoutes.length > 0 && !existingPlan) {
                // Only bulk create routes if it's a new plan to avoid duplicates on edit
                // Prepare route objects for DB
                const dbRoutes = generatedRoutes.map((r, idx) => ({
                    name: `${config.name} - Route ${idx + 1}`,
                    description: `Auto-generated route. Score: ${r.competitivenessScore}`,
                    status: 'PENDING',
                    property_hashes: r.properties.map(p => p.address_hash),
                    metrics: {
                        distance: r.totalDistance,
                        house_count: r.houseCount,
                        score: r.competitivenessScore
                    },
                    priority: idx + 1 // 1 is highest priority (highest score from optimizer)
                }));

                // Split into chunks of 20 for safety if needed, but SDK handles bulk usually
                // We'll do chunks of 50 just in case
                const chunkSize = 50;
                for (let i = 0; i < dbRoutes.length; i += chunkSize) {
                    const chunk = dbRoutes.slice(i, i + chunkSize);
                    setGenerationProgress(`Uploading routes ${i + 1} to ${Math.min(i + chunkSize, dbRoutes.length)}...`);
                    await bulkCreateRoutesMutation.mutateAsync(chunk);
                }
            }

            setGenerationProgress("Complete!");
            onOpenChange(false);

        } catch (e) {
            console.error(e);
            alert("Error generating campaign: " + e.message);
        } finally {
            setIsGenerating(false);
            setGenerationProgress("");
        }
    };

    const handleSaveSettingsOnly = async () => {
        if (!existingPlan) return;
        await updatePlanMutation.mutateAsync({
            id: existingPlan.id,
            data: { strategy_config: config }
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={isGenerating ? undefined : onOpenChange}>
            <DialogContent className="sm:max-w-[600px] bg-[#0A0A0A] border-[#333] text-white max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-xl font-bold flex items-center gap-2" style={{ color: BRAND.gold }}>
                        {existingPlan ? <Settings2 className="w-6 h-6" /> : <Database className="w-6 h-6" />}
                        {existingPlan ? 'Edit Campaign Settings' : 'Initialize Campaign Strategy'}
                    </DialogTitle>
                    <DialogDescription className="text-gray-400">
                        Configure how the territory is segmented and assigned.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 py-4">
                    {/* General Info */}
                    <div className="space-y-2">
                        <Label>Campaign Name</Label>
                        <Input
                            value={config.name}
                            onChange={e => setConfig({ ...config, name: e.target.value })}
                            className="bg-[#1F1F1F] border-[#333]"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                        {/* Filters */}
                        <div className="space-y-4">
                            <h3 className="font-bold text-sm text-gray-400 uppercase tracking-wider border-b border-[#333] pb-2">
                                1. Data Filters
                            </h3>

                            <div className="space-y-2">
                                <Label className="text-xs">Property Status</Label>
                                <div className="grid grid-cols-2 gap-2">
                                    {STATUS_OPTIONS.map(status => (
                                        <div key={status} className="flex items-center space-x-2">
                                            <Checkbox
                                                id={`status-${status}`}
                                                checked={config.included_statuses.includes(status)}
                                                onCheckedChange={(checked) => {
                                                    if (checked) setConfig({ ...config, included_statuses: [...config.included_statuses, status] });
                                                    else setConfig({ ...config, included_statuses: config.included_statuses.filter(s => s !== status) });
                                                }}
                                                className="border-gray-600 data-[state=checked]:bg-yellow-500"
                                            />
                                            <label htmlFor={`status-${status}`} className="text-xs font-medium cursor-pointer">{status}</label>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-xs">Min Price ($)</Label>
                                <Input
                                    type="number"
                                    value={config.min_price}
                                    onChange={e => setConfig({ ...config, min_price: parseInt(e.target.value) || 0 })}
                                    className="bg-[#1F1F1F] border-[#333] h-8 text-xs"
                                />
                            </div>
                        </div>

                        {/* Strategy */}
                        <div className="space-y-4">
                            <h3 className="font-bold text-sm text-gray-400 uppercase tracking-wider border-b border-[#333] pb-2">
                                2. Route Strategy
                            </h3>

                            <div className="space-y-3">
                                <div className="flex justify-between">
                                    <Label className="text-xs">Houses Per Route</Label>
                                    <span className="text-xs font-bold text-yellow-500">{config.houses_per_route}</span>
                                </div>
                                <Slider
                                    value={[config.houses_per_route]}
                                    onValueChange={([v]) => setConfig({ ...config, houses_per_route: v })}
                                    min={10} max={100} step={5}
                                    className="py-2"
                                />
                                <p className="text-[10px] text-gray-500">
                                    Target size for each generated route list.
                                </p>
                            </div>

                            <div className="space-y-3">
                                <div className="flex justify-between">
                                    <Label className="text-xs">Sold Date (Years Ago)</Label>
                                    <span className="text-xs font-bold text-yellow-500">{config.sold_years_min} - {config.sold_years_max} yrs</span>
                                </div>
                                <div className="flex gap-2">
                                    <Input
                                        type="number" placeholder="Min"
                                        value={config.sold_years_min}
                                        onChange={e => setConfig({ ...config, sold_years_min: parseInt(e.target.value) || 0 })}
                                        className="bg-[#1F1F1F] border-[#333] h-8 text-xs w-20"
                                    />
                                    <span className="text-gray-500">-</span>
                                    <Input
                                        type="number" placeholder="Max"
                                        value={config.sold_years_max}
                                        onChange={e => setConfig({ ...config, sold_years_max: parseInt(e.target.value) || 100 })}
                                        className="bg-[#1F1F1F] border-[#333] h-8 text-xs w-20"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {existingPlan && (
                        <div className="bg-yellow-500/10 border border-yellow-500/20 p-3 rounded-lg">
                            <p className="text-xs text-yellow-500">
                                Note: Editing settings on an active campaign will update the strategy for future reference but will NOT regenerate existing routes to preserve field data.
                            </p>
                        </div>
                    )}
                </div>

                <DialogFooter className="flex-col sm:flex-row gap-2">
                    {isGenerating ? (
                        <div className="w-full bg-[#1F1F1F] rounded-lg p-3 flex items-center justify-center gap-3">
                            <Loader2 className="w-5 h-5 animate-spin text-yellow-500" />
                            <span className="text-sm font-medium animate-pulse">{generationProgress}</span>
                        </div>
                    ) : (
                        <>
                            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                            {existingPlan ? (
                                <Button onClick={handleSaveSettingsOnly} style={{ background: BRAND.gold, color: BRAND.voidBlack }} className="font-bold">
                                    <Save className="w-4 h-4 mr-2" />
                                    Save Settings
                                </Button>
                            ) : (
                                <Button 
                                    onClick={handleGenerate} 
                                    disabled={propsLoading}
                                    style={{ background: BRAND.gold, color: BRAND.voidBlack }} 
                                    className="font-bold w-full sm:w-auto"
                                >
                                    {propsLoading ? (
                                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading Data...</>
                                    ) : (
                                        <><MapIcon className="w-4 h-4 mr-2" /> Generate Territory & Routes</>
                                    )}
                                </Button>
                            )}
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}