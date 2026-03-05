import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { base44 } from '@/api/base44Client';
import { Pencil, X, Check, Trash2, Loader2 } from 'lucide-react';
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export default function DrawingControls({
    drawingMode,
    setDrawingMode,
    drawnPolygon,
    setDrawnPolygon,
    draftPolygon,
    setDraftPolygon,
    drawShape,
    setDrawShape,
    drawSizeMiles,
    setDrawSizeMiles,
    user,
    setShowCompare,
    onPullComplete
}) {
    const queryClient = useQueryClient();
    const [pulling, setPulling] = useState(false);
    const [pullProgress, setPullProgress] = useState('');

    const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
    const isOwner = user?.is_owner === true || user?.email?.toLowerCase().includes('christian');
    const canUseLargeAreas = isPaid || isOwner;

    // Active Drawing Controls (shape/size selector + confirm/cancel)
    if (drawingMode) {
        return (
            <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[2000] bg-black/90 backdrop-blur-md border border-yellow-500/50 rounded-2xl p-3 shadow-2xl flex flex-col sm:flex-row items-center gap-3 animate-in slide-in-from-top-4 w-11/12 max-w-lg">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                    <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center shrink-0">
                        <Pencil className="w-4 h-4 text-yellow-500" />
                    </div>
                    <div className="flex-1 sm:w-32">
                        <p className="text-xs font-bold text-white uppercase tracking-wider">Drawing Mode</p>
                        <p className="text-[10px] text-gray-400">Click map to drop shape</p>
                    </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-start border-t sm:border-t-0 border-gray-800 pt-2 sm:pt-0 mt-1 sm:mt-0">
                    <div className="flex gap-2">
                        <select
                            value={drawShape || 'circle'}
                            onChange={(e) => setDrawShape(e.target.value)}
                            className="bg-gray-900 border border-gray-700 text-white text-xs rounded-md px-2 py-1 h-8"
                        >
                            <option value="circle">Circle</option>
                            <option value="square">Square</option>
                            <option value="triangle">Triangle</option>
                        </select>

                        <select
                            value={drawSizeMiles || 10}
                            onChange={(e) => {
                                const val = Number(e.target.value);
                                if ((val === 100 || val === 200) && !canUseLargeAreas) {
                                    toast.error("100 and 200 sq miles are only available on a paid plan.");
                                    return;
                                }
                                setDrawSizeMiles(val);
                            }}
                            className="bg-gray-900 border border-gray-700 text-white text-xs rounded-md px-2 py-1 h-8"
                        >
                            <option value={1}>1 sq mile</option>
                            <option value={5}>5 sq miles</option>
                            <option value={10}>10 sq miles</option>
                            <option value={20}>20 sq miles</option>
                            <option value={30}>30 sq miles</option>
                            <option value={40}>40 sq miles</option>
                            {canUseLargeAreas ? (
                                <>
                                    <option value={100}>100 sq miles</option>
                                    <option value={200}>200 sq miles (Max)</option>
                                </>
                            ) : (
                                <>
                                    <option value={100} disabled>100 sq miles (Pro)</option>
                                    <option value={200} disabled>200 sq miles (Pro)</option>
                                </>
                            )}
                        </select>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            size="icon"
                            onClick={() => {
                                setDrawingMode(false);
                                setDraftPolygon([]);
                            }}
                            className="h-8 w-8 rounded-full bg-red-500/20 text-red-500 hover:bg-red-500 hover:text-white border-none"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                        <Button
                            size="icon"
                            disabled={draftPolygon.length < 3}
                            onClick={() => {
                                setDrawnPolygon(draftPolygon);
                                setDrawingMode(false);
                                toast.success("Territory area saved!");
                            }}
                            className="h-8 w-8 rounded-full bg-green-500/20 text-green-500 hover:bg-green-500 hover:text-white border-none disabled:opacity-50"
                        >
                            <Check className="w-4 h-4" />
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    // Pull Progress Bar
    if (pulling) {
        return (
            <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] w-11/12 max-w-sm animate-in fade-in">
                <div className="bg-black/90 backdrop-blur-md border border-blue-500/50 rounded-xl p-4 shadow-2xl">
                    <div className="flex items-center gap-3 mb-3">
                        <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                        <div>
                            <p className="text-xs font-bold text-white">Fetching Property Data</p>
                            <p className="text-[10px] text-gray-400">{pullProgress}</p>
                        </div>
                    </div>
                    <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full animate-pulse" style={{ width: '70%', transition: 'width 2s ease' }} />
                    </div>
                    <p className="text-[9px] text-gray-500 mt-2 text-center">This may take 10-30 seconds depending on area size</p>
                </div>
            </div>
        );
    }

    // Drawn Polygon Controls (Fetch data / Clear)
    if (!drawingMode && drawnPolygon && drawnPolygon.length > 2) {
        return (
            <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[1000] bg-black/90 backdrop-blur-md border border-gray-800 rounded-full px-4 py-2 shadow-2xl flex items-center gap-3 animate-in fade-in">
                <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
                <Button
                    disabled={pulling}
                    onClick={async () => {
                        // Compute centroid and coverage radius
                        const centerLat = drawnPolygon.reduce((s, p) => s + p.lat, 0) / drawnPolygon.length;
                        const centerLng = drawnPolygon.reduce((s, p) => s + p.lng, 0) / drawnPolygon.length;

                        const R = 3959; // miles
                        const toRad = (v) => v * Math.PI / 180;
                        let maxDist = 0;
                        for (const p of drawnPolygon) {
                            const dLat = toRad(p.lat - centerLat);
                            const dLng = toRad(p.lng - centerLng);
                            const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(centerLat)) * Math.cos(toRad(p.lat)) * Math.sin(dLng / 2) ** 2;
                            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                            const d = R * c;
                            if (d > maxDist) maxDist = d;
                        }
                        const radius = Math.max(0.5, maxDist * 1.05);
                        const areaSqMiles = Math.PI * (radius * radius);

                        const pullLimit = isOwner ? 999 : (isPaid ? 10 : 3);
                        const pullsUsed = user?.area_pulls_count || 0;

                        if (pullsUsed >= pullLimit) {
                            toast.error(isPaid ? "You've reached your custom drawn areas limit." : "You've used your free custom drawn areas. Please upgrade.");
                            if (!isPaid) {
                                setTimeout(() => { window.location.href = '/Billing'; }, 2000);
                            }
                            return;
                        }

                        const maxRadius = isOwner ? 999 : (isPaid ? 50 : 20);

                        if (radius > maxRadius) {
                            toast.error(`The drawn area is too large (approx ${Math.round(radius * 2)} miles across). Max is ${maxRadius * 2} miles.`);
                            return;
                        }

                        setPulling(true);
                        setPullProgress(`Pulling data for ~${areaSqMiles.toFixed(1)} sq mi...`);
                        const toastId = toast.loading(`Pulling data for approx ${areaSqMiles.toFixed(1)} sq miles...`);
                        try {
                            const res = await base44.functions.invoke('fetchAreaProperties', {
                                latitude: centerLat,
                                longitude: centerLng,
                                radius: radius,
                                polygon: drawnPolygon
                            });
                            const d = res.data || {};
                            if (d.error) {
                                toast.error(d.message || d.error, { id: toastId });
                            } else if (d.status === 'empty' || (d.count === 0 && d.in_polygon_count === 0)) {
                                toast.info(d.message || `No properties found in this area.`, { id: toastId });
                            } else {
                                let note = d.recent_sales_12mo ? ` • ${d.recent_sales_12mo} sold in last 12 months.` : '';
                                if (d.count === 0 && d.in_polygon_count > 0) {
                                    toast.success(`Area loaded! ${d.in_polygon_count} properties ready.${note}`, { id: toastId });
                                } else {
                                    toast.success(d.message || `Properties loaded!${note}`, { id: toastId });
                                }

                                if (onPullComplete) {
                                    onPullComplete();
                                } else {
                                    queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
                                    queryClient.invalidateQueries({ queryKey: ['user'] });
                                    setShowCompare(true);
                                    setDrawnPolygon(null);
                                }
                            }
                        } catch (e) {
                            const msg = e.response?.data?.message || e.message;
                            toast.error(`Failed to pull data: ${msg}`, { id: toastId });
                        } finally {
                            setPulling(false);
                            setPullProgress('');
                        }
                    }}
                    className={`text-white text-[10px] h-6 px-2 py-0 rounded-md ml-2 ${pulling ? 'bg-blue-800' : 'bg-blue-600 hover:bg-blue-500'}`}
                >
                    {pulling ? (
                        <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Pulling...</>
                    ) : (
                        'Fetch data'
                    )}
                </Button>
                <button
                    onClick={() => {
                        setDrawnPolygon(null);
                        setDraftPolygon([]);
                    }}
                    className="text-gray-400 hover:text-red-500 transition-colors p-1 bg-white/5 rounded-full"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>
        );
    }

    return null;
}