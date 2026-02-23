import React, { createContext, useContext, useState } from 'react';

const THEME_COLORS = [
    { name: 'Royal Purple', value: '#6C5CE7' },
    { name: 'Electric Cyan', value: '#00D2FF' },
    { name: 'Neon Green', value: '#00F5A0' },
    { name: 'Gold', value: '#FFD93D' },
    { name: 'Hot Pink', value: '#FF0080' },
    { name: 'Orange', value: '#FF6B6B' },
];

const ThemeContext = createContext({
    accent: '#6C5CE7',
    setAccent: () => {},
    colors: THEME_COLORS,
});

export function ThemeProvider({ children }) {
    const [accent, setAccentState] = useState(() => {
        try { return localStorage.getItem('fk_accent') || '#6C5CE7'; } catch { return '#6C5CE7'; }
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