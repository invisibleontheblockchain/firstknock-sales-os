// Shared visual constants for the manager map (extracted from pages/Home)

// Brand Colors
export const BRAND = {
    voidBlack: '#000000',
    gold: '#2EEB57',
    charcoal: '#050505',
    offWhite: '#FFFFFF',
    primary: '#2EEB57',
    success: '#2EEB57',
    danger: '#FF6B6B'
};

// Default Status colors matching Design System
export const DEFAULT_STATUS_COLORS = {
    ELIGIBLE: '#404040',
    SOLD: '#2EEB57',
    HARD_NO: '#FF6B6B',
    CALLBACK: '#39FF4A',
    NO_ANSWER: '#404040',
    QUALIFIED: '#2EEB57',
    UNVERIFIED: '#FFFFFF',
    RECENT_OFF_MARKET: '#39FF4A',
    OTHER: '#404040'
};

export const COLOR_SCHEME_MAP = {
    default: DEFAULT_STATUS_COLORS,
    confidence: DEFAULT_STATUS_COLORS,
    neon: { ELIGIBLE: '#2EEB57', SOLD: '#39FF4A', HARD_NO: '#ff073a', CALLBACK: '#FFFFFF', NO_ANSWER: '#2EEB57', QUALIFIED: '#39FF4A', UNVERIFIED: '#FFFFFF', RECENT_OFF_MARKET: '#39FF4A', OTHER: '#2EEB57' },
    pastel: { ELIGIBLE: '#a8b8c8', SOLD: '#2EEB57', HARD_NO: '#FF6B6B', CALLBACK: '#39FF4A', NO_ANSWER: '#a8b8c8', QUALIFIED: '#2EEB57', UNVERIFIED: '#FFFFFF', RECENT_OFF_MARKET: '#39FF4A', OTHER: '#a8b8c8' },
    heatmap: { ELIGIBLE: '#052e16', SOLD: '#2EEB57', HARD_NO: '#8b0000', CALLBACK: '#39FF4A', NO_ANSWER: '#052e16', QUALIFIED: '#2EEB57', UNVERIFIED: '#FFFFFF', RECENT_OFF_MARKET: '#39FF4A', OTHER: '#052e16' },
    monochrome: { ELIGIBLE: '#555', SOLD: '#fff', HARD_NO: '#888', CALLBACK: '#2EEB57', NO_ANSWER: '#555', QUALIFIED: '#fff', UNVERIFIED: '#999', RECENT_OFF_MARKET: '#2EEB57', OTHER: '#555' },
};

export const LINE_DASH_MAP = {
    solid: null,
    dashed: '8,6',
    dotted: '2,4',
    dashdot: '10,4,2,4',
};

export const ROUTE_COLORS = ['#2EEB57', '#39FF4A', '#FFFFFF', '#10b981', '#22c55e', '#86efac', '#4ade80', '#bbf7d0'];