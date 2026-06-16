import React, { createContext, useContext, useState } from 'react';

const THEME_COLORS = [
    { name: 'FirstKnock Green', value: '#2EEB57' },
    { name: 'Active Green', value: '#39FF4A' },
    { name: 'White', value: '#FFFFFF' },
    { name: 'Charcoal', value: '#101010' },
    { name: 'Soft Gray', value: '#9CA3AF' },
    { name: 'Alert Red', value: '#FF6B6B' },
];

const ThemeContext = createContext({
    accent: '#2EEB57',
    setAccent: () => {},
    colors: THEME_COLORS,
});

export function ThemeProvider({ children }) {
    const [accent, setAccentState] = useState(() => {
        try {
            const saved = localStorage.getItem('fk_accent');
            return ['#6C5CE7', '#A29BFE', '#FFD93D', '#FFD700'].includes(saved) ? '#2EEB57' : (saved || '#2EEB57');
        } catch { return '#2EEB57'; }
    });

    const setAccent = (color) => {
        setAccentState(color);
        try { localStorage.setItem('fk_accent', color); } catch {}
    };

    return (
        <ThemeContext.Provider value={{ accent, setAccent, colors: THEME_COLORS }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    return useContext(ThemeContext);
}

export function contrastText(hex) {
    if (!hex || hex.length < 7) return '#000000';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#FFFFFF';
}