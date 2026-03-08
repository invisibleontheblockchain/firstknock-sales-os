import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Square, Circle, MapPin, Sparkles, ArrowRight, Loader2 } from 'lucide-react';

/**
 * ServiceAreaOnboarding — V2 first-time setup flow
 * 
 * Shown when user hasn't drawn their service area yet.
 * Three-step flow:
 *   1. Choose shape (square or circle)
 *   2. Choose months back (1-3, default 3)
 *   3. Draw on map → generate route
 * 
 * Props:
 *   onStartDrawing: (shape) => void — activates MapDrawTool
 *   onGenerate: (months) => void — triggers data fetch after drawing
 *   isDrawing: boolean — currently in drawing mode
 *   hasDrawn: boolean — polygon exists
 *   isGenerating: boolean — data fetch in progress
 *   drawnAreaSqMi: number — calculated area of drawn polygon
 */
export default function ServiceAreaOnboarding({
  onStartDrawing,
  onGenerate,
  isDrawing = false,
  hasDrawn = false,
  isGenerating = false,
  drawnAreaSqMi = 0,
}) {
  const [selectedShape, setSelectedShape] = useState('circle');
  const [monthsBack, setMonthsBack] = useState(3);
  const [step, setStep] = useState(1);

  const maxArea = 200; // Free tier max
  const isOverLimit = drawnAreaSqMi > maxArea;

  // Step 1: Choose shape
  if (step === 1 && !isDrawing && !hasDrawn) {
    return (
      <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-[#12121A] border border-white/10 rounded-2xl p-8 max-w-md mx-4 shadow-2xl">
          <div className="text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center mx-auto mb-4">
              <MapPin size={28} className="text-yellow-400" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Let's set up your territory</h2>
            <p className="text-white/50 text-sm">
              Draw your full service area on the map. We'll pull every recently sold home inside it.
            </p>
          </div>

          {/* Shape selector */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <button
              onClick={() => setSelectedShape('square')}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                selectedShape === 'square'
                  ? 'bg-yellow-500/10 border-yellow-500/40 text-yellow-400'
                  : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10'
              }`}
            >
              <Square size={32} />
              <span className="text-xs font-bold tracking-wide">SQUARE</span>
            </button>
            <button
              onClick={() => setSelectedShape('circle')}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                selectedShape === 'circle'
                  ? 'bg-yellow-500/10 border-yellow-500/40 text-yellow-400'
                  : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10'
              }`}
            >
              <Circle size={32} />
              <span className="text-xs font-bold tracking-wide">CIRCLE</span>
            </button>
          </div>

          {/* Months slider */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-white/60 tracking-wide">HOW FAR BACK?</span>
              <span className="text-sm font-bold text-yellow-400">{monthsBack} month{monthsBack > 1 ? 's' : ''}</span>
            </div>
            <Slider
              value={[monthsBack]}
              onValueChange={([v]) => setMonthsBack(v)}
              min={1}
              max={3}
              step={1}
              className="w-full"
            />
            <div className="flex justify-between mt-1">
              <span className="text-[9px] text-white/30">1 month</span>
              <span className="text-[9px] text-white/30">2 months</span>
              <span className="text-[9px] text-white/30">3 months</span>
            </div>
          </div>

          <p className="text-[10px] text-white/30 text-center mb-4">
            Free: 200 sq mi · One data pull · 100 homes
          </p>

          <Button
            onClick={() => {
              setStep(2);
              onStartDrawing?.(selectedShape);
            }}
            className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-sm py-3"
          >
            <Sparkles size={16} className="mr-2" />
            Draw My Service Area
            <ArrowRight size={16} className="ml-2" />
          </Button>
        </div>
      </div>
    );
  }

  // Step 2: Drawing mode active
  if (isDrawing && !hasDrawn) {
    return (
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000]">
        <div className="bg-[#12121A]/95 backdrop-blur-xl border border-yellow-500/30 rounded-xl px-6 py-3 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
            <span className="text-sm font-bold text-yellow-400">
              Click on the map to place your {selectedShape}
            </span>
          </div>
          <p className="text-[10px] text-white/40 mt-1">
            Position it to cover your full service area
          </p>
        </div>
      </div>
    );
  }

  // Step 3: Drawn — confirm & generate
  if (hasDrawn && !isGenerating) {
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
        <div className="bg-[#12121A]/95 backdrop-blur-xl border border-white/10 rounded-xl p-4 shadow-2xl min-w-[300px]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-white/60">YOUR TERRITORY</span>
            <span className={`text-xs font-bold ${isOverLimit ? 'text-red-400' : 'text-green-400'}`}>
              ~{Math.round(drawnAreaSqMi)} / {maxArea} sq mi
            </span>
          </div>

          {isOverLimit ? (
            <p className="text-[11px] text-red-400/80 mb-3">
              Area exceeds free tier limit. Reduce the size or upgrade.
            </p>
          ) : (
            <p className="text-[11px] text-white/40 mb-3">
              {monthsBack} month{monthsBack > 1 ? 's' : ''} of leads will be generated
            </p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={() => {
                setStep(1);
                onStartDrawing?.(null); // Cancel
              }}
              variant="outline"
              className="flex-1 border-white/10 text-white/60 text-xs"
            >
              Redraw
            </Button>
            <Button
              onClick={() => onGenerate?.(monthsBack)}
              disabled={isOverLimit}
              className="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-xs"
            >
              <Sparkles size={14} className="mr-1.5" />
              Generate Leads
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Step 4: Generating
  if (isGenerating) {
    return (
      <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-[#12121A] border border-white/10 rounded-2xl p-8 max-w-sm mx-4 shadow-2xl text-center">
          <Loader2 size={48} className="text-yellow-400 animate-spin mx-auto mb-4" />
          <h3 className="text-lg font-bold text-white mb-2">Generating Your Leads</h3>
          <p className="text-sm text-white/50">
            Pulling {monthsBack} month{monthsBack > 1 ? 's' : ''} of recently sold homes in your territory...
          </p>
        </div>
      </div>
    );
  }

  return null;
}
