import React from 'react';
import { useTheme, contrastText } from './ThemeProvider';
import { Check, Paintbrush } from 'lucide-react';

export default function ThemeColorPicker() {
    const { accent, setAccent, colors } = useTheme();

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 mb-1">
                <Paintbrush className="w-4 h-4" style={{ color: accent }} />
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">App Accent Color</span>
            </div>
            <div className="flex flex-wrap gap-2">
                {colors.map(c => (
                    <button
                        key={c.value}
                        onClick={() => setAccent(c.value)}
                        className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110 ring-offset-2 ring-offset-black"
                        style={{
                            background: c.value,
                            boxShadow: accent === c.value ? `0 0 0 2px ${c.value}, 0 0 12px ${c.value}60` : 'none',
                        }}
                        title={c.name}
                    >
                        {accent === c.value && <Check className="w-4 h-4" style={{ color: contrastText(c.value) }} />}
                    </button>
                ))}
            </div>
        </div>
    );
}