import React from 'react';
import { Button } from "@/components/ui/button";
import { Map as MapIcon, Pencil, Layers, X, Check, Trash2 } from 'lucide-react';
import { toast } from "sonner";

export default function TerritoryPrompt({ 
    mode, 
    activeRoute, 
    routesGenerating, 
    showCompare, 
    showRoutePanel,
    drawingMode,
    setDrawingMode,
    drawnPolygon,
    setDrawnPolygon,
    draftPolygon,
    setDraftPolygon,
    user,
    setZipCodeFilter
}) {
    if (mode !== 'generate' || activeRoute || routesGenerating || showCompare || showRoutePanel) return null;

    return (
        <>
            {/* Prompt to start drawing or use main territory */}
            {!drawingMode && (!drawnPolygon || drawnPolygon.length === 0) && (
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[2000] flex flex-col items-center gap-4 w-full px-4">
                    <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mb-2 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                        <MapIcon className="w-8 h-8 text-yellow-500" />
                    </div>
                    <h2 className="text-3xl sm:text-4xl font-extrabold text-white drop-shadow-lg text-center tracking-tight" style={{ textShadow: '0 2px 20px rgba(0,0,0,0.9)' }}>
                        Plan Today's Territory
                    </h2>
                    <p className="text-gray-400 text-sm font-medium mb-2 text-center max-w-xs">Draw a custom area or use your pre-configured territory to build optimized routes.</p>
                    <div className="flex flex-col gap-3 w-full max-w-xs">
                        <Button 
                            onClick={() => setDrawingMode(true)} 
                            className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold h-12 text-base w-full rounded-full shadow-[0_0_20px_rgba(255,215,0,0.4)] transition-transform hover:scale-105 border-none"
                        >
                            <Pencil className="w-5 h-5 mr-2" />
                            Draw Custom Area
                        </Button>
                        <Button 
                            onClick={() => {
                                setZipCodeFilter(user?.territory_zip_codes?.join(', ') || '');
                                toast.success("Using Main Territory");
                            }} 
                            className="bg-black/60 hover:bg-black text-white font-bold h-12 text-base w-full rounded-full border border-gray-700 backdrop-blur transition-colors"
                        >
                            <Layers className="w-5 h-5 mr-2 text-yellow-500" />
                            Use Main Territory
                        </Button>
                    </div>
                </div>
            )}

            {/* Active Drawing Controls */}
            {drawingMode && (
                <div className="absolute top-24 left-1/2 -translate-x-1/2 z-[2000] bg-black/90 backdrop-blur-md border border-yellow-500/50 rounded-2xl p-3 shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 w-11/12 max-w-sm">
                    <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center shrink-0">
                        <Pencil className="w-4 h-4 text-yellow-500" />
                    </div>
                    <div className="flex-1">
                        <p className="text-xs font-bold text-white uppercase tracking-wider">Drawing Mode</p>
                        <p className="text-[10px] text-gray-400">Click map to outline area</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
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
            )}

            {/* Drawn Polygon Controls */}
            {!drawingMode && drawnPolygon && drawnPolygon.length > 2 && (
                 <div className="absolute top-20 left-1/2 -translate-x-1/2 z-[1000] bg-black/90 backdrop-blur-md border border-gray-800 rounded-full px-4 py-2 shadow-2xl flex items-center gap-3 animate-in fade-in">
                     <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                     <span className="text-xs font-bold text-white whitespace-nowrap">Custom Area Active</span>
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
            )}
        </>
    );
}