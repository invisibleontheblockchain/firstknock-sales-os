import React, { createContext, useContext, useState } from 'react';

const THEME_COLORS = [
    { name: 'Gold', value: '#FFD700' },
    { name: 'Electric Blue', value: '#3B82F6' },
    { name: 'Emerald', value: '#10B981' },
    { name: 'Hot Pink', value: '#EC4899' },
    { name: 'Violet', value: '#8B5CF6' },
    { name: 'Orange', value: '#F97316' },
    { name: 'Cyan', value: '#06B6D4' },
    { name: 'Red', value: '#EF4444' },
    { name: 'Lime', value: '#84CC16' },
    { name: 'Rose', value: '#F43F5E' },
];

const ThemeContext = createContext({
    accent: '#FFD700',
    setAccent: () => {},
    colors: THEME_COLORS,
});

export function ThemeProvider({ children }) {
    const [accent, setAccentState] = useState(() => {
        try { return localStorage.getItem('fk_accent') || '#FFD700'; } catch { return '#FFD700'; }
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