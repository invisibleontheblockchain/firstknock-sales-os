/**
 * Logic for generating a grid-based heatmap overlay
 * Aggregates individual points into "Hot Cells" for high-level visualization
 */

import { scoreProperty } from './routeOptimizer';

// Grid size ~0.25 miles
const GRID_LAT_STEP = 0.004;
const GRID_LNG_STEP = 0.004;

export function generateHeatmapGrid(properties) {
    if (!properties || properties.length === 0) return [];

    const grid = {};

    properties.forEach(p => {
        if (!p.lat || !p.lng) return;

        // Create a grid key based on rounded coordinates (bucketing)
        const latKey = Math.floor(p.lat / GRID_LAT_STEP);
        const lngKey = Math.floor(p.lng / GRID_LNG_STEP);
        const key = `${latKey},${lngKey}`;

        if (!grid[key]) {
            grid[key] = {
                id: key,
                lat: (latKey * GRID_LAT_STEP) + (GRID_LAT_STEP / 2), // Center of cell
                lng: (lngKey * GRID_LNG_STEP) + (GRID_LNG_STEP / 2),
                count: 0,
                totalScore: 0,
                properties: []
            };
        }

        const score = scoreProperty(p);
        grid[key].count++;
        grid[key].totalScore += score;
        grid[key].properties.push(p);
    });

    // Convert to array and normalize intensity
    return Object.values(grid).map(cell => ({
        ...cell,
        avgScore: cell.totalScore / cell.count,
        intensity: Math.min(1, cell.count / 10) // Cap intensity at 10 homes per cell for opacity
    }));
}

export function getHeatColor(avgScore) {
    if (avgScore > 200) return '#FFD700'; // Super Hot (Gold)
    if (avgScore > 150) return '#f59e0b'; // Hot (Amber)
    if (avgScore > 100) return '#f97316'; // Warm (Orange)
    return '#3b82f6'; // Cold (Blue)
}

/**
 * Aggregates properties by State for high-level (low zoom) map view
 * Returns list of { state, count, lat, lng, avgScore }
 */
export function generateStateClusters(properties) {
    if (!properties || properties.length === 0) return [];

    const states = {};

    properties.forEach(p => {
        // Use state field or fallback to 'Unknown'
        const stateCode = p.state || 'Unknown';
        
        if (!states[stateCode]) {
            states[stateCode] = {
                id: stateCode,
                count: 0,
                totalLat: 0,
                totalLng: 0,
                totalScore: 0
            };
        }

        states[stateCode].count++;
        states[stateCode].totalLat += (p.lat || 0);
        states[stateCode].totalLng += (p.lng || 0);
        states[stateCode].totalScore += scoreProperty(p);
    });

    return Object.values(states).map(s => ({
        id: s.id,
        count: s.count,
        lat: s.totalLat / s.count,
        lng: s.totalLng / s.count,
        avgScore: s.totalScore / s.count
    }));
}