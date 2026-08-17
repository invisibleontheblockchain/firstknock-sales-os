import React from 'react';

const LIGHT_VARIANTS = [
  { id: 'light', label: 'Neutral', swatch: 'from-slate-100 via-sky-100 to-emerald-100' },
  { id: 'light_soft', label: 'Soft', swatch: 'from-stone-100 via-slate-100 to-gray-200' },
  { id: 'light_warm', label: 'Warm', swatch: 'from-amber-100 via-orange-50 to-lime-100' },
  { id: 'light_cool', label: 'Cool', swatch: 'from-cyan-100 via-blue-50 to-teal-100' },
  { id: 'light_vivid', label: 'Vivid', swatch: 'from-sky-200 via-emerald-200 to-amber-200' },
  { id: 'light_contrast', label: 'Contrast', swatch: 'from-white via-slate-200 to-slate-400' },
  { id: 'light_mono', label: 'Mono', swatch: 'from-white via-gray-200 to-gray-400' },
];

const OTHER_STYLES = [
  { id: 'dark', label: 'Dark', swatch: 'from-slate-950 via-slate-800 to-slate-600' },
  { id: 'streets', label: 'Streets', swatch: 'from-blue-100 via-green-100 to-amber-100' },
  { id: 'minimal', label: 'Minimal', swatch: 'from-white via-stone-100 to-stone-200' },
  { id: 'terrain', label: 'Terrain', swatch: 'from-emerald-200 via-lime-100 to-stone-300' },
  { id: 'satellite', label: 'Satellite', swatch: 'from-green-950 via-slate-700 to-blue-950' },
  { id: 'hybrid', label: 'Hybrid', swatch: 'from-green-900 via-slate-600 to-blue-900' },
];

export default function MapStyleSelector({ routeMode, value, onChange }) {
  const styles = routeMode === 'canvas' ? [...LIGHT_VARIANTS, ...OTHER_STYLES] : [{ ...LIGHT_VARIANTS[0], label: 'Light' }, ...OTHER_STYLES];
  return (
    <div className="grid grid-cols-2 gap-2">
      {styles.map((style) => (
        <button key={style.id} onClick={() => onChange(style.id)} className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[10px] font-bold transition-colors ${value === style.id ? 'border-white/25 bg-white/10 text-white' : 'border-white/[0.05] bg-white/[0.02] text-gray-500 hover:border-white/15 hover:text-white'}`}>
          <span className={`h-6 w-6 shrink-0 rounded-md bg-gradient-to-br ${style.swatch}`} />
          {style.label}
        </button>
      ))}
    </div>
  );
}