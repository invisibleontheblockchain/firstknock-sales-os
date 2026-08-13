import React from 'react';
import { Check } from 'lucide-react';
import { PIN_THEMES, matchPinTheme } from './mapPinThemes';

/**
 * One tap sets the property dots, route paths, and colour scheme as a matched set.
 */
export default function MapThemePicker({ mapSettings = {}, pinSize = null, onApply }) {
  const activeId = matchPinTheme(mapSettings, pinSize);

  return (
    <div className="grid grid-cols-2 gap-2">
      {PIN_THEMES.map((theme) => {
        const active = activeId === theme.id;
        return (
          <button
            key={theme.id}
            onClick={() => onApply(theme)}
            className={`relative overflow-hidden rounded-xl border p-3 text-left transition-all ${active ? 'border-[#2EEB57]/60 bg-[#2EEB57]/[0.08]' : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15'}`}
          >
            {active && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-[#2EEB57]" />}
            <div className="flex items-center gap-1.5">
              {theme.swatch.map((color) => (
                <span
                  key={color}
                  className="h-3.5 w-3.5 rounded-full"
                  style={{ background: color, boxShadow: theme.settings.glowEffect ? `0 0 6px ${color}` : 'none' }}
                />
              ))}
            </div>
            <svg width="100%" height="4" className="mt-2.5">
              <line
                x1="0" y1="2" x2="100%" y2="2"
                stroke={theme.swatch[0]}
                strokeWidth={theme.settings.lineWidth}
                strokeOpacity={theme.settings.lineOpacity}
                strokeDasharray={{ dashed: '8,6', dotted: '2,4', dashdot: '10,4,2,4' }[theme.settings.lineStyle] || 'none'}
              />
            </svg>
            <p className={`mt-2 text-xs font-black ${active ? 'text-white' : 'text-gray-400'}`}>{theme.label}</p>
            <p className="text-[9px] leading-tight text-gray-600">{theme.hint}</p>
          </button>
        );
      })}
    </div>
  );
}