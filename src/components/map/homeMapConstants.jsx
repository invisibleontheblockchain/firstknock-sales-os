// Shared visual constants for the manager map (extracted from pages/Home)

// Brand Colors
export const BRAND = {
    voidBlack: '#0A0A0F', // Updated to new dark background
    gold: '#FFD93D',      // Updated Warning/Gold
    charcoal: '#12121A',  // Surface
    offWhite: '#F0F0F5',  // Text Primary
    primary: '#6C5CE7',
    success: '#00F5A0',
    danger: '#FF6B6B'
};

// Default Status colors matching Design System
export const DEFAULT_STATUS_COLORS = {
    ELIGIBLE: '#404040', // Dark Gray (not knocked)
    SOLD: '#00F5A0',     // Neon Green (interested/closed)
    HARD_NO: '#FF6B6B',  // Soft Red (not interested)
    CALLBACK: '#FFD93D', // Gold (follow-ups)
    NO_ANSWER: '#404040',// Dark Gray
    QUALIFIED: '#00F5A0',// Neon Green
    UNVERIFIED: '#A855F6',// Purple (legacy CSV data)
    RECENT_OFF_MARKET: '#FFD700', // Gold (early warning MLS radar)
    OTHER: '#404040'     // Dark Gray
};

export const COLOR_SCHEME_MAP = {
    default: DEFAULT_STATUS_COLORS,
    confidence: DEFAULT_STATUS_COLORS,
    neon: { ELIGIBLE: '#00fff7', SOLD: '#39ff14', HARD_NO: '#ff073a', CALLBACK: '#ffed00', NO_ANSWER: '#00fff7', QUALIFIED: '#39ff14', UNVERIFIED: '#bf5af2', RECENT_OFF_MARKET: '#ffed00', OTHER: '#00fff7' },
    pastel: { ELIGIBLE: '#a8b8c8', SOLD: '#77dd77', HARD_NO: '#b39ddb', CALLBACK: '#fff176', NO_ANSWER: '#a8b8c8', QUALIFIED: '#77dd77', UNVERIFIED: '#c4b5fd', RECENT_OFF_MARKET: '#fff176', OTHER: '#a8b8c8' },
    heatmap: { ELIGIBLE: '#1e3a5f', SOLD: '#ff4500', HARD_NO: '#8b0000', CALLBACK: '#ff8c00', NO_ANSWER: '#1e3a5f', QUALIFIED: '#ff4500', UNVERIFIED: '#7c3aed', RECENT_OFF_MARKET: '#ff8c00', OTHER: '#1e3a5f' },
    monochrome: { ELIGIBLE: '#555', SOLD: '#fff', HARD_NO: '#888', CALLBACK: '#bbb', NO_ANSWER: '#555', QUALIFIED: '#fff', UNVERIFIED: '#999', RECENT_OFF_MARKET: '#bbb', OTHER: '#555' },
};

export const LINE_DASH_MAP = {
    solid: null,
    dashed: '8,6',
    dotted: '2,4',
    dashdot: '10,4,2,4',
};

export const ROUTE_COLORS = ['#FFD700', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];